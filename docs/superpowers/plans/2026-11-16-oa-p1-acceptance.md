# OA P1「请假」端到端验收记录（Task 15 / issue #2363）

> 关联：设计 spec `docs/superpowers/specs/2026-11-16-ai-native-oa-design.md` §10/§18；
> 实施计划 `docs/superpowers/plans/2026-11-16-ai-native-oa-p0-p1.md` Task 15；
> 平台 PR：`MYTech-Co-LTD/platform-core#2373`（合并提交 `98d8eee8`）；
> 引擎 PR：`MYTech-Co-LTD/case-engine#120`（`origin/main` = `e027a03`，v0.16.0）。
>
> 本篇是**一次真实运行的记录**，不是设计推演。命令、输出、DB 行、时间（一律北京时间）都在下面；
> 脚本可重跑，重跑会得到新的 asset 后缀与时间戳，断言口径不变。

## 0. 环境与形态（先说清边界）

| 项 | 值 |
|---|---|
| 执行时间 | 2026-11-16 15:27:22 – 15:27:25 BJT |
| 机器 | 本机（macOS / Node 22 / 本机 PostgreSQL 16，`postgres://platform:***@127.0.0.1:5432/platform`） |
| 平台 | 本仓校验分支 `ylwzzs/oa-p1-acceptance`（= `main` `98d8eee8`）真进程 `apps/server/src/index.ts` |
| 引擎 | 两次运行：**假引擎**（15:27，`oa-p1-smoke.mjs` 内置）与 **真实 case-engine**（16:05，本地 node 起 `origin/main` `e027a03`）——后者见 §10 |
| 追加验收 | 2026-11-16 16:08–16:14 BJT：dev-stack + 构建后的 web dist + Orca 内置浏览器走查（§11） |
| 租户 | 自建 `oa-smoke`（single 模式 `PLATFORM_ORG=oa-smoke`），不碰 acme/beta 与本机其它夹具 |
| 身份 | MockCasdoor（真 HTTP，真登录 + 租户管理员 `/api/update-permission` 授权；不是签假会话） |
| 通知 | 真链：`modules/notify/seed-builtin.ts`（模板+派生规则）→ `scripts/notify-worker.mjs --once` → `notify.inbox` |

**假引擎与真引擎各证什么**：计划 Task 15 允许「fake engine 或真 engine」。第一轮（15:27）用假引擎
把平台侧接缝与授权钉死；第二轮（16:05，§10）把同一脚本切到 `--real-engine`，用 case-engine
`origin/main`（#120 / `e027a03`，Mastra durable workflow + `@mastra/pg`）真跑了主路径/撤回/负对照。

- 假引擎轮证明：宿主装载、manifest `declaredScopeGate`、`OrganizationPort`、`OaEnginePort`
  （`platform.oa_engine` 登记行 + secret 引用）、提交建单补偿、计划快照、审批代理授权、回调幂等、
  通知事件/模板/规则/worker/inbox——以及引擎**契约的形状**（org 校验、节点循环、quorum、撤回 CAS）。
- 真引擎轮证明：同一批断言在真 HTTP + 真 workflow + 真回调下成立（含并发 409、在途单不吃 v2、
  回调重放 deduped），并暴露出**一处真实契约缺口**：spec §10.2 的「org 不一致 403」在真引擎里
  未实现（实测 201 建单）——如实记 FAIL（§10.3）。

> 第一轮文字保留原样（§0–§9 是 15:27 那一次的记录，含假引擎细节）；追加轮次在 §10/§11，
> 两轮的时间戳、DB 行、断言结果分别标注，别把两轮数字混在一起读。

还有一个刻意的量具选择：假引擎的 `GET /cases/:id` **固定延迟 50ms**。并发决策用例要两个平台请求
都在第一次决策落库前读到 `currentNode=leader`，否则竞态退化成「第二个请求看到节点已前进 ⇒ 403」，
而不是引擎 CAS 的 409。延迟把「测的是 409 不双落」钉死，不是为了放宽断言。

## 1. 运行命令

