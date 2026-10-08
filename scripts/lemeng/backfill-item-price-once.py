#!/usr/bin/env python3
# backfill-item-price-once.py — #499 价格批**首载**一次性脚本（R1 拍板的 H 段例外，2026-10-08）。
#
# ⚠️ 为什么不是管线（正典 §1.3 H「回填走同一条管线换时间窗」的**登记例外**）：
#   引擎 src.rest 的响应体上限（into_string 编译期默认，12.3MB 过 / 32.9MB 炸、不可配——
#   DUCKLE_* 无旋钮，runner 二进制 strings 全查）使「2 年窗全量」在**单店粒度**即可越限
#   （64188 branch116 = 35.9MB；3120 有 38 家大店）⇒ 管线无法承载首载。
#   而首载数据已在盘上：本脚本消费**测量循环的 /tmp/sz_<branch>.json 原始响应**（探针阶段
#   为测响应大小拉的全量，双账套 ~700MB），零新增网关调用。
#   日常增量走管线（lemeng.dim.item_price.l0*，请求侧水位）——影子通路只有这一次，不重复。
#
# 做什么：/tmp/sz_*.json（网关原始 VO）→ duckdb 契约同构整形（列 expr 与管线 shape 节点逐字
#   同源，31 列）→ COPY TO 's3://<ZOS_BUCKET>/lemeng/item_price/system_book=<账套>/bizday=<今日>/all.parquet'
#   （覆盖写 = 幂等，重跑同 key 覆盖）。整形后从内存清掉原始 JSON，不留第二事实源。
#
# 跑法（在**账套对应的 console 容器内**；env：LEMENG_TOKEN 不需要、ZOS_* 必须）：
#   python3 backfill-item-price-once.py <system_book>
# 退出码：0 = 写湖完成并回读行数 > 0；非 0 = 任何失败（fail-loud，不许静默半载）。
# ⚠️ ${VAR} 纪律不适用（python）；但输出里**永不回显任何密钥**。
import json
import subprocess
import sys
from datetime import datetime, timezone, timedelta

BOOK = sys.argv[1] if len(sys.argv) > 1 else ""
if not BOOK.isdigit():
    print("usage: backfill-item-price-once.py <system_book>")
    sys.exit(2)
BUCKET = __import__("os").environ.get("ZOS_BUCKET", "")
ENDPOINT = __import__("os").environ.get("ZOS_ENDPOINT", "")
REGION = __import__("os").environ.get("ZOS_REGION", "")
AK = __import__("os").environ.get("ZOS_ACCESS_KEY", "")
SK = __import__("os").environ.get("ZOS_SECRET_KEY", "")
if not all([BUCKET, ENDPOINT, REGION, AK, SK]):
    print("BACKFILL_FAILED:env 缺 ZOS_*")
    sys.exit(3)

# 采集日 = Asia/Shanghai 今日（与管线 ${date+8h} 同口径）
CST = timezone(timedelta(hours=8))
BIZDAY = datetime.now(CST).strftime("%Y-%m-%d")
TS = datetime.now(CST).strftime("%Y%m%dT%H%M%S")
KEY = f"lemeng/item_price/system_book={BOOK}/bizday={BIZDAY}/all.parquet"

