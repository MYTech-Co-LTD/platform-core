#!/usr/bin/env python3
"""scorecard-heal.py — 把 scorecard 的红/黄行变成「下一步做什么」（自动诊断，**不改任何状态**）。

为什么只诊断、不自动执行：RED 的处置依赖**窗口语义**（缺的是哪一天、源端是否已发布、
该用哪个 backfill 变体），机器判不出来；AMBER 的正确处置本来就是「不动」。
所以本脚本产出修复计划并落盘（交接/复盘用），执行仍按 `pipeline-repair-runbook.md`。

用法（宿主机）：
    python3 scorecard-heal.py /opt/pipeline-scorecard/3120-2026-11-07.csv
    python3 scorecard-heal.py <csv> --out /opt/pipeline-scorecard

产物：`<out>/heal-<console>-<date>.md`（同名覆盖，幂等）。

退出码：0=产出计划（无论有无红）；2=参数/文件问题。
"""
import csv
import os
import sys

RED_STEPS = """1. 确认缺的窗口：读该管线最近失败 run 的 `at` + 管线的窗口 token（`${date-1d}` / `${BIZDAY}` / 固定日）。
2. 确认窗口已闭：源端发布滞后（如 T-1 发布在 D+2 00:11 CST）⇒ 未闭窗先等，别回填截断快照。
3. 回填：优先用该源的 backfill 变体
   `POST /api/run/async {"file":"pipelines/<源>.backfill.<book>.json","params":{"BIZDAY":"<缺的日>"}}`
4. 验证：湖里 `bizday=<日>` 分区存在且行数 > 0；与源端对数；重跑 scorecard 应变 GREEN。
5. 记录：缺的窗口、根因、回填 run id、验证数（→ WeKnora）。"""

AMBER_NOTE = """**多数无需动手**：最后一轮中断/失败，但最近一次成功仍在 owner SLA 内 = 数据在。
看该管线一天几轮、是否同窗口；等下一轮。**连续两轮失败 ⇒ 升级为 RED（按 §1 处理）**。"""

UNKNOWN_NOTE = """排班 enabled 但没有任何 run 记录。查 `schedules.json` 该条目（enabled/kind/cron/时区）、
再查 `/workspace/runs/<pipeline>.json` 是否存在；文件在、调度在、仍不跑 ⇒ 等一个周期看
`trigger=scheduled`（排班热加载约 100s），仍不跑按 SOP §4 复核。"""


def main():
    pos = [a for a in sys.argv[1:] if not a.startswith("--")]
    out_dir = "/opt/pipeline-scorecard"
    if "--out" in sys.argv:
        i = sys.argv.index("--out")
        if i + 1 < len(sys.argv):
            out_dir = sys.argv[i + 1]
    if not pos:
        print("scorecard-heal: 用法 <scorecard.csv> [--out DIR]", file=sys.stderr)
        return 2

    path = pos[0]
    name = os.path.basename(path)
    console = name.split("-", 1)[0]
    date = name[:-4].split("-", 1)[1] if "-" in name else ""
    try:
        with open(path, encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
    except OSError as e:
        print(f"scorecard-heal: 读不到 {path}：{e}", file=sys.stderr)
        return 2

    buckets = {"RED": [], "AMBER": [], "UNKNOWN": []}
    for r in rows:
        level = (r.get("level") or "").strip().upper()
        if level in buckets:
            buckets[level].append(r)

    lines = [f"# 采集健康处置计划 · {console} · {date}", ""]
    lines.append(
        f"RED={len(buckets['RED'])} AMBER={len(buckets['AMBER'])} UNKNOWN={len(buckets['UNKNOWN'])}"
        f"（来源 `{path}`；判据见 `pipeline-repair-runbook.md`）"
    )
    lines.append("")

    if buckets["RED"]:
        lines.append("## RED（真缺：最近一次成功已超 SLA）")
        for r in buckets["RED"]:
            lines += [
                f"### {r.get('pipeline')}",
                f"- 现状：status=`{r.get('status') or '-'}`，last_ok=`{r.get('last_ok_at') or '-'}`，"
                f"error=`{r.get('error') or '-'}`",
                "- 下一步（runbook §1）：",
                "\n".join("  " + ln if ln else ln for ln in RED_STEPS.split("\n")),
                "",
            ]
    if buckets["UNKNOWN"]:
        lines.append("## UNKNOWN（排班了但从未跑）")
        for r in buckets["UNKNOWN"]:
            lines += [f"### {r.get('pipeline')}", UNKNOWN_NOTE, ""]
    if buckets["AMBER"]:
        lines.append("## AMBER（数据仍在 SLA 内）")
        for r in buckets["AMBER"]:
            lines += [
                f"### {r.get('pipeline')}",
                f"- 现状：status=`{r.get('status') or '-'}`，last_ok=`{r.get('last_ok_at') or '-'}`，"
                f"stale_assets=`{r.get('stale_assets')}`",
                "",
                "> " + AMBER_NOTE.replace("\n", "\n> "),
                "",
            ]
    if not any(buckets.values()):
        lines += ["全部 GREEN —— 无处置项。", ""]

    os.makedirs(out_dir, exist_ok=True)
    target = os.path.join(out_dir, f"heal-{console}-{date}.md")
    with open(target, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print(f"scorecard-heal: 计划写入 {target}（RED={len(buckets['RED'])} "
          f"AMBER={len(buckets['AMBER'])} UNKNOWN={len(buckets['UNKNOWN'])}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