```bash
cd /Users/duo/orca/workspaces/platform-core/oa-p1-acceptance
pnpm run typecheck:scripts                     # 脚本自身先过类型门（checkJs strict）
DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform \
  pnpm exec tsx scripts/oa-p1-smoke.mjs
```

脚本自持 MockCasdoor / 假引擎 / 宿主 env（不读 `.env`、不依赖 web dist；本次运行宿主日志有一条
`apps/web/dist 不存在，跳过静态托管`——**UI 不在本次验收范围**，控制台页的组件断言在
`modules/forms/console/console.test.tsx`，Task 15 验的是 API 端到端）。

退出码 `0`，末行：

```
oa-p1-smoke: OK（25 条断言全过；2026-11-16 15:27:25 BJT）
```

脚本同时打印 `SMOKE_RESULT_JSON_BEGIN … END`，含 `results[]`（id/期望/实际/pass）与
`evidence`（submissions / cases / callbacks / inbox / audit）。下面所有数字都摘自这一次运行的
JSON 与随后的 DB 直查。

## 2. 验收总表（Task 15 Step 3 / 3b / 4 逐条对应）

### 2.1 主路径（Step 3）

| # | 验收项（计划原文） | 判定 | 证据（本次运行） |
|---|---|---|---|
| 1 | `POST /defs/leave/submissions` → 201，`status=pending_approval`，`case_ref` 非空 | **PASS** | submission `784`：`status=pending_approval`、`provider=inapp`、`case_ref=case-1`（`main.submit`） |
| 2 | 引擎 `GET /cases/:id` → `status=gate`，`currentNode=leader` | **PASS** | 假引擎直读：`gate / leader`（`main.engine-gate`）；平台 `GET /approvals/case-1` 回 `case.currentNode=leader` |
| 3 | 平台 `GET /approvals/:caseId`（u-lead）→ 200；`POST /approvals/:caseId/decision`（u-lead, approve）→ 200 | **PASS** | 200 / 200，回执 `nodeKey=leader`；无关员工 u-stranger 读详情 403 |
| 4 | 引擎进入 HR 节点；HR approve → case closed；回调 → `submission.status=approved`；notify 收件箱有 `forms.approval.decided` | **PASS** | 第一节点后 `currentNode=hr`（`main.node2`）；u-hr 批准后引擎 `closed/approved`；submission `784` → `approved`（decided_at 15:27:24 BJT）；`notify.inbox` 行见 §3.4 |
| 5 | 审批事件数 = 2 个节点；无重复 `gate.node.decided` | **PASS** | `case-1.events = case.created \| gate.node.decided:leader \| gate.node.awaiting:hr \| gate.node.decided:hr \| case.closed`；每节点恰好 1 条（`main.no-duplicate-node-event`） |

补充断言（计划附表之外、但属主路径的必要面）：

| id | 判定 | 证据 |
|---|---|---|
| `main.plan-snapshot` | PASS | 计划快照 `leader[u-lead] → hr[u-hr]`（dry-run 与提交落库一致） |
| `main.engine-create` | PASS | 引擎实收 `{org:"oa-smoke", externalRef:"forms:submission:784", provider:"inapp"}`（org 由身份钉死，请求参数无口子） |
| `main.callback` | PASS | 引擎 final 回调平台 **1 次**、平台 200 `{ok:true, submissionId:"784"}` |
| `main.inbox-decided` / `main.inbox-api` | PASS | DB 行 + `GET /api/modules/notify/inbox` 都能读到 `eventKey=forms.approval.decided` |

### 2.2 撤回路径（Step 3b）

| # | 验收项 | 判定 | 证据 |
|---|---|---|---|
| 1 | 新建一笔 pending 请假（u1） | **PASS** | submission `785` → `pending_approval`，`case_ref=case-2` |
| 2 | 任何节点决策前撤回 → 200；`status=withdrawn`；引擎 case `closed` | **PASS** | submission `785`：`status=withdrawn`、`withdrawn_at` 有值；引擎 `closed/withdrawn`；引擎实收 `withdraw {actor:"u1"}` 200 |
| 3 | 已有一节点决策后再撤回 → 409，状态不变 | **PASS** | submission `786`：u-lead 已批 leader → u1 撤回 **409**，submission 仍 `pending_approval`、引擎仍 `gate/currentNode=hr` |

