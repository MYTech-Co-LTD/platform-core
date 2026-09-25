#!/bin/sh
# scripts/lemeng/sync-data-plane.test.sh — sync-data-plane.sh 的本地单测。
#
#   sh scripts/lemeng/sync-data-plane.test.sh
#
# 退出码 0 = 全过；非 0 = 有用例失败（逐条打 `ok - <名>` / `FAIL - <名>`，末尾给总数）。
# **不打网络、不碰真机**：网络那一层换成假 curl，从夹具目录发件。
#
# ## 为什么只 stub curl、哈希用真的
#
# 连 `sha256_of` 一起 stub，就把「取到的字节 → 断言」这条链整个短路了，测出来的只是「我调过
# 一个假函数」。所以只换掉网络，哈希走真的（GNU `sha256sum`，BSD 上用 `shasum -a 256`）。
#
# ## 假 curl 的截断是**带 exit 0** 的（这是本文件最重要的一处设计）
#
# 真机上实测到的假绿形态是「HTTP 200 + curl 认为成功 + 内容是半截」（SOP §E.4）。所以假 curl
# 截断时**写出前 N 字节然后 exit 0**——若断言被写在重试循环**外面**，这种错会一路装到机器上。
# 用例 I 就是钉这条的：前 6 次给半截、第 7 次给全量，最终必须成功且内容是全量。

set -u

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
SCRIPT="$SCRIPT_DIR/sync-data-plane.sh"

ROOT=$(mktemp -d)
STUB_BIN="$ROOT/bin"
FIXTURE_SLUG='fixture/repo'
FIXTURE_SHA='0123456789abcdef0123456789abcdef01234567'
# 假 curl 按此前缀剥 URL（见 STUB 里的注）。与 run_sync 传的 SYNC_REPO_SLUG 必须同源。
STUB_PREFIX="https://raw.githubusercontent.com/$FIXTURE_SLUG/"
N_ENTRIES=4
FAILED=0
PASSED=0

trap 'rm -rf "$ROOT"' EXIT INT TERM

# ---- 小工具 ----

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

ok() { PASSED=$((PASSED + 1)); printf 'ok   - %s\n' "$1"; }
bad() { FAILED=$((FAILED + 1)); printf 'FAIL - %s\n' "$1"; }

# assert_eq 期望 实际 名字
assert_eq() {
  if [ "$1" = "$2" ]; then ok "$3"; else bad "$3（期望 [$1] 实得 [$2]）"; fi
}
# assert_contains 大海 针 名字
assert_contains() {
  case "$1" in
    *"$2"*) ok "$3" ;;
    *) bad "$3（输出里找不到 [$2]）：$1" ;;
  esac
}
# assert_file 路径 名字
assert_file() { if [ -f "$1" ]; then ok "$2"; else bad "$2（文件不存在：$1）"; fi }
# assert_gt 实际 下界 名字
assert_gt() { if [ "$1" -gt "$2" ]; then ok "$3"; else bad "$3（实测 $1，需 > $2）"; fi }
assert_no_file() { if [ -f "$1" ]; then bad "$2（文件本不该存在：$1）"; else ok "$2"; fi }

# 整棵树的「路径 + 内容」指纹——`--check` 只读的判据（比 mtime 硬：mtime 粒度粗，改内容可能看不出来）
tree_hash() {
  ( cd "$1" && find . -type f | LC_ALL=C sort | while IFS= read -r f; do
      printf '%s %s\n' "$(sha256_of "$f")" "$f"
    done ) | sha256_of /dev/stdin
}

file_mode() { ls -l "$1" | cut -c1-10; }

out_of() { cat "$ROOT/$1/out"; }
err_of() { cat "$ROOT/$1/err"; }

calls_of() {
  _f="$ROOT/$1/state/calls.log"
  if [ -f "$_f" ]; then wc -l < "$_f" | tr -d ' '; else printf '0'; fi
}
attempts_of() {
  _f="$ROOT/$1/state/attempts.$(printf '%s' "$2" | tr '/' '_')"
  if [ -f "$_f" ]; then cat "$_f"; else printf '0'; fi
}

# ---- 假 curl ----

mkdir -p "$STUB_BIN"
cat > "$STUB_BIN/curl" <<'STUB'
#!/bin/sh
# 假 curl：只认 sync-data-plane.sh 用到的那几个开关，从 $STUB_SRC 发件。
out=''
url=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -sS|-f|-s|-S) shift ;;
    --max-time|-x) shift 2 ;;
    *) url="$1"; shift ;;
  esac
