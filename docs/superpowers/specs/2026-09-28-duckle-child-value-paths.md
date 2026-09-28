# 子管线取值通路穷举：foreach / runjob / trigger / try-fallback 能怎么拿到值（含「不加层 + 零明文」的两层解）

> 2026-09-28 ｜ worker `task_d81f40608cb1`（Orca dispatch `ctx_9ae8f5879f41`）
> 出发点：用户质疑 D1 的「只有 `ctl.runjob` 能递值 ⇒ 为递密钥必须加层」——**要求穷举并证实/证伪**。
> 依据：`docs/superpowers/specs/2026-09-28-duckle-l1-secret-path-d1.md`（重点 §7.1/§7.2/§7.3/§8）
>
> **本报告全部活动**：本机 `/tmp/cvp-lab/`（本地 workspace + 回环 mock 网关 + 本地 `duckle-runner serve` 控制台）
> ＋只读源码阅读。**零生产**：未碰湖、未碰生产卷、未改生产调度、未上机、未用真实密钥
> （自造假密钥 `LABSEC_2f9c1a7b4e6d8035`，sha256[:12] = `fcd77c2f93ca`，len 23）。
> **未外发**：mock 网关只在 `127.0.0.1:8878`，回显摘要不落明文。

---

## 0. 结论速览（先看六条）

1. **用户的质疑成立，而且比质疑更彻底。** 不止「不止 runjob 有递口子」——
   **存在「不加层 + 零明文」的两层解**：`connectionRef`（保存的连接）。
   它不是旁门左道，是引擎**为子管线专门写的**一条通路（`connectors.rs:16911-16922`，
   注释原文点名 runjob / iterate / foreach / batch items / install fallback **五条子路径全覆盖**）。
2. **D1 报告没找错机制，但把它定位错了。** §7.1 已经订正「foreach 也认 connectionRef」，
   却只在 §6.3 把它当「形态 C（静止面最优）」带过，§9 的拍板表**只给了 A（三层）/ B（两层但漏明文）二选一**
   ⇒ 读者得到的结论必然是「两层做不到零明文」。**这是「选项表漏了一行」，不是结论错误。**
3. **零明文有一个前置条件**：连接文件必须是**会加密的写入方**写的。
   headless 的 `duckle-runner` **没有开箱即用的加密写入命令**（见 §3.1 写入方调查）——
   这是这条通路唯一的真实新增成本，且是**一次性 setup**，不是每跑一次的成本。
   lab 已用与源码逐字节对齐的实现把「真密文往返」跑通（D1 §8 把它列为未验）。
4. **四条「看起来更像设计意图」的通路全部实测证伪**——子管线一律不解析：
   `${ENV:NAME}`、`secrets.env` / `secrets.enc`、`${VAULT:NAME}`、以及
   **pipeline 级 `parameters`（#317，含 `type: "secret"`）**。最后一条最值得一提：
   引擎**确实**有一套「secret 类型参数、绝不写进运行历史」的机制，但它**只作用于入口面**，不进子管线。
5. **调度层是死路**：`schedules.json` 的 `Schedule` 结构体**没有任何** vars / env / params 字段（字段面已列全，§3.9）。
6. **`ctl.foreach` 确实没有任何 substitution 类参数**（MCP schema 逐字段列全，无别名/未文档化字段）。
   ⇒ 「顶层就是 foreach」这个形态下，**能有值的只有两条**：`connectionRef`（可密文）与 workspace context 变量（必明文）。

---

## 1. 环境与可复现

| 件 | 值 |
|---|---|
| duckle | **0.7.4**（venv `/tmp/duckle-lab-p1/.venv074`） |
| runner binary | `/tmp/duckle-lab-p1/.venv074/lib/python3.9/site-packages/duckle/duckle-runner`（**shipped wheel 内的真二进制**） |
| DuckDB | 1.5.5（同 venv） |
| 源码快照 | `source-analysis/duckle-latest`（与线上 wheel 逐字节一致，D1 §1 已验） |
| workspace | `/tmp/cvp-lab/ws*`（每个场景一个**隔离** workspace，见下） |
| mock 网关 | `mock/mock_probe.py`，`127.0.0.1:8878`；回显 `sha256(tok)[:12]` + `len`，**不落明文**；日志在 workspace **之外**（`mockstate/`） |
| 假密钥 | `LABSEC_2f9c1a7b4e6d8035`（sha12 `fcd77c2f93ca`，len 23） |
| 判读锚（回显 sha12） | `fcd77c2f93ca`=假密钥到达 · `e3b0c44298fc`=**空串**（什么都没带） · `719f5e361456`=字面量 `${ENV:LAB_SECRET}`(17) · `468b991d3fa3`=字面量 `${LABSECRET}`(12) · `7a82e7337f07`=字面量 `${VAULT:LABSEC}`(15) |
| 隔离方法 | 每个场景一个干净 workspace，**只放该场景的夹具**（`build_ws.sh`）——否则 plaintext 命中会来自别的夹具，审计失去意义（本 lab 踩过，见 §3.2 注） |
| 复现入口 | `evidence-child-value-paths/{build_ws.sh,build→audit2.sh,sweep.sh,polltmp.sh,mkenc.py,mock_probe.py}` |

---

## 2. 通路全表（候选 × 生效性 × 明文面 × 是否加层 × 坑）

> **生效性**=对 `ctl.foreach` 的**子管线**是否真的把值送到最内层（**实测**，不是源码推断）。
> **明文面**=值是否在**静止面**（工作区文件 / runs / logs / state / batches / 临时 DB）以明文出现——用「grep 假密钥」审计，**该方法有牙**（已证明能抓到真泄露，见 §3.2）。

