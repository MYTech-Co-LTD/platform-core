# 加密连接一次性 setup：可进仓、可复现（duckle `connectionRef` 写入方 · 路径 (iii)）

> 2026-09-28 ｜ worker `task_f4f1d8632db4`（Orca dispatch `ctx_48b458d12edf`）
> 依据：`docs/superpowers/specs/2026-09-28-duckle-child-value-paths.md` §3.1.1（写入方调查 + 三条路径取舍）、
> `docs/superpowers/specs/2026-09-28-duckle-l1-secret-path-d1.md` §4（明文面审计法）、
> 正典 `docs/data-platform-handbook.md` §1.1.7（L1 形态与凭据红线）。
> **本任务落地的是路径 (iii)：按源码自封。**
>
> **本报告全部活动**：本机 `/tmp/mkconn-lab/`（隔离 workspace + 回环 mock 8890 + 真 duckle 0.7.4）
> ＋**只读**容器探测（openship MCP）。**零生产写入**：未碰湖、未碰生产卷、未改生产调度、
> **未往任何生产的 console 工作区写过一个字节**、未用真实凭据（自造假密钥 `LABSEC_2f9c1a7b4e6d8035`，
> sha256[:12] = `fcd77c2f93ca`）。**未外发**。

---

## 0. 结论速览

1. **交付三件**：`scripts/duckle/connection-setup.py`（脚本）、`scripts/duckle/connection-setup.test.ts`
   ＋ `connection-setup.kat.json`（测试与已知答案向量）、本报告。
2. **实现语言由容器探测决定，不是偏好**：目标容器**没有** `cryptography` / `Crypto` / `nacl`，
   **没有** node，`openssl enc` 又**拒绝 AEAD**（`enc: AEAD ciphers not supported`）。
   ⇒ 走**纯 stdlib**（自实现的 AES-256-GCM，零依赖、零网络）。
   **因此不需要改 `deploy/duckle/Dockerfile`、不需要重建镜像** —— 脚本 `docker cp` 进去即可跑，
   这对「已经在跑调度的 console 容器」是关键性质（见 §5）。
3. **正确性四层已验，不是自证**：L1 已知答案向量（由 **OpenSSL/`cryptography` 独立生成**，非本脚本产出）
   → L2 **容器自己的 python 3.12.14** 跑同一份密码学核，6 条向量全过
   → L3 **真 duckle 0.7.4 引擎**起两层 `foreach → 子管线` 最小管线，**引擎把脚本封的密文解开并送到了请求里**
   → L4 反向：把同一份密文改名（AAD 语境变），引擎**解不开**（证明 AAD 绑定真的在起作用，不是摆设）。
4. **三条护栏都在，且都用真退出码演示过**：写完自检（明文残留 ⇒ exit 3）、
   全路径不回显凭据（只打键名/长度/sha12）、幂等（重复跑逐字节不变、连 mtime 都不动；轮换才改）。
5. **一处未验（诚实标注）**：**脚本整支**未在容器内实跑过（只跑了它的密码学核）。
   原因是 openship 执行通道单条命令 10 000 字符上限，而脚本 36 KB（gzip+base64 后 16.6 KB）；
   分块灌进运行中的生产容器超出本任务「只读探测」的授权。**收口动作与负责人见 §6。**

---

## 1. 容器环境探测（决定实现语言的依据）

**探测对象**：`platform-core-duckle:local`（本镜像 = `python:3.12-slim` 基座 + `duckle==0.7.4`），
经 openship MCP 的**服务内执行**端点，对**正在运行**的 console 容器只读探测：

```
容器：lemeng-console-3120（project platform-core-data/shanhai-data, serviceId svc_srQwfTvdkjxbCeoA）
宿主机：shanhai 数据面 8281d598-af73-4d0b-99dd-bc8681fcc8bb
```

原始输出（只读命令，无任何写入）：

```
== OCI =PRETTY_NAME="Debian GNU/Linux 13 (trixie)"
== python3=Python 3.12.14
== import probe ==
cryptography False
Crypto False
nacl False
ssl True
hashlib True
base64 True
json True
== binaries ==
openssl=/usr/bin/openssl
node=MISSING
nodejs=MISSING
npm=MISSING
duckdb=/usr/local/bin/duckdb
duckle=/usr/local/bin/duckle
pip3=/usr/local/bin/pip3
python3=/usr/local/bin/python3
== pip list ==
duckdb-cli 1.5.5
duckle     0.7.4
```

