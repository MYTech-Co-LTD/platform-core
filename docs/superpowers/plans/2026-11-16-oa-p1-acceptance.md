# OA P1「请假」端到端验收记录（Task 15 / issue #2363）

> 关联：设计 spec `docs/superpowers/specs/2026-11-16-ai-native-oa-design.md` §10/§18；
> 实施计划 `docs/superpowers/plans/2026-11-16-ai-native-oa-p0-p1.md` Task 15；
> 平台 PR：`MYTech-Co-LTD/platform-core#2373`（合并提交 `98d8eee8`）；
> 引擎 PR：`MYTech-Co-LTD/case-engine#120`（应用内审批链，`e027a03`）与 `#123`（org 门，
> `origin/main` = `216a3aa`，v0.16.1）。
>
> 本篇是**一次真实运行的记录**，不是设计推演。命令、输出、DB 行、时间（一律北京时间）都在下面；
> 脚本可重跑，重跑会得到新的 asset 后缀与时间戳，断言口径不变。

## 0. 环境与形态（先说清边界）

| 项 | 值 |
|---|---|
| 执行时间 | 2026-11-16 15:27:22 – 15:27:25 BJT |
| 机器 | 本机（macOS / Node 22 / 本机 PostgreSQL 16，`postgres://platform:***@127.0.0.1:5432/platform`） |
| 平台 | 本仓校验分支 `ylwzzs/oa-p1-acceptance`（= `main` `98d8eee8`）真进程 `apps/server/src/index.ts` |
| 引擎 | 三次运行：**假引擎**（15:27，`oa-p1-smoke.mjs` 内置）、**真实 case-engine 首轮**（16:05，`e027a03`，发现 org 缺口）、**修复后复测**（17:08，`216a3aa` 含 #123，`ENGINE_ORG=acme`）——见 §10 |
| 追加验收 | 桌面走查 16:08–16:14；移动端 `/m/oa/approvals` 走查 17:10–17:13（platform #2381）——见 §11 |
| 租户 | 首轮 smoke 用自建 `oa-smoke`；org 门复测与 UI 轮按任务单用 **`acme`**（`ENGINE_ORG=acme`） |
| 身份 | MockCasdoor（真 HTTP，真登录 + 租户管理员 `/api/update-permission` 授权；不是签假会话） |
| 通知 | 真链：`modules/notify/seed-builtin.ts`（模板+派生规则）→ `scripts/notify-worker.mjs --once` → `notify.inbox` |

**假引擎与真引擎各证什么**：计划 Task 15 允许「fake engine 或真 engine」。第一轮（15:27）用假引擎
把平台侧接缝与授权钉死；第二轮（16:05，§10）把同一脚本切到 `--real-engine`，用 case-engine
`origin/main`（#120 / `e027a03`，Mastra durable workflow + `@mastra/pg`）真跑了主路径/撤回/负对照。

- 假引擎轮证明：宿主装载、manifest `declaredScopeGate`、`OrganizationPort`、`OaEnginePort`
  （`platform.oa_engine` 登记行 + secret 引用）、提交建单补偿、计划快照、审批代理授权、回调幂等、
  通知事件/模板/规则/worker/inbox——以及引擎**契约的形状**（org 校验、节点循环、quorum、撤回 CAS）。
- 真引擎轮证明：同一批断言在真 HTTP + 真 workflow + 真回调下成立（含并发 409、在途单不吃 v2、
  回调重放 deduped）。首轮还暴露出**一处真实契约缺口**：spec §10.2 的「org 不一致 403」未实现
  （实测 201 建单）；case-engine #123 修复后 17:08 复测 **26/26 PASS**，两条 org 判据全绿（§10.4）。

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

1. **真引擎首轮（16:05）发现 org 缺口，已在 #123 修复并复测转 PASS**：首轮 24/25，
   `neg.org-engine` 对 `org=beta` 返回 201（真的建了 case）。case-engine #123 加 `ENGINE_ORG`
   门后，17:09 复测 **26/26 PASS**：`org=beta` → 403 ORG_MISMATCH、缺 org → 400 ORG_REQUIRED
   （§10.4）。首轮记录保留在 §10.2 作为缺陷物证。
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
4. **UI 移动端缺口已由 #2381 修复并复测**：16:08 轮 390px 默认被 `MobileConfigNotice` 拦；
   platform #2381 新增 `/m/oa/approvals`（不经 console 壳）后，17:10–17:13 复测：无拦截、
   `scrollWidth==innerWidth`、空意见「拒绝」禁用、通过与驳回都由真引擎回调驱动（§11.3）。
   console 直开仍被拦是**产品口径**（PC=配置面），不是缺陷。
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