| # | 通路 | 值从哪来 | foreach 子管线生效？ | 静止面明文 | 需额外层？ | 坑 / 前置 |
|---|---|---|---|---|---|---|
| **1** | **`connectionRef`（加密连接）** | `connections/<id>.json`（密文） | ✅ **实测到达** | ✅ **零**（全场景逐处干净） | ✅ **不需**（两层） | 需**加密写入方**建连接；加载失败**静默**；`${ENV:}` 写在连接里对子管线**不解析** |
| 2 | `connectionRef`（明文连接） | `connections/<id>.json`（明文） | ✅ 实测到达 | 🚨 **明文常驻** | ✅ 不需 | 同 #1 但不加密 ⇒ 审计必红 |
| 3 | workspace context 变量 | `contexts/*.json` / `.duckle/settings.json`→`context_file` | ✅ **实测到达** | 🚨 **明文常驻** | ✅ 不需 | 需 `repository.json` 登记 `type:"context"`；payload 形状是 `{"variables":[{key,value}]}`（**不是**扁平 map） |
| 4 | `${ENV:NAME}`（子管线属性里） | 真 env / `secrets.env` / `secrets.enc` | ❌ **实测字面量透传** | —（不成立） | — | 只有**顶层**有 env pass |
| 5 | `${ENV:NAME}`（**写在连接字段里**） | 同上 | ❌ **顶层 ✅ / 子管线 ❌** | — | — | **同文件不同深度行为不同**＝静默错凭据（§3.4 陷阱） |
| 6 | `${VAULT:NAME}` | `DUCKLE_VAULT_COMMAND` 外部取 | ❌ **实测字面量透传** | — | — | 顶层 ✅ 实测通过；子管线 ❌ |
| 7 | pipeline 级 `parameters`（#317，**含 `type:"secret"`**） | CLI `--param` / API / plan | ❌ **实测字面量透传** | — | — | 顶层 ✅（`--param` 与 `default` 都验过）；**子管线不应用** |
| 8 | call-site subs：`ctl.runjob.contextVariables` / `ctl.runpipeline`·`ctl.trigger.parameters` | 调用点（顶层可写 `${ENV:}`） | ⚠️ **是子管线的"父"**，不是 foreach 的口子 | ✅ 零（D1 已证） | 🚨 **要加层**（foreach 不接受调用点变量） | D1 形态 A 的依据 |
| 9 | `${ITER_INDEX}` / `${ITER_ITEM_*}` | 驱动表列值 | ✅ 到达 | 🚨 若值来自行 ⇒ 明文进驱动表/run DB | ✅ 不需 | ＝spec 选项 (b) 行值，D1 判「最差」 |
| 10 | `ctl.setvar` → run vars → `carried` | SQL 表达式 | ✅ 到达 | 🚨 run DB 明文（进程期＋SIGKILL 驻留）；🚨 `dispatch:"queue"` 进 `batches/*.ndjson` | ✅ 不需 | D1 形态 B；两条红线 |
| 11 | `transportRef` | `connections/<id>.json`（kind `http`） | ✅ 解析（同一函数） | 非凭据（代理/超时/UA） | ✅ 不需 | **不是**密钥通路 |
| 12 | 调度层 `schedules.json` | — | ❌ **结构体无该字段** | — | — | 字段面已列全（§3.9） |
| 13 | MCP `create_connection` 写连接 | — | 🚨 **产出的连接对子管线不可用** | 🚨 `authToken` 走**明文** | — | 守卫表漏 `authToken`；受守卫字段只能写 `${ENV:}` ⇒ 子管线不解析 |
| 14 | 兜底/其它子路径（`ctl.try` fallback、`ctl.iterate`、batch item） | 同 #1 | ✅ **实测到达**（与 foreach 同一函数） | 同 #1 | ✅ 不需 | — |

**判定**：唯一同时满足「子管线生效 + 零明文 + 不加层」的是 **#1 `connectionRef` + 加密连接**。

---

## 3. 逐通路明细与证据

### 3.1 `connectionRef` —— 唯一的两层零明文解

**为什么它必然对每条子路径都生效**（源码锚，`crates/duckdb-engine/src/connectors.rs`）：

```
connectors.rs:16885  pub(crate) fn run_subpipeline_as(&self, path, subs, item) {
connectors.rs:16911-16922
  // A node may hold only `connectionRef` … Every surface resolves refs on the document
  // it was handed, and a child is not that document - it is read from disk right here -
  // so a child using a saved connection failed for a field the connection provides.
  // Every child path (runjob, iterate, foreach, batch items, install fallback) comes
  // through this function, so this is the one place…
  duckle_secrets::resolve_connection_refs(ws, &mut sub_doc.nodes)
```

`resolve_connection_refs`（`duckle-secrets/src/lib.rs:747`）→ `resolve_connection_ref_props`（:377）→
`load_connection`（:331，**STRICT**，会解密）→ `merge_generic_connection`（:650）把连接的
凭据**与配置**字段（`accessKey`/`secretKey`/`endpoint`/`urlStyle`/`useSsl`/`bucket`…）合并进节点属性。
**连接优先于节点内联值** ⇒ 轮换只改一处。

**实测矩阵（全部用加密连接，除注明外）**

