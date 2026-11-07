#!/usr/bin/env python3
"""dbt-failed-nodes.py — 从 dbt 的 run_results.json 里取出**非成功**节点名，供节点级重试。

用法：  python3 dbt-failed-nodes.py <run_results.json>
输出：  空格分隔的节点名（dbt `--select` 可直接吃）；无失败节点则输出空行。

为什么需要它（2026-11-07 真机实证，issue #1621）：
  物化读的是**活湖**（采集每 10 分钟重写「当前小时 + 上一小时」）⇒ DuckDB 的 ETag 校验
  会在读取途中发现文件换版而**整节点 ERROR**。实测单轮 107/108 通过、1 条随机落点失败。
  job 级重跑要重跑整轮 8 分钟；**节点级重试**只重跑那 1 条，几秒收敛。

⚠️ 只对 `status` 属于失败类（error / fail / runtime error）的节点出声；`success` /
  `pass` / `warn` / `skipped` 一律不选——`warn` 是 test 的软失败，重跑没有意义。
⚠️ 节点名取 `unique_id` 的最后一段（dbt 的 `--select` 认这个名字）。
"""
import json
import sys

_OK = {"success", "pass", "warn", "skipped"}


def main() -> int:
    if len(sys.argv) < 2:
        print("", end="")
        return 0
    try:
        with open(sys.argv[1], encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError):
        # 读不到/格式坏 ⇒ 空结果（调用方据此停止重试，而不是拿垃圾去 --select）
        print("", end="")
        return 0
    names = []
    for res in data.get("results") or []:
        if (res.get("status") or "").lower() in _OK:
            continue
        uid = res.get("unique_id") or ""
        if not uid:
            continue
        name = uid.split(".")[-1]
        # 只认标识符形状，防止把异常值拼进 --select（fail-closed）
        if name and all(c.isalnum() or c == "_" for c in name):
            names.append(name)
    print(" ".join(dict.fromkeys(names)), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