> 说明：submission `786` 是本用例**故意留在** `pending_approval` 的行（状态不变就是断言本身），
> 不是脏数据；重跑脚本会在开跑时清掉该 org 的行。

### 2.3 负对照（Step 4 全表）

| 用例 | 期望 | 判定 | 实际 |
|---|---|---|---|
| org 不一致调引擎 | 403 | **PASS** | 引擎侧直调 `POST /cases {org:"beta"}` → **403**；平台回调侧 `{org:"beta"}` → **403 ORG_MISMATCH**（两条都是本次实跑） |
| AI/无 publish scope 调 publish | 403 | **PASS** | `u-ai`（仅 `forms:approval:manage`）→ **403 FORBIDDEN**（宿主 `declaredScopeGate`，不是模块自查） |
| dept_leader 缺失时发布 | 409（dry-run 失败），head 不变 | **PASS** | `u-nodept`（无主部门）发布 → **409 APPROVERS_UNRESOLVED**；`GET /approval-defs/...` 回 `head=null`、版本仍 `draft` |
| 回调重放两次 | 第二次 `deduped:true`，`decided_at` 不变 | **PASS** | 两次重放均 `200 {deduped:true}`；`decided_at` 重放前后**逐值相同** |
| 在途单 + 发布模板 v2 | 在途单仍按 v1 计划执行 | **PASS** | v2（hr 审批人改 `u-hr2`）发布后：submission `787` 的 `approval_plan` 仍是 `leader[u-lead] → hr[u-hr]`；`u-hr2` 批该单 **403**；`u-hr` 批完 **200** → `approved` |
| 并发两次 decision 同一节点 | 一个 200/409，不双落 | **PASS** | 同一 u-lead 并发两次 approve → `statuses=[200,409]`；`case-5` 的 leader 决策**恰好 1 条**；之后 u-hr 批完 → `approved` |
| 未声明事件 emit | 400 `EVENT_NOT_DECLARED` | **PASS** | 服务 PAT 调 `POST /api/modules/notify/emit {eventKey:"forms.not.declared"}` → **400 EVENT_NOT_DECLARED** |

## 3. 关键数据行（北京时间；本次运行 `suffix=4nbnp1`）

### 3.1 `forms.submission`（org=oa-smoke）

| id | status | provider | case_ref | decision_action | submitted BJT | decided BJT |
|---|---|---|---|---|---|---|
| 784 | approved | inapp | case-1 | approved | 15:27:24 | 15:27:24 |
| 785 | withdrawn | inapp | case-2 | withdrawn | 15:27:24 | 15:27:24 |
| 786 | pending_approval | inapp | case-3 | — | 15:27:24 | — |
| 787 | approved | inapp | case-4 | approved | 15:27:24 | 15:27:25 |
| 788 | approved | inapp | case-5 | approved | 15:27:25 | 15:27:25 |

### 3.2 引擎侧 case 事件（假引擎内存；真引擎等价表为 case events / `case_node_decisions`）

```
case-1 forms:submission:784 closed approved  decisions=leader:u-lead,hr:u-hr
       events=case.created | gate.node.decided:leader | gate.node.awaiting:hr | gate.node.decided:hr | case.closed
case-2 forms:submission:785 closed withdrawn  decisions=-
       events=case.created | case.withdrawn
case-3 forms:submission:786 gate  (withdraw-after-decision 用例故意保留)
       events=case.created | gate.node.decided:leader | gate.node.awaiting:hr
case-4 forms:submission:787 closed approved  decisions=leader:u-lead,hr:u-hr
case-5 forms:submission:788 closed approved  decisions=leader:u-lead,hr:u-hr   ← 并发只落一次
```

### 3.3 引擎 → 平台 final 回调

