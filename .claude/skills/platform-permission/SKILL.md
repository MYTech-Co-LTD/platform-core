---
name: platform-permission
description: 做新功能凡涉及接入平台权限时必用——新模块/新权限码/新路由/新 console 页要挡权限，或数据要按部门限制谁能看。四段判停（声明→门卫→扇出→验证）+ 三条红线；权限语义正典是 docs/module-protocol.md 与 docs/architecture.md，部门门原语在 modules/data/domain/dept-gate.ts。
---

# platform-permission：权限接入执法器

## 定位（先读）

- 本 skill 是**流程执法器 + 指针**，不是第二事实源。权限语义正典：
  `docs/module-protocol.md`（manifest 判据 / 声明即授权）与 `docs/architecture.md`（不变量）；
  部门门实现 = `modules/data/domain/dept-gate.ts`。本文件只负责「**别跳步、别自己造**」。
- 正典与本 skill 冲突时**正典赢**，并回来改本文件。
- 列级/值级裁剪（按人裁列、脱敏值）**不存在现成原语**——那是开放 issue #764，
  需求落在那一档时先推动 #764，**不要在业务侧自造**。

## 第 0 步：选路（先判你要接的是哪一档，再动手）

| 你的需求 | 走哪条 | 原语在哪 |
|---|---|---|
| 功能能不能用（API / console 页） | **① 声明式权限** | manifest `permissions` + `api.internal[].scope` + `frontend.console[].scope` |
| 数据按部门谁能看 | **② 部门门** | `requiredDepts` + `deptGatePasses` / `validateDeptGate` / `userDeptClosure` |
| 按人裁列 / 裁值 / 脱敏 | **③ 未做** | issue #764——先立项，不自造 |

判不清时问一句：「挡的是**动作**（能不能调）还是**数据**（能看哪行）？」——动作走 ①，行级走 ②。

## 路线 ①：声明式权限（四段判停，段段不过不进下段）

### A. 声明（manifest 是唯一事实源）

```yaml
permissions:
  - { code: mymod:view, name: 查看 }        # 命名：<模块id>:<动作>，全小写
api:
  internal:
    - { method: GET, path: /items, scope: mymod:view }
frontend:
  console:
    - { path: /console/mymod, scope: mymod:view, ... }
```

**判停**：
- 每条路由（含 console 后端）都有 `scope`；**未声明 = 部署后恒 403**，不是"先放行后补"
- 码名带模块前缀（`mymod:view`），别发明裸名（`view`）——权限码按租户 org 扇出，裸名跨模块撞车
- 只读用 `:view`，写操作给独立码（`mymod:edit`），别一个码包打天下

### B. 门卫（宿主施加，你别写）

**判停**：
- **不在模块代码里自己写权限检查**——宿主按 manifest 施加门卫（声明即授权、fail-closed）；
  你写的检查是第二套真相，早晚和声明漂移
- **双向核对会杀装载**：注册路由集合 ≠ 声明集合 ⇒ 容器**起不来**（不是告警）。
  改路由/改 manifest 只改一边 = 部署即挂——这是特性不是缺陷
- HEAD 请求按 GET 归一（宿主已处理），不用管

### C. 扇出与授权（码怎么到人身上）

- 装载器自动把码供给到**每个租户各自的 Casdoor org**（`provisionModulePermissions`）——
  多租户下不存在"只写一个 org"，漏一个 org 该租户全员模块 API 403
- 供给失败**不再杀进程**（#579 起：降级 + 后台退避重试 + 集成页 `casdoor-admin-session` 变红）——
  看到「平台起了但模块全 403」先查 admin 会话，别怀疑自己的 manifest
- **授权给人**：平台超管在 Casdoor 后台挂码；租户管理员在 console 角色页（码→角色→人）。
  交付新模块时把「要给谁挂哪个码」写进交付清单，别让码声明了却没人持有（症状：规则/页面配了但全员 403）

### D. 验证（顺序固定）

1. `pnpm exec tsx scripts/check-manifests.mjs`（CI 同款，秒级）
2. 本地起 dev-stack，**匿名**打声明的路由 ⇒ 401；带无码用户 ⇒ 403；挂码用户 ⇒ 200
3. console 页：无码用户**看不到入口**（frontend scope 挡的是菜单/路由，不只是页面内容）
4. 涉及 UI 的按规矩自己开浏览器走一遍（`开发完自己开浏览器验证`）

## 路线 ②：部门门（数据行级）

**判停**：
- 数据对象带 `requiredDepts: string[] | null`（部门 ext_id）；请求侧用
  `userDeptClosure(pool, tenantId, userId)`（含祖先闭包）+ `deptGatePasses(...)` 判定
- 配置入口必须过 `validateDeptGate`——部门不存在/组织未同步 ⇒ **拒绝配置**（fail-closed），
  绝不接受"配了但永远没人能满足"的门
- **部门数据源 = `platform.org_node` / `org_membership`**（企微同步维护）。模块直读平台表会被
  B1 架构门禁拦——走**只读视图 + manifest `dataDependencies` 声明**（先例：`013_org_views.sql`）
- 判定缺 `userDepts`（undefined）且行带门 ⇒ **不可见**（fail-closed），别把 undefined 当空集放行

现成样例：报表行级门 `modules/data/routes/reports.ts`（`requiredDepts` + `PUT /reports/:id/dept-gate`）。

## 三条红线

1. **不自造第二套权限**：不写模块内的检查逻辑、不发明 manifest 之外的码、不绕过宿主门卫直挂路由。
2. **不做静默降级**：门卫失败就是 403/404，不"先放行再记日志"；部门门配不了就是拒绝，不建"永远过不了的门"。
3. **列级/值级不自造**：需求落在 #764 那一档时先立项，不在业务侧各写一份裁剪。

## 完工回写

- 判据/契约变了：改 `docs/module-protocol.md`（正典），本 skill 只跟指针
- 踩到新坑（如装载期双向核对的报错形态、Casdoor 扇出的坑）：按知识沉淀规矩进 WeKnora，
  通用教训再回写本文件
