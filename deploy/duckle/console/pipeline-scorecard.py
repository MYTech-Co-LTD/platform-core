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


def owner_rule(owners, pid):
    """把管线 id 映射到 owner 规则：**最长前缀**匹配资产表名（点↔下划线/连字符两种写法）。

    为什么不是「取 id 最后一段」：`lemeng.request.order.l0.3120` 的最后一段是账套号 `3120`，
    `lemeng.dim.item.l0` 的最后一段是 `l0`——拿它去子串匹配 owner.match 等于随机命中
    （2026-11-07 实测：33 条管线里绝大多数落到缺省 36h，恰好和常见值相同，所以一直没被发现；
    真有非 36h 的规则时就会**漏红**）。

    id 的段与资产路径的对应：`lemeng.branch.expense.l0.3120` → `branch_expense`
    （`retail.tick` → 规则里写的是 `retail-tick`，所以连字符也要试）。
    """
    import re

    # ① 显式绑定优先：规则里写 `pipelines: ["<pid>", ...]`（支持 * 通配）。
    #    用于「管线 id 与资产表名对不上」的情况（如 `lemeng.purchase.analysis` 写的是 `item_purchase`）。
    for rule in owners:
        for pat in rule.get("pipelines") or []:
            if _glob(pat, pid):
                return rule

    # ② 退回到按名字推断：id 的段 → 资产路径里的表名段（最长前缀 + 段边界）。
    parts = pid.split(".")
    rest = parts[1:] if len(parts) > 1 else parts
    for n in range(len(rest), 0, -1):
        for sep in ("_", "-"):
            cand = sep.join(rest[:n])
            # 必须是**路径段边界**：`/client` 不能命中 `/client_expense/`
            # （否则 `lemeng.client` 会借到 `client_expense` 的 SLA）。
            pat = re.compile(rf"/{re.escape(cand)}(?=[/.\-])")
            for rule in owners:
                if pat.search(rule.get("match") or ""):
                    return rule
    return None


def sla_hours(owners, pid):
    """本管线的 owner SLA（小时）；规则没写/写坏时缺省 36h。"""
    import re

    rule = owner_rule(owners, pid)
    if not rule:
        return 36.0
    m = re.fullmatch(r"\s*(\d+)\s*([mhd])\s*", str(rule.get("maximumAge", "")), re.I)
    if not m:
        return 36.0
    n = int(m.group(1))
    unit = m.group(2).lower()
    return n / 60.0 if unit == "m" else float(n) if unit == "h" else n * 24.0


def main():
    as_json = "--json" in sys.argv
    strict = "--strict" in sys.argv
    all_runs = "--all" in sys.argv
    explain = "--explain" in sys.argv

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
        # 排除「未展开的模板路径」：真实对象不可能带 `${...}`。引擎的新鲜度表里混进了这类条目
        # （2026-11-07 实测 7 条，形如 `.../bizday=${BIZDAY}/all.parquet`），它们永远解析不到、
        # 永远 stale——不排掉会把 7 条管线误判成 AMBER。
        stale = [
            a
            for a, v in freshness.items()
            if v.get("state") == "stale" and "${" not in a and _glob_any(owners, a)
        ]
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

    if explain:
        # 运维用：这条管线凭什么算 36h/12h？命中了哪条 owner 规则？
        print("pipeline,sla_hours,owner_match")
        for pid in sorted({r["pipeline"] for r in rows}):
            rule = owner_rule(owners, pid)
            print(f"{pid},{sla_hours(owners, pid):g},{(rule or {}).get('match') or '<无规则→缺省 36h>'}")
        return 0

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
    """这条资产是不是这条管线的。

    先看它是否命中**本管线自己的 owner 规则**（最准）；命中不到再退回「资产路径含本管线的表名段」。
    旧实现用 `pid.split('.')[-1]`（账套号 `3120` / `l0`）去比对，几乎恒假 ⇒ stale 资产归属不到任何
    管线 ⇒ 「停更但 run 绿」这一类**永远不会变 AMBER**（2026-11-07 与 SLA 匹配同一处修复）。
    """
    rule = owner_rule(owners, pid)
    if rule and _glob(rule.get("match") or "", asset):
        return True
    if pid in asset:
        return True
    parts = pid.split(".")
    rest = parts[1:] if len(parts) > 1 else parts
    for n in range(len(rest), 0, -1):
        for sep in ("_", "-"):
            cand = sep.join(rest[:n])
            if f"/{cand}/" in asset:
                return True
    return False


if __name__ == "__main__":
    sys.exit(main())
