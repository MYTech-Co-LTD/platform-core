# 观测面命名门禁进 CI（`catalog build` + `catalog lint`）—— 2026-09-29

> Issue #337 · 缺陷案例 #334（两条 retail 子管线缺 `snk.minio` 的 `bucket` ⇒ 零售新鲜度锚是死规则）。
> 性质：**纯仓内改动**（新增 1 个守卫 + 1 个单测 + ci.yml 一个 job 加两步），零生产操作、零管线内容改动。

## 交付物

| 文件 | 是什么 |
|---|---|
| `scripts/check-duckle-catalog.mjs` | 门禁本体：构造最小工作区 → 真跑 `catalog build` + `catalog lint` → 判红/判绿 |
| `scripts/check-duckle-catalog.test.ts` | 7 条黑盒单测（引擎用契约替身，转录逐字取自真机） |
| `.github/workflows/ci.yml` | `gates` job 末尾：`setup-python` + `pip install duckle`（版本取自 Dockerfile）+ 跑本门禁 |
| 本报告 | 探明结论 / 脚本用法 / 红绿双证据 / CI 时长影响 / 覆盖边界 |

## 1 探明结论（先探可行性，再定实现）

### 1.1 CI 里能不能跑 duckle 的 catalog 命令 —— **能**，代价可接受

| 问题 | 实测答案 | 测法（2026-09-29） |
|---|---|---|
| 装得上吗 | 能。`pip install duckle==0.7.4`（PyPI JSON 实查：`Requires-Python: >=3.8`） | `python3.12 -m venv v && v/bin/pip install --no-cache-dir "duckle==0.7.4"` |
| 体积 | duckle wheel（`manylinux2014_x86_64`）**31.6 MB** + 传递依赖 `duckdb-cli==1.5.5`（`manylinux_2_17_x86_64`）**21.3 MB** ≈ **53 MB** | PyPI JSON 的 `urls[].size` |
| 耗时 | 本机 **16.1 s**（`--no-cache-dir`、冷）；**GHA 实测 2.4 s** | `time v/bin/pip install …` ／ CI step 时间戳（见 §3） |
| Python 版本 | 3.12（与运行镜像 `python:3.12-slim` 同）；CI 用 `actions/setup-python@v5` | `deploy/duckle/Dockerfile:57` |
| 要不要另装 DuckDB | **不要**。duckle wheel 自带 `duckle-runner` 二进制，`duckdb-cli` 自带 `duckdb` 控制台脚本，duckle 的入口垫片会自己找到它 | `deploy/duckle/README.md` §2.1（本轮复核仍成立：装完 `duckle catalog --help` 直接可用） |
| 子命令面 | `build` / `assets` / `impact` / `orphans` / `owners` / `lint` / `diff` | `duckle catalog --help` 实拉 |
| 门禁自身耗时 | **0.52 s**（含引擎两次调用；只扫 12 个 JSON） | `time pnpm exec tsx scripts/check-duckle-catalog.mjs` |

⇒ **不需要让步方案**：装包代价（~53 MB / 十几秒）远低于「为它写一份静态复刻」的风险。

**为什么不做静态检查替代**：判据是「**引擎能不能给这个节点命名**」，而命名规则住在引擎里（哪些字段
`required`、连接字段合不合并、`*` 怎么吸收占位符）。静态脚本要复刻这套规则，等于把引擎的实现抄一份
进仓 —— **抄错就静默放行**，而这正是本门禁要根治的那类假绿（#334 就是「六条静态守卫全绿」的产物）。

### 1.2 需要 workspace 的哪些文件 —— **只要 `pipelines/` + `owners.json`**，且**不需要任何凭据**

实测（同一份 `deploy/duckle/console/pipelines/`，四种工作区形状）：

| 工作区内容 | `catalog build` | `catalog lint` |
|---|---|---|
| 只 `pipelines/` | 12 pipelines, 20 assets, 201 links | 无 finding，exit 0 |
| `pipelines/` + `owners.json` | 同上（20 assets） | 无 finding，exit 0 |
| `pipelines/` + `owners.json` + **`connections/zos.json`（带 bucket + 假凭据）** | 同上（20 assets） | 无 finding，exit 0 |
| `pipelines/` + `owners.json` + `alerts.json` + `schedules/` | 同上 | 同上（**alerts 不参与 lint**，见 §5） |

**凭据无关性（A/B 反证）**：在「两条 retail sink 都缺 bucket」的**有缺陷**工作区上，加与不加
`connections/zos.json`（`bucket=fake-bucket` + 假 AK/SK），`catalog build` 的 stderr **逐字相同**
（同样点名那两个节点）、资产数同样 19、`catalog lint` 同样 **exit 1 / 2 findings**。

