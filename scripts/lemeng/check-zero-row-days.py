#!/usr/bin/env python3
"""check-zero-row-days.py — 日更件「静默 0 行」巡检。

## 为什么有这个（2026-11-06 实测教训）

乐檬接口改版会以**两种都不报警**的方式打断采集：

1. **请求字段改版**：网关回 `10001`，管线走空集路径、`die_empty` 不报错
   ⇒ 写出 **0 行 parquet，`status: ok`**（调拨 3120 自 2026-11-02 起 5 天没人发现）。
2. **响应字段改名**：拿到数据但投影按旧字段取 ⇒ 全 NULL ⇒ 契约闸拒写
   （run 红，但没人盯日更件的红）。

两种都**不能靠「run 绿」或「文件在」发现**。本脚本按**行数**判：

    · 近 N 天（默认 3）该数据集**每天都是 0 行**
    · 且此前 30 天**有数据**（至少有 50% 的日子 > 0 行）

⇒ 判「最近断了」，退出码 1，并打印可 grep 的 `ZERO_ROW_STREAK`。
基线没数据（如 `wholesale_return` 业务本身无退货）**不报**，避免长期噪声。

## 通道

读湖走 **pg_duckdb**（实例内已配 S3 secret，免凭据，通道 B）——与 `backfill-history.py`
的 `lake_rows` 同一手法；不碰 console 的密文连接文件（正典：裸 duckdb 拿密文当明文恒失败）。

## 用法（数据面机宿主）

    python3 /opt/lemeng-check-zero-row-rows.py [--days 3] [--baseline 30] [--books 3120,64188]

退出码：0 = 无异常；1 = 至少一个数据集命中「最近连续 0 行」；2 = 依赖不可用。
可 grep 字面量：`ZERO_ROW_STREAK` / `ZERO_ROW_DEP_FAILED` / `ZERO_ROW_OK`
"""
import argparse
import subprocess
import sys
from datetime import date, timedelta

PG_CT = "openship-platform-core-shanhai-data-pg_duckdb"
BUCKET = "shanhai-data"

# 日更数据集 → 湖前缀（都是 `lemeng/<prefix>/system_book=<b>/bizday=<d>/`）
DATASETS = {
    "branch_expense": "lemeng/branch_expense",
    "branch_indicator": "lemeng/branch_indicator",
    "client_expense": "lemeng/client_expense",
    "customer_analysis": "lemeng/customer_analysis",
    "item_purchase": "lemeng/item_purchase",
    "item_sales": "lemeng/item_sales",
    "item_profit": "lemeng/item_profit",
    "loss_adjustment": "lemeng/loss_adjustment",
    "member_summary": "lemeng/member_summary",
    "request_order": "lemeng/request_order",
    "saler_commission": "lemeng/saler_commission",
    "transfer_in": "lemeng/transfer_in",
    "transfer_out": "lemeng/transfer_out",
    "wholesale_out": "lemeng/wholesale_out",
    "wholesale_return": "lemeng/wholesale_return",
    "inventory_movement": "lemeng/inventory_movement",
    "inventory_snapshot": "lemeng/inventory_snapshot",
}


def pg_env() -> dict:
    out = subprocess.run(
        ["docker", "inspect", PG_CT, "--format", "{{range .Config.Env}}{{println .}}{{end}}"],
        capture_output=True, text=True, check=False,
    ).stdout
    env = {}
    for line in out.splitlines():
        k, sep, v = line.partition("=")
        if sep:
            env[k] = v
    return env


def psql(sql: str, env: dict) -> tuple[str, str]:
    """返回 (stdout, 错误摘要)；错误摘要非空 ⇒ 调用方必须 fail-loud。

    ⚠️ 2026-11-06 初版教训：查询写错（`select duckdb.query(...)` 必须放进 FROM）时
    psql 只往 stderr 报 ERROR，而初版只取 stdout ⇒ 每个数据集都「基线无数据」被 continue 跳过
    ⇒ **巡检在真断供上打了 ZERO_ROW_OK**。巡检自己假绿，比没有巡检更危险。
    """
    p = subprocess.run(
        ["docker", "exec", "-i", "-e", "PGPASSWORD=" + env.get("PGDUCK_PASSWORD", ""),
         PG_CT, "psql", "-U", env.get("PGDUCK_USER", "platform"),
         "-d", env.get("PGDUCK_DB", "warehouse"), "-tA", "-f", "-"],
        input=sql, capture_output=True, text=True, check=False,
    )
    blob = (p.stderr or "") + (p.stdout or "")
    err = ""
    for line in blob.splitlines():
        if "ERROR" in line or "FATAL" in line:
            err = line.strip()[:300]
            break
    return p.stdout, err


