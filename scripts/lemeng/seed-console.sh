#!/bin/sh
# seed-console.sh — 把仓内 `deploy/duckle/console/` 的定义 **seed 进某个账套 console 的 workspace 卷**
#                   （正典 deploy/data-plane-deploy-sop.md §F.2 第 1 类）
#
# ── 它补的是哪一格（2026-10-05 实测发现的洞）──────────────────────────────────
# 「管线改动怎么到生产」这条路，此前只有**前半段**有工具：
#   ① 仓 → 检出：`sh /opt/lemeng-sync.sh <全SHA>`（按 lock 逐件）✅ 有工具
#   ② 检出 → console 卷：**没有任何工具**。`docker inspect` 显示 console 只挂
#      `lemeng-console-<账套>-ws:/workspace`（**命名卷，不是 bind**）；`lemeng-sync.sh` 四步里没有 seed；
#      `/opt` 下没有 seed 脚本；openship 的 42 个 job 里也没有一个含 `docker cp` / `/workspace`。
#   ⇒ ② 一直是**手工 `docker cp`**——所以它既没被记录、也没人会记得。本脚本补上这一格。
#
# ── 为什么 seed 之后要**重启容器**（而不是定向部署）────────────────────────────
# §F.2 实测定分：`/workspace` 是**命名卷** ⇒ seed 完**重启**即重新读取，**不必定向部署**。
# （与之相对：`duckle/` 与 `/opt/lemeng-run.sh` 是 **bind-mount**，钉的是 inode ⇒ 必须重建容器。）
# ⚠️ 本脚本**不**重启容器：重启走 openship MCP（控制面），符合「运维操作经唯一通道」。
#    脚本跑完会打印下一步；自证靠 §F.2 给的那条：
#      curl -s -H "Authorization: Bearer $DUCKLE_TOKEN" http://127.0.0.1:<port>/api/schedules
#
# ── ⚠️ `schedules.json` 会被引擎**回写**，别无脑重盖 ───────────────────────────
# 实测（[[duckle-console-schedules-json-engine-rewrites]]）：卷里的 `schedules.json` 会被引擎补上
# `misfire`/`catchup` 与 `last_run_*`。⇒ 默认 **只 seed `pipelines/`**（那才是天天变的那个）；
# 要连排班一起盖必须显式 `--only all`，并知道会重置 `last_run_*`（引擎下次 tick 会重写，但不静默）。
#
# 退出码：0=已同步且逐件一致（或 --check 下本来就一致）；1=有 DRIFT（--check）或写失败；
#         2=用法错；3=依赖不可用（容器不在 / 源文件缺）
# 可 grep 字面量：`SEED_OK <book> files=<n>` / `SEED_DRIFT <book> mismatched=<k>/<n>` /
#                `SEED_FAILED:<reason>`（usage | deps | copy）
#
# 可选 env：REPO（默认 /opt/platform-core-data/platform-core）/ CONSOLE_CT（默认按账套推）
#
# ⚠️ 相邻中文一律 `${VAR}`：本机 /bin/sh（bash 3.2）会把全角字符吃进变量名（全仓纪律，issue #212）。
set -u

REPO=${REPO:-/opt/platform-core-data/platform-core}
BOOK=${1:-}
MODE=${2:---check}
ONLY=${3:-pipelines}

usage() {
  cat >&2 <<'USAGE'
用法：sh seed-console.sh <账套> [--check|--seed] [pipelines|all]
  --check  只比不写（默认）
  --seed   写进 console 卷
  第三位  默认 pipelines（**天天变的那个**）；all 连 schedules/alerts/owners 一起（会重置 schedules.json
           的 last_run_* —— 引擎回写，不静默）。
自证（重启容器之后）：curl -s -H "Authorization: Bearer $DUCKLE_TOKEN" http://127.0.0.1:<port>/api/schedules
退出码：0=一致/已同步；1=DRIFT 或写失败；2=用法错；3=依赖不可用。
USAGE
}

case "${BOOK}" in
  [0-9][0-9]*) ;;
  *) echo "SEED_FAILED:usage 需要账套号（收到 '${BOOK}'）" >&2; usage; exit 2 ;;
esac
case "${MODE}" in
  --check|--seed) ;;
  *) echo "SEED_FAILED:usage 未知模式 '${MODE}'" >&2; usage; exit 2 ;;
esac
case "${ONLY}" in
  pipelines|all) ;;
  *) echo "SEED_FAILED:usage 第三位只认 pipelines|all（收到 '${ONLY}'）" >&2; usage; exit 2 ;;
esac

CONSOLE_CT=${CONSOLE_CT:-openship-platform-core-shanhai-data-lemeng-console-${BOOK}}
CONSOLE_REL="deploy/duckle/console/"
LOCK="${REPO}/deploy/data-plane.lock"
[ -f "${LOCK}" ] || { echo "SEED_FAILED:deps 检出里没有 ${LOCK}（sync 没跑过？）" >&2; exit 3; }
docker inspect "${CONSOLE_CT}" >/dev/null 2>&1 \
  || { echo "SEED_FAILED:deps console 容器 ${CONSOLE_CT} 不在" >&2; exit 3; }