| caseId | 平台响应 |
|---|---|
| case-1 | 200 `{ok:true, submissionId:"784"}` |
| case-2 | 200 `{ok:true, submissionId:"785"}`（withdrawn） |
| case-4 | 200 `{ok:true, submissionId:"787"}` |
| case-5 | 200 `{ok:true, submissionId:"788"}` |

### 3.4 通知（`notify.inbox` / `notify.delivery`）

`notify.inbox`：

| recipient | event_id | event_key | title | created BJT |
|---|---|---|---|---|
| u1 | `forms:submission:784:decided` | `forms.approval.decided` | 审批有结果 | 15:27:24 |
| u-lead | `forms:submission:784:node:leader:awaiting` | `forms.approval.awaiting` | 待审批 | 15:27:24 |
| u-hr | `forms:submission:784:node:hr:awaiting` | `forms.approval.awaiting` | 待审批 | 15:27:24 |

`notify.delivery`（同批）：

| event_id | channel | recipient | status | 说明 |
|---|---|---|---|---|
| `…784:node:leader:awaiting` | inapp_default | u-lead | sent | — |
| `…784:node:hr:awaiting` | inapp_default | u-hr | sent | — |
| `…784:decided` | inapp_default | u1 | sent | — |
| 同上三条 | wecom_default | 同上 | dead | `missing_channel_address`（见 §5 发现 2） |

worker 一轮统计：`{"events":3,"deliveries":3,"sent":3,"failed":0,"dead":0}`（dead 是通道态，
不是 worker 失败；wecom 那 3 条在领取前就被判 `missing_channel_address`，未计入本轮 claim）。

### 3.5 `forms.audit`（节选；顺序即发生序）

```
15:27:23 u-mgr approval.draft     leave-4nbnp1
15:27:23 u-mgr approval.publish   leave-4nbnp1
15:27:24 u1    approval.submit    784
15:27:24 u-lead approval.decision 784  {nodeKey:"leader", action:"approve"}
15:27:24 case-engine approval.callback 784  {action:"approved", decidedBy:"u-hr"}
15:27:24 u-hr  approval.decision  784  {nodeKey:"hr", action:"approve"}
15:27:24 u1    approval.submit    785
15:27:24 case-engine approval.callback 785
15:27:24 u1    approval.withdraw  785
15:27:24 u1    approval.submit    786
15:27:24 u-lead approval.decision 786
15:27:24 u-mgr approval.draft     leave-nodept-4nbnp1
…（发布失败不写 publish 审计：409 在写库前返回）
```

## 4. 25 条机检断言清单（脚本 `results[]`，全部 pass）

主路径 9：`main.submit` / `main.plan-snapshot` / `main.engine-create` / `main.engine-gate` /
`main.node2` / `main.approved` / `main.case-closed` / `main.no-duplicate-node-event` /
`main.callback`；通知 2：`main.inbox-decided` / `main.inbox-api`。

撤回 2：`withdraw.pending` / `withdraw.after-decision`（另有 1 条 `withdraw.engine` 断言引擎收到 withdraw）。

负对照 7 + 在途 v2 的 2 条辅助断言（v2 起草、v2 批完）：`neg.org-engine` / `neg.org-callback` /
`neg.no-publish-scope` / `neg.dept-leader-missing` / `neg.callback-replay` /
`neg.inflight-v2-snapshot` / `neg.inflight-v2-not-approver` / `neg.inflight-v2-finish` /
`neg.concurrent-decision` / `neg.undeclared-event`。

## 5. 发现与边界（不粉饰）

1. **真引擎首轮未跑，16:05 已补跑并发现一处 FAIL**：15:27 轮（§0–§9）的引擎行为是假引擎按 §10
   契约实现的；16:05 追加轮（§10）用真 case-engine `e027a03` 复跑，25 条中 24 条 PASS，
   **`neg.org-engine` FAIL——真引擎对 `org=beta` 的建单请求返回 201（真的建了 case），
   spec §10.2 要求的 403 没有实现**（`core/engine/src/mastra.ts` 的 `POST /cases` 无 org 校验）。
   这条必须修引擎或改契约，不能按 PASS 记。
