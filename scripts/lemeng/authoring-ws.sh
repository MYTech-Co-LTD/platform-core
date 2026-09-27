#!/bin/sh
# authoring-ws.sh — 资产面 authoring 工作区：从仓内正本组装（桌面可开），改动收集回仓（走 PR）。
#
# 背景（正典 handbook §1.1.6⑧/⑧.a）：桌面(+Git)=authoring 与唯一事实源；「桌面要打开的
# 本地工作区」不是仓内某个现成目录 ⇒ 本脚本负责双向映射，本地**不维护常驻副本**
#（随用随组装，避免出现第三正本）：
#   assemble：仓内 → 本地工作区（桌面打开编辑/试跑）
#   collect ：工作区 → 仓内（生成 git diff 走 PR；本脚本绝不提交）
#
# 用法：
#   sh authoring-ws.sh assemble <account> [dir]
#       组装到 <dir>（默认 /tmp/duckle-authoring-<account>）。目录已存在 ⇒ 拒绝（防覆盖手改）；
#       ASSEMBLE_OVERWRITE=1 时重跑：只覆盖「与正本一致」的文件，手改文件原样保留并点名。
#       组装后生成桌面项目树元数据 repository.json/duckle.json（只在缺失时生成，已存在绝不
#       覆盖——用户整理过的树优先，打「keep metadata」点名；坑见 gen_metadata 处注释）。
#   sh authoring-ws.sh collect <account> <dir>
#       把 <dir> 里「与仓内正本不同」的已映射文件复制回仓内对应路径，打 git diff --stat。
#       ⚠️ 工作区里仓内没有对应文件的新 json 只列出不自动收（防 scratch 误入仓）。
#       ⚠️ schedules.json 若含运行态字段（last_run_* / next_run_at）说明文件来源不对，人工核对后再收。
#       ⚠️ 工作区根的 repository.json/duckle.json 是桌面树元数据，不属于映射表，collect 不碰。
#
# 映射表（唯一事实源，assemble/collect 共用；枚举一律基于 REPO_ROOT，不依赖调用方 CWD）：
#   deploy/duckle/console/pipelines/<name>.json    ⇄ pipelines/<name>.json
#   duckle/common/<name>.json                      ⇄ pipelines/common/<name>.json
#   deploy/duckle/console/schedules/<account>.json ⇄ schedules.json
#   deploy/duckle/console/alerts.json              ⇄ alerts.json
#   deploy/duckle/console/owners.json              ⇄ owners.json
#
# 壳法纪律：FAIL 不在管道子壳里调（子壳的 exit 杀不掉全脚本）；变量与全角字符相邻一律 ${VAR}。
set -u
REPO_ROOT=${REPO_ROOT:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}
CONSOLE=deploy/duckle/console
FAIL() { echo "AUTHORING_WS_FAILED: $*"; exit 2; }

