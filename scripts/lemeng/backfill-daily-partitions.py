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


def console_token(book: str) -> str:
    # 运行时从容器 env 现取（不落盘、不进 argv）——与 recon-day-heal.sh 同一口径
    ct = f"openship-platform-core-shanhai-data-lemeng-console-{book}"
    out = subprocess.run(
        ["docker", "inspect", ct, "--format", "{{range .Config.Env}}{{println .}}{{end}}"],
        capture_output=True, text=True, check=False,
    ).stdout
    for line in out.splitlines():
        if line.startswith("DUCKLE_TOKEN="):
            return line.split("=", 1)[1]
    raise SystemExit(f"ENV_FAILED: 取不到 {ct} 的 DUCKLE_TOKEN")


def api(book: str, method: str, path: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f"http://127.0.0.1:{console_port(book)}{path}", data=data, method=method,
        headers={"Authorization": "Bearer " + console_token(book), "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=180) as r:
        raw = r.read()
    return json.loads(raw) if raw else {}


def wait_run(book: str, since_iso: str) -> tuple[str, float]:
    """等这一本 console 上**新起的** day.backfill run 结束。返回 (status, 秒)。"""
    t0 = time.time()
    while time.time() - t0 < RUN_TIMEOUT_S:
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
            try:
                api(b, "POST", "/api/run", {"file": BACKFILL_FILE, "params": {"BIZDAY": day}})
            except Exception as e:  # noqa: BLE001
                print(f"DAY_FAILED day={day} book={b} reason=submit:{e}")
                failed += 1
                continue
            st, secs = wait_run(b, since)
            if st != "ok":
                print(f"DAY_FAILED day={day} book={b} reason=run:{st} after {secs:.0f}s")
                failed += 1
                continue
            # 删该日被取代的小时对象——工具自带「已封版 + 天文件在 + 早于窗口」三条闸
            p = subprocess.run(
                [sys.executable, DELETE_TOOL, "--book", b, "--from", day,
                 "--before", (cur + timedelta(days=1)).isoformat(), "--apply"],
                capture_output=True, text=True, check=False,
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