2. **企微通道未送达**：`wecom_default` 三条 delivery 为 `dead / missing_channel_address`——验收环境
   的 MockCasdoor 用户没有手机号/企微地址（`platform` 组织与 identity-link 无数据）。这是**环境缺料**，
   不是通道代码失败；`inapp_default` 三条全部 `sent`，收件箱断言已过。企微直连的上线实测另有记录
   （`wecom-direct-transport-live`）。
3. **并发决策的 409 来源**：一个 200 / 一个 409 且不双落，已钉住；但 409 具体出自引擎 CAS
   （`NOT_CURRENT_NODE`）还是平台的 `NOT_PENDING`/`NOT_CURRENT_NODE`，取决于两个请求的时序。
   本次假引擎的 50ms GET 延迟把时序钉在「两边都先读到 leader → 引擎 CAS 判后到者 409」，所以本次
   观测到的是引擎 CAS 路径（`statuses=[200,409]`）。真引擎轮（§10）把并发点放在**末节点**：一个
   200 结案、另一个 409（`isClosed`），同样只落一次决策——中间节点不选它，是因为真引擎对非当前
   节点审批人回 400（平台映射 502），会把「重复决策」与「已不是你的节点」两种病因混在一起。
4. **UI 已在 16:08–16:14 补走查**（§11），但发现一个**产品口径冲突**：390px 宽打开 console
   默认被 `MobileConfigNotice` 拦成「配置请在电脑端完成」——审批列表/详情在手机默认路径**不可达**；
   加 `?desktop=1` 后页面本身响应式正常（390px 无横向溢出、列表走卡片、详情可读、拒绝按钮
   空意见禁用）。这与计划 Self-Review「移动端用响应式 console 页承接」的取舍**不一致**，
   要么给 OA 审批开一个 console 白名单，要么补 `/m` 入口（P1 未做）。
5. **残留数据是设计的一部分**：submission `786` 停在 `pending_approval` 是「决策后撤回 409 且状态
   不变」的断言本体；重跑会在开跑时清掉本 org 的提交/审计/通知/映射行（published asset 物理不可删，
   故 asset_id 每次带随机后缀）。

## 6. 复现清单（照抄即可）

```bash
# 1) 起本机 pg（已有则跳过）
docker compose -f deploy/docker-compose.yml up -d postgres
#    若 5432 被本机原生 pg 占着，直接用它：DATABASE_URL 指向本机 pg 即可

# 2) 类型门 + 跑验收（脚本自持 MockCasdoor / 假引擎 / 宿主 env）
pnpm run typecheck:scripts
DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform \
  pnpm exec tsx scripts/oa-p1-smoke.mjs

# 3) 只取机检摘要
… | awk '/SMOKE_RESULT_JSON_BEGIN/{f=1;next}/SMOKE_RESULT_JSON_END/{f=0}f' | jq '.failures, .results'
```

判定标准：退出码 0、末行 `oa-p1-smoke: OK（N 条断言全过）`、JSON `failures=0`。
任何一条 `record` 为 false 时脚本**不早退**（负对照之间独立），全部收集后以非 0 退出并列出失败 id——
报告里要引用的是 `results[]`，不是「跑到第几条停了」。

---

## 10. 追加验收 A：真实引擎 E2E（2026-11-16 16:05 BJT）

> 这一节回答 T7 边界之一：「假引擎证明了平台接缝，但真引擎没跑」。运行结果 **24 PASS / 1 FAIL**，
> FAIL 是真的契约缺口，不是量具错——原样记在 §10.3。
> 收尾回归：加完 `--real-engine` / `--mint-service-pat` 后，假引擎模式在 16:16:54 BJT 复跑仍
> **25/25 PASS**（`oa-p1-smoke: OK（25 条断言全过）`），两种模式共用同一批断言。

### 10.1 起栈方式（本地 node，不用 Docker）

case-engine 是私有仓，用它的 `origin/main`（`e027a03` = v0.16.0，#120 已合）在 `/tmp/oa-engine/case-engine`
建 worktree，**不碰本机既有 checkout**：

