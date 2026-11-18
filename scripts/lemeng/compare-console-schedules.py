#!/usr/bin/env python3
"""compare-console-schedules.py — 仓内 console 排班种子 vs 运行态文件的语义比对（#2467）。

为什么不用 sha256 比：运行态 `/workspace/schedules.json` 会被引擎回写 `last_run_*` / `next_run_at`，
整文件哈希永远对不上（比了只会天天假红）。这里只比**定义面**：

- 条目集合（按 `id`）；
- 每条 `enabled`、`kind.expr`（cron）、`timezone`。

退出码：0=一致；1=有漂移（逐条打印 `DRIFT ...`）；2=用法/文件错误。
用法：`compare-console-schedules.py <seed.json> <live.json>`
"""
import json
import sys

FIELDS = ("enabled", "timezone")


def load(path):
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, list):
        raise ValueError(f"{path}: 期望 JSON 数组，得到 {type(data).__name__}")
    return {str(x.get("id")): x for x in data if isinstance(x, dict)}


def expr(item):
    kind = item.get("kind") or {}
    return kind.get("expr")


def main(argv):
    if len(argv) != 3:
        print("用法: compare-console-schedules.py <seed.json> <live.json>", file=sys.stderr)
        return 2
    try:
        seed = load(argv[1])
        live = load(argv[2])
    except (OSError, ValueError, json.JSONDecodeError) as e:
        print(f"DRIFT 读不到排班文件：{e}", file=sys.stderr)
        return 2

    drift = 0
    for key in sorted(set(seed) - set(live)):
        print(f"DRIFT {key} 运行态缺失（种子有）")
        drift += 1
    for key in sorted(set(live) - set(seed)):
        print(f"DRIFT {key} 运行态多出（种子没有）")
        drift += 1
    for key in sorted(set(seed) & set(live)):
        s, l = seed[key], live[key]
        if expr(s) != expr(l):
            print(f"DRIFT {key} cron：种子 {expr(s)!r} 运行态 {expr(l)!r}")
            drift += 1
        for f in FIELDS:
            if s.get(f) != l.get(f):
                print(f"DRIFT {key} {f}：种子 {s.get(f)!r} 运行态 {l.get(f)!r}")
                drift += 1
    return 1 if drift else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
