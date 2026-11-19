# deploy/artifacts/Dockerfile — 数据单元「只读产物」服务（#2518）
#
# 只是把 nginx 配置**烘进镜像**：openship services 模式不解析相对 bind 挂载
# （`./x` 会被当成命名卷名 ⇒ 建容器 400），所以配置不能靠挂载文件送进去。
# 官方 nginx 镜像自带 envsubst：`/etc/nginx/templates/*.template` 渲染到
# `/etc/nginx/conf.d/`，`${ARTIFACTS_TOKEN}` 在启动时替换（未定义的环境变量保持原样）。
FROM nginx:1.27-alpine

COPY deploy/artifacts/default.conf.template /etc/nginx/templates/default.conf.template