⇒ **`catalog` 的命名只读节点自身的属性（sink 的 `bucket`），不读连接值**。所以门禁工作区
**只拷 `pipelines/` + `owners.json`**，既不需要凭据，也就不会有凭据进 CI 的风险。

（这同时解释了 #334 为什么那么隐蔽：`connectionRef` 里带着 bucket，**写入路径照样成功** ——
掉链子的只有「catalog 侧命名」这一层。）

### 1.3 工作区构造法（脚本内实现）

```
mkdtemp()                              # 临时目录：catalog build 会往工作区写 .duckle/catalog.json，
  ├── pipelines/  ← 拷 deploy/duckle/console/pipelines/    # 不能在仓里跑（会留未跟踪产物）
  └── owners.json ← 拷 deploy/duckle/console/owners.json
```

## 2 门禁脚本

```
pnpm exec tsx scripts/check-duckle-catalog.mjs [源目录] [--duckle <bin>] [--keep]
   # 源目录默认 deploy/duckle/console；--duckle 覆盖引擎路径；--keep 保留临时工作区
```

**契约**

| 情形 | 输出 | 退出码 |
|---|---|---|
| 干净 | stdout：`check-duckle-catalog: OK（12 pipelines, 20 assets, 201 links.；12 个管线文件；catalog lint 无 finding）` | 0 |
| 发现观测面缺陷 | stderr：点名「哪个管线 / 哪条规则」+ **分类修法** | 1 |
| 跑不起来（引擎不在 / 源目录缺 `pipelines/` 或 `owners.json` / pipelines 为空 / build 自身失败） | stderr：`跑不起来 —— …` | **2** |

> 退出码 2 是**响亮失败**，不是通过：**跳过的守卫与绿掉的守卫在 CI 里长得一模一样**，
> 「门禁跑了但什么都没判」正是 #337 要根治的那类不可见。

**两条判据（各自独立，缺一不可）**

1. `catalog build` 的 **stderr 不得**出现 `could not be named`
   —— 引擎对「命名不了」**只警告、退出码仍是 0**（0.7.4 实测），所以只判退出码会漏；而 stderr 里
   **点名了**是哪个管线的哪个节点（`lemeng.retail_order_line.window / sink (snk.minio)`）。
2. `catalog lint` **exit 0** —— lint 把两类问题都算 finding：「命不了的节点」与「owners 规则
   **匹配不到任何资产**」（`matches nothing in this workspace`，即 #334 的死规则本体）。

⇒ 判据 2 是**退出码层面的兜底**：即使哪天引擎改了判据 1 的文案，2 仍会红。两条都判，互为保险。

**为什么不加 `--strict`**：`--strict` 把「无主资产」也算失败，而本工作区 20 个资产里有 17 个是
运行记录 csv（`/workspace/logs/*.csv`）与外部 API URL，本就无主 —— 加了等于**无条件红**。
#334 那一类（**声明了规则却匹配不到资产**）在**不加 strict 时就已经是失败**，无需 strict。

**版本单源**：脚本不校验版本；CI 那步用
`sed -n 's/^ARG DUCKLE_VERSION=//p' deploy/duckle/Dockerfile` 读出运行镜像的版本再装
⇒ **CI 判的引擎与生产跑的引擎同版**，且本仓只有一个引擎版本落点。读不到该 ARG 则**拒绝跑**（exit 1）。

## 3 CI 接入

接在 **`gates` job 末尾**（不是单开 job）：

- `gates` 的语义就是「守卫脚本对真实仓跑」——本脚本是**第八条**，与其余七条同址 ⇒ 找门禁的人只看一处
  （与 `check-tenant-isolation` 的选址理由一致）；单开 job 要再付一次 checkout + `pnpm install`（分钟级）。
- 放**末尾**：Python 装配是本 job 最重的一步（~30 s），显式放最后，让前面那些秒级守卫先失败先反馈。

**不照抄 Dockerfile 的 `-i 清华源`**：那是镜像在**境内**构建才需要的；GitHub runner 直连 PyPI 更快，
且镜像源同步有滞后（Dockerfile 注释里记着 aliyun 未同步 0.7.4 那件事）。

**时长影响（GHA 实测，PR #341 的 run `36551939620`）**

| step | 起止 | 耗时 |
|---|---|---|
| `actions/setup-python@v5` | 09:53:18 → 09:53:18 | **0 s**（runner 镜像自带 3.12，命中工具缓存） |
| `安装 duckle（版本取自 Dockerfile…）` | 09:53:18.98 → 09:53:21.36 | **2.4 s**（`Successfully installed duckdb-cli-1.5.5 duckle-0.7.4`） |
| `pnpm exec tsx scripts/check-duckle-catalog.mjs` | 09:53:21 → 09:53:22 | **1 s** |

