#!/bin/sh
# scripts/lemeng/sync-data-plane.sh — 数据面工件同步（正典：deploy/data-plane-deploy-sop.md §E.3 ③）。
#
# 在**数据面机上**跑（该机无 node）。用法：
#
#     sh sync-data-plane.sh <全SHA>             # 同步
#     sh sync-data-plane.sh <全SHA> --check     # 只比不写（一个字节都不写进检出）
#     sh sync-data-plane.sh <全SHA> --prune     # 同步 + 清点删除检出孤儿（常规链路用这条）
#
# 四步：**取 lock**（按全 SHA）→ **验 lock 自校验** → **逐文件取件**（同目录临时文件 → sha256 断言
# → 补模式 → 原子 `mv -f`）→ **最后**写 `<检出>/.data-plane-revision`；随后**清点/清理**（#683）：
# 枚举检出树 vs lock 落地路径集，孤儿默认报 `EXTRA`、`--prune` 删。清点在标记**之后**——「标记
# 在 = 这套文件是全的」不变式不被 prune 干扰（prune 失败只是没清干净，下次跑收敛）。单文件
# `mv` 原子但**整套不原子**，中途失败停在半应用状态，靠「标记没写上」显性化。
#
# ## 为什么每件都要 sha256 断言（不是「保险起见」）
#
# 智能代理会把流**截断**在 9~11 KB 附近，且**间歇复现**——实测同一次投递连续 6 次都截断、第 7 次
# 才拿到全量（SOP §E.4）。截断时 HTTP **仍是 200**、curl 也报成功 ⇒ 装上去的是**半截脚本**，而半截
# 的 shell 未必语法报错。**sha256 逐字节断言是唯一能拦住它的东西**。⇒ 断言必须在**重试循环里面**
# （截断是「取到但内容不对」，不是「取不到」，放在循环外就一次都不重试）。
#
# ## 凭据：本脚本没有任何凭据
#
# raw.githubusercontent 按**全 SHA 匿名可读**（2026-09-25 实测：匿名取回的文件与仓内那份 sha256
# 逐字节一致）⇒ 不持有、不读取、更不回显任何 token。**别为了「万一要鉴权」加一个 token 参数**
# ——那就是把一个不需要的秘密引进数据面机。
#
# ## 环境变量（全部有默认值，正常不用传）
#
#     REPO           检出根（默认 /opt/platform-core-data/platform-core，与 run-retail-day.sh 同源）
#     SYNC_PROXY     智能代理（默认公网 EIP 113.250.177.229:4878；**内网 10.0.0.8:4878 被云安全组
#                    拦、直连不通**，且该机直连 raw.githubusercontent 实测 code=000）
#     SYNC_REPO_SLUG 仓 slug（默认 MYTech-Co-LTD/platform-core）
#
# 输出契约：每文件一行 `<状态> <落地路径> <期望 sha256> <实际 sha256>`（状态 `OK`/`DRIFT`）；
# 末尾 `SYNC_OK <n>/<n>` 或 `SYNC_DRIFT <n> mismatched`；首行 `# target <全SHA>` 是给人看的台账行
# （不以 OK/DRIFT 开头，不参与契约）。失败字面量：`LOCK_FETCH_FAILED:` / `LOCK_SELFTEST_FAILED:` /
# `FETCH_FAILED: <仓内路径>` / `REVISION_WRITE_FAILED:`——**都是 fail loud + 非零退出**，不静默。
#
# 清点输出（#683，三态都有）：孤儿逐行 `EXTRA <绝对路径>`（报告态）；`--prune` 态删掉的打
# `PRUNED <绝对路径>`、删失败打 `PRUNE_FAILED: <路径>`（fail loud + 非零退出）；摘要行
# `# extra N`（N = 清点/清理**后**残余孤儿数）打在结论行之前。`--check` 退出码仍只看 DRIFT。

set -efu

SCRIPT_NAME='sync-data-plane'

REPO="${REPO:-/opt/platform-core-data/platform-core}"
PROXY="${SYNC_PROXY:-http://113.250.177.229:4878}"
SLUG="${SYNC_REPO_SLUG:-MYTech-Co-LTD/platform-core}"
BASE="https://raw.githubusercontent.com/$SLUG"