| 子路径 | 形态 | exit | mock 看到 | 证据 |
|---|---|---|---|---|
| `ctl.foreach`（inline，`concurrency:1`） | 两层：顶层 foreach → 子 | 0 | `fcd77c2f93ca` ✅ | `run-wsc-enc`、`audit-wsc-enc.txt` |
| `ctl.foreach`（**`dispatch:"queue"`**）+ **worker 进程** | 两层 + 队 | 0 ×3 | `fcd77c2f93ca` ✅ | mock 日志 41-43 行；`batches/*.ndjson` **干净** |
| `ctl.iterate` | 两层 | 0 | `fcd77c2f93ca` ✅ ×2 | `run-iterate.out` |
| `ctl.try` **fallback** | 两层（下游故意失败） | **1**（按设计） | `fcd77c2f93ca` ✅ | `run-try.out`；`logs/`+`runs/` **干净** |
| `ctl.runjob` | 两层 | 0 | `fcd77c2f93ca` ✅ | `run-runjob.out` |
| 单层（顶层直接 `src.rest` + connectionRef） | 一层 | 0 | `fcd77c2f93ca` ✅ | `run-topenv.out` |

> **worker 侧是相对 D1 的净增益**：D1 §8 把「`dispatch:"queue"` + 形态 A（`contextVariables`）的 worker 侧」列为**未验**，
> 并在源码判读里推断 **`contextVariables` 不会随批次文件到达 worker**（`inherited_subs` 在新进程里为空）。
> `connectionRef` **不受这个限制**——它的值不是从父进程继承的，是子进程**自己从磁盘解析**的。
> 实测 3 个 worker 各自独立取到凭据，且 `batches/*.ndjson` 里**根本没有密钥**（对比 D1 形态 B 的 `"vars":{…,"LABSECRET":"LABSEC_…"}`）。

**落盘审计（隔离 workspace，逐处 grep 假密钥）**

| 场景 | mock sha12 | pipelines | connections | contexts | .duckle | logs | runs | state | batches | out | TMPDIR |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **`enc`（加密连接）** | `fcd77c2f93ca` ✅ | clean | **clean** | (absent) | clean | clean | clean | (absent) | (absent) | clean | clean |
| `plain`（明文连接）**对照** | `fcd77c2f93ca` ✅ | clean | 🚨 **PLAINTEXT** | — | clean | clean | clean | — | — | clean | clean |
| `ctx`（context 变量）**对照** | `fcd77c2f93ca` ✅ | clean | — | 🚨 **PLAINTEXT** | clean | clean | clean | — | — | clean | clean |
| `none`（负对照，无提供方） | `e3b0c44298fc`（空串） | clean | — | — | — | clean | clean | — | — | clean | clean |
| `envph`（连接的字段是 `${ENV:}`） | `719f5e361456`（**字面量**） | clean | clean | — | — | clean | clean | — | — | clean | clean |

⇒ **对照行（plain / ctx）证明审计有牙**——不是「因为没写东西所以干净」。
**只有 `enc` 行是「值真的到了 + 全场景逐处零明文」。**

**运行期临时 DB（D1 §4.3 的判决手法，对 connectionRef 重跑）**

```
ws=wsc-poll exit=0 | distinct run DBs seen = 41 | observations = 606 | plaintext hits = 0
survivors after exit: 0
```

41 个 run DB（40 窗 × 每层）被反复扫到 606 次，**明文命中 0**，进程退出后无残留。
（对比 D1 实测的 `ctl.setvar` 通路：run DB 里有 `duckle_var__LABSECRET` 与明文，SIGKILL 后驻留。）
⇒ **connectionRef 通路连运行期数据库面都是干净的**，不需要 D1 形态 B 那两条红线。

#### 3.1.1 写入方调查（唯一的真实成本）

`encrypt_payload_json`（`duckle-secrets/src/lib.rs:284`）的**全部调用点**（全仓 grep）：

| 写入方 | 位置 | headless 可用？ |
|---|---|---|
| 桌面 app | `apps/desktop/src/secrets.rs:20` | ❌ 需要桌面 |
| Web 版编辑器 | `duckle-runner/src/serve.rs:877`（命令 `connection_encrypt_payload`） | ⚠️ 需要 `duckle-runner web --dist <dir>`；**wheel 不带 `--dist` 前端产物** |
| `duckle-runner serve`（管理控制台） | — | ❌ **实测 404**：`/api/cmd/*` 只挂在 `route_web`（web 版），控制台走 `route_console`，没有这条命令 |
| MCP `create_connection` | `crates/duckle-mcp/src/tools.rs:1667` | ❌ **故意不加密**（源码注释：「the MCP server cannot encrypt at rest (that key lives in the desktop app)」） |

⇒ **headless 部署没有开箱的加密写入命令。** 三条可行路径：

- **(i) 跑一次 Web 版**：`duckle-runner web --dist <构建产物>` → `POST /api/cmd/connection_encrypt_payload`
  （需 admin 角色；`--token`/`DUCKLE_CONSOLE_TOKEN` 直接给 admin，**lab 已验** `/api/whoami → {"label":"token","role":"admin"}`）。
  这是**官方写入方**，但要求你能构建/取得前端产物。
- **(ii) 桌面 app 建好连接，连接文件随 workspace 下发**（连接文件是密文，可安全随仓/随包走，**前提是 `.duckle/keys/` 不跟着走**）。
- **(iii) setup 脚本按源码方案自己封**（本 lab 用的就是这条，见 `mkenc.py`）。
  方案完全确定、无隐藏参数：`AES-256-GCM`，密钥 = `<ws>/.duckle/keys/secret.key`（**32 原始字节**，0600），
  密文 = `"enc:v2:" + base64(nonce12 ‖ ct)`，**AAD = `<connection_id>` + `0x1f` + `<字段名>`**（`aad_for`，:171）。
  **lab 实测：脚本封的密文被引擎逐位正确解开**（mock 收到 `fcd77c2f93ca`）⇒ 实现与引擎语义等价。