追加探测（同上，只读）：

```
== openssl ==  OpenSSL 3.5.7 9 Jun 2026
== openssl enc aes-256-gcm ==
enc: AEAD ciphers not supported          <-- 且 enc 也没有 AAD 入口
== site-packages ==
README.txt  duckdb_cli  duckdb_cli-1.5.5.dist-info  duckle  duckle-0.7.4.dist-info  pip  pip-25.0.1.dist-info
```

### 1.1 由此排除的候选（逐条给理由，不是感觉）

| 候选实现 | 判定 | 依据 |
|---|---|---|
| **node 脚本** | ❌ 排除 | 容器内 `node`/`nodejs`/`npm` **全无** |
| **python + `cryptography`** | ❌ 不采用 | 模块不存在；装它要改 `deploy/duckle/Dockerfile` ⇒ **重建镜像**（见 §5 为何这是有代价的） |
| **python + `openssl` CLI** | ❌ 排除 | `openssl enc` 对 AEAD 直接报错；且要传 AAD 也没有入口 |
| **python + `ctypes` 调 libcrypto** | ❌ 不采用 | 容器侧可行，但把宿主/发行版的 soname 变成隐式依赖（CI 是 Ubuntu、开发机是 macOS/LibreSSL），跨环境行为会分叉——**用一个到处都一样的纯 stdlib 实现换掉一个到处不一样的绑定**更划算 |
| **python 纯 stdlib（自实现 AES-256-GCM）** | ✅ **采用** | 零依赖、零网络、零镜像改动；正确性由 §3 四层独立证据兜底 |

> **取舍明说**：自实现密码学通常是要被质疑的选择，这里的理由不是「省事」，而是
> **① 容器里没有可用的实现；② 唯一的替代要付镜像重建的代价；③ 目标是已在跑生产调度的容器。**
> 代价用验证强度对冲：密码学那一段有 4 层独立验证，其中**最终裁判是真引擎**（§3.3）。
> 哪天真加了 `cryptography`，把 `_gf_mul`…`_const_eq` 那一段换掉即可，其余（语义层/护栏/CLI）不动。

---

## 2. 交付物与源码对齐

### 2.1 文件

| 文件 | 作用 |
|---|---|
| `scripts/duckle/connection-setup.py` | 脚本本体。831 行，**只 import `argparse/base64/hashlib/json/os/sys`** |
| `scripts/duckle/connection-setup.test.ts` | vitest，14 条用例，黑盒 spawn CLI；密文用 **`node:crypto`** 独立解开 |
| `scripts/duckle/connection-setup.kat.json` | 7 条已知答案向量，由 **`cryptography` 50.0.1 / OpenSSL** 生成（**不是**本脚本产出） |

进仓门禁：`pnpm run test:guard` = **276 passed / 16 skipped / 0 failed**（含本组 14 条）；
`pnpm run typecheck:scripts` 通过；`check-manifests` / `lint-architecture` / `check-compose` /
`check-env-example` 四条 CI 守卫全 PASS。

### 2.2 与 `crates/duckle-secrets/src/lib.rs` 的逐条对齐

| 规格 | 源码锚 | 脚本实现 |
|---|---|---|
| 钥匙 `<ws>/.duckle/keys/secret.key`，32 原始字节，0600 | `key_path():48`、`workspace_key():55` | `load_or_create_key()`；`O_CREAT\|O_EXCL` + `mode=0o600`（不先建后 chmod，避开 TOCTOU 窗口）；**已存在即复用，绝不覆盖**；既存钥匙 ≠ 32 字节 ⇒ **拒跑**（exit 5） |
| token = `enc:v2:` + base64(nonce12 ‖ ct ‖ tag16) | `ENC_PREFIX_V2:27`、`encrypt_value():185` | `seal()`，`b64encode(nonce + ct + tag)` |
| AAD = context + `0x1f` + field | `aad_for():171` | `aad_for()`，同样 `context.encode() + b"\x1f" + field.encode()` |
| 只封「键名 ∈ SENSITIVE_KEYS」的**字符串**值；空串 / `enc:` 开头 / `${...}` 跳过 | `SENSITIVE_KEYS:30`、`transform():237` | `_sealable()` 与 source 判据逐条一致 |
| SENSITIVE_KEYS 清单 | `lib.rs:30`（13 项） | 逐字照抄（含 `authToken` / `clientSecret` / `accessToken`） |
| 连接文件在 `<ws>/connections/<id>.json`，运行时 STRICT 解密 | `load_connection():331` | 写同一路径、同一 id |
| 连接字段名 = 各引擎读的字段名 | `merge_generic_connection():621` 的 KEYS 白名单 | `zos-s3` 档的字段取自该白名单 + `snk.minio` 表单键（catalog 实测） |
| REST 连接：`headers` 按 key 合并且节点优先；`url/authType/authToken/authHeader/tokenUrl/clientId/clientSecret` 填空 | `merge_rest_connection():650` | `rest-bearer` 档写 `kind/authType/authToken` |

