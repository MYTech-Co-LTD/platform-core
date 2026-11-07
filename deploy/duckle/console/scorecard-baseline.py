#!/usr/bin/env python3
"""scorecard-baseline.py — 从每日 scorecard 历史 CSV 汇总基线（P4 指标）。

每日 job 把 scorecard 落到 /opt/pipeline-scorecard/<console>-<YYYY-MM-DD>.csv（宿主机）；
本脚本只读这些文件，输出：覆盖天数、各 console 的 RED/AMBER/GREEN 管线天数、
RED/AMBER 最多的管线（用于月度评审与指标基线）。

用法（宿主机）：
    python3 /opt/platform-core-data/platform-core/deploy/duckle/console/scorecard-baseline.py
    python3 .../scorecard-baseline.py /opt/pipeline-scorecard --days 30
"""
import csv
import glob
import os
import sys
from collections import Counter, defaultdict


def main():
    pos = [a for a in sys.argv[1:] if not a.startswith("--")]
    root = pos[0] if pos else "/opt/pipeline-scorecard"
    days = 30
    if "--days" in sys.argv:
        try:
            days = int(sys.argv[sys.argv.index("--days") + 1])
        except (IndexError, ValueError):
            days = 30

    files = sorted(glob.glob(os.path.join(root, "*.csv")))[-days:]
    if not files:
        print(f"scorecard-baseline: 没有历史文件（{root}/*.csv）——先让每日 job 跑起来")
        return 2

    level_days = defaultdict(Counter)  # console -> Counter(level)
    pipe_days = defaultdict(Counter)  # pipeline -> Counter(level)
    dates = set()
    console_dates = defaultdict(set)
    rows = 0
    for path in files:
        name = os.path.basename(path)
        console = name.split("-", 1)[0]
        date = name[-14:-4] if name.endswith(".csv") else name
        dates.add(date)
        console_dates[console].add(date)
        try:
            with open(path, encoding="utf-8") as f:
                reader = csv.DictReader(f)
                for r in reader:
                    lvl = (r.get("level") or "").strip().upper()
                    pid = (r.get("pipeline") or "").strip()
                    if not pid or lvl not in ("RED", "AMBER", "GREEN", "UNKNOWN"):
                        continue
                    level_days[console][lvl] += 1
                    pipe_days[pid][lvl] += 1
                    rows += 1
        except OSError:
            continue

    print(f"scorecard-baseline: {len(dates)} 天（{min(dates)}..{max(dates)}）· {rows} 管线-天")
    print("\nconsole,days,red,amber,green,unknown,red_rate,amber_rate")
    for console in sorted(level_days):
        c = level_days[console]
        total = sum(c.values())
        print(
            f"{console},{len(console_dates[console])},{c['RED']},{c['AMBER']},{c['GREEN']},{c['UNKNOWN']},"
            f"{c['RED'] / total:.3%},{c['AMBER'] / total:.3%}"
        )

    print("\nTOP 管线（按 RED+AMBER 天数）:")
    ranked = sorted(pipe_days.items(), key=lambda kv: (-(kv[1]["RED"] + kv[1]["AMBER"]), kv[0]))
    for pid, c in ranked[:15]:
        if c["RED"] + c["AMBER"] == 0:
            break
        print(f"  {pid}: RED={c['RED']} AMBER={c['AMBER']} GREEN={c['GREEN']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