⇒ 本门禁给 `gates` 增加约 **4 s**（该 job 总时长 69 s，`timeout-minutes: 20` 余量充足）。
**注意：GHA 上比本机快 6 倍多**（2.4 s vs 16.1 s）—— runner 到 PyPI 是一等公民链路，
所以「装包代价过大 ⇒ 让步用静态检查」这条路**在本仓的 CI 上不成立**。

**GHA 侧绿证据（逐字，取自该 run 的 gates job 日志）**：

```
duckle 版本（取自 Dockerfile）：0.7.4
Successfully installed duckdb-cli-1.5.5 duckle-0.7.4
check-duckle-catalog: OK（12 pipelines, 20 assets, 201 links.；12 个管线文件；catalog lint 无 finding）
```

四个门禁 job（unit / gates / web / smoke）全 success。

## 4 红绿双证据（逐字）

### 4.1 绿：仓现状（真机、真 workspace）

```
$ pnpm exec tsx scripts/check-duckle-catalog.mjs
check-duckle-catalog: OK（12 pipelines, 20 assets, 201 links.；12 个管线文件；catalog lint 无 finding）
exit=0
```

### 4.2 红①：在分支上临时移除**一条**子管线 sink 的 `bucket`（真机、真仓、真文件）

```
$ pnpm exec tsx scripts/check-duckle-catalog.mjs
check-duckle-catalog: 观测面缺陷（**写入/采集照常**，坏的是「观测面」这一层）

① catalog 命不了这些节点（sink 的 `bucket` 是 required 却没写？）：
     lemeng.retail_order_line.window / sink (snk.minio)

catalog lint 退出码 1，findings 如下：
     1 source/sink node(s) could not be named, so impact answers are incomplete
     17 asset(s) have no owner (not a failure; use --strict to make it one)
     catalog lint: 1 finding(s).

提示：命不了的节点如果本就没有 owners 规则覆盖，就不会出现第 ② 类 finding ——
     但那仍是缺陷（该资产在 catalog 里根本不存在，impact/新鲜度都算不到它）。

怎么修：
  · ① 给上面那些 sink 节点补 `"bucket"`（schema 里 required；值用 `${ENV:ZOS_BUCKET}`
    这类模板 —— 占位符**不展开**、catalog 照原样命名，owners 规则里的 `*` 能吸收）。
exit=1
```

**改回后（同一脚本、同一命令）**：

```
$ pnpm exec tsx scripts/check-duckle-catalog.mjs
check-duckle-catalog: OK（12 pipelines, 20 assets, 201 links.；12 个管线文件；catalog lint 无 finding）
exit=0
$ git diff --stat -- deploy/duckle/console/     # 空 ⇒ 管线内容已逐字还原
```

> 反例是**临时**的、且**已撤回**：`git diff` 为空可自证（本 PR 的 diff 里没有管线文件的改动）。

### 4.3 红②：#334 原状复现（工作区注入：两条 retail 子管线 sink 均无 bucket）

```
$ pnpm exec tsx scripts/check-duckle-catalog.mjs /tmp/src-334
check-duckle-catalog: 观测面缺陷（**写入/采集照常**，坏的是「观测面」这一层）

① catalog 命不了这些节点（sink 的 `bucket` 是 required 却没写？）：
     lemeng.retail_order_line.tick / sink (snk.minio)
     lemeng.retail_order_line.window / sink (snk.minio)

② owners.json 里这些规则**匹配不到任何资产**（= 死规则，告警永远不会响）：
     owners.json: asset rule 'minio://*/lemeng/retail_order_line/system_book=*/bizday=*/hour=*/all.parquet' (data-eng) matches nothing in this workspace

catalog lint 退出码 1，findings 如下：
     owners.json: asset rule 'minio://*/lemeng/retail_order_line/system_book=*/bizday=*/hour=*/all.parquet' (data-eng) matches nothing in this workspace
     2 source/sink node(s) could not be named, so impact answers are incomplete
     17 asset(s) have no owner (not a failure; use --strict to make it one)
     catalog lint: 2 finding(s).

怎么修：
  · ① 给上面那些 sink 节点补 `"bucket"`（…）
  · ② 改 owners.json 里那条规则的 `match` 模式：要么是**拼错/写窄了**（对齐上面命名出来的
    资产 id 逐字改），要么是它该覆盖的资产**根本没被命名**（那就是 ①，先修 ① 再看）。
exit=1
```

逐字对上 Wave C 报告 §6.1 的病灶（`matches nothing in this workspace`）—— **#334 这一刀现在会被 CI 拦下**。

