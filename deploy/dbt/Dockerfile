# deploy/dbt/Dockerfile — dbt runner（postgres adapter 打 pg_duckdb 端点）。
# DBT_VERSION：2026-09-23 PyPI 实测钉 1.9.1（dbt-postgres 1.9 线只到 1.9.1；真机构建+parse+debug 已验证）。
FROM python:3.12-slim
ARG DBT_VERSION=1.9.1
# -i 走国内镜像：与 Dockerfile.server 的 npmmirror 同因（2026-09-23/24 两站实测）——
# RUN 步骤不继承 dockerd 代理，pip 直连 pypi.org 在境内构建容器里会被掐
# （`No matching distribution found` / `versions: none`）；经代理则 MITM 无 CA 校验不过。
# 镜像源是唯一同时满足「可达 + 快 + 不需要装 CA」的路（shanhai 真机实测 7s 建完）。
RUN pip install --no-cache-dir -i https://mirrors.aliyun.com/pypi/simple/ \
      --timeout 60 --retries 5 \
      "dbt-core==${DBT_VERSION}" "dbt-postgres==${DBT_VERSION}"
WORKDIR /usr/app
ENTRYPOINT ["dbt"]