### 2.3 连接 id 约定（已写进脚本头注）

id **账套无关**（`zos` / `lemeng`）。理由：连接文件按**各 workspace 自己的钥匙**加密，
每个 console 工作区各存一份自己的（密文互不通用正是设计意图）；账套维度已由**工作区**承载，
再往 id 里编一份就是两个事实源，会逼得管线 JSON 的 `connectionRef` 带账套名，
与正典「管线定义与账套解耦」冲突。推论：**同一个 id 在不同账套下是不同的凭据**，轮换只动那一个 workspace。

---

## 3. 方案正确性证据

### 3.1 L1 — 已知答案向量，且向量不是本脚本产出的

`cat` 出来的 `kat.json` 头部即 provenance：

```
"provenance": "cryptography 50.0.1 / OpenSSL — generated by gen-kat.py (NOT by connection-setup.py)",
"layout": "sealed_hex = nonce(12) || ciphertext || tag(16); aad = context + 0x1f + field"
```

7 条向量覆盖明文长度 0 / 1 / 15 / 16 / 17 / 64 字节（CTR 分块边界）与含空白/Tab 的值。
生成器用 lab venv 里的 `cryptography`（OpenSSL 后端），**与被测实现异源**。

```
$ python3 scripts/duckle/connection-setup.py --selftest
selftest ok（7 vectors，来源 cryptography 50.0.1 / OpenSSL — generated by gen-kat.py (NOT by connection-setup.py)）
exit=0
```

`--selftest` 除正向比对外，对每条向量还做两项反向：回解必须等于原明文、**换字段名必须解不开**。

### 3.2 L2 — 容器**自己的** python 3.12.14 跑同一份密码学核

把 §2.1 脚本里 `_gf_mul`…`_const_eq` 那一段**逐字截取**（仅去注释与空行，未改任何语句），
经 gzip+base64 送进容器，用 `docker run --rm --read-only --network none`（**无挂载、无网络、
只读根、无任何写入**）在容器解释器上对同一批向量判读：

```
command: docker run --rm --read-only --network none --entrypoint python3 \
           platform-core-duckle:local -c "import base64,gzip,sys;exec(gzip.decompress(base64.b64decode(sys.argv[1])))" '<payload>'
output : PYVER 3.12.14 linux
         PROBE_OK 6 vectors
exit   : 0
```

⇒ **在真正会跑它的那个解释器上**（3.12，且**没有** `cryptography`、**没有** node），
AES-256-GCM + AAD + 分帧与 OpenSSL **逐字节一致**；AAD 反向用例也在容器内真红过。

### 3.3 L3 — 真 duckle 0.7.4 引擎解密（最终裁判）

lab：`/tmp/mkconn-lab/`，隔离 workspace + 回环 mock `127.0.0.1:8890`（只回显 `sha256(tok)[:12]` 与长度，
**不落明文**，日志在 workspace 之外）。

管线形态与正典 §1.1.7 的 **L1 标准形态**一致（两层）：

```
src.csv(windows.csv) → ctl.foreach(itemKey=window, concurrency=1)
  └─ 子管线: src.rest(connectionRef=<id>) → code.sql → snk.csv
```

连接文件**全部由本脚本产出**（`--profile rest-bearer --token-env LAB_TOKEN`）。

**case 1 — AAD 语境一致（id 与文件名都是 `zos`）**