> **诚实标注**：路径 (i) 的 `connection_encrypt_payload` 端点本身**未在 lab 端到端跑通**（wheel 无 `--dist`），
> 只验到「路由归属 + admin 鉴权」两层。**路径 (iii) 已端到端验通**（含引擎解密）。
> 生产若选 (i)，先把「跑通一次 web 版」当成一个独立小任务验掉。

#### 3.1.2 坑（必须进规范）

1. **「零明文」的边界要说清**：`secret.key` 就在 workspace 里（`.duckle/keys/`），
   所以这层加密保护的是「**连接文件单独流出**」（进 git / 备份 / 镜像 / 分享包），
   **不是**「拿到整个 workspace 的人」。⇒ **`.duckle/keys/` 必须与 `connections/` 分开管控**
   （备份/快照/镜像构建上下文都要排除它）。**把 workspace 整体备份的人，等于备份了明文。**
2. **加载失败是静默的（fail-open）**：`resolve_connection_ref_props:411-414`
   `Err(e) => return if is_salesforce { Err(e) } else { Ok(()) }`。
   非 Salesforce 节点上连接**文件缺失 / 密钥缺失 / AAD 不符**→ **exit 0、无报错、凭据为空**。
   ⇒ 典型的「静默 401」。**必须单独探活**（例如连接自检 job，或在 L0 加一条只用凭据的廉价值探测）。
3. **`${ENV:}` 写在连接里 = 同文件不同深度两种行为**（见 §3.4 陷阱）。
4. **节点级连接是「一个组件一条」**：REST 源要一条 `kind:"rest"`，S3 sink 要一条 `kind:"s3"`。
   连接里的 `urlStyle` 会被规范化（`path`/`vhost`），`rest` 连接的 `url` **只填节点的空位**、`headers` **按 key 合并且节点优先**。

---

### 3.2 workspace context 变量 —— 生效，但必明文

**源码锚**（`connectors.rs:19824`）：

```
pub(crate) fn substitute_into_child(content, subs) -> String {
    let mut merged = workspace_context_vars();      // ← 子管线也合并工作区 context 变量
    for (k, v) in subs { merged.insert(k.clone(), v.clone()); }   // 调用点/ITER 覆盖
    …按 ${KEY} 逐个做 JSON 转义后替换…
```

`workspace_context_vars()`（:20800）→ `context_vars_for_workspace()`（:20738）读：
`${workspace}` / `${projectroot}` / 时间内建 / `repository.json` 里 `type:"context"` 的
`contexts/<id>.json`（payload 形状 **`{"variables":[{"key":…,"value":…}]}`**，并同时注册 `KEY` 与 `<ctxname>.KEY`）
/ 最后叠加 `.duckle/settings.json` 的 `context_file`（`context.rs:810`）。

**实测**：`contexts/lab.json` 放 `LABSECRET`，子管线属性写 `X-Lab-Secret: ${LABSECRET}` → **到达**（`fcd77c2f93ca`）。
**审计**：`contexts/*.json` 🚨 **明文常驻**（随 workspace 进备份/快照/git）。

> **本 lab 的一次自我纠错（方法论，值得记）**：第一版审计把 5 个场景跑在**同一个** workspace 上，
> 于是 `enc` 场景也报 `connections/ PLAINTEXT`——命中的是 `plain` 场景留下的夹具。
> **假绿和假红同源：不隔离夹具，审计结论不可信。** 定稿版每个场景一个隔离 workspace。

---

### 3.3 `${ENV:NAME}` / `secrets.env` / `secrets.enc` —— 只作用于顶层

**源码锚**（`duckle-runner/src/main.rs:843`，`apply_env_pass`）：

```
apply_vault(doc)                      // ${VAULT:NAME}
读 env_path（secrets.env，明文）        // ← 都在这一层
load_secrets_enc(workspace)           // secrets.enc（密文，口令 DUCKLE_BUNDLE_PASSPHRASE）
for node in &mut doc.nodes { substitute_deep(props, &replace) }   // ← 只遍历"这一个" doc
```

这个函数**只被 runner 对顶层文档调用一次**；子文档由 `run_subpipeline_as` 从磁盘读、只走
`substitute_into_child`（只认 `${KEY}`，不认 `${ENV:}`）。全仓 `${...}` 命名空间只有两个
（grep：`${ENV:` 85 处、`${VAULT:` 16 处），都只在这一层被解析。

**实测**：子管线里 `X-Lab-Secret: ${ENV:LAB_SECRET}` → mock 收到 **`719f5e361456` len 17 = 字面量**（未解析）。
`secrets.env` / `secrets.enc` 同理：它们只是给顶层 `${ENV:}` **供值**，本身不构成子管线通路。

---

### 3.4 `${VAULT:NAME}` —— 顶层通过、子管线失败（实测对照）

`apply_vault`（`context.rs:247`）用 `DUCKLE_VAULT_COMMAND`（模板，`{name}` 替换，一次运行内按名缓存）外部取值，**不落盘**——
这在设计上是最干净的一条密钥通路，所以值得严格证伪。

lab 造了一个 vault（`DUCKLE_VAULT_COMMAND="cat /tmp/cvp-lab/vault/{name}"`），**同一个子管线文件**跑两次：

| 跑法 | exit | mock 看到 | 判定 |
|---|---|---|---|
| 作为**顶层**跑（单层） | 0 | `fcd77c2f93ca` len 23 resolved=true | ✅ **解析** |
| 作为 **foreach 子管线**跑（两层） | 0 | `7a82e7337f07` len 15 resolved=false | ❌ **字面量 `${VAULT:LABSEC}`** |