def day_rows(prefix: str, book: str, days: list[str], env: dict) -> dict[str, int]:
    """一天一行：该账套该数据集在这几天各自的行数（缺失记 -1）。"""
    globs = ",".join(
        f"'s3://{BUCKET}/{prefix}/system_book={book}/bizday={d}/*.parquet'" for d in days
    )
    sql = (
        "select * from duckdb.query($$ select regexp_extract(file_name,'bizday=([0-9-]+)',1) d,"
        " coalesce(sum(num_rows),0) n from parquet_file_metadata([%s])"
        " group by 1 order by 1 $$);\n" % globs
    )
    out, err = psql(sql, env)
    if err:
        # 「该窗口内一个文件都没有」= 合法缺分区（发布滞后 / 当天还没采），按空集处理；
        # 其余错误（连接、权限、SQL 写错）才是依赖故障，必须响亮。
        if "No files found" in err:
            return {d: -1 for d in days}
        raise RuntimeError(err)
    got: dict[str, int] = {}
    for line in out.splitlines():
        parts = line.strip().split("|")
        if len(parts) == 2 and parts[0][:2] == "20" and parts[1].lstrip("-").isdigit():
            got[parts[0]] = int(parts[1])
    return {d: got.get(d, -1) for d in days}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=3, help="最近几天连续为 0 判异常")
    ap.add_argument("--baseline", type=int, default=30, help="基线回看天数")
    ap.add_argument("--books", default="3120,64188")
    a = ap.parse_args()
    books = [b for b in a.books.split(",") if b]

    env = pg_env()
    if not env:
        print("ZERO_ROW_DEP_FAILED: 读不到 pg_duckdb 的 env（容器不在？）", file=sys.stderr)
        return 2

    # 截止日取「昨天」（今天的分区可能还没发布，不参与判定）
    end = date.today() - timedelta(days=1)
    recent = [(end - timedelta(days=i)).isoformat() for i in range(a.days - 1, -1, -1)]
    base = [(end - timedelta(days=i)).isoformat() for i in range(a.days, a.days + a.baseline)]

    bad = 0
    checked = 0
    for name, prefix in DATASETS.items():
        for book in books:
            try:
                r = day_rows(prefix, book, recent, env)
                b = day_rows(prefix, book, base, env)
            except RuntimeError as e:  # 查询失败必须响亮，不许当作「没数据」
                print("ZERO_ROW_DEP_FAILED dataset=%s book=%s reason=%s" % (name, book, e),
                      file=sys.stderr)
                return 2
            checked += 1
            # 基线判据：有过数据（至少一半的日子 > 0 行）
            base_days = [d for d in b if b[d] > 0]
            if len(base_days) < max(1, len(base) // 2):
                continue  # 本来就没数据（如业务无退货），不报
            zeros = [d for d in recent if r.get(d, -1) == 0]
            missing = [d for d in recent if r.get(d, -1) < 0]
            # 断供判据：窗口内**有分区的天全都 0 行**，且这些天 + 缺分区的天覆盖整个窗口。
            # 只缺分区（一个分区都没有）= 发布滞后 / 还没采，**不报**（避免每天误报 T-1）。
            if zeros and (len(zeros) + len(missing)) == len(recent):
                bad += 1
                print(
                    "ZERO_ROW_STREAK dataset=%s book=%s zero_days=%s missing_days=%s"
                    " baseline_days_with_data=%d/%d"
                    " hint=查该管线 run 记录：请求字段被拒(10001) 或 响应字段改名(契约拒写)"
                    % (name, book, ",".join(zeros), ",".join(missing) or "-",
                       len(base_days), len(base))
                )

    if bad == 0:
        print("ZERO_ROW_OK 检查 %d 个 (数据集×账套)，近 %d 天均有数据" % (checked, a.days))
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
