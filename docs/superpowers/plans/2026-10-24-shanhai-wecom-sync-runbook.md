# 山海企微通讯录同步（Casdoor 侧）运维 Runbook

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **本计划是运维作业**：Task 3–5 在 Casdoor 机（113.249.101.33）上执行，根本法则第 1 条例外（该机不在控制面），**执行前留档授权**（spec §6.3——本计划的用户批准即授权记录，执行日志再确认一次）。

**Goal:** Casdoor org **`shanhaiyiguo-org`**（platform 实例 `PLATFORM_ORG` 实证，2026-10-24）完成企微通讯录 → Casdoor 同步（用户 + 组织树），存量对账按摸底数据裁决，全程零影响其他 org。

> **红线（用户 2026-10-24 明确指示）：`shanhai` org（628 户/27 角色/49 组）是另一套生产体系，本作业对它只读（基线比对）、绝不写。** syncer 行的 organization 字段一旦配错就是写穿红线——写前后都逐字核对 `organization='shanhaiyiguo-org'`。

**Architecture:** 复刻 mytech 已实证通路（WeKnora 条目 `919ae8e9-52b8-4553-9ae4-7983f3891d82`）：官方 latest Casdoor 内建 WeCom Syncer，`userid→Name+isKey:true` + `is_read_only=true` + disabled 手动 run-syncer。共享生产库——副本彩排全绿才动生产。

**Spec:** `docs/superpowers/specs/2026-10-24-shanhai-wecom-directory-and-org-admin-design.md` §3.2–3.3

## Global Constraints

- **共享生产库**：Casdoor DB 6 组织 640+ 用户；任何写动作前先备份，验收含「其他 org 零影响」。
- **目标 org = `shanhaiyiguo-org`**（3 户/0 组/0 角色，干净 org，与 mytech 同步前同构）；`shanhai` org 红线勿写（见 Goal 下方）。
- **syncer 现状（2026-10-24 实测 get-syncers）**：全库仅 2 个——mytech WeCom（disabled/只读，本文的 copy 源）、`shanhai` 的 Database syncer（disabled，**别人的，勿动勿删**）。目标 org 无既有 syncer。
- **is_read_only=true 铁律**：关掉会把本地户反向创建进企微通讯录。
- **secret 纪律**：corpid/secret 只进 Casdoor syncer 配置与一次性 env，不进文档/命令历史/日志。
- Casdoor 机 daemon.json 有**失效 mirror 残留未清**（WeKnora 全案遗留）——若需在机上拉镜像，用新前缀直拉或临时 override，不重启 docker daemon（波及同机 Novu 栈）。
- 仓库内脚本（Task 2/5）走 issue → PR 纪律；`scripts/` 是 checkJs（字面量类型会加宽，守卫用单形状恒在字段）。

---

### Task 1: 前置收集（人工协调，用户执行）

- [ ] **Step 1: 山海企微管理员侧**（微信沟通，用户牵头）：
  - corpid（企业管理后台「我的企业」页）；
  - **通讯录同步助手** secret（管理后台 → 安全与管理 → 管理工具 → 通讯录同步；**不是**自建应用的 secret——权限面不同，WeKnora 全案 §企微侧要点）；
  - 可信 IP 白名单：企业管理后台 → 通讯录同步助手 → 「接收事件服务器/可信 IP」加 `113.249.101.33`（Casdoor 机出口 IP）。
- [ ] **Step 2: 确认山海租户 org 名**（在控制面机或经 openship service exec 对山海实例）：

```sh
psql "$DATABASE_URL" -c "select slug, casdoor_org from platform.tenant order by slug;"
```
✅ **已确认（2026-10-24 spike）**：山海实例 `PLATFORM_ORG=shanhaiyiguo-org`；Casdoor org 列表含 `shanhaiyiguo-org`（目标）与 `shanhai`（生产在用，勿动）。下文统一写 `<target-org>` = `shanhaiyiguo-org`。**只记录名字，不记录任何 secret。**

- [ ] **Step 3: 阻断门**：corpid + secret + 白名单三项齐备才进 Task 2。缺任一项 → 停，回头找企微管理员。

---

### Task 2: 摸底脚本（通讯录 vs identity_link 存量，一次性只读）

**Files:**
- Create: `scripts/audit-shanhai-wecom-overlap.mjs`
- Test: `scripts/audit-shanhai-wecom-overlap.test.ts`

