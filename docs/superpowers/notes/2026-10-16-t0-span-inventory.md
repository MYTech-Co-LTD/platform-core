# T0 开箱验证 —— span 内容清单

> 计划：`docs/superpowers/plans/2026-10-16-askdata-loop-p1-t0-openbox.md` · issue **#741** · 执行 2026-10-16
> 本文件由 T0 的三个 task 陆续写入：**Task 1 基线** / Task 2 开箱 / Task 3 清单与判定。

## 0. 裁决前提

| 项 | 裁决 |
|---|---|
| **R1 隐私面** | 用户裁决 **认**——`captureContent: true` 会把业务正文 + 思考全文送进 OO |
| **R2 时段** | 用户指定 **现在**（2026-10-16 ~15:50 UTC / 北京 23:50，天然低峰）；中断代价实测值见 §2.3 |

## 1. 基线（Task 1，**只读**）

### 1.1 备份与配置现状

| 项 | 值 |
|---|---|
| 备份路径 | `/var/lib/docker/volumes/openship-platform-core-shanhai-openclaw_state/_data/openclaw.json.bak-t0-telemetry`（4766 B，权限 600 / uid 1000，与源一致） |
| 当前 `openclaw.json` | **4766 字节**（宿主与容器两侧一致） |
| 上次修改 | 2026-10-16 13:36:14 +0800 |
| **`diagnostics` 计数** | **0** —— 生产未配，与 spec §2.2 一致 |
| 顶层键 | `agents, channels, commands, gateway, meta, models, plugins, skills, tools, wizard` |

> 顶层键清单是 Task 2「深合并没写坏」的对照基线：开箱后除新增 `diagnostics` 外，这些键必须逐字不变。

### 1.2 开箱前通道健康基线

| 判据 | 值 |
|---|---|
| openclaw 容器 `healthz` | **200** |
| 会话库 `agents/main/.../openclaw-agent.sqlite` | 10,158,080 B |
| 会话库 `agents/wecom-dm-zhangduo/.../openclaw-agent.sqlite` | 667,648 B |
| 容器 → OO `https://observe.hookflow.cn/healthz` | **200** |

> 会话库规模是 Task 3「开箱后有没有新会话写入」的对照。

### 1.3 凭据取法（**只写「在哪、怎么取」，不含值**）

| 项 | 内容 |
|---|---|
| 位置 | **openclaw 宿主**的 `/etc/openobserve-ingest.env`（root-only `600`） |
| 键 | `OO_BASE` / `OO_ORG` / `OO_AUTH` / `OO_TOKEN` |
| 头形态 | `Authorization: Basic $OO_AUTH`——`OO_AUTH` 是**裸 base64**（`base64("<空用户名>:<token>")`） |
| 口径 | 该文件头注：自 2026-09-18 起改用 **ingestion token**（只写、可按机器单独停用），**机器上不再放用户口令** |
| 用法 | 只在宿主 shell 内 `source` 后直接写盘；**不经任何容器、不进 exec 输出** |

（`OO_BASE` = `https://observe.hookflow.cn`；`OO_ORG` = `3IJ5tM4en3A06FzcJQhoHMTl4Xe`——两项都非密，仓内已有记载。）

### 1.4 执行期对计划的订正（一手实测，Task 2 按订正走）

计划 Task 2 Step 1 有**三处错**，Setup 期实测订正如下：

| # | 计划原文 | 实测订正 |
|---|---|---|
| 1 | 用 OO **root 账号**（容器 env `ZO_ROOT_USER_*`），需跨机传凭据 | 用 **openclaw 宿主**现成的 `/etc/openobserve-ingest.env`（**只写 ingestion token**，更合最小权限）；**不必跨机传凭据** |
| 2 | 头写 `Basic base64(email:password)` | `OO_AUTH` 是**裸 base64**（空用户名）⇒ 头写 `Authorization: Basic $OO_AUTH`；写成 `Authorization: $OO_AUTH` 会 **401** |
| 3 | 在容器内改配置（凭据要进容器） | 宿主**可直接写卷** `/var/lib/docker/volumes/openship-platform-core-shanhai-openclaw_state/_data/openclaw.json` ⇒ 在**宿主 shell 内** source 后深合并写盘，密钥永不进容器/exec 输出 |

**凭据射程实测**（宿主上跑，凭据未出 shell）：

| 探针 | 结果 |
|---|---|
| `POST $OO_BASE/api/$OO_ORG/otlp_probe/_json`（对照） | **200** |
| `POST $OO_BASE/api/$OO_ORG/v1/traces`（OTLP/JSON） | **206 partialSuccess**——仅因探针把 `startTimeUnixNano` 写成 `0`（1970、超出保留期）被拒 1 个 span ⇒ **端点与鉴权本身是好的** |
| 用 `Authorization: $OO_AUTH`（漏 `Basic ` 前缀） | **401** ⇒ 坐实订正 #2 |