```bash
git -C /Users/duo/mytechcode/case-engine worktree add /tmp/oa-engine/case-engine origin/main
cd /tmp/oa-engine/case-engine
npm ci
npx mastra build --dir src/mastra          # 产物 .mastra/output/index.mjs

# 引擎库：本机 pg 新建独立库（不动 platform 库）
psql postgres://platform:***@127.0.0.1:5432/postgres -c "create database case_oa"
psql postgres://platform:***@127.0.0.1:5432/case_oa -c "create extension if not exists vector"

# 服务 PAT 必须先铸（引擎启动时要用它当 NOTIFY_PAT；铸造走 scripts 的 --mint-service-pat）
PAT=$(DATABASE_URL=postgres://platform:***@127.0.0.1:5432/platform \
  pnpm exec tsx scripts/oa-p1-smoke.mjs --mint-service-pat 2>/dev/null)

# 起引擎（in-process：orchestration+scheduler 同进程；不拆 worker 就不需要 Redis）
DATABASE_URL=postgres://platform:***@127.0.0.1:5432/case_oa \
PORT=13200 ENGINE_STORAGE_ID=oa-engine-e027a03 ENGINE_VERSION=case-engine-e027a03 \
MASTRA_WORKERS=orchestration,scheduler \
NOTIFY_PLATFORM_BASE=http://127.0.0.1:13300 NOTIFY_PAT="$PAT" \
node .mastra/output/index.mjs
```

实测启动输出：

```
{"planVersion":1,"engineVersion":"case-engine-e027a03","providers":["inapp"],
 "features":["nodeLoop","quorum","nodeSla","collab"]}          ← GET /capabilities
{"mode":"in-process","llm":{"configured":false},"redisUrl":null} ← GET /engine/config
Mastra API running { url: 'http://localhost:13200/api' }
```

两点口径说明（避免照抄错）：

- **引擎代码里没有 `ENGINE_ORG` 这个 env**（`git grep ENGINE_ORG origin/main` = 0 命中）。
  租户归属由平台 `platform.oa_engine` 登记行 + `POST /cases` 的 `body.org` 表达；`provider` 只有
  `inapp`（能力面自报）。本轮 smoke 的 org 用 `oa-smoke`（脚本自建租户，避免踩 acme 的本地演示数据）；
  **任务单要求的 acme 映射在同一真引擎上由 §11 的 UI 轮实测**：引擎库 `cases` 里 804/805 的
  `payload->>'org'` 都是 `acme`，审批通过/驳回都由真引擎回调驱动。
- `NOTIFY_PLATFORM_BASE` 必须钉到一个**固定端口**（本轮 13300）——平台脚本的 `--real-engine`
  因此要求 `OA_SMOKE_PLATFORM_PORT`，端口随机会让真回调打到空端口，看起来像「引擎不回调」。

平台侧同一脚本切真引擎（PAT 只走 env，不进仓库/提交）：

```bash
DATABASE_URL=postgres://platform:***@127.0.0.1:5432/platform \
OA_SMOKE_ENGINE_URL=http://127.0.0.1:13200 \
OA_SMOKE_ENGINE_PAT=<engine-inbound-bearer> \
OA_SMOKE_SERVICE_PAT="$PAT" \
OA_SMOKE_PLATFORM_PORT=13300 \
pnpm exec tsx scripts/oa-p1-smoke.mjs --real-engine
```

脚本先打 `GET /capabilities` 并断言 `engineVersion !== fake-engine-0.1.0`——**防止把假引擎的
PASS 当成真引擎的 PASS**（`--real-engine` 缺任何一个 env 直接 fail-fast，不静默退回替身）。

### 10.2 结果（2026-11-16 16:05:15 – 16:05:18 BJT）