⇒ 与 `${ENV:}` 完全同形：**顶层 ✅ / 子管线 ❌**。

#### ⚠️ 由此得到一条必须进规范的陷阱（比 D1 的 §6.4 四条更阴）

**同一个连接文件、同一个节点、同一份属性，只因为深度不同，行为相反：**

```
connections/<id>.json  { "authToken": "${ENV:LEMENG_TOKEN}" }
   ├─ 该连接被"顶层"节点引用   → ${ENV:} 被 env pass 解析 → ✅ 正常取到凭据
   └─ 该连接被"子管线"节点引用 → 无人解析         → ❌ 把字符串 "${ENV:LEMENG_TOKEN}"
                                                     原样当 Bearer token 发出去
```

lab 对这条**特意正反各测一次**（`child-conn-envph` 字面量 / `topenv` 顶层解析成功），
两次都 **exit 0**——**没有任何一处会报错**。这正是「静默 401」的标准形状，
也是 §3.1.2 坑 #2 的姊妹坑：**连接里的占位符，深一层就变成字面量。**
⇒ **规范写法：连接字段一律写实值（由加密保护），不写 `${ENV:}`。** 要写 `${ENV:}` 就只许顶层引用。

---

### 3.5 pipeline 级 `parameters`（#317，含 `type: "secret"`）—— 不作用于子管线

这是本次穷举里**最像「引擎设计意图」**的一条，所以单独列。`plan/mod.rs:19` `PipelineDoc` 有：

```
#[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
pub parameters: crate::params::Schema,        // #317 类型化参数契约
```

`params.rs` 的模块文档原话：

> **Secrets are a type, not a naming convention** — A parameter declared `secret` is never written to
> run history, a receipt, or any other record.
> Everything here happens **once**, before compilation, and every surface gets the same typed result:
> **desktop, console, CLI, HTTP API, MCP, scheduler, Plans, backfills, retry.**

`ParamType` = String / Integer / Number / Boolean / Date / Datetime / **Secret**；
`ParamSpec` 有 `default` / `enum` / `minimum` / `maximum` / `pattern` / `description`。

**如果它作用于子管线，那就是最理想的解**（secret 类型天然不落历史）。**实测：不作用。**

| 场景（**同一个管线文件**，`parameters:{"LABSECRET":{"type":"secret","default":"LABSEC_…"}}`，属性写 `${LABSECRET}`） | exit | mock 看到 | 判定 |
|---|---|---|---|
| 作为**顶层**跑 + `--param LABSECRET=…` | 0 | `fcd77c2f93ca` len 23 | ✅ **解析**（`--param` 生效） |
| 作为**顶层**跑，**不给** `--param`（吃 `default`） | 0 | `fcd77c2f93ca` len 23 | ✅ **解析**（`default` 生效） |
| 作为 **foreach 子管线**跑 | 0 | `468b991d3fa3` len 12 = 字面量 `${LABSECRET}` | ❌ **不解析** |

**且这不是 bug，是设计边界**：`params.rs` 的入口清单数完了 desktop/console/CLI/API/MCP/scheduler/Plans/backfills/retry，
**「子管线运行」不在其中**；`apply_params` 的调用点也只在 `main.rs`/`serve.rs`/`backfill_exec.rs`/`context.rs`，
`connectors.rs`（子管线路径）**一处都没有**。
⇒ 想要「`parameters` 下传到子管线」＝ **改上游**（D1 选项 (d) 的同族），不可自控。
**但这是一条值得报给上游的 feature request**（比 `ctl.foreach` 加 `contextVariables` 更贴已有设计）。

---

### 3.6 `ctl.foreach` 的完整属性面（MCP schema 逐字段，无遗漏）

`get_component_schema ctl.foreach` 给出的**全部**属性（`sections[0].fields`）：

| key | kind | 备注 |
|---|---|---|
| `pipelineRef` | pipeline-ref | required |
| `itemKey` | column | 命名每次迭代的 run |
| `concurrency` | integer | 仅 `dispatch=inline` 可见 |
| `dispatch` | select | `inline` / `queue` |
| `maxAttempts` | integer | 仅 queue |
| `retryBackoff` | select | `fixed`/`exponential`，仅 queue |
| `retryInitialSeconds` | integer | 仅 queue |
| `retryMaxSeconds` | integer | 仅 queue |

**没有** substitutions / parameters / contextVariables / vars / env / secrets 任何同义字段，
也**没有**别名或未文档化字段。对照组（同为子管线发起方）：

| 组件 | 属性面 |
|---|---|
| `ctl.runjob` | `pipelineRef` · `waitForCompletion` · **`contextVariables`(key-value)** |
| `ctl.runpipeline` / `ctl.trigger`（trigger 是 runpipeline 的别名） | `pipelineRef` · `waitForCompletion` · **`parameters`(key-value)** |
| `ctl.iterate` | `pipelineRef` · `count` —— **没有** |
| `ctl.parallelize` | `maxConcurrency`（并行分支，**不是**子管线） |
| `ctl.setvar` | `name` · `value`（SQL 表达式） |

⇒ **D1 §0.2 的判断成立且已用 MCP schema 复核**：`ctl.foreach` 确实没有调用点变量口子。
**但这不是「所以两层做不到」——两层靠的是 §3.1 的 connectionRef，不是靠这个口子。**

**全仓穷举：值能进子管线的写入点只有这几个**（`inherited_subs` 全仓仅 `connectors.rs:16940` 一处写入）：