**Interfaces:**
- Produces: `compareRoster()` 纯函数 + 控制台报告（交集数即 D3 对账决策的输入）。
- env 契约：`WECOM_CORP_ID`、`WECOM_CONTACT_SECRET`（企微侧）、`DATABASE_URL`（读 `platform.identity_link` 的 phone）。全部运行时注入，**脚本内不出现字面量**。

- [ ] **Step 1: 写失败测试**（compareRoster 纯函数）：

```ts
import { describe, expect, test } from 'vitest'
import { compareRoster } from './audit-shanhai-wecom-overlap'

describe('compareRoster', () => {
  const wecom = [
    { userid: 'zhangsan', name: '张三', phone: '13800000001' },
    { userid: 'lisi', name: '李四', phone: '' },              // 企微侧无手机号
    { userid: 'wangwu', name: '王五', phone: '13800000003' },
  ]
  test('手机号唯一命中归交集；空手机号归「不可判」不乱配', () => {
    const local = [
      { name: '13800000001', phone: '13800000001' },          // identity_link 行（phone 列）
      { name: 'openid-abc', phone: '13800000003' },
      { name: 'openid-def', phone: '13800000001' },           // 与张三同号 → 歧义，双方都不自动判
    ]
    const r = compareRoster(wecom, local)
    expect(r.ambiguous).toHaveLength(1)                        // 13800000001 一号对两人
    expect(r.ambiguous[0].wecomUserids).toEqual(['zhangsan'])
    expect(r.matched).toHaveLength(1)                          // wangwu ↔ openid-abc
    expect(r.matched[0]).toMatchObject({ userid: 'wangwu', casdoorName: 'openid-abc' })
    expect(r.wecomNoPhone.map((w) => w.userid)).toEqual(['lisi'])
  })
  test('本地空表 → 全部 wecomOnly', () => {
    const r = compareRoster(wecom, [])
    expect(r.matched).toHaveLength(0)
    expect(r.wecomOnly.map((w) => w.userid)).toEqual(['zhangsan', 'lisi', 'wangwu'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**：`pnpm run test:guard -- audit-shanhai-wecom-overlap`
- [ ] **Step 3: 实现**。脚本骨架（纯函数 + IO 壳，IO 壳不做单测只做真跑）：

```js
// scripts/audit-shanhai-wecom-overlap.mjs — 山海企微通讯录 vs identity_link 存量摸底（只读）
// 用法：WECOM_CORP_ID=… WECOM_CONTACT_SECRET=… DATABASE_URL=… node scripts/audit-shanhai-wecom-overlap.mjs
// 产出：控制台摘要 + scripts/.out/shanhai-wecom-overlap.json（gitignore 的 .out 目录）
import { Client } from 'pg'

/** 纯函数：企微清单 × 本地(手机号, casdoor名) → 摸底报告。手机号是唯一强键；重名/重号不自动判。 */
export function compareRoster(wecom, local) {
  const byPhone = new Map()
  for (const l of local) {
    if (!l.phone) continue
    if (!byPhone.has(l.phone)) byPhone.set(l.phone, [])
    byPhone.get(l.phone).push(l)
  }
  const matched = []
  const ambiguous = []
  const wecomNoPhone = []
  const claimed = new Set()
  for (const w of wecom) {
    if (!w.phone) { wecomNoPhone.push(w); continue }
    const hits = byPhone.get(w.phone) ?? []
    if (hits.length === 1) { matched.push({ ...w, casdoorName: hits[0].name }); claimed.add(hits[0].name) }
    else if (hits.length > 1) ambiguous.push({ ...w, wecomUserids: [w.userid], candidates: hits })
    else { /* 本地无此号 */ }
  }
  const wecomOnly = wecom.filter((w) => !matched.includes(w) && !wecomNoPhone.includes(w) && !ambiguous.some((a) => a.userid === w.userid))
  return { matched, ambiguous, wecomNoPhone, wecomOnly, localOnly: local.filter((l) => !claimed.has(l.name) && l.phone && !matched.some((m) => m.casdoorName === l.name)) }
}

