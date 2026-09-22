#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# deploy/duckle/entrypoint.sh — duckle headless runner 的容器入口
#
# 这个脚本只做三件事，都不含业务逻辑：
#   ① 把 token 从「编排声明的名字」翻成「引擎真正读的名字」（两个名字不一样，见下）；
#   ② 在「会开控制台面、或会跑管线」而 token 为空时**拒跑**（exit 1）；
#   ③ exec 引擎本体，让信号 / 退出码 / stdio 与直接调用它完全一致。
#
# ── 为什么需要 ②（而不是靠引擎自己兜） ──────────────────────────────────────
# 引擎的控制台安全模型（`duckle-runner serve --help` 原文，从 v0.7.3 二进制提取）：
#
#     On 127.0.0.1 with no accounts the console is open, because reaching it
#     means already being on the machine. On any other --host with no credential
#     it starts UNCLAIMED: for 15 minutes anyone who can reach it can claim
#     it and become its administrator.
#
# 即：**绑回环**→无凭据也安全；**绑非回环且无凭据**→15 分钟认领窗。引擎只在
# 「凭据已设置但为空」时主动拒起（二进制字符串实测：
# 「Refusing to start rather than opening an administrator claim window.」）；
# 凭据**整个未设置**时它走的是上面那条 UNCLAIMED 分支。
# ⇒ 「未设置」就是缺口，本脚本堵的就是它。
#
# 安全闸**不放 compose 的 `:?`**：`:?` 会让「没配 token」的部署连无关服务的 up 都起不来
# （T3 compose 注释已言明同一取舍）。闸放在入口，只挡真正要 token 的那一次调用。
#
# ── 为什么不无脑拒一切 ──────────────────────────────────────────────────────
# duckle 有一批**自我声明不需要凭据、不开端口**的离线动词 —— `validate` 的原文：
#
#     Compiles pipelines to SQL without opening a source or writing a sink, so it
#     needs no DuckDB binary, no credentials and no network.
#
# 它们是 CI 门禁用法（`validate` / `test` 退出码 0/1/2 稳定，见引擎 EXIT CODES 段）。
# 若入口对空 token 一律拒跑，镜像里就连自己的静态检查都跑不了 —— 那不是安全，是残废。
# ⇒ 处置：**默认拒（含 `serve` / `web` / 跑管线 / `mcp` / 一切未知形态），
#    只放行「引擎自陈无凭据无网络」的那一组离线动词**。名单是显式白名单，不是通配。
# ─────────────────────────────────────────────────────────────────────────────

set -eu

# 引擎真实读的名字是 DUCKLE_CONSOLE_TOKEN（`serve --help` 的 `--token` 条目自陈
# 「also DUCKLE_CONSOLE_TOKEN」）。编排侧（deploy/data-compose.yml）声明的是
# DUCKLE_TOKEN —— 两个名字都得认，否则 compose 里配了 token 引擎也收不到。
# 优先取引擎的正式名，回落到编排用的别名。
TOKEN="${DUCKLE_CONSOLE_TOKEN:-}"
if [ -z "$TOKEN" ]; then
  TOKEN="${DUCKLE_TOKEN:-}"
fi

# 「引擎自陈无凭据、无网络、不开端口」的离线动词白名单。
# 每个都取自 v0.7.3 二进制的 USAGE / 说明文本，不是推测：
#   validate    self-documented: no credentials and no network
#   test        同上（对着固定输入断言单节点输出，不下写 sink）
#   review      静态模式（不带 --data/--drift 时）不执行任何东西
#   catalog     扫工作区里的管线文件，写 .duckle/catalog.json（本地）
#   drift / sql / components / python / xsd   本地解析与检查
#   console     写本地 Argon2 哈希（本来就是为了**建立**凭据）
#   cache / import / branch / runs / audit / sequence / deliveries / work  本地工作区读写真
# ⚠️ 白名单外的任何形态（含 `serve`、`web`、`--pipeline` 跑管线、`mcp`、
#    以及将来引擎新增的子命令）**一律要 token** —— 宁可将来多要一次，不可默认放开一次。
NEEDS_TOKEN=1
if [ "$#" -gt 0 ]; then
  case "$1" in
    validate|test|review|catalog|drift|sql|components|python|xsd|console|cache|import|branch|runs|audit|sequence|deliveries|work)
      NEEDS_TOKEN=0
      ;;
  esac
fi

if [ "$NEEDS_TOKEN" -eq 1 ] && [ -z "$TOKEN" ]; then
  # 文案要能自解释「该怎么修」：只说「缺 token」会让人去翻 compose 猜变量名。
  echo "duckle-runner: 拒绝启动 —— 需要凭据但 token 为空。" >&2
  echo "" >&2
  echo "  本次调用: duckle $*" >&2
  echo "  该调用会开控制台面（serve / web）或执行取数与落盘，必须先给凭据。" >&2
  echo "  否则 duckle 在非回环绑定下会以 UNCLAIMED 起，15 分钟内任何人可认领成管理员。" >&2
  echo "" >&2
  echo "  设置 DUCKLE_CONSOLE_TOKEN（引擎正式名）或 DUCKLE_TOKEN（编排侧别名）后重试。" >&2
  echo "  真值在 openship env(isSecret)——**不要写进 compose 文件或镜像层**。" >&2
  echo "" >&2
  echo "  若本次只是静态检查（validate / test / catalog / review …），它们不需要凭据，可直接运行。" >&2
  exit 1
fi

# 有 token 时把它翻到引擎认的名字上再交给它。
# 只在非空时导出：若导出成空串，引擎会走「已设置但为空 ⇒ 拒起」分支，
# 与上面基于动词的判断打架（离线动词本来不该被 token 状态影响）。
if [ -n "$TOKEN" ]; then
  DUCKLE_CONSOLE_TOKEN="$TOKEN"
  export DUCKLE_CONSOLE_TOKEN
fi

# exec 而非 sh -c 包一层：信号（Ctrl-C / docker stop 的 SIGTERM）直达引擎进程，
# 退出码原样透出（validate/test 的 0/1/2 是 CI 门禁要用的，不能被包装层吃掉）。
exec duckle "$@"