| 来源 | 锚 | 内容 |
|---|---|---|
| 调用点 subs | `connectors.rs:16793`（`run_subpipeline_with_subs`，由 `lib.rs:2146` 调用） | `contextVariables` / `parameters` |
| 逐行 subs | `lib.rs:2283` / `lib.rs:2310` | `ITER_INDEX` / `ITER_ITEM_*`（＋`sets_run_vars` 时携带的 run vars） |
| 批次 vars | `work.rs:338` | `batches/*.ndjson` 里那一行 |
| **磁盘解析** | `connectors.rs:16921` | **`connectionRef`（与上面三条正交，不依赖继承）** |
| **工作区 context** | `connectors.rs:19828` | `contexts/*.json` / `context_file` |

---

### 3.7 调度层（`schedules.json`）—— 死路

`duckdb-engine/src/schedules.rs:51` `pub struct Schedule` 的**全部**字段：

```
id · pipeline_id · name · enabled · plan_id · kind
timezone · exclude · misfire · catchup
last_run_at · last_run_status · last_run_duration_ms · last_run_error · next_run_at
```

**没有任何** vars / env / params / context 字段。⇒ **调度层无法给管线注入变量**，这条候选**证伪**（字段面已列全，非抽样）。

---

### 3.8 MCP `create_connection` —— 错误的写入方（解释 D1 §7.2 的 🚨）

MCP 的守卫（`duckle-mcp/src/tools.rs:1946` `first_plaintext_secret` + `:1894` `is_secret_key`）
**拒绝字面密钥**，要求 `${ENV:KEY}` 占位。但两张表**不一致**：

| 表 | 用途 | 内容 |
|---|---|---|
| `SENSITIVE_KEYS`（`duckle-secrets/src/lib.rs:29`） | **加密** | password, secretKey, accessKey, accountKey, sessionToken, pat, token, apiKey, passphrase, secret, clientSecret, accessToken, **authToken** |
| `is_secret_key`（`duckle-mcp/src/tools.rs:1894`） | **MCP 拒绝** | 同上**但缺 `authToken`**（另有 `accountname`） |

**实测（lab，`/tmp/cvp-lab/mcptest`）**：

| 调用 | 结果 |
|---|---|
| `create_connection {kind:"rest", authToken:"LABSEC_…"}` | ✅ **接受** → 落盘 `"authToken": "LABSEC_2f9c1a7b4e6d8035"` 🚨 **明文** |
| `create_connection {kind:"s3", accessKey:"AKIALAB", secretKey:"LABSEC_…"}` | ❌ **拒绝**：`connection field 'accessKey' contains a literal secret; MCP-created connections must use a ${ENV:KEY} placeholder` |

⇒ **MCP 无论走哪条都产不出「能喂子管线」的连接**：
- 受守卫字段 ⇒ 只能写 `${ENV:}` ⇒ **子管线不解析**（§3.3 实测）＝ 静默错凭据；
- `authToken` ⇒ 守卫漏掉 ⇒ **明文落盘**（＝ D1 §7.2 那条 🚨 的确切成因）。

**这解释了 D1 为什么把 connectionRef 判成「有坑的配角」**：D1 用 MCP 建连接做实验，
拿到的是**最差的那一种写入方**。换成会加密的写入方，坑的性质就完全不同了（只剩 §3.1.2 那几条）。

---

## 4. 正面回答用户质疑 + 可直接抄的写法

### 4.1 正面回答

> **质疑：不可能只有 runjob 有递口子，是不是我们没用对方法。**

**成立，两层解存在。** 分三句：

1. **「不止 runjob」是对的**：能进子管线的写入点共 **5 类**（§3.6 表）——
   调用点 subs、逐行 `ITER_*`、批次 vars、**`connectionRef`（磁盘解析）**、**工作区 context（磁盘解析）**。
   其中后两类**与「谁是父文档」无关**，所以 `ctl.foreach` 也能用。
2. **「用错了方法」也对**：D1 的结论建立在 **MCP `create_connection`** 这个写入方上，
   而那恰好是**唯一明文/占位符**的写入方（§3.8）。换写入方，`connectionRef` 立刻从「有坑的配角」
   变成**唯一同时满足两层 + 零明文**的通路。
3. **但「两层 + 零明文」不是白来的**：代价从「多一层薄入口」变成了
   **「连接要由会加密的写入方建（一次性 setup）+ `.duckle/keys/` 要单独管控 + 连接加载失败要单独探活」**。
   这是一个**不同性质的代价**，该由人拍板，不该由实验报告替人拍板。

### 4.2 可直接抄的写法（两层，零明文）

**形态 C′（推荐）**：顶层 `ctl.foreach` → 子管线（重管线照抄，只把凭据改成 `connectionRef`）。

```
┌─ 顶层（L1，唯一被 ${ENV:} 解析的文档——但本形态不需要它）───────────┐
│  src.csv(窗口表) → ctl.foreach  pipelineRef="<ws>/pipelines/l0-heavy.json" │
│                                   itemKey="window"  concurrency=1           │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ 子管线自己从磁盘解析连接（不经父进程）
┌─ L0 重管线（子，现重管线逐字保留，凭据改为引用连接）─────────────────┐
│  src.rest   connectionRef="lemeng-prod"   ← authToken 在连接里（密文）│
│  snk.minio  connectionRef="zos-prod"      ← accessKey/secretKey/endpoint/bucket │
└──────────────────────────────────────────────────────────────────────┘
```