## 10. 追加验收 A：真实引擎 E2E（首轮 16:05 发现缺口 → 修复后 17:08 复测）

> 这一节回答 T7 边界之一：「假引擎证明了平台接缝，但真引擎没跑」。
> **首轮（16:05，引擎 `e027a03`）24 PASS / 1 FAIL**——org 不一致建单返回 201，spec §10.2 要求 403；
> 该缺口由 case-engine #123 修复（`ENGINE_ORG` + `checkOrg`）。**修复后（17:08，引擎 `216a3aa`）
> 同一脚本复测 26/26 PASS**（含新增的「缺 org → 400 ORG_REQUIRED」），原告 FAIL 的两条 org 判据
> 全部转 PASS——证据在 §10.4。
> 收尾回归：假引擎模式在 17:07:45 BJT 复跑 **26/26 PASS**，两种模式共用同一批断言。

### 10.1 起栈方式（本地 node，不用 Docker）

case-engine 是私有仓，用它的 `origin/main`（修复后复测取 `216a3aa` = v0.16.1，含 #120 + #123）在
`/tmp/oa-engine/case-engine` 建 worktree，**不碰本机既有 checkout**：

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
PORT=13200 ENGINE_STORAGE_ID=oa-engine-e027a03 ENGINE_VERSION=case-engine-216a3aa \
ENGINE_ORG=acme \
MASTRA_WORKERS=orchestration,scheduler \
NOTIFY_PLATFORM_BASE=http://127.0.0.1:13300 NOTIFY_PAT="$PAT" \
node .mastra/output/index.mjs
```

实测启动输出：

```
{"planVersion":1,"engineVersion":"case-engine-216a3aa","providers":["inapp"],
 "features":["nodeLoop","quorum","nodeSla","collab"]}          ← GET /capabilities
{"org":"acme","mode":"in-process","llm":{"configured":false},"redisUrl":null} ← GET /engine/config
Mastra API running { url: 'http://localhost:13200/api' }
```

三点口径说明（避免照抄错）：

- **`ENGINE_ORG` 自 case-engine #123 起是必填的 org 门基准**（首轮 `e027a03` 没有这个 env，
  正是「org 不一致被 201 接受」的根因；`ENGINE_ORG=""` 空白同样算缺失，不会静默不校验）。
  公开端点的 org 携带方式：`POST /cases` / `decision` / `withdraw` 走 **body.org**；
  `GET /cases`、`GET /cases/:id` 走 **query org**；缺失 400 ORG_REQUIRED，不匹配 403 ORG_MISMATCH。
- 平台 `platform.oa_engine` 的登记行 + 平台侧身份 org 必须与 `ENGINE_ORG` **逐字一致**
  （大小写敏感）。本轮两边都是 `acme`：smoke 用 `OA_SMOKE_ORG=acme` 跑，提交/回调/审批页全在 acme 下。
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

### 10.2 首轮结果（2026-11-16 16:05:15 – 16:05:18 BJT，引擎 `e027a03`）

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

1. **org 校验缺失（首轮 FAIL；已由 case-engine #123 修复并复测 PASS）**：首轮见上表（201 建单）。
   平台侧当时不受影响（平台不会发别人的 org），但单租户引擎的安全边界只靠「调用方自觉」。
   #123 给公开端点加了 `ENGINE_ORG` 门：缺 400 / 不匹配 403；17:08 复测两条都 PASS（§10.4）。
2. **`finalAction` 词汇不同**：真引擎落 `approve` / `reject`（动词），平台 submission 用
   `approved` / `rejected`。回调里由引擎转写，所以平台侧无感；断言按两套词汇都接受。
3. **没有 `gate.node.decided` case event**：真引擎把节点决策写 `case_node_decisions` 表，
   `case_events` 只有 `intake` / `writeback`。计划 Task 15 写的「无重复 `gate.node.decided`」
   在真引擎上按**等价判据**执行：`nodeDecisions` 每节点恰好 1 条、无 `(nodeKey,approver)` 重复。

### 10.4 修复后复测（2026-11-16 17:09:18 – 17:09:21 BJT，引擎 `216a3aa` 含 #123）

命令与 §10.1 相同，差别只有两处：引擎带 **`ENGINE_ORG=acme`**（#123 起必填），脚本带
**`OA_SMOKE_ORG=acme`**（org 必须与引擎逐字一致）：

```bash
# 引擎（216a3aa）：ENGINE_ORG=acme / VERSION=case-engine-216a3aa / 其余同 §10.1
# 平台脚本：
OA_SMOKE_ORG=acme DATABASE_URL=… \
OA_SMOKE_ENGINE_URL=http://127.0.0.1:13200 OA_SMOKE_ENGINE_PAT=… \
OA_SMOKE_SERVICE_PAT=… OA_SMOKE_PLATFORM_PORT=13300 \
pnpm exec tsx scripts/oa-p1-smoke.mjs --real-engine
```

结果：**26 / 26 PASS，`failures=0`**（`oa-p1-smoke: OK（26 条断言全过；2026-11-16 17:09:21 BJT）`）。
两条 org 判据（首轮 FAIL 的那条 + 新增的缺 org）实测：

| 判据 | 结果 | 证据 |
|---|---|---|
| `POST /cases {org:"beta", 合法 plan}` | **PASS** | `403 {"error":"ORG_MISMATCH"}`；没有建 case（engine 库无该 externalRef） |
| `POST /cases` 缺 org | **PASS** | `400 {"error":"ORG_REQUIRED"}` |
| 主路径 / 撤回 / 重放 / 在途 v2 / 并发 | PASS | submission `903` approved（leader+hr）、`904` withdrawn、`905` 决策后撤回 409 留 `gate/hr`、`906` 在途 v1 approved、`907` 并发 `[200,409]` hr 决策 1 条 |

引擎库 `case_oa`（org 列已随 #123 落**校验过的实例租户**）：

```
forms:submission:903 closed approve   org=acme
forms:submission:904 closed withdrawn org=acme
forms:submission:905 gate             org=acme   ← 决策后撤回 409 的留档
forms:submission:906 closed approve   org=acme
forms:submission:907 closed approve   org=acme
```

**结论：T9（case-engine #123 org 门）在真引擎上复测通过，首轮 FAIL 已转 PASS。**

## 11. 追加验收 B：UI 走查（2026-11-16 16:08–16:14 桌面；17:10–17:13 移动端）

### 11.1 起栈与夹具

```bash
# web 产物（tsc 门在 React bigint 上另案红，照既有配方跳过 tsc 直接 vite build）
node scripts/gen-console-registry.mjs && pnpm --filter @platform/web exec vite build