# 契约 31 列的整形（与管线 shape 节点逐字同源；行来源 = 原始 VO 文件）
SHAPE_SQL = f"""
CREATE OR REPLACE VIEW shape AS
SELECT
  'dim-' || '{BOOK}' || '-item_price-backfill-{TS}Z' AS batch_id,
  '{BOOK}' AS system_book,
  DATE '{BIZDAY}' AS bizday,
  CAST(o.branch_num AS INTEGER) AS branch_num,
  json_extract_string(CAST(o.branch AS JSON), '$.branch_code') AS branch_code,
  json_extract_string(CAST(o.branch AS JSON), '$.branch_name') AS branch_name,
  CAST(json_extract_string(CAST(o.branch AS JSON), '$.branch_matrix_price_actived') AS BOOLEAN) AS branch_matrix_price_actived,
  CAST(o.item_num AS BIGINT) AS item_num,
  CAST(o.item_grade_num AS BIGINT) AS item_grade_num,
  json_extract_string(CAST(o.pos_variant AS JSON), '$.item_code') AS item_code,
  json_extract_string(CAST(o.pos_variant AS JSON), '$.item_barcode') AS bar_code,
  json_extract_string(CAST(o.pos_variant AS JSON), '$.item_name') AS item_name,
  json_extract_string(CAST(o.pos_variant AS JSON), '$.spec_num') AS spec_num,
  json_extract_string(CAST(o.pos_variant AS JSON), '$.spec_unit') AS spec_unit,
  CAST(json_extract_string(CAST(o.pos_variant AS JSON), '$.spec_rate') AS DECIMAL(18,8)) AS spec_rate,
  json_extract_string(CAST(o.pos_variant AS JSON), '$.item_unit') AS item_unit,
  json_extract_string(CAST(o.pos_variant AS JSON), '$.item_category') AS item_category,
  json_extract_string(CAST(o.pos_variant AS JSON), '$.item_department') AS item_department,
  CAST(o.last_edit_time AS VARCHAR) AS last_edit_time,
  CAST(o.branch_item_regular_price AS DECIMAL(18,8)) AS regular_price,
  CAST(o.branch_item_level2_price AS DECIMAL(18,8)) AS level2_price,
  CAST(o.branch_item_level3_price AS DECIMAL(18,8)) AS level3_price,
  CAST(o.branch_item_level4_price AS DECIMAL(18,8)) AS level4_price,
  CAST(o.branch_item_max_price AS DECIMAL(18,8)) AS max_price,
  CAST(o.branch_item_min_price AS DECIMAL(18,8)) AS min_price,
  CAST(o.branch_item_regular_real_price AS DECIMAL(18,8)) AS regular_real_price,
  CAST(o.branch_item_level2_real_price AS DECIMAL(18,8)) AS level2_real_price,
  CAST(o.branch_item_level3_real_price AS DECIMAL(18,8)) AS level3_real_price,
  CAST(o.branch_item_level4_real_price AS DECIMAL(18,8)) AS level4_real_price,
  CAST(o.branch_item_max_real_price AS DECIMAL(18,8)) AS max_real_price,
  CAST(o.branch_item_min_real_price AS DECIMAL(18,8)) AS min_real_price
FROM read_json('/tmp/sz_*.json', format='auto', maximum_object_size=67108864) raw,
     (SELECT unnest(raw.result) AS o) ;
"""

# 归一 endpoint：duckdb 要 host[:port]，不带 scheme
ep = ENDPOINT.replace("https://", "").replace("http://", "").rstrip("/")
use_ssl = "true" if ENDPOINT.startswith("https://") else "false"

SQL = f"""
INSTALL httpfs; LOAD httpfs;
SET s3_endpoint='{ep}';
SET s3_region='{REGION}';
SET s3_access_key_id='{AK}';
SET s3_secret_access_key='{SK}';
SET s3_url_style='path';
SET s3_use_ssl={use_ssl};
{SHAPE_SQL}
COPY (SELECT * FROM shape) TO 's3://{BUCKET}/{KEY}' (FORMAT PARQUET, COMPRESSION zstd);
COPY (SELECT count(*) AS n FROM shape) TO '/dev/stdout' (FORMAT CSV, HEADER 0);
"""

proc = subprocess.run(
    ["/usr/local/bin/duckdb", "-c", SQL], capture_output=True, text=True, timeout=900,
)
if proc.returncode != 0:
    print("BACKFILL_FAILED:duckdb 非零退出")
    print(proc.stderr[-2000:])
    sys.exit(1)
rows = proc.stdout.strip().splitlines()[-1] if proc.stdout.strip() else "0"
if rows == "0":
    print("BACKFILL_FAILED:0 行——/tmp/sz_*.json 不在或为空？")
    sys.exit(1)
print(f"BACKFILL_OK book={BOOK} bizday={BIZDAY} rows={rows} key={KEY}")