// ---- IO 壳（一次性真跑，不单测）----
// ① 企微：GET /cgi-bin/gettoken?corpid=&corpsecret= → access_token
//    GET /cgi-bin/department/list?access_token= → department[]（顶层 department_id）
//    GET /cgi-bin/user/list?access_token=&department_id=<id>&fetch_child=1 → userlist[]（userid/name/mobile）
//    多部门遍历后按 userid 去重（fetch_child 递归 + 多顶级部门会重叠）
//    mobile 为空 = 企微侧没填（全案已知坑），如实报告不猜测
// ② 本地：select casdoor_name, phone from platform.identity_link where org='shanhaiyiguo-org' and phone is not null
//    union all（去重）select name, phone from aftersales.employee where org='shanhaiyiguo-org' and phone is not null —— 表名以实际 schema 为准，跑前 \d 确认
// ③ compareRoster → console.table 摘要 + JSON 落盘
```

> WeCom API 形状是稳定公开接口；**mobile 字段能否取到取决于通讯录同步助手 secret 的敏感字段权限**（spec §6.2）——取不到时报告如实为「姓名弱键，转人工」。真跑前先 `curl` 一次 gettoken 验 secret。

- [ ] **Step 4: 测试绿 → Step 5: 真·摸底跑**（用户在 Casdoor 机同款出口或本地均可——企微 API 走公网；DATABASE_URL 指山海实例只读口）。记录：交集数、ambiguous 数、wecomNoPhone 数。
- [ ] **Step 6: 决策门（回填 spec D3）**：交集 ≈ 0 → Task 5 跳过；交集显著 → Task 5 纳入执行。结论写进 PR 描述与本计划文末执行记录。
- [ ] **Step 7: Commit + issue + PR**：

```sh
gh issue create -R MYTech-Co-LTD/platform-core -t "chore(auth): 山海企微通讯录摸底与对账脚本" \
  -b "spec §3.2/§3.3；摸底结论：【填交集数】"
git add scripts/audit-shanhai-wecom-overlap.mjs scripts/audit-shanhai-wecom-overlap.test.ts
git commit -m "feat(scripts): 山海企微通讯录存量摸底脚本（手机号强键比对）"
# push + PR（Closes #N）
```

---

### Task 3: 副本彩排（SSH 授权作业，照 mytech 全案）

**Files:** 无仓库文件（作业留档进执行记录 + WeKnora 更新在 Task 6）。

- [ ] **Step 0: 授权留档**：执行日志开头记录「根本法则第 1 条例外——Casdoor 机不在控制面，本次 SSH 作业经 spec/plan 审批授权，范围=山海 syncer 彩排与首同步」。
- [ ] **Step 1: 预检（只读）**：compose/镜像 digest/磁盘/容器健康/用户总数基线（`select count(*) from user` 按 owner 分组）。记录基线表——验收的「其他 org 零影响」以它为锚。
- [ ] **Step 2: T0 备份**：`pg_dump` 压缩**两份**落盘（全案惯例：不同目录），记录文件名与 sha256。确认旧镜像 tag 在盘。
- [ ] **Step 3: 副本环境**（mytech 全案同款）：临时 docker 网络隔离 + 副本 postgres 容器（恢复 T0 备份）+ conf 副本改 DB host + casdoor 容器指向副本。**副本 casdoor 用与生产同镜像 tag**。
- [ ] **Step 4: 建目标 org syncer 行（副本库）**：照 mytech 的 syncer 行 copy，改四值——`organization='shanhaiyiguo-org'`（**写前逐字核对，防写穿 `shanhai` 红线**）、user 字段=山海一果 **corpid**、password 字段=通讯录同步助手 **secret**、name 标识=`shanhaiyiguo-wecom-directory`；其余照抄：table_columns 的 **userid 列 casdoorName=Name + isKey:true**、**is_read_only=true**、**disabled=true**（手动触发）。
- [ ] **Step 5: 副本真同步**：`POST /api/run-syncer`（**新镜像是 POST**；请求体形状**逐字重放** mytech 全案执行留档里的成功请求，只换 syncerId/org——不按想象构造）。等任务完成后逐项验：

| # | 验收项 | 判据 |
|---|---|---|
| 1 | 撞键零 | run-syncer 无 duplicate key 报错 |
| 2 | 用户增量 | `shanhaiyiguo-org` 用户数 = 企微通讯录人数（Task 2 报告口径） |
| 3 | 组织树 | group 数与企微部门数一致，挂接正确（is_top_group 唯一） |
| 4 | 其他 org 零影响 | 基线表逐 org 比对：用户数/权限/订阅原样；**`shanhai` org（628 户）逐字节不变** |
| 5 | tenantsub 未动 | 锚用户原样（is_read_only 生效证据） |
| 6 | 反向零推送 | （结构性保证，副本上无法验企微侧，生产验收补） |
| 7 | roles 回填 | 抽同步户 get-user 看 roles/group（**给 console 计划 Task 1 spike 补山海样本**） |

- [ ] **Step 6: 决策门**：七项全绿 → 进 Task 4；任何一项红 → 修配置回 Step 5（副本随便炸，这正是彩排的意义）。

---

### Task 4: 生产首次真同步 + 验收

- [ ] **Step 1: 生产建 syncer 行**（Step 4 同款 SQL 打到生产库，仍 disabled）。
- [ ] **Step 2: 生产 run-syncer**（POST，同款请求体）。
- [ ] **Step 3: 生产验收** = Task 3 Step 5 七项 + **第 6 项补验**：请企微管理员看通讯录人数**不变**（is_read_only 生效的最终证据）。
- [ ] **Step 4: 观察期登记**：syncer 保持 disabled + 手动触发（spec D4）；把「手动重跑同步只 add/update、不翻转 forbidden」的实测结论记进执行记录（这决定对账脚本是否需要每次同步后补跑——spec §3.3）。
- [ ] **Step 5: 若摸底交集 ≈ 0**：本任务到此为止，跳过 Task 5 直进 Task 6。

---

### Task 5: 对账脚本（条件执行——摸底交集显著才做）

**Files:**
- Create: `scripts/reconcile-shanhai-wecom-users.mjs`
- Test: `scripts/reconcile-shanhai-wecom-users.test.ts`

**Interfaces:**
- Produces: `buildReconcilePlan(matched, syncedUsers)` 纯函数 → 动作清单；`--apply` 才落库。默认 dry-run **响亮打印将执行的每条动作**（identity_link insert + 禁用重复户），不打 `--apply` 绝不写。

- [ ] **Step 1: 失败测试**（纯函数）：

```ts
import { describe, expect, test } from 'vitest'
import { buildReconcilePlan } from './reconcile-shanhai-wecom-users'

