#!/usr/bin/env python3
"""pipeline-scorecard.py — 每日采集管线健康 scorecard（P2）。

用法（console 容器内）：
    python3 /workspace/pipeline-scorecard.py            # 人读表 + 红黄判据（exit 1 = 有红）
    python3 /workspace/pipeline-scorecard.py --json     # 机器读
    python3 /workspace/pipeline-scorecard.py --strict   # 黄也算失败

读（只读，不改任何状态）：
    /workspace/runs/<pipeline>.json    最近 run 记录（status/duration_ms/error）
    /workspace/.duckle/freshness.json  资产新鲜度（fresh/stale/unknown/recovered）
    /workspace/schedules.json          排班（enabled/kind/last_run_status）
    /workspace/owners.json             owner 规则（asset match → owner）

判据（红/黄/绿）：
    RED    最近 run status != ok **且** 最近一次成功已超 owner SLA（真缺）
    AMBER  最近 run 中断/失败但 last_ok 仍在 SLA 内（多轮同窗口，数据在）；或 owner 资产 stale
    GREEN  最近 run ok 且无 stale 资产
    UNKNOWN 排班 enabled 但没有 run 记录（新管线 / 从未跑）
"""
import glob
import json
import os
import sys

WS = os.environ.get("DUCKLE_WORKSPACE", "/workspace")


def load(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def last_run(records):
    if isinstance(records, dict):
        return records
    if isinstance(records, list) and records:
        return max(records, key=lambda r: str(r.get("at", "")))
    return None


def last_ok(records):
    """最近一次成功 run（多轮同窗口时，用它判「数据是否还在 SLA 内」）。"""
    if isinstance(records, dict):
        return records if records.get("status") == "ok" else None
    if isinstance(records, list):
        oks = [r for r in records if r.get("status") == "ok"]
        return max(oks, key=lambda r: str(r.get("at", ""))) if oks else None
    return None


def age_hours(iso):
    if not iso:
        return 1e9
    try:
        from datetime import datetime, timezone

        t = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
        return (datetime.now(timezone.utc) - t).total_seconds() / 3600.0
    except ValueError:
        return 1e9


def sla_hours(owners, pid):
    """从 owner 规则里找本管线的 maximumAge（粗匹配：match 含 table 段）；缺省 36h。"""
    import re

    table = pid.split(".")[-1]
    for rule in owners:
        if table in rule.get("match", ""):
            m = re.fullmatch(r"\s*(\d+)\s*([mhd])\s*", str(rule.get("maximumAge", "")), re.I)
            if m:
                n = int(m.group(1))
                unit = m.group(2).lower()
                return n / 60.0 if unit == "m" else float(n) if unit == "h" else n * 24.0
    return 36.0


def main():
    as_json = "--json" in sys.argv
    strict = "--strict" in sys.argv
    all_runs = "--all" in sys.argv

    runs = {}
    for path in sorted(glob.glob(os.path.join(WS, "runs", "*.json"))):
        pid = os.path.basename(path)[:-5]
        if pid.startswith("run-") or pid == "_probe":
            continue
        records = load(path, None)
        rec = last_run(records)
        if rec:
            runs[pid] = (rec, last_ok(records))

    freshness = (load(os.path.join(WS, ".duckle", "freshness.json"), {}) or {}).get("assets", {})
    schedules = load(os.path.join(WS, "schedules.json"), []) or []
    owners = (load(os.path.join(WS, "owners.json"), {}) or {}).get("assets", []) or []

    scheduled_ids = {s.get("pipeline_id") for s in schedules}
    rows = []
    for pid, (rec, ok) in sorted(runs.items()):
        if not all_runs and pid not in scheduled_ids:
            continue
        stale = [a for a, v in freshness.items() if v.get("state") == "stale" and _glob_any(owners, a)]
        # 只统计「本管线 owner 规则覆盖到的」stale 资产；owner 匹配不到的 stale 资产单独列
        my_stale = [a for a in stale if _asset_belongs(owners, a, pid)]
        status = rec.get("status", "?")
        ok_at = ok.get("at") if ok else None
        sla = sla_hours(owners, pid)
        if status != "ok":
            # 多轮同窗口：最后一轮中断/失败，但最近一次成功仍在 SLA 内 ⇒ 数据在，只算 AMBER
            level = "AMBER" if ok is not None and age_hours(ok_at) <= sla else "RED"
        elif my_stale:
            level = "AMBER"
        else:
            level = "GREEN"
        rows.append(
            {
                "pipeline": pid,
                "level": level,
                "last_run_at": rec.get("at"),
                "status": status,
                "last_ok_at": ok_at,
                "duration_ms": rec.get("duration_ms"),
                "error": (rec.get("error") or "")[:120],
                "stale_assets": len(my_stale),
            }
        )

    # 排班里 enabled 但从未跑过的管线也标 UNKNOWN
    scheduled = {s.get("pipeline_id") for s in schedules if s.get("enabled")}
    for pid in sorted(scheduled - set(runs)):
        rows.append(
            {
                "pipeline": pid,
                "level": "UNKNOWN",
                "last_run_at": None,
                "status": None,
                "last_ok_at": None,
                "duration_ms": None,
                "error": "scheduled but never ran",
                "stale_assets": 0,
            }
        )

    if as_json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
    else:
        print("pipeline,level,last_run_at,status,last_ok_at,duration_ms,stale_assets,error")
        for r in rows:
            print(
                f"{r['pipeline']},{r['level']},{r['last_run_at']},{r['status']},{r['last_ok_at']},"
                f"{r['duration_ms']},{r['stale_assets']},\"{r['error']}\""
            )

    red = [r for r in rows if r["level"] == "RED"]
    amber = [r for r in rows if r["level"] == "AMBER"]
    unknown = [r for r in rows if r["level"] == "UNKNOWN"]
    print(
        f"\nscorecard: {len(rows)} pipelines · RED={len(red)} AMBER={len(amber)} UNKNOWN={len(unknown)}",
        file=sys.stderr,
    )
    if red or unknown or (strict and amber):
        return 1
    return 0


def _glob(pattern, text):
    """极简 glob：* 匹配任意字符。"""
    import fnmatch

    return fnmatch.fnmatchcase(text, pattern)


def _glob_any(owners, asset):
    return any(_glob(r.get("match", ""), asset) for r in owners)


def _asset_belongs(owners, asset, pid):
    # owner 规则没有 pipeline 列；用 asset 路径里是否含 pid 的 domain/table 段做粗归属
    if pid in asset:
        return True
    parts = pid.split(".")
    return len(parts) >= 2 and f"/{parts[-1]}/" in asset and parts[0] in asset


if __name__ == "__main__":
    sys.exit(main())
