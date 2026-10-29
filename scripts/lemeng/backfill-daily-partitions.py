#!/usr/bin/env python3
"""backfill-daily-partitions.py — 把历史闭窗日逐日转成「天文件」，并删掉被取代的小时对象。

## 它编排的三件事（每天 × 每账套）

1. **整天重采**：POST `<console>/api/run`，文件 `pipelines/lemeng.retail.day.backfill.json`，
   `params={BIZDAY: <day>}`。子管线 96 页扇出，产出一个天文件 + 一份镜像 + 一个封版标记。
2. **删被取代的小时对象**：交给 `delete-supplanted-hour-partitions.py`（**不在这里重复实现**）。
   它自带三条 fail-closed：已封版 / 天文件在 / `bizday < --before`；任一不满足就 SKIP 不删。
3. **逐日报账**：`DAY_OK` / `DAY_FAILED`，最后一行 `BACKFILL_DONE ok=… failed=…`。

## 为什么删必须跟在封版后面（实测，2026-10-20）

天文件与镜像同在**单 glob** `system_book=*/**/*.parquet` 的射程里（镜像那份是为了让审计层的
7 个 `audit_lemeng__retail__*` 看得见）。**小时文件还在**时，单 glob 会同时命中镜像与小时文件
⇒ 审计**双算**（实测 2026-10-20 15:34 那次 `ERROR=1`）。删掉当天小时文件后 15:39 立刻全绿。

## 用法（在**数据面机**上跑；宿主有 python3，控制台在 127.0.0.1:<port>）

  python3 scripts/lemeng/backfill-daily-partitions.py --from 2026-09-24 --to 2026-10-17
  …同上看计划（dry-run：只报哪天会被处理，不发请求、不删）…
  … --apply                                    # 真跑

  --books 3120,64188     默认两本
  --console-port 3120=18080,64188=18081   控制台端口（宿主映射）

⚠️ 删热分区那步要 S3 凭据，而**宿主上没有**（在 console 容器 env 里）⇒ 本脚本每次从 console
容器 `docker inspect` 现取 `LEMENG_ZOS_*` 注入子进程（2026-10-29 实测：不注入就恒 exit 2
`ENV_FAILED`，把已经落湖成功的一天记成 DAY_FAILED——假红比真红更费人）。

## 输出

  PLAN      day=<D> books=<…>（dry-run，未做任何事）
  DAY_START day=<D> book=<B>
  DAY_OK    day=<D> book=<B> ms=<N> hours_deleted=<N>
  DAY_FAILED day=<D> book=<B> reason=<…>
  DAY_SKIP  day=<D> book=<B> reason=not_closed | no_day_file
  BACKFILL_DONE ok=<N> failed=<N> skipped=<N>

退出码：0 全成功；1 有失败；2 参数/env 不合法。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
DELETE_TOOL = os.path.join(HERE, "delete-supplanted-hour-partitions.py")
BACKFILL_FILE = "pipelines/lemeng.retail.day.backfill.json"
RUN_TIMEOUT_S = 900
# `POST /api/run` 是**同步阻塞**的（整天回填 ~70s 才返回）。180s 在调度竞争/网关抖动下会把
# 「已经跑完并落湖」的一天判成 `submit: timed out` 并让整本账套停机（2026-10-29 实测：3120
# 09-20 记为失败，湖侧 13,788 行在）。⇒ 客户端给到 600s；真超时也先按 run 记录判真伪。
HTTP_TIMEOUT_S = 600
# submit 超时后的「判真伪」窗口：够跑到 run 记录出现终态即可，不必等满 RUN_TIMEOUT_S。
SUBMIT_RECOVERY_S = 300


def arg(name: str, default: str = "") -> str:
    if name in sys.argv:
        i = sys.argv.index(name)
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return default


def console_port(book: str) -> int:
    m = arg("--console-port", "3120=18080,64188=18081")
    for pair in m.split(","):
        b, _, p = pair.partition("=")
        if b.strip() == book:
            return int(p)
    raise SystemExit(f"ARGS_FAILED: --console-port 里没有 {book}")


def console_env(book: str) -> dict[str, str]:
    """console 容器的 env（运行时现取，不落盘、不进 argv）——与 recon-day-heal.sh 同一口径。"""
    ct = f"openship-platform-core-shanhai-data-lemeng-console-{book}"
    out = subprocess.run(
        ["docker", "inspect", ct, "--format", "{{range .Config.Env}}{{println .}}{{end}}"],
        capture_output=True, text=True, check=False,
    ).stdout
    env: dict[str, str] = {}
    for line in out.splitlines():
        k, sep, v = line.partition("=")
        if sep:
            env[k] = v
    return env


def console_token(book: str) -> str:
    env = console_env(book)
    tok = env.get("DUCKLE_TOKEN", "")
    if not tok:
        raise SystemExit(f"ENV_FAILED: 取不到 console-{book} 的 DUCKLE_TOKEN")
    return tok


# 删热分区那步要 S3 凭据。**宿主上没有这些变量**（它们在 console 容器里），
# 2026-10-29 实测：不注入 ⇒ `delete-supplanted-hour-partitions.py` 恒 exit 2（ENV_FAILED），
# 每天都被记成 DAY_FAILED——而数据其实已经落湖（run 本身 ok），是最误导人的那种假红。
S3_ENV_KEYS = (
    "ZOS_ACCESS_KEY", "ZOS_SECRET_KEY", "ZOS_ENDPOINT", "ZOS_REGION", "ZOS_BUCKET",
    "LEMENG_ZOS_ACCESS_KEY", "LEMENG_ZOS_SECRET", "LEMENG_ZOS_SECRET_KEY",
    "LEMENG_ZOS_ENDPOINT", "LEMENG_ZOS_REGION", "LEMENG_ZOS_BUCKET",
)


def delete_env(book: str) -> dict[str, str]:
    """子进程 env = 本进程 env + console 容器里的 S3 五键（工具侧已认 LEMENG_ZOS_* 别名）。"""
    env = dict(os.environ)
    ct_env = console_env(book)
    for k in S3_ENV_KEYS:
        if k in ct_env:
            env[k] = ct_env[k]
    return env


def api(book: str, method: str, path: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f"http://127.0.0.1:{console_port(book)}{path}", data=data, method=method,
        headers={"Authorization": "Bearer " + console_token(book), "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_S) as r:
        raw = r.read()
    return json.loads(raw) if raw else {}


def wait_run(book: str, since_iso: str, timeout_s: float | None = None) -> tuple[str, float]:
    """等这一本 console 上**新起的** day.backfill run 结束。返回 (status, 秒)。"""
    limit = RUN_TIMEOUT_S if timeout_s is None else timeout_s
    t0 = time.time()
    while time.time() - t0 < limit:
        time.sleep(10)
        try:
            runs = api(book, "GET", "/api/runs?limit=8").get("runs", [])
        except Exception:  # noqa: BLE001 — 取不到就继续等，超时算失败
            continue
        for r in runs:
            if r.get("id") != "lemeng.retail.day.backfill":
                continue
            if (r.get("at") or "") < since_iso:
                continue
            st = r.get("status")
            if st in ("ok", "error", "failed", "finished"):
                return st, time.time() - t0
    return "timeout", time.time() - t0


def main() -> int:
    frm, to = arg("--from"), arg("--to")
    if not (len(frm) == 10 and len(to) == 10):
        print("ARGS_FAILED: 需要 --from YYYY-MM-DD 与 --to YYYY-MM-DD（to 为排他上界）", file=sys.stderr)
        return 2
    books = [b for b in arg("--books", "3120,64188").split(",") if b]
    apply_ = "--apply" in sys.argv
    if not os.path.exists(DELETE_TOOL):
        print(f"ARGS_FAILED: 找不到 {DELETE_TOOL}（删那步复用它，不重复实现）", file=sys.stderr)
        return 2

    d0 = datetime.strptime(frm, "%Y-%m-%d").date()
    d1 = datetime.strptime(to, "%Y-%m-%d").date()
    if d0 >= d1:
        print("ARGS_FAILED: --from 必须早于 --to", file=sys.stderr)
        return 2
    today = datetime.now().date()          # 只处理**已闭窗**的日子（严格早于今天）
    ok = failed = skipped = 0
    cur = d0
    while cur < d1:
        day = cur.isoformat()
        if cur >= today:
            print(f"DAY_SKIP  day={day} book=- reason=not_closed")
            skipped += 1
            cur += timedelta(days=1)
            continue
        if not apply_:
            print(f"PLAN      day={day} books={','.join(books)}（dry-run，未做任何事）")
            cur += timedelta(days=1)
            continue
        for b in books:
            print(f"DAY_START day={day} book={b}")
            since = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S")
            submit_ok = True
            try:
                api(b, "POST", "/api/run", {"file": BACKFILL_FILE, "params": {"BIZDAY": day}})
            except Exception as e:  # noqa: BLE001
                # 超时 ≠ 失败：POST 是同步的，客户端先放弃时空服务端还在跑、还会落湖。
                # 转为「等 run 记录判真伪」，只有确实没有 ok 记录才判失败。
                submit_ok = False
                print(f"DAY_WARN day={day} book={b} submit:{e}（等 run 记录判真伪）")
            st, secs = wait_run(b, since, None if submit_ok else SUBMIT_RECOVERY_S)
            if not submit_ok and st == "timeout":
                print(f"DAY_FAILED day={day} book={b} reason=submit:{st} 且 {SUBMIT_RECOVERY_S}s 内无 run 记录")
                failed += 1
                continue
            if st != "ok":
                print(f"DAY_FAILED day={day} book={b} reason=run:{st} after {secs:.0f}s")
                failed += 1
                continue
            # 删该日被取代的小时对象——工具自带「已封版 + 天文件在 + 早于窗口」三条闸
            p = subprocess.run(
                [sys.executable, DELETE_TOOL, "--book", b, "--from", day,
                 "--before", (cur + timedelta(days=1)).isoformat(), "--apply"],
                capture_output=True, text=True, check=False, env=delete_env(b),
            )
            deleted = sum(int(x.split("objects=")[1]) for x in p.stdout.splitlines() if "DELETE_PLAN" in x)
            if p.returncode != 0:
                print(f"DAY_FAILED day={day} book={b} reason=delete rc={p.returncode} {p.stderr.strip()[:160]}")
                failed += 1
                continue
            print(f"DAY_OK    day={day} book={b} ms={secs*1000:.0f} hours_deleted={deleted}")
            ok += 1
        cur += timedelta(days=1)

    print(f"BACKFILL_DONE ok={ok} failed={failed} skipped={skipped}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