### 4.4 红③：只有 owners 规则拼错（**节点命名全正常**）

```
$ pnpm exec tsx scripts/check-duckle-catalog.mjs /tmp/src-typo     # 规则里 bizday 手滑成 bizdy
catalog lint 退出码 1，findings 如下：
     owners.json: asset rule 'minio://*/lemeng/retail_order_line/system_book=*/bizdy=*/hour=*/all.parquet' (data-eng) matches nothing in this workspace
     17 asset(s) have no owner (not a failure; use --strict to make it one)
     catalog lint: 1 finding(s).

怎么修：
  · ② 改 owners.json 里那条规则的 `match` 模式：要么是**拼错/写窄了**（…）
exit=1
```

这一类最阴（一个字母之差 = 某个团队**永远收不到告警**，节点侧毫无异常），且**修法与 ① 不同**
（改 owners.json，不是改管线）—— 故报错的「怎么修」是**分类给**的，不会把人指向错的文件。

### 4.5 守卫单测：7 条，且**变异测试证明它不空转**

`pnpm exec vitest run scripts/check-duckle-catalog.test.ts` → **7 passed**。
引擎用**契约替身**（转录逐字取自真机 0.7.4，argv 形状不对即 exit 90），覆盖：真仓绿 / 缺 bucket 红且点名 /
绿 fixture / 规则拼错红且修法指向 owners.json / 引擎不在 exit 2 / 缺 owners.json exit 2 / 替身自身 argv 断言。

**变异测试**（把守卫的判据串改坏：`/could not be named/` → `/could not be namedXYZ/`，并把绿条件放宽成
只看 lint 退出码）⇒ 单测 **红**（`expected … to contain 'lemeng.retail_order_line.tick / sink …'`），
改回则绿。⇒ 这条守卫**能红**，单测不是摆设。

> 替身的边界照实说：它**只建模两条规则**（`snk.minio` 缺 `bucket` ⇒ 命名不了；owners 错拼 ⇒ 死规则），
> 不是引擎模拟器。**真机判定由 CI 那步真跑负责**，替身锁的是「守卫拿到这套输出后红/绿与文案对不对」。

### 4.6 红/绿各自是在哪里证的（照实说，别读宽）

- **绿**：**本机与 GHA 两侧都证了**（GHA 逐字见 §3）。
- **红（①②③）**：在本机用**同一个 `duckle==0.7.4`**、**同一个脚本**、**同一套工作区构造法**实证
  （§4.2 用的是真仓真文件、改后撤回；§4.3/§4.4 是工作区注入）。**没有**在 GHA 上造一次红 ——
  造法只能是「往分支里真写坏管线 + 开 PR 触发」，那要污染一个已合并语义的仓面、还多花两条 PR，
  与「反例必须撤回、管线内容零改动」的纪律冲突。
  红绿两条路径的差异只有「引擎在哪个平台输出什么」；**绿已经在 GHA 上跑通**，且引擎版本
  由「从 Dockerfile 读」**同源钉住**（不是各写各的），解析层与平台无关。
- 残余风险（照实记）：若将来 duckle 改了判据①的文案，**本机/GHA 都会一起失效**，而单测的替身
  转录是死的 ⇒ 那时判据②（lint 退出码）仍会红，是本守卫的第二道保险。

## 5 覆盖边界与遗留（照实记，别读宽）

1. **`alerts.json` 不参与 `catalog lint`**（实测：把它放进工作区，lint 输出与退出码**不变**）
   ⇒ 告警规则的「匹配不到任何东西」这类死规则**本门禁看不见**。已知空缺，是否需要另立守卫另议。
2. **仓根 `duckle/common/*.json` 不在扫描面**：那是另一处管线定义（不叫 `pipelines/`、也没有
   `owners.json`），catalog 的工作区布局读不到它。本门禁扫的是**观测面工作区**
   （`deploy/duckle/console/`：管线与 owners.json 同址的那一个）。
3. **只管仓内声明态，管不到生产 workspace 的 catalog 新鲜度**：新管线进卷后「必须重建 catalog」
   （`deploy/duckle/console/README.md` §「新增 L0 管线的硬前置」）仍是**投递清单上的手工动作**，
   本门禁不覆盖。它拦的是「声明本身命不了名」。
4. **「能被命名」≠「探测能命中具体对象」**：asset id 里是不展开的 `${ENV:ZOS_BUCKET}` 模板串
   （沿用 #334 的诚实标注）。本门禁只解决「能否命名」。
5. **GHA 实测时长已回填**（§3：pip 2.4 s + 门禁 1 s，`gates` 共增 ~4 s）。
6. **红没在 GHA 上造过一次**（只在同一引擎版本的本机造）——理由与残余风险见 §4.6。
