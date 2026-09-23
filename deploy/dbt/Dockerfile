# deploy/dbt/Dockerfile — dbt runner（postgres adapter 打 pg_duckdb 端点）。
# DBT_VERSION：2026-09-23 PyPI 实测钉 1.9.1（dbt-postgres 1.9 线只到 1.9.1；真机构建+parse+debug 已验证）。
FROM python:3.12-slim
ARG DBT_VERSION=1.9.1
RUN pip install --no-cache-dir "dbt-core==${DBT_VERSION}" "dbt-postgres==${DBT_VERSION}"
WORKDIR /usr/app
ENTRYPOINT ["dbt"]
