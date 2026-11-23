# Casdoor 职责边界与订阅归属（决策记录）

> 状态：✅ **已定（2026-11-23 人裁）**；条文即刻生效，落地按 §6 清单。
> 性质：边界 ADR。它**不推翻**既有裁决（D4 双层、订阅源默认 casdoor、组织架构 D5 修订、账户统一 B' 否决），
> 而是把它们收拢成一张职责矩阵，并对三个具体问题做终裁：渠道 provider、绑定同步、订阅归属。
> 不变量已挂 `docs/architecture.md` §4.2「Casdoor 边界」。

## 1 背景

售后花名册接入（冷启动）引出三个连锁问题：

1. 员工从企微 / 公众号 / 未来钉钉进入，如何被识别成同一个人？
2. 我们做了一整套公众号身份链路，**却没有在 Casdoor 创建公众号 provider**——是不需要还是漏了？
3. 模块订阅与付费，用 Casdoor 的 plan/subscription/payment，还是自建？

三个问题的答案共同指向同一个原则：**业务真相在平台，Casdoor 只收投影；认证域的事留给 Casdoor，商业域的事不塞给它。**

## 2 Casdoor 职责矩阵（宪法级）

| 维度 | Casdoor | 平台 | 谁都不做 |
|---|---|---|---|
| 员工账号（存储/密码/MFA/禁用） | ✅ 权威 | 建号时机（JIT 规则） | — |
| 权限码 → 角色 → 人 | ✅ 权威 | manifest 声明面、门卫、scope 解析、按 org 扇出 | — |
| 订阅**运营面记录** | ✅（现状，见 §4 迁移） | — | — |
| 渠道 OAuth（公众号/企微/钉钉） | ❌ | ✅ 宿主 adapter（现状：`auth-wechat-oa` / `auth-wecom`） | Casdoor broker 化（除非 §3 触发） |
| 身份绑定（多 provider ↔ 账号） | ❌（单值列模型错配） | ✅ `platform.identity_link`（权威） | 双写同步 |
| 外部顾客（访客） | ❌ | ✅ 访客 session | 顾客进 Casdoor |
| 平台会话 | ❌ | ✅ 平台自签（HttpOnly Cookie，自包含） | Casdoor 签应用会话 |
| 组织架构 | ❌（2026-10-30 D5 修订已迁出） | ✅ `platform.org_*` | 双写 |
| **订阅真身（授权结果）** | ❌（见 §4） | ✅ subscription 域 | 两处真身 |
| **计费/支付/发票** | ❌（见 §5） | 待建（触发后） | 用 Casdoor payment |

**一句话**：Casdoor = **员工身份与权限的权威 + 公司 SSO 中心**；平台 = 渠道适配、绑定工作流、会话、组织、业务、订阅与计费。

## 3 渠道 provider 终裁

**裁决：不在 Casdoor 创建渠道 provider（含公众号 WeChat Mobile）；渠道 OAuth 继续由宿主自实现。**

理由（五条，与 §2 矩阵同源；1、2 是「入口在公众号」这一真实场景（售后 `/app/aftersales`）的直接结论）：
1. **静默授权的体验不可替代**：宿主路用 `snsapi_base` 静默拿 openid（「入口即授权」，SPA 只载一次）；
   Casdoor 的 WeChat Mobile provider 走 `snsapi_userinfo`——**弹授权页**，把无感入口变成有感；
   要静默就得宿主自实现，那就回到了现状本身。
2. **两态访客装不下**：售后的核心设计是「中间态访客（openid 先到）→ 绑定后正式态」；
   Casdoor 登录要么有账号要么失败，没有「先访客后绑定」的中间态。
3. **多租户 appid**：每租户自己的公众号 appid ⇒ 需 per-org provider，provider 数 = 租户数，运维面膨胀；
4. **单值列**：Casdoor `User.Wechat` 为单值列，一人多公众号 openid（工作号/生活号、换 appid）装不下；
5. **绑定是业务工作流**：pending/active/revoked/disputed、审核单关联、异议、审计——Casdoor 无载体；
   且售后访客是 C 端顾客，不应进 Casdoor 的内部账号模型。

> **案例（2026-11-23）**：售后入口在公众号内 ⇒ 曾被提议「公众号也绑到 Casdoor」。结论是不绑——
> 「入口在哪」与「认证由谁发起」是两件事：入口在公众号，正是**宿主自实现静默授权**的理由。

**「单向同步 openid 进 Casdoor」不做**：没有 provider 配置时，写进 `user.wechat` 的是一个**无法验证的字符串**
（Casdoor 不用它登录，外部系统也无法验证租户级 openid）——无语义的同步只会制造第二份真相。

跨系统识别按需求分层：

| 对方需要什么 | 提供什么 | 存在哪 |
|---|---|---|
| 「这个人是谁」 | 规范 id = `casdoor_name` | Casdoor（已有） |
| 「他有哪些外部身份」 | 绑定**查询面**（宿主端口/内部 API） | `identity_link` 数据已有，**查询面待建** |
| 「用公众号登录我这个系统」 | 那时才配 provider | Casdoor per-org（**触发后**） |

