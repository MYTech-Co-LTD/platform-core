# deploy/dbt/Dockerfile — dbt runner（postgres adapter 打 pg_duckdb 端点）。
# ⚠️ DBT_VERSION 默认值待确认：layered §11 只有内存资源画像、未记 dbt 版本号——
# 待实测人确认（开工前置外部输入⑥：人给版本号，或确认默认 1.9.8），
# 拍板时以现场实际安装为准，确认后改掉本行注释。
FROM python:3.12-slim
ARG DBT_VERSION=1.9.8
RUN pip install --no-cache-dir "dbt-core==${DBT_VERSION}" "dbt-postgres==${DBT_VERSION}"
WORKDIR /usr/app
ENTRYPOINT ["dbt"]