| 组 | 结果 | 证据 |
|---|---|---|
| 主路径（提交 → 两级审批 → 回调 → approved） | **PASS** | submission `799`：`approved / inapp / case ce54185c-…`；真引擎 `GET /cases/:id` 先 `pending`→`gate`（异步推进，实测等待 **210ms**）→ `gate/leader` → `gate/hr` → `closed / approve`，`nodeDecisions=[leader:u-lead, hr:u-hr]` |
| 引擎建单（真 HTTP） | **PASS** | 平台发的 case 用 `GET /cases?externalRef=forms:submission:799` 能反查到，`plan.nodes=2` |
| 回调（真引擎 → 平台） | **PASS** | `forms.audit` 里 `approval.callback` **恰好 1 条**；`notify.inbox` 产出 `forms.approval.decided` |
| 撤回（决策前 / 决策后） | **PASS** | submission `800` → `withdrawn`，引擎 `closed / withdrawn`；submission `801` 先批 leader 再撤回 → **409**、仍 `pending_approval` |
| 回调重放两次 | **PASS** | 两次重放 `200 {deduped:true}`，`decided_at` 逐值不变 |
| 在途单 + 发布 v2 | **PASS** | `802` 的 `approval_plan` 仍是 v1；v2 的 HR `u-hr2` 批它 **403**；v1 的 `u-hr` 批完 **200 → approved** |
| 并发两次 decision（末节点 hr） | **PASS** | `statuses=[200,409]`，`hr` 节点决策恰好 1 条（`803`） |
| 无 publish scope / dept_leader 缺失 / 未声明事件 | **PASS** | 403 / 409+head 不变 / 400 EVENT_NOT_DECLARED |
| **org 不一致调引擎** | **FAIL** | 发 `POST /cases {org:"beta", 合法 plan}` → **201 + caseId**（真建了 `3cfe80a1-…`）。spec §10.2 要求 **403**；`core/engine/src/mastra.ts` 的 `POST /cases` 没有任何 org/ENGINE_ORG 校验 |

引擎库直查（`case_oa`）：

```
ce54185c-… closed approve   oa-smoke forms:submission:799   ← 主路径
7f43e994-… closed withdrawn oa-smoke forms:submission:800   ← 撤回
98bfcb52-… gate             oa-smoke forms:submission:801   ← 决策后撤回被拒（留在 hr）
9921fd6c-… closed approve   oa-smoke forms:submission:802   ← 在途 v1
63a300f1-… closed approve   oa-smoke forms:submission:803   ← 并发
3cfe80a1-… gate   (org=beta) forms:submission:org-mismatch-lanr9u  ← 负对照 FAIL 的物证
```

`case_node_decisions`：每个已结案 case 恰好 `leader` + `hr` 各 1 条；并发 case `803` 的 `hr`
只有 1 条（没有双落）。

### 10.3 与契约的三处偏差（不影响主流程，但要登记）

1. **org 校验缺失（FAIL，需引擎修）**：见上表。平台侧不受影响（平台不会发别人的 org——`main.engine-create`
   断言 `externalRef` 命中、平台回调侧 `org:"beta"` 仍 403 ORG_MISMATCH），但**单租户引擎的安全边界
   现在只靠「调用方自觉」**。
2. **`finalAction` 词汇不同**：真引擎落 `approve` / `reject`（动词），平台 submission 用
   `approved` / `rejected`。回调里由引擎转写，所以平台侧无感；断言按两套词汇都接受。
3. **没有 `gate.node.decided` case event**：真引擎把节点决策写 `case_node_decisions` 表，
   `case_events` 只有 `intake` / `writeback`。计划 Task 15 写的「无重复 `gate.node.decided`」
   在真引擎上按**等价判据**执行：`nodeDecisions` 每节点恰好 1 条、无 `(nodeKey,approver)` 重复。

## 11. 追加验收 B：UI 走查（2026-11-16 16:08–16:14 BJT）

### 11.1 起栈与夹具

```bash
# web 产物（tsc 门在 React bigint 上另案红，照既有配方跳过 tsc 直接 vite build）
node scripts/gen-console-registry.mjs && pnpm --filter @platform/web exec vite build

# dev-stack：acme 单租户；forms 不在 dev-stack 的订阅种子里 ⇒ 订阅源钉旧表（无行=启用）
PLATFORM_SUBSCRIPTION_SOURCE=platform DEV_STACK_PORT=13100 \
OA_ENGINE_PAT_ACME="$(cat <acme PAT>)" \
pnpm exec tsx scripts/dev-stack.mjs
# MockCasdoor :51734 / 宿主 http://127.0.0.1:13100
```

