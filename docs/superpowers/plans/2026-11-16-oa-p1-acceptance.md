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
| 引擎 | **假引擎**（`scripts/oa-p1-smoke.mjs` 内起的 HTTP 服务，逐条实现 spec §10.1–10.6） |
| 租户 | 自建 `oa-smoke`（single 模式 `PLATFORM_ORG=oa-smoke`），不碰 acme/beta 与本机其它夹具 |
| 身份 | MockCasdoor（真 HTTP，真登录 + 租户管理员 `/api/update-permission` 授权；不是签假会话） |
| 通知 | 真链：`modules/notify/seed-builtin.ts`（模板+派生规则）→ `scripts/notify-worker.mjs --once` → `notify.inbox` |

**为什么用假引擎，以及它证不了什么**：P1 的引擎实现在私有仓 case-engine（Mastra durable workflow），
本机没有可用的引擎运行栈（`core/engine` 需 `npm ci` + Mastra build + 独立 pg）。计划 Task 15 明确
允许「fake engine 或真 engine」。因此本次验收**证明的是平台侧接缝与授权**：

- 真：宿主装载、manifest `declaredScopeGate`、`OrganizationPort`（platform 组织表）、
  `OaEnginePort`（`platform.oa_engine` 登记行 + secret 引用）、提交建单的补偿、计划快照、
  审批代理的授权、回调幂等、通知事件/模板/规则/worker/inbox。
- 假：引擎的节点循环、quorum、撤回 CAS、`gate.node.decided` 事件数、final 回调的**触发时机**。
  这些的正确性由 case-engine 自己的测试负责（`core/engine/__tests__/case-approval.test.ts`、
  `notify-emit.test.ts`），**本次没有重跑它们**——这是本记录最大的边界，不接受「端到端全绿」的
  过度解读。

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

1. **真引擎未在本次运行**：上面的引擎行为（节点循环、quorum、撤回 CAS、事件数、回调时机）是假引擎按
   §10 契约实现的，不是 case-engine 的实测。要升级为「真端到端」，需在能起 Mastra 栈的环境把
   `platform.oa_engine.base_url` 指向真引擎；届时本脚本的假引擎部分可整段替换，其余断言（平台侧）
   不变。**在此之前，「P1 请假端到端」的结论只到平台接缝。**
2. **企微通道未送达**：`wecom_default` 三条 delivery 为 `dead / missing_channel_address`——验收环境
   的 MockCasdoor 用户没有手机号/企微地址（`platform` 组织与 identity-link 无数据）。这是**环境缺料**，
   不是通道代码失败；`inapp_default` 三条全部 `sent`，收件箱断言已过。企微直连的上线实测另有记录
   （`wecom-direct-transport-live`）。
3. **并发决策的 409 来源**：一个 200 / 一个 409 且不双落，已钉住；但 409 具体出自引擎 CAS
   （`NOT_CURRENT_NODE`）还是平台的 `NOT_PENDING`/`NOT_CURRENT_NODE`，取决于两个请求的时序。
   本次假引擎的 50ms GET 延迟把时序钉在「两边都先读到 leader → 引擎 CAS 判后到者 409」，所以本次
   观测到的是引擎 CAS 路径（`statuses=[200,409]`）。真引擎的 resume CAS 需另行验证。
4. **UI 未覆盖**：本次宿主无 web dist，静态托管被跳过；控制台审批页的行为在
   `modules/forms/console/console.test.tsx` 覆盖，浏览器手工走查未做（不是本 Task 的交付物，
   但**别把它读成「UI 已验收」**）。
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
