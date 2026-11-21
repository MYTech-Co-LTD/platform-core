# AI 原生 OA P2：标准审批（企微）镜像实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「标准审批」（公司级、固定链、预置企微审批模板）在企微审批应用内原生执行，platform-core 通过**独立企微应用的回调 + 小时级对账**做只读镜像（状态/审批人/时间/可得的表单摘要），并让 agent 能选中标准模板、深链直达。

**Architecture:** 标准审批**不进 case-engine**；企微是执行方与事实源，平台只镜像。平台新增：租户级「审批应用」凭据、`forms.external_approval` 镜像表、WeCom 回调验签/解密（公开仓独立实现，不 import 私有引擎）、`wecom_native` 绑定资产、回调 host 路由 + forms 模块端口、小时级对账 job。

**Tech Stack:** TypeScript / Hono / pg / Node crypto（AES-256-CBC + SHA1）/ Vitest；企微自建应用（独立于 case-engine 决策门应用）。

## Repo roots

- platform-core：`/Users/duo/mytechcode/platform-core`
- case-engine：仅作**只读参考**（`core/decision-gate/src/wecom-callback.ts` / `wecom-crypt.ts`），**不 import、不复制私有包**；实现按企微官方文档独立写。
- 所有改动在本仓；跨仓只读。

## Global Constraints

- 迁移幂等；当前迁移序号止于 `021_oa_engine.sql`，本计划用 `022_wecom_approval.sql`（server）与 `modules/forms/migrations/003_external_approval.sql`。
- B1：host 不直写 `forms` schema；回调路由验签后经 **forms 模块端口** `runtime.port('forms','upsertExternalApproval')` 写入。
- 敏感值只写「在哪、怎么取」：审批应用的 corpId/agentId/secret/token/aesKey 存 `platform.tenant` 新列或 env secret，代码/日志不出现值。
- 回调必须验签失败 fail-closed（403），未知 `TemplateId` 不静默丢弃：落 attention + 告警。
- 标准审批**不创建** `forms.submission`、不建 case；镜像行只读展示与数据面。
- 本计划的所有 PR：`Refs #2363`（或新建 P2 issue），不提前关闭 P1 收口 issue。
- 时间：API 用 RFC3339 UTC；验收记录北京时间。

---

## 用户前置（开工前必须由人完成）

1. 在企微后台新建（或指定）一个**独立自建应用**用于标准审批，拿到：corpId、agentId、secret、回调 Token、EncodingAESKey。
2. 把该应用的回调 URL 配到 `https://<平台域名>/api/platform/wecom/approval-callback`（GET 验证 + POST 事件同一 URL）。
3. 在企微审批应用里建一个**标准报销模板**，拿到 `template_id` / `process_code`（平台绑定资产要用）。
4. 提供一条**真实测试审批**（提交→审批→通过/驳回），用于 T1 抓真实回调与 `getapprovaldetail` 形状。

> 没有 1–4，T1 无法完成；T2/T3 可先做（schema/加解密单测），但 T4 之后的验收必须等前置。

---

## Task 1: 真实回调与 API 形状取证（spike）

**Files:**
- Create: `scripts/wecom-approval-spike.mjs`（临时抓包/转发，不提交生产逻辑）
- Create: `docs/superpowers/notes/2026-11-16-wecom-approval-callback-shape.md`

**Interfaces:**
- Produces: 真实 `sys_approval_change` XML 字段清单、签名/解密参数、`getapprovaldetail` 真实响应形状、`getapprovaldata`（列表）可用性结论。

- [ ] **Step 1: 起一个最小抓包端点**

用 30 行 Node http server（或 Hono）实现：
```js
// GET: 校验 msg_signature，解密 echostr 原样回
// POST: 打印 query（msg_signature/timestamp/nonce）+ 原始 body（脱敏后）到文件
```
不写库；只落 `/tmp/wecom-approval-spike/*.xml`。

