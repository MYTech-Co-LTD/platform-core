#!/usr/bin/env python3
"""scorecard-alert.py — 把 scorecard 的 RED/UNKNOWN 行投进 OO `data_plane_probes`（桥→企微）。

为什么要它：**openship job 的 notifyConfig / `job.run.failed` 订阅在本环境不投递**
（2026-11-07 真机实测：手工触发与定时触发各一次 failed，deliveries 里零条）。数据面告警的
单出口是 OO：`data_plane_probes` 里 `verdict <> 'OK'` 的行由 `oo-notify-bridge.sh` 通道②
转发企微（≤2 分钟，per-check 冷却）。本脚本只投递事实，不改判定、不掩盖失败。

用法（宿主机）：
    python3 scorecard-alert.py /opt/pipeline-scorecard/3120-2026-11-07.csv
    python3 scorecard-alert.py <csv> --due "月度评审到期：报告 /opt/pipeline-scorecard/monthly-2026-11.txt"

退出码：0=无事或全部投递成功；1=有行投递失败（观测面降级，job 应显红）；2=参数/文件问题。
"""
import csv
import json
import os
import sys
import urllib.error
import urllib.request

ENV_FILE = "/etc/openobserve-ingest.env"
STREAM = "data_plane_probes"
# 只有这两级代表「数据没到」；AMBER = last_ok 仍在 SLA 内（数据在），不打扰
ALERT_LEVELS = ("RED", "UNKNOWN")


def load_env(path):
    env = {}
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    except OSError:
        return {}
    return env


def post(env, row):
    url = f"{env['OO_BASE'].rstrip('/')}/api/{env['OO_ORG']}/{STREAM}/_json"
    req = urllib.request.Request(
        url,
        data=json.dumps(row, ensure_ascii=False).encode("utf-8"),
        headers={
            "Authorization": f"Basic {env['OO_AUTH']}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        body = resp.read().decode("utf-8", "replace")
    return '"successful":1' in body


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    due = None
    if "--due" in sys.argv:
        i = sys.argv.index("--due")
        due = sys.argv[i + 1] if i + 1 < len(sys.argv) else ""

    env = load_env(ENV_FILE)
    if not all(env.get(k) for k in ("OO_BASE", "OO_ORG", "OO_AUTH")):
        print(f"scorecard-alert: 缺 {ENV_FILE} 里的 OO_BASE/OO_ORG/OO_AUTH —— 跳过投递", file=sys.stderr)
        return 2

    rows = []
    if due is not None:
        rows.append(
            {
                "probe": "pipeline-scorecard",
                "check": "monthly_review_due",
                "verdict": "DUE",
                "mode": "advisory",
                "detail": due[:160],
            }
        )
    elif args:
        path = args[0]
        name = os.path.basename(path)
        console = name.split("-", 1)[0]
        date = name[:-4].split("-", 1)[1] if "-" in name else ""
        try:
            with open(path, encoding="utf-8") as f:
                for r in csv.DictReader(f):
                    level = (r.get("level") or "").strip().upper()
                    pid = (r.get("pipeline") or "").strip()
                    if level not in ALERT_LEVELS or not pid:
                        continue
                    detail = (
                        f"{level} {date} status={r.get('status') or '-'} "
                        f"last_ok={r.get('last_ok_at') or '-'} {r.get('error') or ''}"
                    ).strip()
                    rows.append(
                        {
                            "probe": "pipeline-scorecard",
                            "console": console,
                            "check": f"scorecard:{pid}",
                            "verdict": "ERR",
                            "mode": "advisory",
                            "detail": detail[:200],
                        }
                    )
        except OSError as e:
            print(f"scorecard-alert: 读不到 {path}：{e}", file=sys.stderr)
            return 2
    else:
        print("scorecard-alert: 用法 <scorecard.csv> | --due <文本>", file=sys.stderr)
        return 2

    if not rows:
        print("scorecard-alert: 无 RED/UNKNOWN 行，不投递")
        return 0

    failed = 0
    for row in rows:  # 本 OO 构建的 _json 端点拒多行 NDJSON 批 ⇒ 逐行 POST
        try:
            ok = post(env, row)
        except (urllib.error.URLError, OSError) as e:
            ok = False
            print(f"scorecard-alert: 投递异常 {row['check']}：{e}", file=sys.stderr)
        if not ok:
            failed += 1
            print(f"scorecard-alert: 投递失败 {row['check']}", file=sys.stderr)
        else:
            print(f"scorecard-alert: 已投递 {row['check']} {row['verdict']}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