**顶层（`top.json`，逐字可抄）**：
```json
{
  "name": "l1-window-driver",
  "nodes": [
    {"id":"w0","position":{"x":0,"y":0},"data":{"label":"windows","componentId":"src.csv","properties":{
      "path":"${workspace}/data/windows.csv","hasHeader":true,"delimiter":","}}},
    {"id":"fe","position":{"x":220,"y":0},"data":{"label":"for each window","componentId":"ctl.foreach","properties":{
      "pipelineRef":"${workspace}/pipelines/l0-heavy.json",
      "itemKey":"window","concurrency":1}}}
  ],
  "edges": [
    {"id":"e0","source":"w0","sourceHandle":"main","target":"fe","targetHandle":"main","data":{"connectionType":"main"}}
  ]
}
```

**子（`l0-heavy.json`，只改动凭据两处）**：
```json
{
  "name": "l0-heavy",
  "nodes": [
    {"id":"p1","position":{"x":0,"y":0},"data":{"label":"lemeng","componentId":"src.rest","properties":{
      "connectionRef":"lemeng-prod",
      "url":"https://<gw>/agi/api/….find",
      "method":"POST",
      "body":"{\"page_number\":1,\"page_size\":200,\"window\":\"${ITER_ITEM_WINDOW}\"}",
      "responsePath":"/result/content","checkpoint":true}}},
    {"id":"sink","position":{"x":300,"y":0},"data":{"label":"lake","componentId":"snk.minio","properties":{
      "connectionRef":"zos-prod",
      "key":"l1/branch/system_book=${SYSTEM_BOOK}/window=${ITER_ITEM_WINDOW}/all.parquet",
      "format":"parquet","mode":"overwrite","compression":"zstd"}}}
  ],
  "edges": [
    {"id":"e0","source":"p1","sourceHandle":"main","target":"sink","targetHandle":"main","data":{"connectionType":"main"}}
  ]
}
```
> `${workspace}` 上例在**顶层与子管线两处都实测可用**（`run-wsvar.out`：窗口表被读到、子管线被找到、sink 落在 `$WS/out/`），
> 所以父/子都建议用它而不是绝对路径。
> 注意：`bucket` / `endpoint` / `urlStyle` / `useSsl` 这类**非密钥配置**也一并从连接合并（§3.1），
> 所以连接要写全。`rest` 连接的 `url` **只填节点的空位**、`headers` **按 key 合并且节点优先** ⇒
> 每条查询仍可自带 URL/header。子文档里 **绝不要** 写 `${ENV:...}`（§3.4）。

**连接（`connections/lemeng-prod.json`，密文；`authToken` 处是 `enc:v2:…`）**：
```json
{"kind":"rest","authType":"bearer","authToken":"enc:v2:<base64(nonce12‖ct)>"}
```
**生成方式三选一**（§3.1.1）：Web 版 `connection_encrypt_payload` / 桌面 app / setup 脚本（`mkenc.py`，本 lab 验通）。

**落地前必须补的三件事**（否则「零明文」是纸面的）：
1. **连接自检**：一个只用凭据的廉价值 job（或 `duckle validate` 之外的探活），
   验证「连接能解密且非空」——因为加载失败**不会让管线红**（§3.1.2 #2）。
2. **`.duckle/keys/` 的管控制度**：排除出备份/快照/镜像构建上下文；与 `connections/` 分开授权。
3. **规范红线**：连接字段写实值（不写 `${ENV:}`）；子文档不写 `${ENV:}`/`${VAULT:}`；
   密钥不进 URL/query、不进返回行（D1 §6.4 原四条继续有效）。

---

## 5. 与 D1 报告「形态 A（三层）」的对比与建议

| 维度 | **D1 形态 A**（`ctl.runjob.contextVariables`） | **D1 形态 B**（`ctl.setvar` + foreach） | **本报告形态 C′**（`connectionRef` 加密连接） |
|---|---|---|---|
| 层数 | 🚨 **3 层**（入口 → L1 → L0） | 2 层 | ✅ **2 层** |
| 静止面明文 | ✅ 零 | ✅ 成功路径零 | ✅ **零**（含对照验证） |
| 运行期 run DB | ✅ 零（D1 实测 5 DB / 0 命中） | 🚨 明文（进程期＋SIGKILL 驻留） | ✅ **零**（实测 41 DB / 606 观测 / 0 命中） |
| `dispatch:"queue"` | ⚠️ D1 判「值到不了 worker」（**未实跑**） | 🚨 明文进 `batches/*.ndjson` | ✅ **实测 worker 也取到，且批次文件干净** |
| 失败路径 | ✅（前提：密钥不进 URL） | ✅（同左） | ✅ **实测 `ctl.try` 失败场景 logs/runs 干净** |
| 新增一次性成本 | 多一层薄入口（改手册 §1.1.7 形态定义） | 无 | **加密写入方 setup + 密钥管控 + 连接自检** |
| 每节点改动 | 改占位符名 | 加 `ctl.setvar` 节点 | 加 `connectionRef` + 把凭据搬进连接（**轮换收敛到一处**） |
| 上游依赖 | 无（已可用） | 无（已可用） | 无（0.7.4 已可用） |
| 适配全部子路径 | 仅 runjob/runpipeline/trigger 作为父 | 仅 foreach/iterate | ✅ runjob/iterate/foreach/batch/fallback **全覆盖**（实测 5/5） |

**建议**：

1. **首选 C′**——它是唯一同时拿到「两层 + 全场景零明文 + worker 可用 + 全子路径覆盖」的形态，
   而且顺带解决了凭据轮换（连接优先于节点内联值）。
2. **A 作为退路保留**——如果你不接受「加密写入方 + 密钥管控 + 连接自检」这套新增运维面，
   那么 A 是**不需要新的静止面工件**的零明文解，代价是多一层。**两者是「运维面 vs 层数」的取舍。**