- [ ] **Step 2: 让用户在企微后台把回调指到抓包端点，提交一条测试审批**

记录：回调事件名（`sys_approval_change` / `open_approval_change`）、`SpNo`、`SpStatus`、`TemplateId`、`ApplyTime`、`AgentID` 等真实字段名（大小写/下划线以真实 XML 为准）。

- [ ] **Step 3: 用真实 corpId/secret 调 API**

```bash
# gettoken
GET https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=...&corpsecret=...
# 详情（用 Step 2 的 SpNo）
POST https://qyapi.weixin.qq.com/cgi-bin/oa/getapprovaldetail?access_token=...
{"sp_no":"..."}
# 列表（验证是否可用；不可用就记录 exact 错误码）
POST https://qyapi.weixin.qq.com/cgi-bin/oa/getapprovaldata?access_token=...
{"starttime":..., "endtime":..., "cursor":...}
```

- [ ] **Step 4: 写形状笔记**

`docs/superpowers/notes/2026-11-16-wecom-approval-callback-shape.md` 写死：
- 回调 XML 真实标签名（双形兼容列表）；
- 签名算法与 AES 参数（32B key、IV=key 前 16B、PKCS#7）；
- `getapprovaldetail` 响应里状态/审批人/时间/表单字段的真实路径；
- `getapprovaldata` 是否可用；不可用则 P2 对账只能用「回调 + 详情」或改由用户导出。

- [ ] **Step 5: 提交**

```bash
git add scripts/wecom-approval-spike.mjs docs/superpowers/notes/2026-11-16-wecom-approval-callback-shape.md
git commit -m "docs(oa): 企微标准审批回调/API 形状取证（#P2）"
```

---

## Task 2: 租户审批应用凭据 + 镜像表

**Files:**
- Create: `apps/server/src/migrations/022_wecom_approval.sql`
- Create: `modules/forms/migrations/003_external_approval.sql`
- Modify: `apps/server/src/tenant.ts`（TenantRow 新列）
- Modify: `modules/forms/storage.ts`（upsert/list 镜像）
- Test: `apps/server/src/tenant.test.ts`、`modules/forms/kernel.test.ts`

**Interfaces:**
- Produces: `platform.tenant.wecom_approval_{corp_id,agent_id,secret,token,aes_key}`；`forms.external_approval`；`upsertExternalApproval(pool, row)` / `listExternalApprovals(pool, org, limit)`。

- [ ] **Step 1: 写失败测试**

```ts
it('tenant 行带审批应用五列，缺省 null', async () => {
  const t = await getTenantByOrg(pool, 'acme')
  expect(t.wecom_approval_corp_id).toBeNull()
})
it('external_approval 按 (org, provider_ref) 幂等 upsert', async () => {
  await upsertExternalApproval(pool, { org: 'acme', processCode: 'PC1', providerRef: 'SP1',
    title: '差旅报销', requester: 'u1', status: 'pending', detail: {} })
  await upsertExternalApproval(pool, { org: 'acme', processCode: 'PC1', providerRef: 'SP1',
    title: '差旅报销', requester: 'u1', status: 'approved', detail: { x: 1 } })
  const rows = await listExternalApprovals(pool, 'acme', 10)
  expect(rows).toHaveLength(1); expect(rows[0].status).toBe('approved')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run apps/server/src/tenant.test.ts modules/forms/kernel.test.ts`
Expected: FAIL（列/表不存在）。

- [ ] **Step 3: 迁移**

