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
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import date, timedelta

# 数据面化（#2590）：原来靠 `docker exec` 进 pg_duckdb 容器取 env + 跑 psql ⇒ **只能跑在宿主**。
# 现在走 DSN（调度器容器里是 DATA_WAREHOUSE_URL），因此可以进平台调度器（data.zero_row_check）。
DSN_ENV = ("ZERO_ROW_DSN", "DATA_WAREHOUSE_URL")
BUCKET = os.environ.get("LEMENG_ZOS_BUCKET") or "shanhai-data"
# 判红投递：容器内用 OO_BASE/OO_ORG/OO_AUTH（摄取凭据）；宿主机用这个 env 文件（同 scorecard-alert.py）。
ENV_FILE = os.environ.get("PROBE_ENV_FILE", "/etc/openobserve-ingest.env")
STREAM = "data_plane_probes"

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


def dsn() -> str:
    for k in DSN_ENV:
        v = os.environ.get(k, "").strip()
        if v:
            return v
    raise RuntimeError("缺 DSN（%s 任一）——数据面化后不再从 docker inspect 取凭据" % " / ".join(DSN_ENV))


def psql(sql: str) -> tuple[str, str]:
    """返回 (stdout, 错误摘要)；错误摘要非空 ⇒ 调用方必须 fail-loud。

    ⚠️ 2026-11-06 初版教训：查询写错（`select duckdb.query(...)` 必须放进 FROM）时
    psql 只往 stderr 报 ERROR，而初版只取 stdout ⇒ 每个数据集都「基线无数据」被 continue 跳过
    ⇒ **巡检在真断供上打了 ZERO_ROW_OK**。巡检自己假绿，比没有巡检更危险。
    """
    p = subprocess.run(
        ["psql", dsn(), "-tA", "-v", "ON_ERROR_STOP=1", "-f", "-"],
        input=sql, capture_output=True, text=True, check=False,
    )
    blob = (p.stderr or "") + (p.stdout or "")
    err = ""
    for line in blob.splitlines():
        if "ERROR" in line or "FATAL" in line:
            err = line.strip()[:300]
            break
    return p.stdout, err


def month_globs(prefix: str, book: str, days: list[str]) -> dict[str, list[str]]:
    """把窗口按「年-月」分组，返回 month → 该月 glob 列表（每月一条）。

    为什么要按月而不是按天拼 glob（2026-11-06 第三次踩坑）：
    `parquet_file_metadata([<多天 glob>])` 里**只要有一天没分区**，整条查询直接
    `IO Error: No files found` ⇒ 全窗口被判「无数据」⇒ 断供日被吞掉 ⇒ **假绿**。
    按月 glob（`bizday=2026-11-*`）只在该月整体没有文件时才报错，粒度可控。
    """
    by_month: dict[str, list[str]] = {}
    for d in days:
        by_month.setdefault(d[:7], []).append(d)
    return {
        m: ["s3://%s/%s/system_book=%s/bizday=%s-*/*.parquet" % (BUCKET, prefix, book, m)]
        for m in by_month
    }


def day_rows(prefix: str, book: str, days: list[str]) -> dict[str, int]:
    """一天一行：该账套该数据集在这几天各自的行数（分区不存在记 -1）。"""
    got: dict[str, int] = {}
    want = set(days)
    for month, globs in month_globs(prefix, book, days).items():
        sql = (
            "select * from duckdb.query($$ select regexp_extract(file_name,'bizday=([0-9-]+)',1) d,"
            " coalesce(sum(num_rows),0) n from parquet_file_metadata([%s])"
            " group by 1 order by 1 $$);\n" % ",".join("'%s'" % g for g in globs)
        )
        out, err = psql(sql)
        if err:
            if "No files found" in err:
                continue  # 整月无分区：该月全记 -1
            raise RuntimeError(err)
        for line in out.splitlines():
            parts = line.strip().split("|")
            if len(parts) == 2 and parts[0][:2] == "20" and parts[1].lstrip("-").isdigit():
                got[parts[0]] = int(parts[1])
    return {d: got.get(d, -1) if d in want else -1 for d in days}