**Casdoor broker 化触发条件**：第三方系统经 Casdoor SSO 接入，且要求「公众号」是 Casdoor 登录页的入口之一。
届时前置：per-org provider（appid/secret）、回调域名、Casdoor 侧用户绑定、开放 id ↔ 本地绑定的冲突处理。
**并存口径**：即使触发，平台的访客入口**仍保持宿主静默路**（理由 1、2 不因触发而消失）；Casdoor provider
只服务「经 Casdoor 登录其他系统」这一条，两者各服务各的场景。
在此之前配了也没人用，反而多一份与 `identity_link` 并存的绑定源。

## 4 订阅归属终裁

**裁决：订阅真身归平台；Casdoor 只收投影（订阅生效后的角色/权限码授予）。**

| | 平台 | Casdoor |
|---|---|---|
| 是什么 | `plan`（模块组合 × 档位 × 额度）+ `subscription`（org × plan × 起止 × 状态：trial/active/overdue/canceled）+ `audit` | 该租户 org 的角色成员与权限码授予 |
| 为什么 | 与 `tenant_module` / `enabledFor` / 权限闸门**同域**才有一致性；订阅变更要审计、可回滚、可试算；不依赖认证服务做功能开关 | 权限的运行时判定需要 `effectiveScopes`（投影必须继续） |

**不使用 Casdoor 的 plan/subscription/pricing/payment 作为订阅载体**，理由：
1. **模型错配**：Casdoor 订阅是扁平套餐 × organization，你的商品是「模块组合 × 档位 × 席位/额度」；
2. **业务语义缺失**：变更历史、审计、试用、欠费停服、回滚——Casdoor 无载体（与绑定问题同构）；
3. **两处真身**：授权判定必在平台，订阅在 Casdoor 就多一条同步链路与漂移风险。

**迁移路径（现成条件）**：`PLATFORM_SUBSCRIPTION_SOURCE` 开关（默认 casdoor）+ `tenant_module` 回滚兜底已在。

```
① 平台建 subscription 域（platform schema）
② 运营面：console「管理」组订阅页（超管：列表/开通/续费/到期）
③ 双写期：平台为准；订阅生效时投影到 Casdoor（角色/权限码）
④ 切 PLATFORM_SUBSCRIPTION_SOURCE=platform
⑤ 移除 Casdoor 读取路径（保留投影写入）
```

**注意**：迁移的是**真身**，不是投影——Casdoor 的角色/权限授予必须继续写（否则 `effectiveScopes` 消失）。

## 5 计费与支付（触发后做）

- **billing 域不预建**（无案例不立标准）。触发：在线购买 / 试用期 / 欠费停服 / 按量计费 / 需要发票与收入对账任一首次出现。
- **与 entitlement 解耦**：billing 只输出「已支付 / 有效 / 额度」这一结论，订阅状态机在 entitlement 域；两者不互相嵌入。
- **支付渠道**：**待核实项**——Casdoor 支持的 payment provider 列表尚未做一手核实，任何选型前先查；
  实现形态参考：国内场景大概率是支付宝/微信/对公转账 + 人工核销（发票是刚需），海外才是 Stripe/PayPal。

## 6 落地清单

| # | 动作 | 触发 | 状态 |
|---|---|---|---|
| 1 | 本 ADR + architecture §4.2「Casdoor 边界」不变量 | 即刻 | 本 PR |
| 2 | 平台 subscription 域（表 + 运营页 + 审计）+ 切换 `PLATFORM_SUBSCRIPTION_SOURCE` | 订阅运营需求（**已确认要做**） | 待排期 |
| 3 | 绑定查询面（宿主端口/内部 API） | 第一个外部身份消费者 | 待触发 |
| 4 | Casdoor broker 化（provider/回调/同步/冲突） | 三方系统 SSO + 公众号入口 | 待触发 |
| 5 | billing 域 + 支付接入 | 在线支付/欠费/发票场景 | 待触发 |

## 7 与既有正典的关系

| 正典 | 关系 |
|---|---|
| `2026-09-13-saas-admin-domain-design.md` D4（订阅双层） | **不推翻**；「订阅真身」位置由本 ADR §4 终裁为平台，D4 的双层运营语义随 §4 迁移 |
| `2026-10-27-authz-hardening-design.md` D4（订阅源默认 casdoor） | 保留为**当前默认**；§4 迁移完成后默认切 platform |
| `2026-10-30-org-as-platform-primitive-design.md` D5 修订 | **同源扩展**：该文已定「Casdoor 只存人 + 权限码 + 角色」，本 ADR 把它扩成完整职责矩阵 |
| `2026-10-10-aftersales-account-unification-design.md` §2 B' 否决 | **维持**；本 ADR §3 补充「不建 provider、不做 openid 同步」的明确表述 |
| `docs/architecture.md` §4.2 | 新增「Casdoor 边界」不变量（仅文档档） |

## 8 本 ADR 不做什么（防预建）

- 不在 Casdoor 建任何渠道 provider；
- 不做 openid → Casdoor 的同步；
- 不建 billing 域、不接在线支付；
- 不改账户统一 Phase 1 的既有实现（两态 session、identity_link 结构不变）。
