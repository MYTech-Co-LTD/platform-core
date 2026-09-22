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
# duckle 有一批**不读活源、不写 sink、不出网**的本地动词 —— `validate` 的原文：
#
#     Compiles pipelines to SQL without opening a source or writing a sink, so it
#     needs no DuckDB binary, no credentials and no network.
#
# 它们是 CI 门禁用法（`validate` / `test` 退出码 0/1/2 稳定，见引擎 EXIT CODES 段）。
# 若入口对空 token 一律拒跑，镜像里就连自己的静态检查都跑不了 —— 那不是安全，是残废。
# ⇒ 处置：**默认拒（含 `serve` / `web` / 跑管线 / `mcp` / 一切未知形态），
#    只放行「不读活源、不写 sink、不出网的本地动词」**。名单是显式白名单，不是通配。
#
# ⚠️ 这里**不写**「名单里每个动词都是引擎自陈的无凭据无网络动词」这种普适断言 ——
#    那句话曾经写在本文件里，而且**不成立**（`sequence` / `work` / `drift` / `python`
#    等被当成离线动词放行了，它们实际会跑管线、读活源、取包）。普适断言一旦与实现
#    不符，下一个维护者就会照着它去增删名单。**每个动词的取舍理由逐条写在白名单注释里**，
#    增删前请先核对那一份，而不是照一句话。
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

# 白名单：**不读活源、不写 sink、不出网**的本地动词，**逐条**给依据，不写普适断言。
# 依据 = v0.7.3 二进制的 USAGE / 说明文本（`strings` 实测；该二进制 sha256
# 1a7d4e2b…cb37e748，与 README §2.2 记的 release 资产逐字节一致）：
#   validate    「Compiles pipelines to SQL without opening a source or writing a
#                sink, so it needs no DuckDB binary, no credentials and no network.」
#   test        「A case names the node it asserts on, so the run STOPS there: nothing
#                downstream executes and no sink writes. `given` maps a source node id
#                to the text it should read」⇒ 源文本由用例给，不读活源、不下写
#   catalog     「what the workspace reads and writes」；`build` 扫工作区里的管线写
#                `.duckle/catalog.json`，其余子命令读它；`diff` 明写 Nothing is checked out
#   sql check   「usage: duckle-runner sql check <pipeline.json> [--node ID] [--duckdb
#                PATH] [--format json|junit|sarif]」⇒ 按节点编译 SQL，CI 门禁用法
#   components  读工作区里的组件面（`schema` / `external` / `conform <id>`）
#   xsd         `list` 读已接受的契约；`accept` 只把指纹与理由记进**工作区** audit log
#   console     账号 / API key 的本地管理（写 Argon2 哈希到工作区 —— 本就是为了**建立**凭据）
#   cache       「See and drop the stage outputs kept for reuse」，本地；引擎自陈
#                Clearing is safe at any time
#   import      「convert a folder of legacy job files」到 --out（本地目录互转，不出网）
#   runs        `logs` / `diff` 读工作区里的运行日志与回执
#   audit       「Reads <workspace>/logs/audit.ndjson」（本地只读）
#
# 上面除 `validate` / `test` / `catalog` / `cache` / `audit` / `import` 有引擎原句外，
# `sql check` / `components` / `xsd` / `console` / `runs` 只有 USAGE 行 —— 判它们可放行
# 是**基于用法**的判定（都不开控制台面、不吃 `--token`、只碰工作区），**不是**引擎自陈
# 「无凭据无网络」。`docs/standards` 之外没有更硬的凭据，这个强弱差异如实记在这里。
#
# review 是**条件**动词，单独判（见下面的 case）：
#   不带 `--data`/`--drift`：引擎自陈「Without --data/--drift the review is static and
#   read-only (nothing is executed, no DuckDB binary needed)」⇒ 放行；
#   带 `--data`：「Sinks are stripped before running, so no destination is written;
#   sources are read and transforms run」；带 `--drift`：「read each source's live
#   schema and compare it to the declared one」⇒ **读活源、跑变换**，与跑管线同类 ⇒ 要 token。
#
# **被剔出白名单的 6 个**（它们曾按一句「离线动词」的普适断言写在这里，逐条核对**不成立**）：
#   sequence    「apply   run it, one link at a time, in order.」（跑管线，该块声明
#                "uri": "s3://registry/deltas"）
#   work        「work - run queued batch items」（跑管线；「claimed with the same lock
#                a pipeline run uses」）
#   deliveries  「deliveries retry」…「duckle-runner work retry --dead starts them over」
#                （重投递出站）
#   drift       「the live schema is read from the real data」（读活源）
#   branch      「promote <name>    Replace the live database with the branch.」（改活库）
#   python      `prepare` 「build .venv from pyproject.toml + uv.lock (needs uv)」（取包重建环境）
#   ⇒ 别再把它们加回来；引擎改口径时，先改本注释的事实陈述，再改名单。
#
# ⚠️ 白名单外的任何形态（含 `serve`、`web`、`--pipeline` 跑管线、`mcp`、
#    以及将来引擎新增的子命令）**一律要 token** —— 宁可将来多要一次，不可默认放开一次。
NEEDS_TOKEN=1
if [ "$#" -gt 0 ]; then
  case "$1" in
    validate|test|catalog|sql|components|xsd|console|cache|import|runs|audit)
      NEEDS_TOKEN=0
      ;;
    review)
      # 条件判：静态 review 不执行任何东西 ⇒ 放行；`--data` / `--drift` 会读活源、跑变换
      # ⇒ 与跑管线同类，要 token。开关在**后续参数**里，所以扫全部参数，
      # `--data` 与 `--data=…` 两种形态都认（少认一种就等于给了一条绕过路径）。
      NEEDS_TOKEN=0
      for arg in "$@"; do
        case "$arg" in
          --data|--data=*|--drift|--drift=*)
            NEEDS_TOKEN=1
            ;;
        esac
      done
      ;;
  esac
fi

if [ "$NEEDS_TOKEN" -eq 1 ] && [ -z "$TOKEN" ]; then
  # 文案要能自解释「该怎么修」：只说「缺 token」会让人去翻 compose 猜变量名。
  echo "duckle-runner: 拒绝启动 —— 需要凭据但 token 为空。" >&2
  echo "" >&2
  echo "  本次调用: duckle $*" >&2
  echo "  该调用会开控制台面（serve / web）、跑管线 / 读活源 / 改活库 / 投递出站，" >&2
  echo "  或属于白名单外的形态，必须先给凭据。" >&2
  echo "  否则 duckle 在非回环绑定下会以 UNCLAIMED 起，15 分钟内任何人可认领成管理员。" >&2
  echo "" >&2
  echo "  设置 DUCKLE_CONSOLE_TOKEN（引擎正式名）或 DUCKLE_TOKEN（编排侧别名）后重试。" >&2
  echo "  真值在 openship env(isSecret)——**不要写进 compose 文件或镜像层**。" >&2
  echo "" >&2
  echo "  若本次只是本地静态检查（validate / test / catalog / …），它们不需要凭据，可直接运行；" >&2
  echo "  review 只在**不带** --data/--drift（纯静态）时才属此类。" >&2
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