`022_wecom_approval.sql`：
```sql
alter table platform.tenant add column if not exists wecom_approval_corp_id text;
alter table platform.tenant add column if not exists wecom_approval_agent_id text;
alter table platform.tenant add column if not exists wecom_approval_secret text;
alter table platform.tenant add column if not exists wecom_approval_token text;
alter table platform.tenant add column if not exists wecom_approval_aes_key text;
```
`003_external_approval.sql`：
```sql
create table if not exists forms.external_approval (
  id bigserial primary key,
  org text not null,
  provider text not null default 'wecom',
  process_code text not null,
  provider_ref text not null,
  title text,
  requester text,
  status text not null,
  started_at timestamptz,
  finished_at timestamptz,
  detail jsonb,
  synced_at timestamptz not null default now(),
  unique (org, provider, provider_ref)
);
create index if not exists idx_external_approval_org_time
  on forms.external_approval (org, started_at desc);
```

- [ ] **Step 4: storage**

`upsertExternalApproval` 用 `on conflict (org,provider,provider_ref) do update`；`listExternalApprovals` 按 `started_at desc`。状态只接受白名单（`pending/approved/rejected/canceled`），非法值抛 `FormsError`。

- [ ] **Step 5: 跑测试并提交**

Run: `pnpm vitest run apps/server/src/tenant.test.ts modules/forms/kernel.test.ts`
Expected: PASS。

```bash
git add apps/server/src/migrations/022_wecom_approval.sql modules/forms/migrations/003_external_approval.sql apps/server/src/tenant.ts modules/forms/storage.ts apps/server/src/tenant.test.ts modules/forms/kernel.test.ts
git commit -m "feat(oa): 审批应用凭据与标准审批镜像表（#P2）"
```

---

## Task 3: 企微回调验签/解密/解析（公开仓独立实现）

**Files:**
- Create: `apps/server/src/wecom/approval-crypto.ts`
- Create: `apps/server/src/wecom/approval-parse.ts`
- Test: `apps/server/src/wecom/approval-crypto.test.ts`、`approval-parse.test.ts`

**Interfaces:**
- Produces: `verifyWecomSignature({token,timestamp,nonce,encrypt})`；`decryptWecomEnvelope(encrypt,aesKey)`；`parseApprovalChange(xml): {event, spNo, spStatus, templateId, applyTime, requester, agentId}`。

- [ ] **Step 1: 写失败测试**

