#!/usr/bin/env python3
"""emit-probe.py — 把一行数据面判定事实投进 OO `data_plane_probes`（桥 → 企微）。

为什么要它：openship 的 job 通知**不进站内 deliveries feed**（2026-11-07 实测：最近 100 条
delivery 里 `job.* = 0`）；数据面的既定单出口是 OO——`data_plane_probes` 里
`verdict <> 'OK'` 的行由 `oo-notify-bridge.sh` 通道②转发企微（≤2 分钟，per-check 冷却）。
本脚本只投递事实，不改判定、不掩盖失败。

用法（宿主上；与 scorecard-alert.py 用同一个 env 文件）：
    python3 /opt/lemeng-emit-probe.py <check> <verdict> <detail> [--dry-run]

退出码：0=投递成功（或 dry-run）；1=投递失败（观测面降级）；2=参数/env 问题。
凭据只从 `/etc/openobserve-ingest.env` 读（`PROBE_ENV_FILE` 可覆盖），不落日志、不进 argv。
"""
import json
import os
import sys
import urllib.error
import urllib.request

ENV_FILE = os.environ.get("PROBE_ENV_FILE", "/etc/openobserve-ingest.env")
STREAM = "data_plane_probes"
PROBE = "regression"


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


def build_row(check, verdict, detail):
    return {
        "probe": PROBE,
        "check": check,
        "verdict": verdict,
        "mode": "advisory",
        "detail": detail[:200],
    }


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


def main(argv):
    dry_run = "--dry-run" in argv
    args = [a for a in argv if not a.startswith("--")]
    if len(args) != 3:
        print("用法：emit-probe.py <check> <verdict> <detail> [--dry-run]", file=sys.stderr)
        return 2
    check, verdict, detail = args
    if not check.strip() or not verdict.strip():
        print("emit-probe: check/verdict 不能为空", file=sys.stderr)
        return 2
    row = build_row(check.strip(), verdict.strip().upper(), detail)
    if dry_run:
        print(json.dumps(row, ensure_ascii=False))
        return 0

    env = load_env(ENV_FILE)
    if not all(env.get(k) for k in ("OO_BASE", "OO_ORG", "OO_AUTH")):
        print(f"emit-probe: 缺 {ENV_FILE} 里的 OO_BASE/OO_ORG/OO_AUTH", file=sys.stderr)
        return 2
    try:
        ok = post(env, row)
    except (urllib.error.URLError, OSError) as e:
        print(f"emit-probe: 投递异常 {e}", file=sys.stderr)
        return 1
    if not ok:
        print("emit-probe: 投递未被 OO 接受（响应里没有 successful:1）", file=sys.stderr)
        return 1
    print(f"emit-probe: 已投递 {check} {row['verdict']}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