3. **B 不再推荐**——它的两条红线（queue 明文、SIGKILL 驻留）在 C′ 里都不存在。
4. **D1 §9 的拍板表应补第三行 C′**，并在 §6.3 把形态 C 从「备选」升格为与 A 并列的主选。
   **D1 §7.1 已经把机制挖出来了，只是没走完最后一步。** 本报告把最后一步走完了。
5. **另报一条上游 feature request**（非阻塞）：让 pipeline 级 `parameters`（#317，含 `secret` 类型）
   下传到子管线运行。它是现有设计里最贴近「安全的子管线参数」的机制（secret 类型天然不落历史），
   只是入口清单里漏了「子管线」这一面。

---

## 6. 硬性写法红线（在 D1 §6.4 四条之外新增）

D1 §6.4 原四条（继续有效）：密钥不进 URL/query · 密钥不进返回行 · 子文档不写 `${ENV:}` · queue 下不把密钥经 `ctl.setvar`。

**新增四条**：

5. **连接字段写实值，不写 `${ENV:}`**——连接里写 `${ENV:}` 只在顶层能解析，进子管线**静默变字面量**
   （实测：同一个连接文件、同一个节点，顶层 ✅ / 子管线 ❌，两次都 exit 0）。
6. **`connectionRef` 必须配「连接自检」**——非 Salesforce 节点上连接加载失败是 **fail-open（exit 0、凭据空）**，
   管线不会红，只会静默 401。
7. **`.duckle/keys/` 与 `connections/` 分开管控**——密钥与密文同处一个 workspace 时，
   「零明文」只对「连接文件单独流出」成立；**整包备份 workspace = 备份了明文**。
8. **别用 MCP `create_connection` 建子管线要用的连接**——受守卫字段只能写 `${ENV:}`（子管线不解析），
   `authToken` 会**明文落盘**（守卫表漏词）。

---

## 7. 未验 / 待验（不冒充）

| 项 | 为什么没测 | 风险 |
|---|---|---|
| `duckle-runner web --dist` 的 `connection_encrypt_payload` **端到端** | wheel **不带前端产物**，`--dist` 无源可用 | 中——它是「官方写入方」这条路的前提；本 lab 用等价实现（`mkenc.py`）验通了引擎侧解密 |
| 连接字段**真密文**由桌面 app 产生时的行为 | 本机无桌面 app | 低——两种写入方都调同一个 `encrypt_payload_json` |
| `ctl.try` fallback 在 **`dispatch:"queue"`** 下的组合 | 未构造该组合 | 低——批次的子路径与 foreach 共用 `run_batch_item`→`run_subpipeline_as` |
| 生产 workspace 的 `.duckle/keys/` 生命周期（进不进备份/快照） | 属部署面，lab 覆盖不到 | **高**——直接决定「零明文」是否成立，须由人在部署面确认 |
| `deadLetter` / `ctl.deadletter` 落盘面 | 未构造死信场景 | 低——按设计接**行数据**，与 D1 §4.2 #13 同规矩 |
| `${VAULT:}` 在**生产真实 vault** 下的行为 | lab 用 `cat` 假 vault | 低——解析路径与取回值无关 |

## 8. 证据索引（`./evidence-child-value-paths/`）

| 文件 | 内容 |
|---|---|
| `audit-wsc-{enc,plain,ctx,none,envph}.txt` | **隔离 workspace 的逐处落盘审计**（5 场景 × 12 个持久面）；`plain`/`ctx` 两行 🚨 即「审计有牙」的证明 |
| `mkenc.py` | 按源码方案自封加密连接的脚本（**引擎解密已验通**）；也记录了 `SENSITIVE_KEYS` 与 AAD 规则 |
| `build_ws.sh` / `audit2.sh` / `sweep.sh` / `polltmp.sh` / `probe.sh` | 复现入口（隔离工作区构建 → 审计 → 扫描 → 运行期 DB 轮询） |
| `mock_probe.py` | mock 网关（回显摘要，不落明文；日志在 workspace 之外） |
| `pipelines/child-conn-{plain,enc,envph}.json`、`child-ctx.json` | 四个关键子管线（可直接抄） |
| `top-try.json` | `ctl.try` fallback 场景的顶层 |
| `batches-sample.txt` | `dispatch:"queue"` 的批次行原文（**无密钥**，对比 D1 形态 B 的 `run-s4.out`） |

**原始运行目录**：`/tmp/cvp-lab/`（`out/run-*.out`、`mockstate/requests.log`、各 `wsc-*/`）。
`/tmp` 会被清理，故关键产物已复制进本目录。

---

## 附：本报告相对 D1 的账（三条）

1. **订正定位**：D1 §6.3/§9 把 `connectionRef` 当「静止面最优的备选」，
   **§9 拍板表漏了它**。本报告证明它是**唯一的「两层 + 零明文」解**，应升格为主选并列。
2. **补完 D1 §8 的两项未验**：
   - 「`connectionRef` **真密文**往返」→ **已验**（引擎解密逐位正确）。
   - 「`dispatch:"queue"` + 形态 A 的 worker 侧」→ **已验，且结论反转**：
     `contextVariables` 到不了 worker（D1 推断成立），但 **`connectionRef` 到得了**。
3. **新增证伪四条**：`${ENV:}` / `secrets.env` / `secrets.enc` / `${VAULT:}` 对子管线全部无效；
   pipeline 级 `parameters`（#317，含 secret 类型）**不作用于子管线**；调度层无字段可注入。