```
########## enc  (connectionRef=zos) exit=0
status   : ok
--- mock saw (tok_sha12 | len | src) ---
1|...|path=/probe|tag=w01|secret_src=header|tok_sha12=fcd77c2f93ca|tok_len=23
2|...|path=/probe|tag=w02|secret_src=header|tok_sha12=fcd77c2f93ca|tok_len=23
VERDICT: PASS — 引擎解出脚本封的密文，并作为 Bearer 送到了请求里
```

`fcd77c2f93ca` / `len=23` 正是假密钥 `LABSEC_2f9c1a7b4e6d8035` 的判读锚（lab 既定口径）。
子管线收据同样为证：

```
window,tag,sha12,len,resolved,src
w01,w01,fcd77c2f93ca,23,true,header
w02,w02,fcd77c2f93ca,23,true,header
```

**case 2 — 反向对照：同一份密文改名为 `other.json`（AAD 语境变成 `other`）**

```
########## aad  (connectionRef=other) exit=0
status   : ok
--- mock saw ---
3|...|secret_src=query|tok_sha12=e3b0c44298fc|tok_len=0
4|...|secret_src=query|tok_sha12=e3b0c44298fc|tok_len=0
VERDICT: 引擎没解出 ⇒ 空凭据（AAD 绑定生效 + 文档记录的 fail-open）
```

`e3b0c44298fc` = `sha256("")[:12]`。**这条反向是整套证据里最有用的一条**：
同一个 workspace、同一把钥匙、同一份密文，只换 AAD 语境就解不开 ⇒ 证明
① AAD 绑定**真的**在引擎侧生效（不是本脚本自说自话），
② 客观复现了 `child-value-paths` §3.1.2 坑 2 记录的 **fail-open**：
非 Salesforce 节点上连接解不开时 **exit 0、无报错、凭据为空** —— 典型「静默 401」。
⇒ §1.1.7 要求的「独立探测」不是可选项，是必需品。

**落盘明文审计**（隔离 workspace 逐处 grep 假密钥，方法沿用 D1 §4）：

```
  pipelines    plaintext_hits=0
  connections  plaintext_hits=0
  .duckle      plaintext_hits=0
  logs         plaintext_hits=0
  runs         plaintext_hits=0
  out          plaintext_hits=0
  data         plaintext_hits=0
  合计明文命中=0（0 = 全绿）
  TMPDIR 残留 duckle_run DB: 0
```

`connections/` 处 0 命中值得留意：**连接文件确实在那里，但里面是密文** —— grep 明文搜不到，
这正是「零明文」的意思。脚本产出的文件形态（值截断）：

```
  zos.json -> {
      kind       'rest'
      authType   'bearer'
      authToken  enc:v2:p4r7Mol…（75 字节 token）
  }
```

### 3.4 L4 — 顺带确认的一件运维事实

**`connectionRef` 不需要在 `repository.json` 里登记**。实测：删掉 `repository.json` 后重跑同一条管线，
`status: ok` 且 mock 仍收到 `fcd77c2f93ca`。引擎的运行时路径是 `load_connection()` 直读
`connections/<id>.json`（`lib.rs:331`），登记只对 console 面的列举有意义（那一面**未验**，见 §6）。
⇒ 部署 runbook 里**不需要**一步「注册连接」。

---

## 4. 自检护栏验证（真退出码，不是「读起来对」）

护栏与 `--check-only` **共用同一个函数**（`find_plaintext_sensitive`），所以下面两组证据是同一个判据的两种入口。

**A) 写完自检的输入面 —— 明文连接必须被点名且非零退出**（这正是 MCP `create_connection` 产出的那种形态）：

```
$ connection-setup.py --check-only guarddemo/connections        # 目录模式，扫 *.json
PLAINTEXT guarddemo/connections/bad.json :: authToken
自检未过：1 处明文敏感字段。管线里写 connectionRef 前必须先封（用 profile / --set 重跑本脚本）。
exit=3
```

注意输出：**点名了字段 `authToken`，但没有打印它的值**。

**B) 源码会静默留明文的那一档 —— 敏感键下挂非字符串值**：

源码 `transform()` 只封**字符串**，所以 `{"secretKey": 12345678}` 会被引擎**原样留下**。
本脚本把这一档也算违规（正典口径：不许静默产出明文）：

