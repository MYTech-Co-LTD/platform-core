#!/usr/bin/env python3
"""backfill-history.py — 通用历史回填驱动（handbook §1.3 阶段 H；issue #1160）。

## 它驱动什么

对某个数据集的 `${BIZDAY}` 回填变体，**逐日**调 console 的 `POST /api/run`，串行推进，
每天落一条台账并**回读湖侧行数**。默认**从新往旧**走（用户 2026-10-29 裁决），
每天成功才推前一天——准确性优先，不并发。

零售明细不归本脚本：它还要封版 + 删被取代的小时分区，走 `backfill-daily-partitions.py`
（同目录，2026-10-20 起是那条链的既有执行面）。

## 为什么每天要回读湖侧

`run` 的 `rows` 是**父管线最后一条 sink 的行数**，不是这一天的数据量（实测 2026-10-29：
retail day 回填 `rows=4`，而湖侧 16,522 行）。只信 run 状态 = 把「跑完了」当「数据在」。
回读走 pg_duckdb 容器里的 psql（宿主没有 psql 客户端），每次现建 S3 secret、查完即弃。

## 用法（在**数据面机**上跑）

    python3 scripts/lemeng/backfill-history.py --dataset inventory_snapshot \\
        --books 3120,64188 --from 2024-10-01 --to 2026-10-25 --apply

    --direction desc|asc     默认 desc（从新往旧）
    --max-days N             只跑最近 N 天（灰度/试跑用）
    --allow-empty            空日不算失败（源侧确实可能整天零单；默认要求 >0 行）

字面量：`BF_DAY_OK day=… book=… rows=… secs=…` / `BF_DAY_EMPTY …` / `BF_DAY_FAILED … reason=…`
      / `BF_DONE ok=… empty=… failed=…`。退出码 0=全成功；1=有失败；2=参数错。

## 环境

宿主无 python 依赖；`docker` 可用（取 console token 与回读湖都靠它）。
S3 五键同样从 console 容器 env 现取（`LEMENG_ZOS_*`），不落盘、不进 argv。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.request
from datetime import date, datetime, timedelta, timezone

CONSOLE_CT = "openship-platform-core-shanhai-data-lemeng-console-{book}"
PG_CT = "openship-platform-core-shanhai-data-pg_duckdb"
CONSOLE_PORT = {"3120": 18080, "64188": 18081}
RUN_TIMEOUT_S = 3600
LEDGER_DIR = "/tmp/lemeng-backfill"

# dataset → (管线 id 模板, 湖前缀)；管线 id 用 {book} 占位。
# ⚠️ 只列**有 ${BIZDAY} 变体**的数据集；retail 走 backfill-daily-partitions.py。
DATASETS: dict[str, tuple[str, str]] = {
    "inventory_snapshot": ("lemeng.inventory.snapshot.backfill.{book}", "lemeng/inventory_snapshot"),
    "branch_expense": ("lemeng.branch.expense.backfill.{book}", "lemeng/branch_expense"),
    "loss_adjustment": ("lemeng.loss.adjustment.backfill.{book}", "lemeng/loss_adjustment"),
    "request_order": ("lemeng.request.order.backfill.{book}", "lemeng/request_order"),
    "item_purchase": ("lemeng.purchase.analysis.backfill.{book}", "lemeng/item_purchase"),
    "transfer_in": ("lemeng.transfer.in.backfill.3120", "lemeng/transfer_in"),
    "transfer_out": ("lemeng.transfer.out.backfill.3120", "lemeng/transfer_out"),
    "wholesale_out": ("lemeng.wholesale.out.backfill.3120", "lemeng/wholesale_out"),
    "client_expense": ("lemeng.client.expense.backfill.{book}", "lemeng/client_expense"),
    "member_summary": ("lemeng.member.summary.backfill.{book}", "lemeng/member_summary"),
    "branch_indicator": ("lemeng.branch_indicator.backfill.{book}", "lemeng/branch_indicator"),
}


def arg(name: str, default: str = "") -> str:
    if name in sys.argv:
        i = sys.argv.index(name)
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return default


def container_env(book: str) -> dict[str, str]:
    out = subprocess.run(
        ["docker", "inspect", CONSOLE_CT.format(book=book), "--format",
         "{{range .Config.Env}}{{println .}}{{end}}"],
        capture_output=True, text=True, check=False,
    ).stdout
    env: dict[str, str] = {}
    for line in out.splitlines():
        k, sep, v = line.partition("=")
        if sep:
            env[k] = v
    return env


def api(book: str, method: str, path: str, body: dict | None = None) -> dict:
    tok = container_env(book).get("DUCKLE_TOKEN", "")
    if not tok:
        raise SystemExit(f"ENV_FAILED: console-{book} 没有 DUCKLE_TOKEN")
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f"http://127.0.0.1:{CONSOLE_PORT[book]}{path}", data=data, method=method,
        headers={"Authorization": "Bearer " + tok, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=180) as r:
        raw = r.read()
    return json.loads(raw) if raw else {}


def wait_run(book: str, pipeline: str, since_iso: str) -> tuple[str, float]:
    t0 = time.time()
    while time.time() - t0 < RUN_TIMEOUT_S:
        time.sleep(5)
        try:
            runs = api(book, "GET", "/api/runs?limit=200").get("runs", [])
        except Exception:  # noqa: BLE001 —— 取不到就继续等，超时算失败
            continue
        for r in runs:
            if r.get("id") != pipeline or (r.get("at") or "") < since_iso:
                continue
            st = r.get("status")
            if st in ("ok", "error", "failed", "finished"):
                return st, time.time() - t0
    return "timeout", time.time() - t0


def lake_rows(book: str, prefix: str, bizday: str) -> int:
    """回读湖侧该日行数（-1 = 读不了/分区不存在）。SQL 走 stdin，凭据不进 argv。"""
    env = container_env(book)
    bucket = env.get("LEMENG_ZOS_BUCKET") or env.get("ZOS_BUCKET") or ""
    if not bucket:
        return -1
    pg = subprocess.run(
        ["docker", "inspect", PG_CT, "--format", "{{range .Config.Env}}{{println .}}{{end}}"],
        capture_output=True, text=True, check=False,
    ).stdout
    pgenv: dict[str, str] = {}
    for line in pg.splitlines():
        k, sep, v = line.partition("=")
        if sep:
            pgenv[k] = v
    glob = f"s3://{bucket}/{prefix}/system_book={book}/bizday={bizday}/**/*.parquet"
    sql = (
        "select duckdb.create_simple_secret('s3','%s','%s','','%s','path','','%s','','','true');\n"
        % (
            env.get("LEMENG_ZOS_ACCESS_KEY", ""), env.get("LEMENG_ZOS_SECRET", ""),
            env.get("LEMENG_ZOS_REGION", ""), env.get("LEMENG_ZOS_ENDPOINT", ""),
        )
        + f"select * from duckdb.query($$select count(*) n from read_parquet('{glob}')$$);\n"
    )
    p = subprocess.run(
        ["docker", "exec", "-i", "-e", "PGPASSWORD=" + pgenv.get("PGDUCK_PASSWORD", ""),
         PG_CT, "psql", "-U", pgenv.get("PGDUCK_USER", "postgres"),
         "-d", pgenv.get("PGDUCK_DB", "postgres"), "-tA", "-f", "-"],
        input=sql, capture_output=True, text=True, check=False,
    )
    for line in p.stdout.splitlines():
        line = line.strip()
        if line.isdigit():
            return int(line)
    return -1


def main() -> int:
    ds = arg("--dataset")
    if ds not in DATASETS:
        print(f"ARGS_FAILED: --dataset 只认 {sorted(DATASETS)}", file=sys.stderr)
        return 2
    books = [b for b in arg("--books", "3120").split(",") if b]
    frm, to = arg("--from"), arg("--to")
    if not (len(frm) == 10 and len(to) == 10):
        print("ARGS_FAILED: 需要 --from / --to（YYYY-MM-DD，to 为排他上界）", file=sys.stderr)
        return 2
    apply_ = "--apply" in sys.argv
    allow_empty = "--allow-empty" in sys.argv
    direction = arg("--direction", "desc")
    max_days = int(arg("--max-days", "0") or 0)
    tpl, prefix = DATASETS[ds]

    d0 = datetime.strptime(frm, "%Y-%m-%d").date()
    d1 = datetime.strptime(to, "%Y-%m-%d").date()
    if d0 >= d1:
        print("ARGS_FAILED: --from 必须早于 --to", file=sys.stderr)
        return 2
    today = datetime.now().date()
    days: list[date] = []
    cur = d1 - timedelta(days=1)
    while cur >= d0:
        if cur < today:  # 只碰已闭窗
            days.append(cur)
        cur -= timedelta(days=1)
    if direction == "asc":
        days.reverse()
    if max_days > 0:
        days = days[:max_days]

    os.makedirs(LEDGER_DIR, exist_ok=True)
    ok = empty = failed = 0
    for b in books:
        pipeline = tpl.format(book=b)
        ledger = open(f"{LEDGER_DIR}/{ds}-{b}.jsonl", "a")
        for d in days:
            day = d.isoformat()
            if not apply_:
                print(f"BF_PLAN day={day} book={b} pipeline={pipeline}")
                continue
            since = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
            try:
                api(b, "POST", "/api/run", {"file": f"pipelines/{pipeline}.json", "params": {"BIZDAY": day}})
            except Exception as e:  # noqa: BLE001
                print(f"BF_DAY_FAILED day={day} book={b} reason=submit:{e}")
                failed += 1
                break
            st, secs = wait_run(b, pipeline, since)
            rows = lake_rows(b, prefix, day) if st == "ok" else -1
            rec = {"day": day, "book": b, "pipeline": pipeline, "status": st,
                   "secs": round(secs, 1), "rows": rows}
            ledger.write(json.dumps(rec, ensure_ascii=False) + "\n")
            ledger.flush()
            if st != "ok":
                print(f"BF_DAY_FAILED day={day} book={b} reason=run:{st} secs={secs:.0f}")
                failed += 1
                break  # 准确性优先：一天失败就停，不带病往前
            if rows <= 0 and not allow_empty:
                print(f"BF_DAY_EMPTY day={day} book={b} rows={rows} secs={secs:.0f}"
                      "（源侧可能真零单：核过后用 --allow-empty 重跑该段）")
                empty += 1
                break
            print(f"BF_DAY_OK day={day} book={b} rows={rows} secs={secs:.0f}")
            ok += 1
    print(f"BF_DONE ok={ok} empty={empty} failed={failed}")
    return 0 if failed == 0 and empty == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