# ── 待 seed 的 (仓内相对路径 → 卷内路径) —— **以 `data-plane.lock` 为准，不按目录 glob** ──
# 🔴 为什么不 glob：`lemeng-sync.sh` **只取件、不删件** ⇒ 机器检出会**永久堆积孤儿**
#    （2026-10-05 实测：仓里 **2026-09-29 就删掉**的 5 个退役薄壳 `*.run.json`，在检出里还躺着）。
#    按目录 glob 会把它们**重新灌回生产卷** —— 那才是「把退役件灌回去」这件事的真实来源
#    （不是仓里有，是检出里有）。lock 是 sync 用的那份清单 = **本次同步到的 revision 的准确文件集**
#    ⇒ 以它为准，孤儿天然进不来。
# ⚠️ 检出里多出来的文件（孤儿）**既不报错也不 seed**：它们不属于这个 revision。
_pairs() {
  # ⚠️ 别用 `/^pipelines\/[^/]+\.json$/` 这种字面量：awk 的 `/.../ ` 定界符**不认字符类里的斜杠**，
  #    `[^/]` 会把正则**提前截断**（实测报 `nonterminated character class`）。用 split 判段数，稳。
  awk -v pre="${CONSOLE_REL}" -v book="${BOOK}" -v only="${ONLY}" '
    /^sha256-of-rest/ { next }
    NF >= 4 && index($2, pre) == 1 {
      rel = substr($2, length(pre) + 1)
      np = split(rel, p, "/")
      if (np == 2 && p[1] == "pipelines" && p[2] ~ /\.json$/)      print rel "\t/workspace/" rel
      else if (only == "all" && rel == "schedules/" book ".json")  print rel "\t/workspace/schedules.json"
      else if (only == "all" && rel == "alerts.lemeng.json")       print rel "\t/workspace/alerts.json"
      else if (only == "all" && rel == "owners.lemeng.json")       print rel "\t/workspace/owners.json"
    }' "${LOCK}"
}

# ── sha256 工具在两边**名字不一样**（2026-10-05 真机实测，别想当然）─────────────
#   宿主 Ubuntu：`shasum`（perl，还会因 locale 未装而刷一堆 warning）与 `sha256sum` **都有**；
#   duckle 容器：**只有 `sha256sum`，没有 `shasum`**。
#   ⇒ 早先那版用 `shasum` 取卷内哈希，拿到的是**空串**，于是**每一件都报 DRIFT**
#     ——"工具既说齐也说不齐"这类判据最容易以假红的样子骗过自己。统一优先 `sha256sum`、退回 `shasum`。
_host_sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi 2>/dev/null | cut -d' ' -f1; }
# 卷内文件的 sha256 必须在**容器里**算 —— 宿主那份与卷里那份是**两份副本**，只有进容器才比得到真的
_vol_sha() { docker exec "${CONSOLE_CT}" sh -c "if command -v sha256sum >/dev/null 2>&1; then sha256sum '$1'; else shasum -a 256 '$1'; fi" 2>/dev/null | cut -d' ' -f1; }

n=0; bad=0
while IFS="$(printf '\t')" read -r rel dst; do
  [ -n "${rel}" ] || continue
  src="${REPO}/${rel}"
  [ -f "${src}" ] || { echo "SEED_FAILED:deps lock 登记了 ${rel}，但检出里没有：${src}" >&2; exit 3; }
  want=$(_host_sha "${src}")
  got=$(_vol_sha "${dst}")
  n=$((n + 1))
  if [ "${MODE}" = "--check" ]; then
    if [ "${want}" = "${got}" ]; then
      echo "OK    ${dst}"
    else
      bad=$((bad + 1)); echo "DRIFT ${dst}  期望 ${want} 实际 ${got:-<缺失>}"
    fi
  else
    docker cp "${src}" "${CONSOLE_CT}:${dst}" >/dev/null 2>&1 \
      || { echo "SEED_FAILED:copy 写不进去：${dst}" >&2; exit 1; }
    now=$(_vol_sha "${dst}")
    if [ "${want}" = "${now}" ]; then
      echo "OK    ${dst}"
    else
      bad=$((bad + 1)); echo "DRIFT ${dst}  写完仍不一致（期望 ${want} 实际 ${now:-<缺失>}）"
    fi
  fi
done <<EOF
$(_pairs)
EOF

# 一件都没匹配上 = 这份 lock 里没有 console 条目（revision 不对？）⇒ **判红**，
# 而不是静默报 `SEED_OK files=0`（"零覆盖的门禁会空转通过"是本仓点过名的坑）。
[ "${n}" -gt 0 ] || { echo "SEED_FAILED:deps lock 里一条 console 条目都没匹配到：${LOCK}" >&2; exit 3; }

if [ "${bad}" -gt 0 ]; then
  echo "SEED_DRIFT ${BOOK} mismatched=${bad}/${n}" >&2
  exit 1
fi
echo "SEED_OK ${BOOK} files=${n}"
[ "${MODE}" = "--seed" ] && cat >&2 <<'NEXT'

下一步（**必须**，否则 console 还在读旧卷内容）：
  ① 经 openship MCP 重启该 console 服务（**服务级 restart 即可**，卷不是 bind ⇒ 不必定向部署）：
       post_projects_by_id_services_by_serviceId_restart
  ② 自证它真读到了（§F.2）：
       curl -s -H "Authorization: Bearer $DUCKLE_TOKEN" http://127.0.0.1:<port>/api/schedules
     条目数与 seed 的一致即算生效。
NEXT
exit 0