```
$ connection-setup.py --check-only guarddemo/connections/numeric.json
PLAINTEXT guarddemo/connections/numeric.json :: secretKey（非字符串，源码的 transform 不封它）
exit=3
```

**C) 合规文件放行**（避免「一律报红」的假门禁）：

```
$ connection-setup.py --check-only ws/connections/zos.json
clean ws/connections/zos.json（已封 1 个敏感字段）
exit=0
```

**D) 不回显**：vitest 里有一条用例对三种路径（正常 / `--dry-run` / 缺必填）断言
stdout **与** stderr 都不含假凭据字面量，同时断言 sha12 指纹**出现**（指纹是有意保留的对账锚）。

**E) 幂等**：重复跑后连接文件**逐字节一致**、钥匙逐字节一致，输出 `未改`。
**轮换**：只改 env 里的 `ZOS_SECRET_KEY` 重跑 ⇒ 该字段密文变、**未变的字段密文不变**，
新值可被 `node:crypto` 解出。

**F) 拒绝 `literal:` 传敏感值**（会进 `ps` / shell 历史）：
`--set secretKey=literal:…` ⇒ 非零退出且不回显该值。

---

## 5. 运维口径

### 5.1 一条命令（读 env → 生成钥匙 → 写连接文件 → 自检）

```sh
# 湖（S3 兼容：天翼云 ZOS）。env 键名已是全仓既有口径（compose / dbt profiles 同源）
python3 /opt/connection-setup.py --workspace /workspace --id zos --profile zos-s3

# 业务网关（REST bearer）。token 的 env 键名由 --token-env 显式给，脚本不替你猜
python3 /opt/connection-setup.py --workspace /workspace --id lemeng \
    --profile rest-bearer --token-env LEMENG_TOKEN
```

先干跑核对（不建钥匙、不落盘）：加 `--dry-run`。
只读复查（可给文件或目录）：`--check-only /workspace/connections`。
不存在档位时用 `--set`：`--profile none --set kind=literal:s3 --set bucket=env:MY_BUCKET --set secretKey=env:MY_SECRET`。

**成功时的输出**（真实样例，凭据值一律不进日志）：

```
== duckle 加密连接 setup ==
workspace  : /workspace
connection : zos  →  /workspace/connections/zos.json
key        : /workspace/.duckle/keys/secret.key  minted
field kind         plaintext  = rest
field authType     plaintext  = bearer
field authToken    SEALED     len=23 sha12=fcd77c2f93ca  （env LAB_TOKEN）
self-check : clean（1 个敏感字段已封）
result     : wrote /workspace/connections/zos.json（改动 3 项：kind, authType, authToken；未改 0 项）
```

### 5.2 怎么把脚本放进容器（不重建镜像）

镜像不必动。两条路，**任选其一**：

```sh
# ① docker cp 进运行中的 console 容器（一次性 setup 最省事）
docker cp scripts/duckle/connection-setup.py <container>:/opt/connection-setup.py
docker exec <container> python3 /opt/connection-setup.py --workspace /workspace --id zos --profile zos-s3

# ② 常驻化：让它在仓里就能被容器看到（需改 compose 挂载，属部署面决定，本任务未做）
```

> ⚠️ 若走 ①，`docker cp` 进来的文件在容器重建后会消失 —— 这是一次性 setup，符合语义；
> 但要把**命令本身**记进 runbook（本报告 + 正典指针），别让下次靠回忆。
> 若希望它长期在场，走 ②，但那要改 `deploy/data-compose.yml` 的挂载面 ⇒ **属架构/部署面改动，
> 需先经人同意并更新架构文档**（团队规则「架构先行」），本任务**没有**动。

### 5.3 凭据轮换

1. 更新该 console 工作区对应项目的 env（openship，`isSecret`）——**只动这一个账套**；
2. 用**同一条命令**重跑（`--id`/`--profile` 不变）；
3. 脚本会解开既有密文与新的明文比对：变了就重封、没变就**原样保留**（逐字节不变）。
   输出里 `改动 N 项 / 未改 M 项` 就是轮换账。
4. 轮换后按 §6 的「静默 401」风险做一次凭据探活（**必须**，因为 fail-open 不会报错）。

**钥匙本身的轮换是另一件事，且本脚本不提供**：换 `.duckle/keys/secret.key` = 作废该 workspace
**所有**既有密文。本脚本遇到「既有密文解不开」时**拒跑**（exit 5），不会覆盖。