LOCK_REL='deploy/data-plane.lock'
LOCK_HEADER_KEY='sha256-of-rest'
REVISION_REL='.data-plane-revision'

# 取件重试上限：实测连败 6 次后第 7 次成功 ⇒ 10 留了余量，又不至于挂太久。
MAX_TRIES=10
# 单次 curl 超时（秒）。直连不可达时是 15s 级超时，给到 30 留余量。
CURL_TIMEOUT=30

usage() {
  echo "用法：sh $0 <全SHA> [--check|--prune]" >&2
  echo "  <全SHA>  40 位十六进制，**从 git 命令输出逐字复制**（分支名会漂移，绝不用分支名）" >&2
  echo "  --check  只比不写；退出码只看 DRIFT（孤儿 EXTRA 是信息行）" >&2
  echo "  --prune  完整同步后清点删除检出孤儿（机器本地物豁免，见 is_allowlisted）" >&2
}

# 算一个文件的 sha256（小写十六进制）。
# 先 GNU `sha256sum`（数据面机有），退回 BSD `shasum -a 256`（开发机因此也能跑本脚本的单测）。
# **别删这个退回分支**——它不是死码，是「同一份逻辑能在两个平台上被验」的那条路。
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# 取一件并**断言 sha256**：$1=全SHA $2=仓内路径 $3=落地临时文件 $4=期望 sha256。
# 返回 0 = 拿到且逐字节相符。每次尝试**清盘重取**——不复用半截文件（两段残片拼起来可能「长度对、
# 内容错」，而那种错只有靠断言才发现，等于把断言的价值又还回去了）。
fetch_verified() {
  _url="$BASE/$1/$2"
  _want="$4"
  _n=0
  while [ "$_n" -lt "$MAX_TRIES" ]; do
    _n=$((_n + 1))
    rm -f "$3"
    # -f 不能省：没有它，404 的 HTML 也会被当成内容写进临时文件（错 SHA / 路径写错时必须立刻失败）。
    if curl -sS -f --max-time "$CURL_TIMEOUT" -x "$PROXY" -o "$3" "$_url" >/dev/null 2>&1; then
      _got=$(sha256_of "$3")
      if [ "$_got" = "$_want" ]; then
        return 0
      fi
    fi
  done
  return 1
}

# ---- #683 清点/清理：机器本地物 allowlist + 孤儿审计 ----