map_list() { # $1=account $2=wsdir → stdout: "repo相对路径 ws绝对路径" 逐行
  for f in "$REPO_ROOT/$CONSOLE"/pipelines/*.json; do
    [ -f "$f" ] || continue
    printf '%s %s\n' "${f#"$REPO_ROOT"/}" "$2/pipelines/$(basename "$f")"
  done
  for f in "$REPO_ROOT"/duckle/common/*.json; do
    [ -f "$f" ] || continue
    printf '%s %s\n' "${f#"$REPO_ROOT"/}" "$2/pipelines/common/$(basename "$f")"
  done
  printf '%s %s\n' "$CONSOLE/schedules/$1.json" "$2/schedules.json"
  printf '%s %s\n' "$CONSOLE/alerts.json" "$2/alerts.json"
  printf '%s %s\n' "$CONSOLE/owners.json" "$2/owners.json"
}

# 桌面坑（2026-09-27 实测）：仅把管线 json 放进工作区目录，桌面项目树**不显示**——Duckle 桌面的
# 项目树由工作区根两个元数据文件驱动：repository.json（树清单 [{id,name,type:project|folder|
# pipeline,parentId}]）与 duckle.json（{"version":2,"engine":"duckdb","jobs":[{id,name,dirty}...],
# "activeJobId":""}）。App 对新目录会生成默认样例树，外来管线被自动收编成 parentId 指向不存在
# 的节点 ⇒ 不渲染。故 assemble 在缺失时生成这两个文件；已存在绝不覆盖（用户可能整理过树），
# collect 也不碰它们。id 规则：管线一律用文件 stem（文件名去 .json），与桌面自动收编一致。
json_tree_nodes() { # $1=account → stdout：repository.json 节点行（根 parentId=""，两 folder 挂根下）
  rid="authoring-$1"
  printf '{"id":"%s","name":"%s","type":"project","parentId":""}\n' "$rid" "$rid"
  printf '{"id":"pipelines","name":"pipelines","type":"folder","parentId":"%s"}\n' "$rid"
  printf '{"id":"common","name":"common","type":"folder","parentId":"%s"}\n' "$rid"
  for f in "$REPO_ROOT/$CONSOLE"/pipelines/*.json; do
    [ -f "$f" ] || continue
    s=$(basename "$f" .json)
    printf '{"id":"%s","name":"%s","type":"pipeline","parentId":"pipelines"}\n' "$s" "$s"
  done
  for f in "$REPO_ROOT"/duckle/common/*.json; do
    [ -f "$f" ] || continue
    s=$(basename "$f" .json)
    printf '{"id":"%s","name":"%s","type":"pipeline","parentId":"common"}\n' "$s" "$s"
  done
}
json_jobs() { # → stdout：duckle.json 的 jobs 行（覆盖 pipelines/ 与 pipelines/common/ 全部管线）
  for f in "$REPO_ROOT/$CONSOLE"/pipelines/*.json "$REPO_ROOT"/duckle/common/*.json; do
    [ -f "$f" ] || continue
    s=$(basename "$f" .json)
    printf '{"id":"%s","name":"%s","dirty":false}\n' "$s" "$s"
  done
}
gen_metadata() { # $1=account $2=wsdir — 桌面树元数据；两文件各自「缺失才生成」，存在即 keep
  REP="$2/repository.json"
  if [ -f "$REP" ]; then
    echo "  keep metadata ${REP}"
  else
    { echo '['; json_tree_nodes "$1" | sed '$!s/$/,/'; echo ']'; } > "$REP"
    echo "  gen metadata ${REP}"
  fi
  DUC="$2/duckle.json"
  if [ -f "$DUC" ]; then
    echo "  keep metadata ${DUC}"
  else
    { echo '{"version":2,"engine":"duckdb","jobs":['; json_jobs | sed '$!s/$/,/'; echo '],"activeJobId":""}'; } > "$DUC"
    echo "  gen metadata ${DUC}"
  fi
}

case "${1:-}" in
  assemble)
    ACC=${2:?account}; DIR=${3:-/tmp/duckle-authoring-$ACC}
    [ -f "$REPO_ROOT/$CONSOLE/schedules/$ACC.json" ] || FAIL "未知账套 ${ACC}（$CONSOLE/schedules/$ACC.json 不存在）"
    if [ -d "$DIR" ] && [ "${ASSEMBLE_OVERWRITE:-0}" != "1" ]; then
      FAIL "${DIR} 已存在（换目录，或 ASSEMBLE_OVERWRITE=1 覆盖一致文件）"
    fi
    mkdir -p "$DIR/pipelines/common"
    MAP=$(map_list "$ACC" "$DIR")
    while read -r rp wp; do
      [ -n "$rp" ] || continue
      src="$REPO_ROOT/$rp"
      [ -f "$src" ] || FAIL "正本缺失 $rp"
      if [ -f "$wp" ] && ! cmp -s "$src" "$wp"; then
        echo "  KEEP(手改保留) $wp"
      else
        cp "$src" "$wp" && echo "  ok $wp"
      fi
    done <<MAPLIST
$MAP
MAPLIST
    gen_metadata "$ACC" "$DIR"
    echo "assemble 完成：${DIR}（桌面打开它；改完 collect 收回走 PR）"
    ;;
  collect)
    ACC=${2:?account}; DIR=${3:?dir}
    [ -d "$DIR" ] || FAIL "${DIR} 不存在"
    MAP=$(map_list "$ACC" "$DIR")
    while read -r rp wp; do
      [ -n "$rp" ] || continue
      [ -f "$wp" ] || continue
      dst="$REPO_ROOT/$rp"
      if [ ! -f "$dst" ]; then
        echo "  SKIP(仓内无正本，人工安置) $wp"
      elif ! cmp -s "$dst" "$wp"; then
        cp "$wp" "$dst" && echo "  collected $rp"
      fi
    done <<MAPLIST
$MAP
MAPLIST
    WSNEW=$(for f in "$DIR"/pipelines/*.json "$DIR"/pipelines/common/*.json; do
      [ -f "$f" ] || continue
      b=$(basename "$f")
      printf '%s\n' "$MAP" | grep -q " $b\$" || echo "$f"
    done)
    while read -r wp; do
      [ -n "$wp" ] || continue
      echo "  SKIP(仓内无正本，人工安置) $wp"
    done <<WSNEW
$WSNEW
WSNEW
    (cd "$REPO_ROOT" && git diff --stat | tail -8)
    echo "collect 完成：检查上方 diff 并走 PR（本脚本不提交）"
    ;;
  *)
    echo "usage: $0 assemble <account> [dir] | collect <account> <dir>"; exit 2 ;;
esac