### 5.4 红线（与脚本头注同一份）

1. **绝不回显凭据值**（只打键名 / 来源 / 长度 / sha12）。
2. **绝不覆盖已有钥匙**；既存钥匙坏掉 ⇒ 拒跑，交人工。
3. **敏感字段不许用 `literal:`**（`ps` / 历史可见）。
4. **`.duckle/keys/` 必须与 `connections/` 分开管控**（备份 / 快照 / 镜像构建上下文一律排除钥匙目录）——
   这层加密保护的是「**连接文件单独流出**」，不是「拿到整个 workspace 的人」。

---

## 6. 未验项（诚实清单，逐条给负责人）

| # | 未验的事 | 为什么没验 | 谁来收口 |
|---|---|---|---|
| 1 | **脚本整支在容器内实跑** | openship 执行通道单条命令 10 000 字符上限；脚本 36 KB（gzip+b64 后 16.6 KB）。分块写入运行中的生产容器超出本任务「只读探测」授权。**已验的是它的密码学核在容器解释器上逐字通过（§3.2）**；未验的只是 CLI/文件 IO 骨架在 3.12 上跑（这些 API 在 3.9/3.12 之间无行为差异） | **Wave 1 首航时由协调者**：`docker cp` 进去按 §5.1 跑一次 `--dry-run` + 真跑，确认 `self-check : clean` |
| 2 | 生产 console 工作区的**真实连接**与真实凭据 | 本任务明令零生产写入，生产应用留 Wave 1 | 协调者 |
| 3 | console 面（UI）能否列出/编辑**未登记 `repository.json`** 的连接 | 运行时不需要登记已实测（§3.4）；UI 面要 `duckle-runner web --dist`，而官方 wheel **不带前端产物**（`child-value-paths` §3.1.1 已记） | 首航时顺手看一眼；不影响运行时正确性 |
| 4 | `useSsl` 用字符串 `"true"` vs 布尔 `true` | **两种都被引擎接受**已由源码确认（`s3.rs:154` `as_bool().or_else(as_str != "false")`）；选字符串只是为与 UI 下拉框取值形态一致。**未在真 ZOS 上端到端跑过** | 首航真写湖时自然验掉 |
| 5 | `zos-s3` 档在真实天翼云 ZOS 上的端到端写入 | 本任务只做凭据通路，不碰湖 | Wave 1 首航（正典 §1.1.7 的验收） |
| 6 | 长期形态：脚本常驻容器（compose 挂载） | 属部署面改动，需先经人同意 + 更新架构文档（架构先行） | 待裁决（本任务未动） |

### 6.1 建议的下一步（给协调者）

1. **开一张 issue** 承接本交付（本任务未建 issue、未开 PR —— 按纪律 `feat` 必须先有 issue，
   且派发约定禁止运行期向 GitHub 发文）。建议标题：
   `feat(duckle): 加密连接一次性 setup 脚本——connectionRef 写入方（路径 iii）落地`；
   PR body 需带 `Closes #N`。
2. Wave 1 首航按 §5.1 + §6#1 收口。
3. 首航通过后，把「写入方 = 本脚本」这一条回填进正典 `docs/data-platform-handbook.md` §1.1.7
   的凭据行（现在那里写的是「建连接用会加密的写入方」三种并列，还没有钦定）。

---

## 附：lab 复现入口

```
/tmp/mkconn-lab/
  lab.sh                 # 起两层 foreach 管线跑两个 case + 落盘审计（本报告 §3.3 的全部输出）
  gen-kat.py             # 用 lab venv 的 cryptography 生成 kat.json（= 交付物里那份的生成器）
  mock/mock_probe_8890.py# 回环 mock，只回显 sha12/len，不落明文，日志在 workspace 之外
  probe.py               # §3.2 送进容器的密码学核（由 connection-setup.py 逐字截取 + 驱动器）
  out/、mockstate/        # 原始 stdout 与 mock 请求日志
真引擎：/private/tmp/duckle-lab-p1/.venv074/（duckle 0.7.4 + DuckDB 1.5.5，lab 既有 venv，只读复用）
```

跑法：`python3 mock/mock_probe_8890.py &` 然后 `bash lab.sh`。