done

# URL 形状：https://raw.githubusercontent.com/<owner>/<repo>/<sha>/<path>
# 按**前缀**剥而不是「数斜杠」：前缀对不上时 rest 原样保留 ⇒ sha 必然对不上 ⇒ 404。
# 顺带钉住「脚本确实拿 SLUG 拼了 URL」——slug 写错会在这里显形，而不是静默取到别处的东西。
rest=${url#"$STUB_PREFIX"}
sha=${rest%%/*}
path=${rest#*/}

mkdir -p "$STUB_STATE"
printf '%s\n' "$url" >> "$STUB_STATE/calls.log"

# SHA 不认识 = 404（真端点同行为：不存在的 commit 就是 404，且 404 的 HTML 绝不该被当内容写下去）
[ "$sha" = "$STUB_SHA" ] || exit 22

key=$(printf '%s' "$path" | tr '/' '_')
n=0
[ -f "$STUB_STATE/attempts.$key" ] && n=$(cat "$STUB_STATE/attempts.$key")
n=$((n + 1))
printf '%s' "$n" > "$STUB_STATE/attempts.$key"

[ "$path" = "${STUB_FAIL_PATH:-}" ] && exit 22

if [ "$path" = "${STUB_TRUNCATE_PATH:-}" ] && [ "$n" -le "${STUB_TRUNCATE_ATTEMPTS:-0}" ]; then
  # **exit 0**：真机上的假绿正是「连上了、HTTP 200、curl 报成功，但流被截断」。
  head -c "${STUB_TRUNCATE_BYTES:-40}" "$STUB_SRC/$path" > "$out"
  exit 0
fi

if [ "$path" = "${STUB_CORRUPT_PATH:-}" ]; then
  cat "$STUB_SRC/$path" > "$out"
  printf '# corrupt\n' >> "$out"
  exit 0
fi

cp "$STUB_SRC/$path" "$out" || exit 22
exit 0
STUB
chmod 0755 "$STUB_BIN/curl"

# ---- 夹具 ----

# setup <夹具名>：建 src（仓内真相）+ checkout（模拟机器检出，REPO 指向它）+ opt（改名脚本落地处），
# 并生成一份**真的** lock（首行 = 其余部分的 sha256）。
setup() {
  _n="$1"
  _w="$ROOT/$_n"
  _src="$_w/src"
  _co="$_w/checkout"
  _opt="$_w/opt"
  mkdir -p "$_src/deploy/duckle" "$_src/duckle" "$_src/dbt/tests" "$_src/scripts/lemeng" \
           "$_co/deploy/duckle" "$_co/duckle" "$_co/scripts/lemeng" "$_opt" "$_w/state"
  printf '#!/bin/sh\necho entrypoint\n' > "$_src/deploy/duckle/entrypoint.sh"
  printf '{"a":1}\n'                    > "$_src/duckle/a.json"
  printf 'select 1\n'                   > "$_src/dbt/tests/new.sql"
  # run.sh 夹具**故意写长**：用例 I 要从中间把它截断，而 `head -c N` 对短于 N 的文件是**原样吐回**
  # ⇒ 夹具要是只有几十字节，「截断重试」用例就退化成「零次重试也过」的空断言（第一版正是栽在这里：
  # 夹具 20 B / 截断长度 40 B）。长度另有 assert_gt 兜住，防止以后有人把它改短。
  {
    printf '#!/bin/sh\n'
    printf '# filler：让截断真的截得动\n'
    _i=0
    while [ "$_i" -lt 12 ]; do printf '# filler line %s\n' "$_i"; _i=$((_i + 1)); done
    printf 'echo run\n'
  } > "$_src/scripts/lemeng/run.sh"

  {
    printf '%s %s %s %s\n' \
      "$(sha256_of "$_src/deploy/duckle/entrypoint.sh")" 'deploy/duckle/entrypoint.sh' \
      '${REPO}/deploy/duckle/entrypoint.sh' '0644'
    printf '%s %s %s %s\n' \
      "$(sha256_of "$_src/duckle/a.json")" 'duckle/a.json' \
      '${REPO}/duckle/a.json' '0644'
    # 父目录 dbt/tests/ 在检出里**故意不存在** ⇒ 用例 A 顺带验「自动建目录」
    printf '%s %s %s %s\n' \
      "$(sha256_of "$_src/dbt/tests/new.sql")" 'dbt/tests/new.sql' \
      '${REPO}/dbt/tests/new.sql' '0644'
    # 真绝对路径 + 改名 + 执行位（与生产那条 /opt/lemeng-run.sh 同形）
    printf '%s %s %s %s\n' \
      "$(sha256_of "$_src/scripts/lemeng/run.sh")" 'scripts/lemeng/run.sh' \
      "$_opt/lemeng-run.sh" '0755'
  } > "$_w/body"
  {
    printf 'sha256-of-rest %s\n' "$(sha256_of "$_w/body")"
    cat "$_w/body"
  } > "$_src/deploy/data-plane.lock"
}

# run_sync <夹具名> [--check]：跑被测脚本，stdout/stderr 落文件，**返回退出码**。
run_sync() {
  _n="$1"
  shift
  _w="$ROOT/$_n"
  REPO="$_w/checkout" \
  SYNC_REPO_SLUG="$FIXTURE_SLUG" \
  SYNC_PROXY='http://stub-proxy.invalid:4878' \
  STUB_SRC="$_w/src" \
  STUB_PREFIX="$STUB_PREFIX" \
  STUB_SHA="$FIXTURE_SHA" \
  STUB_STATE="$_w/state" \
  STUB_FAIL_PATH="${STUB_FAIL_PATH:-}" \
  STUB_CORRUPT_PATH="${STUB_CORRUPT_PATH:-}" \
  STUB_TRUNCATE_PATH="${STUB_TRUNCATE_PATH:-}" \
  STUB_TRUNCATE_ATTEMPTS="${STUB_TRUNCATE_ATTEMPTS:-0}" \
  STUB_TRUNCATE_BYTES="${STUB_TRUNCATE_BYTES:-40}" \
  PATH="$STUB_BIN:$PATH" \
  sh "$SCRIPT" "$FIXTURE_SHA" "$@" > "$_w/out" 2> "$_w/err"
  printf '%s' "$?"
}

# ---- 用例 ----

printf '== sync-data-plane.sh ==\n'

# A 正常同步：四件全部落地、执行位补上、目录自动建、标记写上
setup a
st=$(run_sync a)
assert_eq '0' "$st" 'A: 退出码 0'
assert_contains "$(out_of a)" "SYNC_OK $N_ENTRIES/$N_ENTRIES" 'A: SYNC_OK 4/4'
assert_contains "$(out_of a)" 'OK ' 'A: 逐文件 OK 行'
assert_eq "$(cat "$ROOT/a/src/duckle/a.json")" "$(cat "$ROOT/a/checkout/duckle/a.json")" 'A: duckle/a.json 逐字节落地'
assert_eq "$(cat "$ROOT/a/src/dbt/tests/new.sql")" "$(cat "$ROOT/a/checkout/dbt/tests/new.sql")" 'A: 父目录不存在时自动建并落地'
assert_eq "$(cat "$ROOT/a/src/scripts/lemeng/run.sh")" "$(cat "$ROOT/a/opt/lemeng-run.sh")" 'A: 改名脚本落地'
assert_eq '-rwxr-xr-x' "$(file_mode "$ROOT/a/opt/lemeng-run.sh")" 'A: 改名脚本的执行位是 0755'
assert_file "$ROOT/a/checkout/.data-plane-revision" 'A: 版本标记写上'
assert_contains "$(cat "$ROOT/a/checkout/.data-plane-revision" 2>/dev/null)" "sha $FIXTURE_SHA" 'A: 标记内容含目标全 SHA'
assert_eq '' "$(find "$ROOT/a/checkout" -name '.*sync-tmp*' 2>/dev/null)" 'A: 无临时文件残留'

# B 幂等 + 模式补齐：第二跑不再取内容（只取 lock），且内容对而模式错时也要收敛
before=$(calls_of a)
chmod 0600 "$ROOT/a/checkout/duckle/a.json"
st=$(run_sync a)
after=$(calls_of a)
assert_eq '0' "$st" 'B: 第二跑仍退出码 0'
assert_contains "$(out_of a)" "SYNC_OK $N_ENTRIES/$N_ENTRIES" 'B: 第二跑仍 SYNC_OK 4/4'
assert_eq '1' "$((after - before))" 'B: 内容已对的文件不重取（本跑只取 lock 这一次）'
assert_eq '-rw-r--r--' "$(file_mode "$ROOT/a/checkout/duckle/a.json")" 'B: 内容对但模式被改成 0600 时仍被补回 0644'

# C --check 干净：SYNC_OK，且**一个字节都不写**
setup c
run_sync c > /dev/null
h_before=$(tree_hash "$ROOT/c/checkout")
before=$(calls_of c)
st=$(run_sync c --check)
after=$(calls_of c)
assert_eq '0' "$st" 'C: 干净时 --check 退出码 0'
assert_contains "$(out_of c)" "SYNC_OK $N_ENTRIES/$N_ENTRIES" 'C: 干净时 --check 报 SYNC_OK 4/4'
assert_eq "$h_before" "$(tree_hash "$ROOT/c/checkout")" 'C: --check 不改检出任何一个字节'
assert_eq '1' "$((after - before))" 'C: --check 只取 lock（不取件）'

# D --check 有漂移：报 DRIFT + 非零，且**不修**
printf '{"a":2}\n' > "$ROOT/c/checkout/duckle/a.json"
h_before=$(tree_hash "$ROOT/c/checkout")
st=$(run_sync c --check)
assert_eq '1' "$st" 'D: 有漂移时 --check 退出码 1'
assert_contains "$(out_of c)" 'DRIFT ' 'D: 打出 DRIFT 行'
assert_contains "$(out_of c)" 'duckle/a.json' 'D: DRIFT 行点名漂移文件'
assert_contains "$(out_of c)" 'SYNC_DRIFT 1 mismatched' 'D: 尾部 SYNC_DRIFT 1 mismatched'
assert_eq "$h_before" "$(tree_hash "$ROOT/c/checkout")" 'D: --check 不修漂移（漂移文件原样留着）'

# E --check 面对缺失文件：报「(缺失)」而不是崩
rm -f "$ROOT/c/checkout/duckle/a.json"
st=$(run_sync c --check)
assert_eq '1' "$st" 'E: 文件缺失时 --check 退出码 1'
assert_contains "$(out_of c)" '(缺失)' 'E: 缺失的文件报 (缺失)'

# F lock 自校验失败：LOCK_FETCH_FAILED，且**什么都没落地、标记没写**
setup f
printf 'deadbeef %s\n' "$(head -n 2 "$ROOT/f/body" | tail -n 1)" >> "$ROOT/f/src/deploy/data-plane.lock"
st=$(run_sync f)
assert_eq '1' "$st" 'F: lock 自校验失败时退出码 1'
assert_contains "$(err_of f)" 'LOCK_FETCH_FAILED' 'F: 报 LOCK_FETCH_FAILED'
assert_no_file "$ROOT/f/checkout/duckle/a.json" 'F: 一件都没落地'
assert_no_file "$ROOT/f/checkout/.data-plane-revision" 'F: 标记没写（这套不算同步完成）'

# F2 首行的 key 被换掉：同样 LOCK_FETCH_FAILED（不是「静默当没自校验」）
setup f2
tail -n +2 "$ROOT/f2/src/deploy/data-plane.lock" > "$ROOT/f2/tmp"
printf 'sha256-of-nothing %s\n' "$(head -c 64 /dev/zero | tr '\0' 'a')" > "$ROOT/f2/src/deploy/data-plane.lock"
cat "$ROOT/f2/tmp" >> "$ROOT/f2/src/deploy/data-plane.lock"
st=$(run_sync f2)
assert_eq '1' "$st" 'F2: 首行 key 不对时退出码 1'
assert_contains "$(err_of f2)" 'LOCK_FETCH_FAILED' 'F2: 报 LOCK_FETCH_FAILED'

# G lock 被**永久**截断：重试到上限后放弃（次数必须是 MAX_TRIES=10，证明重试有界）
setup g
STUB_TRUNCATE_PATH='deploy/data-plane.lock' STUB_TRUNCATE_ATTEMPTS=99 STUB_TRUNCATE_BYTES=40
st=$(run_sync g)
assert_eq '1' "$st" 'G: lock 永久截断时退出码 1'
assert_contains "$(err_of g)" 'LOCK_FETCH_FAILED' 'G: 报 LOCK_FETCH_FAILED'
assert_eq '10' "$(attempts_of g 'deploy/data-plane.lock')" 'G: lock 取件重试上限是 10 次'
STUB_TRUNCATE_PATH='' STUB_TRUNCATE_ATTEMPTS=0

# H 单文件永久 sha 不符：FETCH_FAILED；在它之前的已落地、之后的没落地、标记没写、无残留
setup h
STUB_CORRUPT_PATH='duckle/a.json'
st=$(run_sync h)
assert_eq '1' "$st" 'H: 单文件 sha 永久不符时退出码 1'
assert_contains "$(err_of h)" 'FETCH_FAILED: duckle/a.json' 'H: 报 FETCH_FAILED 并点名仓内路径'
assert_file "$ROOT/h/checkout/deploy/duckle/entrypoint.sh" 'H: 排在它前面的文件已落地（不回滚，靠标记缺失暴露）'
assert_no_file "$ROOT/h/checkout/duckle/a.json" 'H: 失败的那件没有落地'
assert_no_file "$ROOT/h/checkout/.data-plane-revision" 'H: 标记没写'
assert_eq '' "$(find "$ROOT/h/checkout" -name '.*sync-tmp*' 2>/dev/null)" 'H: 失败后不留临时文件'
assert_eq '10' "$(attempts_of h 'duckle/a.json')" 'H: 取件重试上限是 10 次'
STUB_CORRUPT_PATH=''

# I 截断 → 重试 → 成功（**决定性用例**：证明 sha256 断言在重试循环**里面**）
setup i
# 前提先行：夹具必须**长于**截断长度，否则本用例什么都没测（见 setup 里 run.sh 的注）。
assert_gt "$(wc -c < "$ROOT/i/src/scripts/lemeng/run.sh" | tr -d ' ')" '40' \
  'I: 前提——夹具长于截断长度（否则「截断」是空操作，本用例退化）'
STUB_TRUNCATE_PATH='scripts/lemeng/run.sh' STUB_TRUNCATE_ATTEMPTS=6 STUB_TRUNCATE_BYTES=40
st=$(run_sync i)
assert_eq '0' "$st" 'I: 前 6 次半截、第 7 次全量 ⇒ 退出码 0'
assert_contains "$(out_of i)" "SYNC_OK $N_ENTRIES/$N_ENTRIES" 'I: SYNC_OK 4/4'
assert_eq "$(cat "$ROOT/i/src/scripts/lemeng/run.sh")" "$(cat "$ROOT/i/opt/lemeng-run.sh")" 'I: 落地的是**全量**内容（不是 40 字节前缀）'
assert_eq '7' "$(attempts_of i 'scripts/lemeng/run.sh')" 'I: 恰好取件 7 次（6 次半截 + 1 次全量）'
assert_eq '-rwxr-xr-x' "$(file_mode "$ROOT/i/opt/lemeng-run.sh")" 'I: 重试后执行位照样补上'
STUB_TRUNCATE_PATH='' STUB_TRUNCATE_ATTEMPTS=0

# J 参数校验：分支名 / 短 SHA 一律拒，且**根本不调 curl**（否则投递物会漂移且静默）
# 短 SHA 从夹具那个 40 位值**裁末位**派生 —— 不引用任何真实 commit 标识符：外部标识符一旦被
# 转手就可能已是截断形态，拿它当「39 位」的样例会让用例随那个值一起错。
setup j
st=$(REPO="$ROOT/j/checkout" sh "$SCRIPT" 'main' > "$ROOT/j/out2" 2> "$ROOT/j/err2"; printf '%s' "$?")
assert_eq '2' "$st" 'J: 分支名（main）被拒，退出码 2'
assert_contains "$(cat "$ROOT/j/err2")" '40 位十六进制' 'J: 提示要求 40 位十六进制全 SHA'
short_sha=$(printf '%s' "${FIXTURE_SHA%?}")
st=$(REPO="$ROOT/j/checkout" sh "$SCRIPT" "$short_sha" > "$ROOT/j/out3" 2> "$ROOT/j/err3"; printf '%s' "$?")
assert_eq '2' "$st" 'J: 39 位短 SHA 被拒，退出码 2'
assert_contains "$(cat "$ROOT/j/err3")" '长度应为 40' 'J: 短 SHA 走的是长度校验那条分支'
assert_eq '0' "$(calls_of j)" 'J: 参数不合法时一次 curl 都没发'

# K 检出根不存在：显式失败，不静默
st=$(REPO="$ROOT/does-not-exist" PATH="$STUB_BIN:$PATH" sh "$SCRIPT" "$FIXTURE_SHA" > "$ROOT/k-out" 2> "$ROOT/k-err"; printf '%s' "$?")
assert_eq '2' "$st" 'K: 检出根不存在时退出码 2'
assert_contains "$(cat "$ROOT/k-err")" '检出根不存在' 'K: 报检出根不存在'

# ---- 汇总 ----

printf '\n%d 通过, %d 失败\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ] || exit 1
exit 0