# dev-stack：acme 单租户；forms 不在 dev-stack 的订阅种子里 ⇒ 订阅源钉旧表（无行=启用）
PLATFORM_SUBSCRIPTION_SOURCE=platform DEV_STACK_PORT=13100 \
OA_ENGINE_PAT_ACME="$(cat <acme PAT>)" \
pnpm exec tsx scripts/dev-stack.mjs
# MockCasdoor 随机端口（日志里有）/ 宿主 http://127.0.0.1:13100
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

> 16:08 轮曾判 **FAIL**：390px 默认打开 `/console/forms/approvals` 被 `MobileConfigNotice`
> 拦成「配置请在电脑端完成」，OA 审批手机默认不可达。该缺口由 platform #2381（Closes #2380）
> 修复：新增 `/m` 移动壳下的 `/m/oa/approvals` 与 `/m/oa/approvals/:caseId`，**不经 console 壳**。
> 17:10–17:13 用同一套真引擎（`ENGINE_ORG=acme`）复测如下：

| 场景（390×844，Orca 内置浏览器） | 结果 | 证据 |
|---|---|---|
| 打开 `/m/oa/approvals` | **PASS** | 无「配置请在电脑端完成」（`gate:false`）；渲染 2 张待办卡片；`scrollWidth=innerWidth=390`、`overflow=false`。截图 `docs/img/oa-p1-approvals-390.png` |
| 点卡进 `/m/oa/approvals/:caseId` | **PASS** | 状态「审批中」、当前节点「直属主管」、只读申请内容、审批历史；`overflow=false` |
| 空意见时「拒绝」禁用 | **PASS** | DOM `{approveDisabled:false, rejectDisabled:true}`；录取意见后 `rejectDisabled:false`。截图 `docs/img/oa-p1-approval-detail-actions-390.png`（动作区） |
| **驳回**（真引擎） | **PASS** | submission `910` → `rejected`（17:12:36 BJT，意见「手机端走查：材料不全」）；引擎 case `e635d9b4-…` `closed / reject`；列表剩 1 张 |
| **通过**（真引擎） | **PASS** | submission `908` → `approved`（17:12:55 BJT）；引擎 case `27918abc-…` `closed / approve`；列表「暂无待审批」、`overflow=false` |

判定：**390px 默认路径可用，无 console 拦截、无横向溢出；通过与驳回都是真引擎回调驱动**
（不是前端本地改状态）。16:08 轮的 FAIL 已由 #2381 修复并从 FAIL 转 PASS；
`docs/img/oa-p1-mobile-gate.png` 保留为「console 直开仍被拦」的对照证据（产品口径未变：
console 仍是 PC 配置面，审批走 `/m` 业务面）。