```ts
it('签名：sha1(sort(token,timestamp,nonce,encrypt))', () => {
  const sig = wecomSignature({ token: 't', timestamp: '1', nonce: 'n', encrypt: 'e' })
  expect(sig).toBe(createHash('sha1').update(['t','1','n','e'].sort().join('')).digest('hex'))
})
it('解密：AES-256-CBC，IV=key 前 16B，PKCS#7', () => {
  const { key, encrypt, plain } = encryptForTest('hello')
  expect(decryptWecomEnvelope(encrypt, key)).toBe(plain)
})
it('解析：真实双形标签 SpNo/sp_no 都认', () => {
  const e = parseApprovalChange('<xml><Event>sys_approval_change</Event><SpNo>SP1</SpNo><SpStatus>1</SpStatus></xml>')
  expect(e).toMatchObject({ event: 'sys_approval_change', spNo: 'SP1', spStatus: 1 })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run apps/server/src/wecom/approval-crypto.test.ts apps/server/src/wecom/approval-parse.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现**

- `wecomSignature`：`sha1([token,timestamp,nonce,encrypt].sort().join(''))`。
- `decryptWecomEnvelope`：`aesKey` base64 → 32B；`createDecipheriv('aes-256-cbc', key, key.subarray(0,16))`；按 PKCS#7 去填充；去尾部 16 字节随机数 + 4 字节 msgLen（企微信封）；校验 `<xml>` 开头。
- `parseApprovalChange`：双形标签（`SpNo/sp_no`、`SpStatus/sp_status`、`TemplateId/template_id`、`ApplyTime/apply_time`、`FromUserName/from_user_name`、`AgentID/AgentId`）；未知事件返回 `null` 由调用方决定（不静默）。

- [ ] **Step 4: 用 T1 真实样本补一条 known-answer 测试**

从 T1 抓到的真实回调密文/明文（脱敏后放 fixtures）断言解析结果。若 T1 未完成，本步显式标 `skip` 并在 PR 里写明；T4 验收前必须补上。

- [ ] **Step 5: 跑测试并提交**

Run: `pnpm vitest run apps/server/src/wecom/approval-crypto.test.ts apps/server/src/wecom/approval-parse.test.ts`
Expected: PASS。

```bash
git add apps/server/src/wecom/approval-crypto.ts apps/server/src/wecom/approval-parse.ts apps/server/src/wecom/*.test.ts
git commit -m "feat(oa): 企微审批回调验签/解密/解析（#P2）"
```

---

## Task 4: 回调 host 路由 + forms 模块端口

**Files:**
- Create: `apps/server/src/routes/wecom-approval.ts`
- Modify: `apps/server/src/app.ts`（挂路由，免 session/PAT）
- Modify: `modules/forms/index.ts`（`createPorts` 暴露 `upsertExternalApproval`）
- Modify: `modules/forms/storage.ts`
- Test: `apps/server/src/wecom-approval.test.ts`

**Interfaces:**
- Produces: `GET/POST /api/platform/wecom/approval-callback`；forms port `upsertExternalApproval({org, processCode, providerRef, title, requester, status, startedAt, finishedAt, detail})`。

- [ ] **Step 1: 写失败测试**

```ts
it('GET echostr：验签通过回明文；签名错 403', async () => {
  const res = await app.request('/api/platform/wecom/approval-callback?...')
  expect(res.status).toBe(200)
})
it('POST：合法事件 upsert 镜像；未知 TemplateId 落 attention', async () => {
  // 用测试 key 构造签名+密文
})
it('POST：验签失败 403，不写库', async () => {})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run apps/server/src/wecom-approval.test.ts`
Expected: FAIL（路由不存在）。

- [ ] **Step 3: 实现 host 路由**

- 解析 query：`msg_signature/timestamp/nonce/echostr`；用**该租户** `wecom_approval_token/aes_key` 验签解密。
- 租户解析：回调 URL 不带 Host 区分时，用 `AgentID` 反查租户（`platform.tenant.wecom_approval_agent_id`）；查不到 → 404 + 告警（不猜）。
- GET：回 `echostr` 明文。
- POST：解密 inner XML → `parseApprovalChange` → 由 `TemplateId` 找 `approval_def(provider=wecom_native)` 绑定；找不到 → 落 `platform.integration` attention + 返回 200（企微会重推，避免风暴）。
- 找到绑定 → `runtime.port('forms','upsertExternalApproval')`；端口不存在 → 503 + 告警（不静默）。
- 事件状态映射：`SpStatus` 真实码表以 T1 为准；映射到 `pending/approved/rejected/canceled`。

- [ ] **Step 4: forms 端口**

`modules/forms/index.ts`：
```ts
createPorts: ({ pool }) => ({
  async upsertExternalApproval(row) { await store.upsertExternalApproval(pool, row) },
})
```
host 用 `runtime.port('forms','upsertExternalApproval')`（加载器已有机制）。

- [ ] **Step 5: 跑测试并提交**

Run: `pnpm vitest run apps/server/src/wecom-approval.test.ts modules/forms/module.test.ts`
Expected: PASS。

```bash
git add apps/server/src/routes/wecom-approval.ts apps/server/src/app.ts modules/forms/index.ts modules/forms/storage.ts apps/server/src/wecom-approval.test.ts
git commit -m "feat(oa): 企微标准审批回调与镜像写入（#P2）"
```

---

## Task 5: 小时级对账 job

**Files:**
- Create: `scripts/oa-standard-approval-reconcile.mjs`
- Test: `scripts/oa-standard-approval-reconcile.test.mjs`

**Interfaces:**
- Produces: 每小时跑一次：对每个 `wecom_native` 绑定（按 org/processCode/agentId），拉列表/详情 → upsert；失败写告警。

- [ ] **Step 1: 写失败测试**

用 fake fetch：`gettoken` → `getapprovaldata` 返回 2 条 → 断言 upsert 2 条；第二次跑幂等（不新增）；token 失败 → 退出码非 0 + 日志 `evt=token_failed`。

- [ ] **Step 2: 实现**

- 读绑定：`forms.asset_version` 中 `kind='approval_def'`、`body->>'provider'='wecom_native'`、published。
- 读租户审批应用凭据（五列；缺任一 → 跳过该租户 + 告警 `config_missing`）。
- `gettoken` → `getapprovaldata`（若 T1 证明不可用，降级为「只处理回调已到达、`detail is null` 的行，用 `getapprovaldetail` 补齐」并显式记录）。
- 逐条 `upsertExternalApproval`（`provider_ref` 唯一）。
- 输出统计：`bindings/tenants/synced/skipped/errors`。

- [ ] **Step 3: 跑测试并提交**

Run: `node --test scripts/oa-standard-approval-reconcile.test.mjs`（或 `pnpm test:guard`）
Expected: PASS。

```bash
git add scripts/oa-standard-approval-reconcile.mjs scripts/oa-standard-approval-reconcile.test.mjs
git commit -m "feat(oa): 标准审批小时级对账（#P2）"
```

---

## Task 6: `wecom_native` 绑定资产 + 发布门 + 管理面

**Files:**
- Modify: `modules/forms/domain/approval.ts`（支持 `provider=wecom_native` 的 binding body）
- Create: `modules/forms/domain/wecom-binding.ts`
- Modify: `modules/forms/routes.ts`（绑定 CRUD/发布/校验）
- Modify: `modules/forms/manifest.yaml`（权限/端点）
- Modify: `modules/forms/console/`（平台管理员绑定页）
- Test: `modules/forms/domain/wecom-binding.test.ts`、`routes.test.ts`

**Interfaces:**
- Produces: `WecomBindingBody = { provider:'wecom_native', processCode, deepLink, name, verifiedChain[], verifiedAt }`；`validateWecomBinding`；发布门要求 `forms:global-manage`；事项模板 `provider=wecom_native` 时 `schema` 可为 null。

- [ ] **Step 1: 写失败测试**

```ts
it('绑定 body 缺 processCode/deepLink 拒绝', () => {
  expect(validateWecomBinding({ provider:'wecom_native' })).toMatchObject({ ok:false, code:'BINDING_INCOMPLETE' })
})
it('事项模板 provider=wecom_native 且 schema=null 可发布', async () => {})
it('非平台管理员发布 wecom_native ⇒ 403', async () => {})
```

- [ ] **Step 2: 实现校验与路由**

- `validateWecomBinding`：`processCode` 非空、`deepLink` https、`name` 非空、`verifiedChain` 非空、`verifiedAt` RFC3339。
- 发布门：`provider=wecom_native` 只允许 `forms:global-manage`；普通 `forms:publish` 403。
- 事项模板：`provider=wecom_native` 时 `schema` 可 null；`mode=approval` 必须引用已发布绑定；绑定退役 ⇒ 引用它的模板不能新发布。
- 管理面：console 一个「标准审批绑定」页（列表/新建/版本/发布），字段就是 binding body；`verifiedChain` 用文本列表。

- [ ] **Step 3: 跑测试并提交**

Run: `pnpm vitest run modules/forms/domain/wecom-binding.test.ts modules/forms/routes.test.ts`
Expected: PASS。

```bash
git add modules/forms/domain/approval.ts modules/forms/domain/wecom-binding.ts modules/forms/routes.ts modules/forms/manifest.yaml modules/forms/console modules/forms/domain/wecom-binding.test.ts modules/forms/routes.test.ts
git commit -m "feat(forms): wecom_native 绑定资产与发布门（#P2）"
```

---

## Task 7: 标准审批镜像列表 + 导出 + agent 选模板

**Files:**
- Modify: `modules/forms/routes.ts`（`GET /standard-approvals`）
- Modify: `modules/forms/console/`（列表页/页签）
- Modify: `modules/forms/mcp.ts` / `mcp-manage`（`search_standard_approvals`）
- Modify: `modules/forms/manifest.yaml`
- Test: `routes.test.ts`、`mcp.test.ts`

**Interfaces:**
- Produces: `GET /standard-approvals?limit=`（org 内镜像列表）；`search_standard_approvals(query)` 返回绑定 + `deepLink`；`GET /standard-approvals/export?after_id=`（数据面）。

- [ ] **Step 1: 写失败测试**

```ts
it('标准审批列表只返回本 org 镜像', async () => {})
it('search_standard_approvals 返回 name/deepLink，不返回标准表单字段', async () => {})
it('export 按 id 键集游标分页', async () => {})
```

- [ ] **Step 2: 实现**

- 列表：`forms.external_approval` 按 `started_at desc`；只读。
- agent 工具：`search_standard_approvals` 查已发布 `wecom_native` 绑定（按 name/processCode 模糊），返回 `{name, deepLink, description}`；**不渲染字段、不预填**。
- 导出：id 键集游标，字段 = 镜像列；`detail` 可得才带（不可得为 null，不假装）。

- [ ] **Step 3: 跑测试并提交**

Run: `pnpm vitest run modules/forms/routes.test.ts modules/forms/mcp.test.ts`
Expected: PASS。

```bash
git add modules/forms/routes.ts modules/forms/console modules/forms/mcp.ts modules/forms/manifest.yaml modules/forms/routes.test.ts modules/forms/mcp.test.ts
git commit -m "feat(forms): 标准审批镜像列表/导出/agent 选模板（#P2）"
```

---

## Task 8: 验收（真实企微标准审批）

**前置**：用户完成 T1 的四项配置，且平台回调 URL 已生效。

- [ ] **Step 1: 主路径**

1. agent/console 选中标准报销模板 → 返回 `deepLink`。
2. 用户在企微审批应用提交 → 企微回调到平台 → `forms.external_approval` 出现 `pending` 行。
3. 审批人在企微通过 → 回调更新 `approved` + `finished_at`；镜像列表可见。
4. 再提交一条并驳回 → `rejected`；状态不串。

- [ ] **Step 2: 负对照**

| 用例 | 期望 |
|---|---|
| 伪造 `msg_signature` | 403，不写库 |
| 未知 `TemplateId` | 200 + attention/告警（不静默丢） |
| 重复回调同一 `SpNo` | 幂等，不新增行 |
| 回调丢失 + 小时级对账 | 行最终补齐（若列表端点可用） |
| 租户审批应用凭据缺失 | 跳过 + 告警 `config_missing`，不写脏行 |
| 非平台管理员发布 `wecom_native` | 403 |

- [ ] **Step 3: 记录**

`docs/superpowers/plans/2026-11-16-oa-p2-acceptance.md`：命令、真实 `SpNo`（脱敏）、状态变化时间（北京时间）、回调日志摘要、对账统计。

- [ ] **Step 4: 提交**

```bash
git add docs/superpowers/plans/2026-11-16-oa-p2-acceptance.md
git commit -m "test(oa): P2 标准审批真实回调验收（#P2）"
```

---

## 已知边界（写进 PR）

- 标准审批的**表单与附件都在企微**；平台不复制、不存附件。
- 平台镜像的字段完整性取决于 `getapprovaldetail` 可得性；不可得时只存状态/审批人/时间，**不假装有数据**。
- `getapprovaldata`（列表）若端点不可用，对账降级为「补详情」而非「发现新单」；新单依赖回调——这会在验收里如实标注。
- 标准审批不建 `forms.submission`、不进 case-engine；数据面按 `external_approval` 单独导出。
- P2 不做标准审批的催办/改派（企微原生负责）；不做跨租户全局模板。