真引擎按 §10.1 重启，`NOTIFY_PLATFORM_BASE=http://127.0.0.1:13100`、`NOTIFY_PAT=<acme admin1 PAT>`；
平台 `platform.oa_engine` 加 `acme → http://127.0.0.1:13200`。权限经 MockCasdoor
`/api/update-permission` 授予（`forms*` 全套给 admin1，`forms:view/fill` 给 viewer1）。

夹具：审批模板 `ui-leave`（单节点，审批人=user:`admin1`）+ 事项模板 `ui-leave-item`
（schema: reason/startDate/endDate）；viewer1 提交两笔 → submission `804` / `805`（case
`4f3cd2d9-…` / `cea716bd-…`），admin1 的「待我审批」两行。

### 11.2 桌面 1440×900（Orca 内置浏览器，真登录）

| 步骤 | 结果 | 证据 |
|---|---|---|
| 登录 admin1 / pw → `/console/forms/approvals` | **PASS** | 列表两行（标题 `ui-leave-item - viewer1`、发起人 viewer1、节点「直属主管」、时间 16:08:38） |
| 点「查看」进详情 | **PASS** | `审批中` 标签、当前节点「直属主管」、契约版本 v1、RJSF 只读字段（reason/endDate/startDate）、审批意见框 |
| 空意见时「拒绝」禁用 | **PASS** | DOM：`{rejectDisabled:true, approveDisabled:false}` |
| 填意见后「拒绝」解禁并提交 | **PASS** | 填「UI 走查：材料不全，请补充」→ `{rejectDisabled:false}`；点击后 toast「已驳回」、回列表剩 1 行；DB submission `805` → `rejected`（16:12:50 BJT），引擎 case `closed / reject` |
| 第二笔点「通过」 | **PASS** | toast「已通过」、列表「暂无待审批」；DB submission `804` → `approved`（16:13:11 BJT），引擎 case `closed / approve` |

> 两次动作的终态来自**真引擎回调**（引擎 13200 → dev-stack 13100），不是前端本地改状态：
> `forms.audit` 有 `approval.callback`，引擎库 `cases.status=closed`。

截图：`docs/img/oa-p1-approvals-list.png`（列表）、`docs/img/oa-p1-approval-detail.png`（详情，
拒绝禁用）。

### 11.3 窄屏 390px（`~390px` 要求）

| 场景 | 结果 | 证据 |
|---|---|---|
| 默认打开 `/console/forms/approvals`（390px） | **FAIL（不可达）** | console 壳命中 `MobileConfigNotice`：「配置请在电脑端完成」+「打开手机工作台」+「仍要打开桌面版」；审批列表/详情在手机默认路径打不开。截图 `docs/img/oa-p1-mobile-gate.png` |
| `?desktop=1` 强制桌面版：列表 | **PASS** | 响应式卡片列表（`.ant-list-item` = 1，非 Table），`scrollWidth=innerWidth=390`、`overflow=false`；截图 `docs/img/oa-p1-approvals-390.png` |
| `?desktop=1` 强制桌面版：详情 | **PASS** | 只读字段 + 审批动作可读，`overflow=false`，空意见「拒绝」仍 `disabled:true`；截图 `docs/img/oa-p1-approval-detail-390.png` |

**判定**：页面组件本身在 390px 是响应式可用、无横向溢出的（三种视图 `overflow=false`）；
但**产品壳层把移动端 console 整体拦掉**，OA 审批没有 `/m` 入口（P1 未接）⇒ 审批人用手机
默认打不开待审批。这与计划 Self-Review 的「移动端用响应式 console 页承接」冲突，需产品决断：
要么把 OA 审批页加入移动白名单，要么补 `/m` 深链（P1.5）。在决断前，本条按 **FAIL** 记。