# 机器本地物 allowlist（相对 `${REPO}`）：这些件不在仓里（与 `deploy/data-plane-manifest.txt`
# 头注的「机器本地物」清单同源），清点不得判成孤儿。改这张表与改 manifest 头注同 PR 走。
# 注：崩溃残留（`..data-plane-revision.tmp.*` / `.sync-tmp.*`）**不在**表里——它们不该活着，
# 视作孤儿被报告/清理是更优行为，不是误伤。
is_allowlisted() {
  case "$1" in
    .data-plane-revision) return 0 ;;
    deploy/.env | dbt/profiles.yml | dbt/.user.yml) return 0 ;;
    dbt/target/* | dbt/logs/*) return 0 ;;
    *) return 1 ;;
  esac
}

# 审计孤儿：stdin 逐行喂 `${REPO}` 内绝对路径。$1 = 'report'（只报）| 'prune'（删）。
# 计数走全局 `_extra`；调用方必须用**重定向**喂（`audit_extras x < file`），不能接在
# `find | audit_extras` 管道里——管道会把函数放进子 shell，计数器出不来（与主循环
# `done < file` 同一个坑、同一个解法）。
audit_extras() {
  _mode="$1"
  _extra=0
  while IFS= read -r _abs; do
    _rel=${_abs#"$REPO"/}
    if grep -Fqx -- "$_rel" "$_tmpdir/expected"; then
      continue
    fi
    if is_allowlisted "$_rel"; then
      continue
    fi
    _extra=$((_extra + 1))
    if [ "$_mode" = 'prune' ]; then
      if rm -f "$_abs"; then
        echo "PRUNED $_abs"
      else
        echo "PRUNE_FAILED: $_abs" >&2
        exit 1
      fi
    else
      echo "EXTRA $_abs"
    fi
  done
}

# 清点入口：全树枚举（**只限 `${REPO}` 内**——`/opt` 是共享目录，「不该有什么」没有基准；且本
# 脚本自己就不在 manifest，枚举它必把自己判成孤儿）+ 排序（输出确定，两次跑的清单可逐行比对）。
audit_checkout() {
  find "$REPO" -type f > "$_tmpdir/found"
  LC_ALL=C sort "$_tmpdir/found" > "$_tmpdir/found.sorted"
  audit_extras "$1" < "$_tmpdir/found.sorted"
}

# ---- 参数 ----

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  usage
  exit 2
fi

SHA="$1"
CHECK_MODE='0'
PRUNE_MODE='0'
if [ "$#" -eq 2 ]; then
  case "$2" in
    --check) CHECK_MODE='1' ;;
    --prune) PRUNE_MODE='1' ;;
    *)
      echo "$SCRIPT_NAME: 未知参数 '$2'" >&2
      usage
      exit 2
      ;;
  esac
fi

# 全 SHA 形状硬校验。这条是**承重**的：raw.githubusercontent **同时接受分支名**，所以 `main` 会
# 「正常工作」——于是投递物变成一个会漂移的目标，而失败是静默的（下次取到别的 commit）。
case "$SHA" in
  '' | *[!0-9a-f]*)
    echo "$SCRIPT_NAME: 目标必须是 40 位十六进制全 SHA，实得 '${SHA}'" >&2
    usage
    exit 2
    ;;
esac
if [ "${#SHA}" -ne 40 ]; then
  echo "$SCRIPT_NAME: 全 SHA 长度应为 40，实得 ${#SHA}（'$SHA'）——不要手工补写，回源头逐字复制" >&2
  exit 2
fi

if [ ! -d "$REPO" ]; then
  echo "$SCRIPT_NAME: 检出根不存在：$REPO" >&2
  exit 2
fi

_tmpdir=$(mktemp -d)
# ⚠️ 清理**不许改退出码**。macOS 的 bash 3.2 实测：EXIT trap 里末条命令的状态会成为 shell 的
# 退出状态 ⇒ 裸 `trap 'rm -rf ...' EXIT` 会把脚本里**每一处** `exit 1` 悄悄改成 `exit 0`
# （`rm` 成功 = 0），于是「同步失败」在机器上表现为「报绿」。这正是本机制要防的那类假绿，
# 却被自己的清理动作制造出来 ⇒ 显式把状态捞回来再退出。INT/TERM 另给固定码（否则被信号打断
# 也可能落成 0）。
trap '_rc=$?; rm -rf "$_tmpdir"; exit "$_rc"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# 变量一律写 ${VAR}：下面这些变量后面紧跟的是**全角标点**，而 bash 3.2 在 UTF-8 locale 下会把
# 0x80 以上的字节也当成变量名的合法字符 ⇒ `$SHA（` 会被解析成变量 `SHA（`（未定义 ⇒ set -u 下
# 直接死）。同一坑在 .github/workflows/ci.yml 的 main-guard 里已有留档。
echo "# target ${SHA}（checkout ${REPO}，mode=$([ "$CHECK_MODE" = '1' ] && echo check || echo sync)）"

# ---- ① 取 lock ----

# lock 的期望 sha256 **无法预先知道**（它就写在 lock 自己里）⇒ 这里不能复用 fetch_verified 的
# 「按期望值断言」，断言换成**自校验**。重试照样保留（截断对 lock 一样会发生），只是每次尝试的
# 判定改成「首行 == 其余部分的 sha256」。
_lock="$_tmpdir/lock"
_lock_ok='0'
_n=0
while [ "$_n" -lt "$MAX_TRIES" ]; do
  _n=$((_n + 1))
  rm -f "$_lock"
  if curl -sS -f --max-time "$CURL_TIMEOUT" -x "$PROXY" -o "$_lock" "$BASE/$SHA/$LOCK_REL" >/dev/null 2>&1; then
    _first=$(head -n 1 "$_lock")
    case "$_first" in
      "$LOCK_HEADER_KEY "*)
        _self=${_first#"$LOCK_HEADER_KEY "}
        tail -n +2 "$_lock" > "$_tmpdir/body"
        if [ "$_self" = "$(sha256_of "$_tmpdir/body")" ]; then
          _lock_ok='1'
          break
        fi
        ;;
    esac
  fi
done
if [ "$_lock_ok" != '1' ]; then
  echo "LOCK_FETCH_FAILED: 取不到 ${LOCK_REL}，或取到的 lock 首行自校验对不上（重试 $MAX_TRIES 次）" >&2
  echo "  ⇒ lock 被截断/被改，或 SHA 写错。**不要跳过这一步**：lock 是后面每一件 sha256 的基准。" >&2
  exit 1
fi
echo "# lock OK（$LOCK_REL 自校验通过）"

# ---- ② 逐条 ----

# 主循环读的是 `$_tmpdir/body`（= lock 去掉首行自校验头之后的部分），**不是** `$_lock` 本身。
# 读整个 lock 会让首行 `sha256-of-rest <hex>` 以「两列」的身份进循环 ⇒ 立刻 fail。
# 顺带一个好处：body 正是自校验哈希过的同一份字节，循环与自校验因此必然看同一套内容。
#
# `set -f`（脚本开头）在跑：下面 `set -- $line` 靠词的拆分取四列，若路径里混进 `*` 会被当通配符展开
# 成文件名，四列就散了。
# 预期集落盘（主循环逐行追加）：清点的「应有文件集」基准 = lock 落地路径列，不二次解析 lock。
printf '' > "$_tmpdir/expected"
_ok=0
_drift=0
_total=0
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    '') continue ;;
  esac
  # shellcheck disable=SC2086
  set -- $line
  if [ "$#" -ne 4 ]; then
    echo "$SCRIPT_NAME: lock 行不是四列（实得 $# 列）：$line" >&2
    exit 1
  fi
  f_sha="$1"
  f_repo="$2"
  f_land="$3"
  f_mode="$4"
  _total=$((_total + 1))

  case "$f_mode" in
    0[0-7][0-7][0-7]) ;;
    *)
      echo "$SCRIPT_NAME: lock 里的模式不是 0[0-7]{3}：'$f_mode'（${f_repo}）" >&2
      exit 1
      ;;
  esac

  # 把落地路径模板换成真实路径。用 case/前缀剥离而不是 sed：sed 的替换串里 `&`、`\` 有特殊含义，
  # 而检出根是外部输入，不该被当成替换模板解释。
  case "$f_land" in
    "\${REPO}"*) real_land="$REPO${f_land#\$\{REPO\}}" ;;
    *) real_land="$f_land" ;;
  esac
  # 落地路径来自**网络**（lock）。虽然取件本身是内容寻址的，仍不该让一个写歪的路径指到检出之外——
  # 这类形状只可能是笔误，宁可 fail loud。
  case "$real_land" in
    /.. | /../* | */../* | */..)
      echo "$SCRIPT_NAME: 落地路径含 '..'，拒绝：${real_land}（${f_repo}）" >&2
      exit 1
      ;;
    /*) ;;
    *)
      echo "$SCRIPT_NAME: 落地路径必须是绝对路径，实得：${real_land}（${f_repo}）" >&2
      exit 1
      ;;
  esac

  # 预期集顺手收集。`${REPO}` 外的落地路径（如 /opt 改名件）剥不掉前缀就原样存；枚举只产出
  # `${REPO}` 内路径 ⇒ 两者天然不相交。
  printf '%s\n' "${real_land#"$REPO"/}" >> "$_tmpdir/expected"

  if [ "$CHECK_MODE" = '1' ]; then
    if [ -f "$real_land" ]; then
      actual=$(sha256_of "$real_land")
    else
      actual='(缺失)'
    fi
    if [ "$actual" = "$f_sha" ]; then
      echo "OK $real_land $f_sha $actual"
      _ok=$((_ok + 1))
    else
      echo "DRIFT $real_land $f_sha $actual"
      _drift=$((_drift + 1))
    fi
    continue
  fi

  # 内容已对就别重写（省 mtime 抖动：这些路径被容器 bind 着，无谓的重建没好处）。模式仍补一次
  # ——内容对但模式错也是没收敛。
  if [ -f "$real_land" ] && [ "$(sha256_of "$real_land")" = "$f_sha" ]; then
    chmod "$f_mode" "$real_land"
    echo "OK $real_land $f_sha $f_sha"
    _ok=$((_ok + 1))
    continue
  fi

  # 落地目录**要建**（不是「不存在就失败」）：仓里新增一个文件时，它的父目录在旧检出里可能还不
  # 存在（git 不追踪空目录，tarball 里自然没有），而「手工 mkdir」正是 E.5 要消灭的那类手工步骤。
  # 破坏性为零：只补目录，不删不动任何已有东西。建不出来（权限等）才 fail loud。
  now_dir=$(dirname "$real_land")
  if ! mkdir -p "$now_dir" 2>/dev/null; then
    echo "FETCH_FAILED: ${f_repo}（落地目录建不出来：${now_dir}）" >&2
    exit 1
  fi
  # 临时文件放**同目录**：跨目录 rename 不原子。`$$` 让并发/重入不至于互踩。
  now_tmp="$now_dir/.$(basename "$real_land").sync-tmp.$$"
  if ! fetch_verified "$SHA" "$f_repo" "$now_tmp" "$f_sha"; then
    echo "FETCH_FAILED: ${f_repo}（取件并 sha256 断言，重试 $MAX_TRIES 次仍不符）" >&2
    rm -f "$now_tmp"
    exit 1
  fi
  chmod "$f_mode" "$now_tmp"
  mv -f "$now_tmp" "$real_land"
  echo "OK $real_land $f_sha $f_sha"
  _ok=$((_ok + 1))
done < "$_tmpdir/body"

# ---- ③ 结论 ----

if [ "$CHECK_MODE" = '1' ]; then
  # 清点只报不删；摘要行打在结论行之前。退出码仍只看 DRIFT——`--check` 的原语义是「这套 lock
  # 是否装齐」，EXTRA 不影响装齐；改了会打断现有探活/审计调用方的退出码约定。
  audit_checkout report
  echo "# extra $_extra"
  if [ "$_drift" -eq 0 ]; then
    echo "SYNC_OK $_ok/$_total"
    exit 0
  fi
  echo "SYNC_DRIFT $_drift mismatched"
  exit 1
fi

# 标记**最后**写，且同样走「同目录临时 + 原子 mv」——半截的标记比没有标记更坏（它会声称这套是全的）。
_rev="$REPO/$REVISION_REL"
_rev_tmp="$REPO/.$REVISION_REL.tmp.$$"
if ! printf 'sha %s\nsynced_at %s\n' "$SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$_rev_tmp"; then
  echo "REVISION_WRITE_FAILED: 写不了 $_rev_tmp" >&2
  exit 1
fi
if ! mv -f "$_rev_tmp" "$_rev"; then
  echo "REVISION_WRITE_FAILED: 装不上 $_rev" >&2
  rm -f "$_rev_tmp"
  exit 1
fi

# ---- ④ 清点/清理（#683）：在标记写完**之后**——「标记在 = 这套文件是全的」不被 prune 干扰；
# prune 失败时标记已在 ⇒ 这套是全的、只是没清干净，下次跑收敛（清理幂等、方向单一）。
# 摘要行 `# extra N` 的 N 定义是「清点/清理**后**残余」（spec ③）⇒ prune 态删完**再复核一遍**
# 树：`_extra` 必须来自「清完之后走一遍树数残余」，不能拿 prune 态的删除计数顶替（那是删了几个，
# 不是还剩几个）。复核顺带把 prune 过程中的竞态重建显形（删完又被写回 ⇒ 残余 > 0 可见）。
if [ "$PRUNE_MODE" = '1' ]; then
  audit_checkout prune
  audit_checkout report
else
  audit_checkout report
fi
echo "# extra $_extra"

echo "SYNC_OK $_ok/$_total"
echo "# revision $SHA → $REVISION_REL"
