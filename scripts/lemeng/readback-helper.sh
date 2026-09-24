#!/bin/sh
# readback-helper.sh — 回读 helper（**在 duckle 容器内执行**，由 run-retail-day.sh rb 挂载进来）
#
# 作用：把容器 env 里的 ZOS 五键拼成 DuckDB 的 S3 secret，再跑 $RB_QUERY。
# 为什么要这一层：DuckDB 的 CREATE SECRET 不接受 env 变量，而值又不许进命令行/日志 ⇒
# 让**容器内的 sh**在运行时展开（值只在容器进程内存里），SQL 里不出现字面量。
#
# 依赖 env: ZOS_ACCESS_KEY / ZOS_SECRET_KEY / ZOS_ENDPOINT / ZOS_REGION / RB_QUERY
set -u
printf "%s\n" \
  "CREATE SECRET zos_rb (TYPE S3, KEY_ID '$ZOS_ACCESS_KEY', SECRET '$ZOS_SECRET_KEY', ENDPOINT '$ZOS_ENDPOINT', URL_STYLE 'path', USE_SSL true, REGION '$ZOS_REGION'); $RB_QUERY" \
  > /tmp/rb.sql
duckdb < /tmp/rb.sql
