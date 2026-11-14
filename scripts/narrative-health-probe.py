#!/usr/bin/env python3
"""narrative-health-probe.py — AI 叙事质量的数据面判据（R5）。

职责分工（正典 `docs/data-platform-handbook.md` §1.5.3）：
  · 本脚本 = **判据本体**：只读平台 PG 的 `data.narrative_runs`，算回退率 / 数字越界率 /
    全链路 p95，逐项与阈值比较；
  · 通知 = `data_plane_probes` 流（经 `/opt/lemeng-emit-probe.py` 投递）→ `oo-notify-bridge.sh`
    通道② → 企微。**本脚本不发通知、不碰 OO 规则、不持 OO 搜索凭据**；
  · 阈值单一事实源 = `modules/data/domain/narrative-runs.ts` 的 `NARRATIVE_SLO`。这里抄一份是
    为了能在数据面机（无 node）上独立运行；`scripts/narrative-health-thresholds.test.ts` 在 CI
    机械比对两处，漂移即红。

用法（数据面机 / 宿主）：
    python3 narrative-health-probe.py --dry-run          # 只打印，不投递（默认）
    python3 narrative-health-probe.py --emit             # 投递到 data_plane_probes
    python3 narrative-health-probe.py --emit --selftest  # 反向测试：合成一条 ERR（会进群）
    python3 narrative-health-probe.py --help

退出码：0=正常（含 dry-run / 无样本）；1=投递失败（观测面降级，job 应红）；2=参数或依赖问题。
"""
import argparse
import json
import subprocess
import sys

# ⚠️ 与 TS 的 NARRATIVE_SLO 保持逐值一致（CI 有机械比对测试）。
SLO_FALLBACK_RATE = 0.20
SLO_P95_MS = 45_000
SLO_NUMBER_CHECK_RATE = 0.05

DEFAULT_PG_CONTAINER = "openship-platform-core-shanhai-postgres"
DEFAULT_EMIT = "/opt/lemeng-emit-probe.py"
SQL = """
select org,
       count(*) filter (where outcome in ('ok','fallback'))::int as generated,
       count(*) filter (where outcome = 'fallback')::int as fallback,
       count(*) filter (where reason = 'number_check')::int as number_check,
       percentile_cont(0.95) within group (order by duration_ms)
         filter (where duration_ms is not null) as p95_ms
  from data.narrative_runs
 where created_at >= now() - make_interval(days => {days})
 group by org
 order by org
"""


def query_rows(container, days):
    sql = SQL.format(days=int(days))
    try:
        out = subprocess.run(
            ["docker", "exec", container, "psql", "-U", "platform", "-d", "platform",
             "-tA", "-F", "\t", "-c", sql],
            check=True, capture_output=True, text=True, timeout=30,
        )
    except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired) as e:
        detail = getattr(e, "stderr", "") or str(e)
        print(f"narrative-health-probe: 查询失败（{detail.strip()[:200]}）", file=sys.stderr)
        return None
    rows = []
    for line in out.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) != 5:
            continue
        org, generated, fallback, number_check, p95 = parts
        rows.append({
            "org": org,
            "generated": int(generated or 0),
            "fallback": int(fallback or 0),
            "number_check": int(number_check or 0),
            "p95_ms": None if p95 in ("", "\\N") else float(p95),
        })
    return rows


def pct(v):
    return f"{v * 100:.1f}%"


def verdicts_of(row):
    """返回 [(check, verdict, detail)]；无生成样本 ⇒ 空（不能判，也不冒充健康）。"""
    generated = row["generated"]
    if generated == 0:
        return []
    org = row["org"]
    out = []
    fallback_rate = row["fallback"] / generated
    out.append((
        "narrative_fallback_rate",
        "ERR" if fallback_rate > SLO_FALLBACK_RATE else "OK",
        f"org={org} generated={generated} fallback_rate={pct(fallback_rate)} (limit {pct(SLO_FALLBACK_RATE)})",
    ))
    number_rate = row["number_check"] / generated
    out.append((
        "narrative_number_check",
        "ERR" if number_rate > SLO_NUMBER_CHECK_RATE else "OK",
        f"org={org} generated={generated} number_check_rate={pct(number_rate)} (limit {pct(SLO_NUMBER_CHECK_RATE)})",
    ))
    if row["p95_ms"] is not None:
        out.append((
            "narrative_p95_ms",
            "ERR" if row["p95_ms"] > SLO_P95_MS else "OK",
            f"org={org} p95={row['p95_ms']:.0f}ms (limit {SLO_P95_MS}ms)",
        ))
    return out


def emit(emit_path, check, verdict, detail):
    proc = subprocess.run(
        [sys.executable, emit_path, check, verdict, detail],
        capture_output=True, text=True, timeout=30,
    )
    if proc.returncode != 0:
        print(f"narrative-health-probe: 投递失败 {check} → {proc.stderr.strip()[:200]}", file=sys.stderr)
        return False
    return True


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--emit", action="store_true", help="投递到 data_plane_probes（缺省只打印）")
    ap.add_argument("--dry-run", action="store_true", help="显式 dry-run（默认行为）")
    ap.add_argument("--selftest", action="store_true", help="反向测试：合成一条 ERR（会进群）")
    ap.add_argument("--days", type=int, default=7, help="统计窗口天数（默认 7）")
    ap.add_argument("--pg-container", default=DEFAULT_PG_CONTAINER)
    ap.add_argument("--emit-probe", default=DEFAULT_EMIT)
    args = ap.parse_args(argv)

    if args.days < 1 or args.days > 90:
        print("narrative-health-probe: --days 必须在 1..90", file=sys.stderr)
        return 2

    if args.selftest:
        row = ("narrative_quality_selftest", "ERR", "反向测试：合成一条叙事质量告警，收到即链路通")
        print(json.dumps(row, ensure_ascii=False))
        if args.emit and not emit(args.emit_probe, *row):
            return 1
        return 0

    rows = query_rows(args.pg_container, args.days)
    if rows is None:
        return 1
    lines = []
    for r in rows:
        lines.extend(verdicts_of(r))
    if not lines:
        print(f"narrative-health-probe: 近 {args.days} 天无生成样本，跳过（无样本 ≠ 健康）")
        return 0

    ok = True
    for check, verdict, detail in lines:
        print(json.dumps({"check": check, "verdict": verdict, "detail": detail}, ensure_ascii=False))
        if args.emit and not emit(args.emit_probe, check, verdict, detail):
            ok = False
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
