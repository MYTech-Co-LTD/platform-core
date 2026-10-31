# 多渠道出站：`ImProvider` 契约 + 凭据表 + 企微直连（设计）

> **状态：待用户 review（2026-10-31 起草）。** 按架构先行，review 通过后开 issue 分三期实施。
> 触发：山海企微轮卡在「共享桥没注册这个租户」；用户提出**后续要接飞书、钉钉**。

## 0. 一句话

把「发一条 IM 消息」收敛成 **N 个 provider 共用一套契约**：凭据加密入库、token 统一缓存、
语义消息按渠道渲染、活性判据 = 能取到 token。**企微直连是第一个实现，同时干掉共享桥这个历史跳板。**

## 1. 现状与证据（2026-10-31 实测）

| # | 事实 | 后果 |
|---|---|---|
| 1 | 共享桥 `push.hookflow.cn` 的 `tenants.local.json` 只有 `woke` / `mytech` 两个租户（**文件式，不入库**） | 新增一客户 = 人工把该客户的企微凭据搬到桥主机上 |
| 2 | 平台自己的 `platform.tenant` 里**已经**有 `wecom_corp_id / wecom_agent_id / wecom_secret`（山海拔实测：18/7/43 字符） | **凭据已存在两份**；桥当初「凭据不进应用」的理由已不成立 |
| 3 | `checkWecomHealth` 探的是 `{origin}/healthz`（桥主机） | **假绿**：桥活着但租户没注册，健康检查照样 200 |
| 4 | 平台已有 `renderContents(contents, payload, providers)`：模板按 provider 分键（`wecom_chat`/`in_app`/`webhook`） | 消息模型已是「语义消息 + 每渠道渲染」形状 ✅ |
| 5 | 平台已有 outbox（`notify.event → delivery → worker`）+ 重试/退避/幂等/审计 | 投递层不需要新建 ✅ |
| 6 | 平台已有 `platform.identity_link(provider, external_id, casdoor_name)` | 身份映射有骨架 ✅，缺各渠道的绑定入口 |
| 7 | 集成健康已是 provider 无关的（`kind` + `source`） | 每个渠道加一条判据即可 ✅ |

**结论**：六层里 ④⑤⑥ 已就位，缺的是 **① provider 契约**、**② 凭据存储**，③ 缺各渠道绑定入口。

## 2. 六层与不变量

| 层 | 不变量 |
|---|---|
| ① Provider 契约 | 薄、无状态、可穷举单测；**不做**跨渠道统一卡片/SDK |
| ② 凭据 | **入库必加密**（AES-256-GCM + KEK 在 env）；明文只在进程内存；轮换留痕 |
| ③ 身份映射 | 绑定**时**落 `identity_link`，发送时只做一次索引查询（飞书 `open_id` 是应用级，发送时现拉必被打限流） |
| ④ 消息 | 语义消息（title/body/blocks/link/actions）+ **每渠道渲染器**；模板按 provider 分键 |
| ⑤ 投递 | 复用现有 outbox；每渠道只补**错误分类**（可重试 / 永久）与限流码 |
| ⑥ 健康 | 判据 = **能否取到 token**；`kind=token`，一条/（渠道 × 租户） |

## 3. 设计

### 3.1 `ImProvider` 契约（`modules/notify/domain/im/`）

```ts
export interface ImCredential {
  /** 渠道内的应用标识：企微 corpId / 飞书 app_id / 钉钉 appkey */
  appKey: string
  agentId?: string
  /** 已解密的 secret（只在进程内存里出现） */
  secret: string
}

/** token 租约：统一 TTL、统一单飞（同 key 并发只取一次） */
export interface TokenLease { token: string; expiresAt: number }

export interface ImProvider {
  readonly id: 'wecom' | 'feishu' | 'dingtalk'
  readonly capabilities: { markdown: boolean; card: boolean; mention: boolean }
  /** 取 token（内部走 token 缓存；失败抛错，调用方按 retryable 处理） */
  token(cred: ImCredential): Promise<TokenLease>
  /** 发一条消息；`target` 是该渠道的用户标识（userid / open_id …） */
  send(lease: TokenLease, cred: ImCredential, target: string, msg: RenderedMessage): Promise<SendResult>
  /** 活性判据：只证明「凭据还能换到 token」——这是唯一不撒谎的信号 */
  probe(cred: ImCredential): Promise<{ ok: boolean; detail?: string }>
}
```

`RenderedMessage` = 现有 `renderContents` 的输出（每 provider 一份），**不新造消息模型**。

### 3.2 凭据存储：`notify.channel_credential`

```sql
create table if not exists notify.channel_credential (
  org            text not null,
  provider       text not null,          -- wecom | feishu | dingtalk
  app_key        text not null,          -- corpId / app_id / appkey（明文，用于展示与去重）
  agent_id       text,
  secret_enc     text not null,          -- base64(iv || ciphertext || tag)
  key_version    int  not null default 1,
  extra          jsonb not null default '{}',
  created_by     text not null,
  created_at     timestamptz not null default now(),
  rotated_at     timestamptz,
  primary key (org, provider)
);
```

