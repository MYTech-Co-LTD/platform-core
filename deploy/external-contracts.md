# 外部契约清单（换机 / 换域名 / 换控制面时必须逐项过）

> 2026-11-20 起。**只写「在哪、怎么配、怎么验」，不写密钥明文。**
> 事故来源：W4 把应用单元从 `113.249.104.181` 换到 `113.249.104.180` 后，企微自建应用的
> 「企业可信IP」没跟着搬 ⇒ `department/list 60020 not allow to access from your ip`，
> `org.sync` 每轮红、平台侧企微投递 14 天为 0。**机器起来了 ≠ 外部契约还在。**

## 1. 契约清单

| 外部系统 | 绑定形态 | 当前绑定值 / 登记处 | 换机 / 换域名的影响 | 验证判据 |
|---|---|---|---|---|
| 企业微信·自建应用（组织同步、服务端消息） | **出口 IP 白名单** | 应用单元出口 `113.249.104.180`；配置处：企微后台 → 应用管理 → 自建应用 → 企业可信IP | 换机即 `60020`；`org.sync` 红、服务端发消息被拒 | `org.sync` exit 0（0 变更）；`notify.channel_probe.wecom_chat.reachable=true` |
| 企业微信·机器人回调 | 入站回调 URL + token/aeskey | `bot-admin.shanhaiyiguo.com`（openship edge → openclaw:18789） | 换域名/换 edge 需在企微重配，否则群消息无回包 | 群内发一条消息，收到回复 |
| Casdoor OIDC | redirect URI / issuer | `platform.shanhaiyiguo.com`；应用配置见 openship env `CASDOOR_APPLICATION` | 换域名需改 Casdoor 应用的 redirect | 浏览器登录回跳成功 |
| GitHub（部署触发 / Checks） | payload URL + secret | `deploy.hookflow.cn`（控制面）；secret 在 GitHub repo/org | 控制面地址变更需改 webhook | 一次 push 能触发部署，Check 状态回写 |
| 天翼 ZOS（对象存储） | AK/SK 凭据鉴权，**无 IP 白名单**（2026-11-20 实测：新应用单元出口 `113.249.104.180` 直连售后桶 `ListObjectsV2` 即通） | openship env（isSecret）：`ZOS_*` / `LEMENG_ZOS_*` | 换机**不需要**加白；若某桶单独开了白名单会表现为 `403 AccessDenied`（不易定位，注意区分） | 容器内用同份凭据 `ListObjectsV2`（探针脚本见 issue #2548 关联记录）；采集落湖成功、湖侧可读 |
| OpenObserve ingest | token + host | 各机 `/etc/openobserve-ingest.env`；OO 机 `10.0.0.3` | 换机需同步该文件；漏了只是「没监控」不报错 | OO 里能看到该机 metrics |
| openship 通知通道（job 失败推送） | webhook URL | 控制面通知通道配置 | 通道/域名变更需改；注意 job 通知**不进 deliveries feed**，只能开环到群验证 | 故意失败一次 job，群里收到 |
| 支付宝结算（若启用） | 账号 / 证书 / IP（待核实） | 【待核实】 | — | — |

## 2. 迁移验收清单（每次换机 / 换域名照单打勾）

1. **出口 IP 白名单**：企微「企业可信IP」等按源 IP 鉴权的系统，全部确认新出口已加入。
2. **入站回调 / OAuth redirect**：机器人回调、OIDC redirect、GitHub webhook 指向新地址。
3. **部署连带重启面**：本次部署会不会重建状态容器（`postgres` / `pg_duckdb` / console）——
   见 `deployment-units.md` §5。
4. **全量 job 引用扫描**：所有 `docker exec <容器名>` / `/opt` 脚本路径的 openship job 是否仍指向存在的主机。
5. **跨机数据库与台账**：执行器所在单元能否连到台账库；发一次手动 run 确认 `job_run` 正常收口。
6. **备份与恢复路径**：卷、对象存储、备份目的地在新机上可达。

## 3. 维护规则

- 新增任何**按 IP / 域名 / 回调 URL 绑定**的外部系统时，必须在本表加一行（含验证判据）。
- 迁移 PR 的验收节必须贴出本清单的逐项结果；**没验过的写「未验证」，不要写成已通过**。
- 本表只登记**绑定关系与取法**，密钥值一律不落文（见 `security-baseline`）。