test('重叠自然人 → identity_link 绑定 + 重复户禁用；已有 active 绑定的不重复出动作', () => {
  const plan = buildReconcilePlan(
    [{ userid: 'wangwu', name: '王五', casdoorName: 'openid-abc' }],
    [{ name: 'wangwu', displayName: '王五', isForbidden: false }],
    [{ provider: 'wecom', externalId: 'wangwu', casdoorName: 'openid-abc', status: 'active' }],
  )
  expect(plan.links).toHaveLength(0)                    // 已有绑定 → 不重复
  expect(plan.disable).toEqual(['wangwu'])
})
test('无既有绑定 → 出绑定动作（bound_via=manual, status=active）', () => {
  const plan = buildReconcilePlan(
    [{ userid: 'zhangsan', name: '张三', casdoorName: 'openid-def' }],
    [{ name: 'zhangsan', displayName: '张三', isForbidden: false }],
    [],
  )
  expect(plan.links).toEqual([
    { provider: 'wecom', externalId: 'zhangsan', casdoorName: 'openid-def', status: 'active', boundVia: 'manual' },
  ])
  expect(plan.disable).toEqual(['zhangsan'])
})
```

- [ ] **Step 2: 红 → Step 3: 实现**（IO 壳：读 Task 2 落盘 JSON + Casdoor Admin API listUsers + identity_link 现状 → plan → dry-run 打印 / `--apply` 逐条执行，单条失败收集续跑；Casdoor 写走 CasdoorClient 等价调用——**参考迁移先例：容器内跑等价客户端调用**，脚本直连 Casdoor Admin API 需 admin 凭据经 env 注入）。**Step 4: 绿 → Step 5: 真跑**（dry-run 人工过目 → --apply）→ Step 6: Commit + PR（并入 Task 2 的 issue/PR 或单独，二选一登记清楚）。

```sh
git commit -m "feat(scripts): 山海企微重叠自然人对账脚本（绑定归一+重复户禁用，dry-run 默认）"
```

---

### Task 6: WeKnora 更新原条目 + 知识沉淀

- [ ] **Step 1: 查重确认**（knowledge-capture 纪律第 4 条）：hybrid-search「Casdoor 企微通讯录同步」→ 命中原条目 `919ae8e9-52b8-4553-9ae4-7983f3891d82`（2026-10-24 已预查命中）→ **更新原条目，不新建**。
- [ ] **Step 2: 取全文**：`GET /knowledge/919ae8e9-…` → `metadata.content`。
- [ ] **Step 3: 追加「山海复刻（2026-10-XX）」章节**（正文注意 WeKnora WAF 触发词：不写完整查询语句、不写改权限类命令与八进制权限位同现、降低代码密度）：
  - 复用结论：同款配置三键（isKey/is_read_only/disabled+手动）零改动复用；
  - 山海特有：存量 openid 命名户与企微户的摸底比对法（手机号强键 + 重号歧义不自动判）；
  - 「手动重跑不翻转 forbidden」实测结论；
  - effectiveScopes 角色继承的真机结论（与 console 计划 Task 1 spike 合并记录）；
  - 踩的新坑（若有）。
- [ ] **Step 4: `PUT /knowledge/manual/:id` 更新 → `POST /knowledge/:id/reparse` → 轮询 parse_status=completed → hybrid-search 验新内容可检索**。
- [ ] **Step 5: 收尾**：执行留档（授权记录/基线表/验收清单）归档到 openship-platform 侧运维记录或 PR 描述；spec 状态行更新（「Phase 0/1 已执行，结论回填 §…」）+ commit `docs(auth): 山海企微同步执行结论回填`。

---

## 执行记录（2026-10-26 执行完毕）

- **授权留档（根本法则第 1 条例外）**：Casdoor 机 SSH 作业经本 runbook 审批授权（2026-10-24 spec 定稿 + 用户 2026-10-26 指示「用 casdoor provider 凭证做同步」）。secret 全程 DB 侧/变量内流转，未进终端记录与文件。
- **Task 1 前置**：用户改道——不用通讯录同步助手 secret，改用 Casdoor 已配 provider `wecom_silent`（corpid ww8252c1eee248867c）的自建应用凭证；企微侧权限已由用户放开，实测能拉全量。⚠️ 修订认知：自建应用权限给够也能拉通讯录（旧认知「必须通讯录同步助手」作废，已写进 WeKnora 订正）；手机号字段仍不可得。
- **Task 2 摸底**：243 部门 / 403 人（status 1=170 已激活、4=232 未激活、5=1 退出中）、手机号 0。对账判定：目标 org 存量仅 3 户（identity_link 0 行 / employee 0 行），唯一撞名 `ZhangDuo` = 同一人（预期覆盖，mytech 先例），**交集≈0 → Task 5 跳过**。摸底 dump 留存 `scripts/.out/shanhai-wecom-dir.json`（gitignore）。
- **Task 3 彩排（副本七项全绿）**：T0 备份双份（容器内 -f 落盘 + docker cp；流式重定向会产出脏文件——新坑已沉淀 WeKnora）→ 副本 pg17（版本对齐生产）+ conf 整目录挂载 → syncer 行 INSERT…SELECT 模板 copy（secret 走 provider 子查询）→ `POST /api/run-syncer?id=admin/shanhaiyiguo-wecom-directory` → 用户数 405=3+402 精确命中、243 组、其他 org 零扰动、锚用户原样、权限绑定逐行一致、未激活→isForbidden 映射确认（171 外/234 内）。
- **Task 4 生产同步**：二次备份 → 生产行（is_read_only=t / is_enabled=f / interval=0）→ run-syncer 72 秒 ok → **验收全绿**：405/243/其他 org 原样/tenantsub 原样/权限 18 条原样/无重复名；**反向零推送实锤：企微通讯录人数 403→403**。回滚三件套在 `/root/casdoor-backup-2/`（3 份 dump）。重跑方式 = 同一条 run-syncer（syncer 保持 disabled 手动）。
- **Task 5 对账**：按判定跳过，未执行。
- **Task 6 WeKnora**：已更新原条目（`919ae8e9`，山海复刻章节 + 备份姿势坑 + 自建应用凭证订正），reparse 后新内容可检索。
- **后续**：山海实例手工更版（console 页面等本同步数据就绪后发布）——待用户触发。