- **加密**：`AES-256-GCM`，KEK 来自 env `NOTIFY_CRED_KEK`（32 字节 hex）；`key_version` 只为将来轮换留位（本期不做轮换 UI）。
- **fail-closed**：KEK 缺失 ⇒ 拒绝加密/解密 ⇒ 该通道**发不出去且判据 PROBE_FAILED**（绝不降级成明文存储）。
- **env 路线保留**：私有化交付仍可 `WECOM_DIRECT__<ORG>=corpId|agentId|secret` 注入（与 DB 二选一，DB 优先）；两者都没有 ⇒ 通道未配置。
- **与 `platform.tenant.wecom_*` 的关系**：后者服务**登录**（SSO），前者服务**出站**；本期**不合并**，但提供一次性导入（`POST /channels/:id/import-tenant-cred`，把 platform 那份搬进 notify 并加密）避免运维重录。合并 SSO 读取路径属后续议题（需端口化，YAGNI 本期）。

### 3.3 token 缓存

- key = `(org, provider, appKey)`；进程内 `Map`；TTL = `expires_in - 300s`；
- **单飞**：同 key 并发取 token 只发一次请求（其余 await 同一个 promise）；
- 多副本各自缓存（token 无状态、可并存）⇒ **不引 Redis**（私有化现场优先少依赖）。

### 3.4 判据改造（修假绿）

- registry 里 wecom 那条：`source` 从 `http-healthz:WECOM_BRIDGE_URL__…` 改成 **`token:wecom:<org>`**；
- 语义：**能换到 access_token 才算活**——同时覆盖「凭据失效 / 被禁用 / 出口 IP 被拒」三种真故障；
- 桥主机 `/healthz` 从此**不作为**任何租户的活性证据（它只证明桥进程活着）。

### 3.5 迁移与回滚（企微）

| 步 | 动作 | 回滚 |
|---|---|---|
| 1 | 落 `channel_credential` + 导入山海凭据（加密） | 删行 |
| 2 | 加 `wecom_direct` provider，**通道级开关** `notify.channel.config.transport = 'direct' \| 'bridge'`（缺省 bridge） | 改回 bridge |
| 3 | 山海切 direct，发一条真机消息验收 | 同上 |
| 4 | 早于 direct 的客户保持 bridge；桥对 platform-core **不退役**，只是不再是默认 | — |

> 共享桥仍服务 Novu 老链路与其他项目，**不动它**。

### 3.6 身份映射（本期只做企微）

- 发送目标仍由 `ChannelAddressResolver.resolve({provider, casdoorName})` 解析（现有实现查 `identity_link`，provider=`wecom`）；
- 飞书/钉钉接入时**只加**各自的绑定入口与 `provider` 取值，不改这条解析路径。

## 4. 数据流

```
模板(按 provider 分键) ──renderContents──► RenderedMessage
                                            │
worker（既有 outbox）──► provider.send(token, cred, target, msg) ──► 渠道 API
                              ▲
      token(cred) ──► TokenLease（缓存 + 单飞）
                              ▲
   channel_credential（密文）──解密──► ImCredential（内存）
```

## 5. 分期与验收

| 期 | 内容 | 验收（真机） |
|---|---|---|
| **P1** | 契约 + 企微直连 provider + `channel_credential`（加密）+ token 缓存 + 判据改 `token` + 导入接口 | ① 山海切 direct 后**真机收到一条企微消息**（不经共享桥）；② `psql` 直接看 `secret_enc` 是密文；③ 判据条目变 `token:wecom:…` 且 OK；④ **变异**：写错 secret ⇒ 判据 PROBE_FAILED 并点名渠道；KEK 删掉 ⇒ 发送 fail-closed（不落明文、不静默发） |
| **P2** | 飞书 provider + 凭据录入 UI + 扫码授权绑定 | 真机收到一条飞书卡片消息；绑定后 `identity_link` 有 `feishu` 行 |
| **P3** | 钉钉 provider 同上 | 真机收到一条钉钉 markdown |

## 6. 明确不做（YAGNI）

- **代开发 / ISV 应用商店形态**：与「多渠道」正交；只在一个实例托管很多小客户时才需要。
- **跨渠道统一卡片抽象**：飞书卡片 / 钉钉 ActionCard / 企微 markdown 语义边界不同，硬抽必被撕开。
- **Redis 级 token 缓存**：私有化现场优先少依赖；多副本各缓存即可。
- **KEK 轮换 UI**：只留 `key_version` 字段，轮换流程等真有需求再定。
- **把 SSO 也改成读 notify 凭据表**：需要端口化，本期不动。

## 7. 风险

1. **KEK 丢失 = 全部通道凭据需重录**（加密的代价）——备份策略写进交付 runbook；
2. 企微**目录类**接口仍受「可信 IP」主体校验（60020），与出站发送是两条路，本设计不解决它（org-sync 另案）；
3. 凭据从 env 转 DB 后，**审计面变化**：谁能读表谁就能解密（进程内）——DB 只授 `notify` 应用账号，且有 `audit` 记录写入；
4. 迁移期两条路并存（bridge/direct），配置漂移的风险由**通道级 `transport` 字段**单一开关兜住。

## 8. 与既有体系的关系

- **通知基础设施 spec（2026-10-27）**：本节只把 `wecom_chat` 的**实现方式**从「外挂桥」换成「provider + 凭据表」，通道/模板/规则/投递语义不变；
- **集成健康（2026-10-31）**：判据从 `http-healthz` 改 `token`，是那份设计里「token 类主动 dry-run」的第一次真实使用；
- **安全基线**：凭据**不入 repo、不入日志、不进会话**；DB 内加密；界面只显示 `appKey` 尾号与「已配置」。