def _oo_env() -> dict:
    """OO 摄取凭据：容器内走进程 env（OO_BASE/OO_ORG/OO_AUTH），宿主走 env 文件。

    容器里那份 OO_AUTH 是**摄取凭据**（只写）——本脚本只需要写流，正好匹配；
    读端点会 401，那是正常表现（见 WeKnora「平台调度器容器能接哪些 job」）。
    """
    env = {k: os.environ.get(k, "") for k in ("OO_BASE", "OO_ORG", "OO_AUTH")}
    if all(env.values()):
        return env
    try:
        with open(ENV_FILE, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                env.setdefault(k.strip(), "")
                if not env[k.strip()]:
                    env[k.strip()] = v.strip().strip('"').strip("'")
    except OSError:
        pass
    return env


def emit(rows: list[dict]) -> int:
    """把判红行投进 `data_plane_probes`（逐行 POST）。返回失败条数——投递失败不改变判定结论。"""
    env = _oo_env()
    if not all(env.get(k) for k in ("OO_BASE", "OO_ORG", "OO_AUTH")):
        print("ZERO_ROW_EMIT_SKIPPED: 缺 OO_BASE/OO_ORG/OO_AUTH（判红结论仍然有效，只是没进预警面）",
              file=sys.stderr)
        return len(rows)
    url = "%s/api/%s/%s/_json" % (env["OO_BASE"].rstrip("/"), env["OO_ORG"], STREAM)
    failed = 0
    for row in rows:
        req = urllib.request.Request(
            url,
            data=json.dumps(row, ensure_ascii=False).encode("utf-8"),
            headers={"Authorization": "Basic %s" % env["OO_AUTH"], "Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                body = resp.read().decode("utf-8", "replace")
            ok = '"successful":1' in body
        except (urllib.error.URLError, OSError) as e:
            ok = False
            print("ZERO_ROW_EMIT_FAILED %s: %s" % (row.get("check"), e), file=sys.stderr)
        if not ok:
            failed += 1
        else:
            print("ZERO_ROW_EMITTED check=%s verdict=%s" % (row.get("check"), row.get("verdict")))
    return failed


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=3, help="最近几天连续为 0 判异常")
    ap.add_argument("--baseline", type=int, default=30, help="基线回看天数")
    ap.add_argument("--books", default="3120,64188")
    a = ap.parse_args()
    books = [b for b in a.books.split(",") if b]

    try:
        dsn()  # 早失败：缺 DSN 就别跑下去（下面每条查询都会用到）
    except RuntimeError as e:
        print("ZERO_ROW_DEP_FAILED: %s" % e, file=sys.stderr)
        return 2

    # 截止日取「昨天」（今天的分区可能还没发布，不参与判定）
    end = date.today() - timedelta(days=1)
    span = max(a.days, 7)   # 稀疏数据集用 7 天窗口
    recent = [(end - timedelta(days=i)).isoformat() for i in range(span - 1, -1, -1)]
    base = [(end - timedelta(days=i)).isoformat() for i in range(span, span + a.baseline)]

    bad = 0
    checked = 0
    alerts: list[dict] = []
    for name, prefix in DATASETS.items():
        for book in books:
            try:
                r = day_rows(prefix, book, recent)
                b = day_rows(prefix, book, base)
            except RuntimeError as e:  # 查询失败必须响亮，不许当作「没数据」
                print("ZERO_ROW_DEP_FAILED dataset=%s book=%s reason=%s" % (name, book, e),
                      file=sys.stderr)
                return 2
            checked += 1
            # 基线判据：有过数据（至少一半的日子 > 0 行）
            base_days = [d for d in b if b[d] > 0]
            if len(base_days) < max(1, len(base) // 2):
                continue  # 本来就没数据（如业务无退货），不报
            # 稀疏数据集（客户费用/报损这类事件驱动的）基线覆盖率天然低，
            # 连续 3 天 0 行可能只是「真没单」⇒ 阈值提到 7 天；密集数据集维持 3 天。
            need = a.days if len(base_days) >= (len(base) * 9 // 10) else max(7, a.days)
            if len(recent) < need:
                continue
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
                alerts.append({
                    "probe": "zero-row",
                    "check": "zero_row:%s:%s" % (name, book),
                    "verdict": "ERR",
                    "mode": "advisory",
                    "detail": ("zero_days=%s missing_days=%s baseline=%d/%d "
                               "hint=请求字段被拒(10001) 或 响应字段改名(契约拒写)")
                              % (",".join(zeros), ",".join(missing) or "-", len(base_days), len(base)),
                })

    if bad == 0:
        print("ZERO_ROW_OK 检查 %d 个 (数据集×账套)，近 %d 天均有数据" % (checked, a.days))
        return 0
    # 判红 ⇒ 进预警面（OO `data_plane_probes` → 桥 → 企微）。投递失败**不改判定**：
    # 巡检的结论仍然是「断了」，只是没进 OO——所以下面照样返回 1，并把投递失败打到 stderr。
    emit(alerts)
    return 1


if __name__ == "__main__":
    sys.exit(main())
