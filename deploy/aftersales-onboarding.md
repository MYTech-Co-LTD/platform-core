# 售后模块接入 runbook（冷启动 → 正式运营）

> 状态：2026-11-23 人裁「数据先不迁移，先跑一阵」的落地记录与执行单。
> 范围：从「代码已在生产」（M1c single 已随山海一果销账，2026-09-19）到「真实业务稳定在跑」之间的 Gate。
> 代码侧能力与协议见 `docs/module-onboarding.md`；本文只写**接入与运营动作**。

## 0. 裁决记录（2026-11-23）

| 项 | 裁决 |
|---|---|
| 历史**工单** | **不迁**，从 AS-00000001 重新编号 |
| 历史**附件** | 不迁（旧图留在无极 COS 原值；外链展示另立题） |
| **员工花名册** | **批量导入**（`employee_info`） |
| **售后规则** | **批量导入**（`after_sales_rule`） |
| 回迁通路 | **保留**（#151 挂起不关闭），短期不承诺 |

**对外预期（必须提前同步给业务方，否则会被当 bug）**：
1. 系统内查不到历史工单与历史图片；
2. 新单号从 `AS-00000001` 起，与无极单号不同体系；
3. 花名册/规则是导入快照，之后变更一律走平台（登记审批 / console 规则页）。

## 1. Gate 1：冷启动导入

**前置（缺一不可）**
- [ ] wuji 只读凭据在 env：`WUJI_APPID` / `WUJI_KEY_<表>`（不落仓、不落日志）；
      山海租户的接口路径是 `/api/public/object` ⇒ 另设 `WUJI_API_PATH=/api/public/object`
      （缺省 `/api/private/object`）
- [ ] 字段已按真实样本钉死（2026-11-23 实测）：`employee_name` / `employee_phonenumber` /
      `openId`（=`_id`）/ `store_info`（单值或逗号多值）；`employee_info` **无审批态字段**
      ⇒ 导入按 `--employee-status-default`（默认 `approved`）补，计数进 `defaulted_status`
- [ ] 拉真样本核对字段名：`migration/clean.ts` 的 KEYS 是**暂定清单**，Task 3 要求逐表对真样本钉死
- [ ] 门店编码映射决策（见下，**最重要**）
- 接龙金额单位：**不导入 group_buying_\***，此 gate 不适用（`--tables` 不含它即不会触发 `GROUPBUY_UNIT_UNPROVEN`）

**命令（默认 dry-run，`--apply` 才写库）**
```sh
# 1) 拉样（只读，落盘供核对字段名）
npx tsx scripts/migrate-aftersales-wuji.mjs --org <casdoor_org> --sample 50 --sample-out /tmp/wuji-sample
# 2) dry-run：拉取 + 清洗 + 打印（不写库）；--store-map 也会在这里校验并打印覆盖率
npx tsx scripts/migrate-aftersales-wuji.mjs --org <casdoor_org> --tables employee_info,after_sales_rule \
  --store-map /path/to/store-map.csv
# 3) apply
npx tsx scripts/migrate-aftersales-wuji.mjs --org <casdoor_org> --tables employee_info,after_sales_rule \
  --store-map /path/to/store-map.csv --apply
# 4) 对账：clean 产物 vs 库内计数/金额和（reconcile）；skip reasons 必须为空或逐条解释
```

**门店清单保密（防竞对枚举，2026-11-24 用户裁定）**

注册页的门店候选**只许远程关键词搜索**（`/guest/stores?q=` ilike），**禁止**：
- 全量预载/全量下拉（360 家门店清单 = 竞对可摸清门店网络的情报）；
- 无关键词的枚举接口形态；
- 「进页面先拉全量再本地过滤」的任何变体。

代价与引导：员工必须**输入门店名**才能搜到（placeholder 已引导「请输入门店名称或编号搜索」）。
残余风险如实记录：品牌词/区县词枚举（如搜「品品甜」命中 81 家）仍是泄露面；彻底防住需注册
邀请码/工号前置——演进项，未立项不实施。

**门店映射文件（`--store-map`，2026-11-23 落地，issue #2729）**

格式 `无忌门店id,dim_branch.code`（支持 `#` 注释与表头；重复后者覆盖；非法行整体失败）。
文件**不进仓**（含客户门店编码清单），随部署环境投递；日志只打印条数与覆盖率。

生成方法（工具化）：`scripts/gen-store-map.mjs`——

```sh
DATABASE_URL=… WUJI_APPID=… WUJI_KEY_STORE_INFO=… WUJI_API_PATH=/api/public/object \
  npx tsx scripts/gen-store-map.mjs --org <casdoor_org> [--out /path/store-map.csv]
```

**判据（2026-11-23）：编码 + 名称必须指向同一条平台门店才算 100% 对上。** 匹配顺序：
① 源 `store_code` ↔ `dim_branch.code`（实测同源，296/299 命中）；② 名称归一（NFKC + 去品牌前缀
品品甜/熊喵）作辅助证据。两者不一致或缺失 ⇒ 逐条打印（名称未命中 / 名称多候选 / 编码与名称指向
不同门店 / 编码未命中 / 都未命中），**绝不猜**——人工裁决后补进 CSV。dry-run 的
`[store-map] 覆盖率` 行显示命中/未命中；**未命中不为 0 就不要 apply**。

**门店编码硬约束（导入员工前必读）**

员工的门店引用由导入器写**无忌门店 id 的字符串形**进 `employee.store_code` / `employee_store.store_code`
（`modules/aftersales/migration/import.ts` 的 #476 注释）——它和 `data.dim_branch.code`（乐檬门店编码）
**不是同一套编码，仓内无映射表**。因此：

- **不要导入 `store_info`**。导了只会让员工门店链「解析成功」，落的还是无忌 id——制造「看起来有归属、
  其实对不上」的假象，比明着空更贵。
- **正确做法：用 `--store-map` 导入**（映射是迁移配置的一部分，幂等可重跑、可对账）；
  **不要**用「导入后再补一次性 SQL」——那破坏幂等（重跑会覆盖回错值）且对账看不见。
- **在门店归属正确之前，不要开访客登记页**（「我的门店」会展示错编码）。
- 覆盖率不足时的处置：补映射后**重跑 dry-run → apply**（幂等），不要手工 UPDATE。

**对账判据**
- 每张导入表：`fetched = imported + skipped`，且 `skipped/reasons` 为空或已逐条说明；
- 抽 5 名员工、5 条规则与源系统逐字段比对（金额/比例/状态码是重点）。

## 2. Gate 2：账号与授权

- [ ] 租户管理员在 Casdoor 租户 org 下**持有并授予** `aftersales:manage`——否则审批通知
      **零收件人**（notify-preflight 会红，且 health 全绿不报警）。
- [ ] 门店员工账号挂 `aftersales:guest`（访客/门店侧权限的来源）。
- [ ] 手机号摸底：`node scripts/audit-employee-phones.mjs`（只读）；回填先 dry-run 再 `--apply`
      （`CASDOOR_*` 五 env 齐备）。
- [ ] 身份绑定走 `platform.identity_link`；Phase 2（企微绑定分流 + 通讯录预填）未立项，
      绑定期望按「自动匹配 + 人工审核」管理。

## 3. Gate 3：存储

- [ ] 租户行五键（或平台默认 env）：endpoint / bucket / AK / SK / region；
      **漏配 = 附件端点 503，不是启动报错**。
- [ ] 冒烟：小图直传 → console 看原图；>1MiB 视频直传（bodyLimit 外的预签名链路）；
      删单后跑 GC dry-run 看孤儿计数。

### 3.1 桶生命周期（2026-11-26 已配，山海实测）

**为什么必须配**：附件是照片/视频，**存储费与出流量费都按量计费**；售后凭证的真实访问曲线是
「平时不读，一旦读就是急事」。不配 = 全量长期躺在标准存储里按最高档计费。

**山海 `after-sales` 桶（西南1）已配**（控制台 → 桶 → 基础设置 → 生命周期）：

| 规则 | 值 | 理由 |
|---|---|---|
| 当前版本转换 | **未更新 90 天 → 转低频** | 审批后 90 天是申诉/二次投诉高发期，要秒开；低频最小存储期 30 天早已满足，不产生补差 |
| 当前版本转换 | **未更新 730 天 → 删除** | 财务对账跨季、供应商索赔按合同账期、食品类合规审计——三类都要回头翻图 |
| 碎片清理 | 未更新 30 天 → 删除碎片 | 传一半断掉的残留，纯垃圾 |
| **归档档不用** | — | 归档**需解冻**、可用性低；售后凭证的读模式是「急事」，解冻延迟不可接受 |

**新租户接附件时要做同样的配置**——这是环境动作，不是代码能力（代码侧只有上传/预签名/GC）。

> ZOS 的三档存储（2026-11-26 文档实测）：标准（无最小期限）/ 低频（**30 天**）/ 归档（**90 天**，需解冻）。

## 4. Gate 4：渠道

- [ ] 公众号 appid/secret 落租户行（CLI 写，无管理页）——`--module aftersales` 一并配。
- [ ] 真机链（只有客户机能验）：公众号内开 `/app/aftersales` → 访客 session → 带图提交 →
      console 按规则出金额 → 状态流转 → 二次访问免登录。
- [ ] 走企微直连时：出口 IP 进**对应自建应用**的企业可信 IP（换机踩过 60020）。

## 5. Gate 5：验收

- [ ] M1c **multi** 销账（#153）——单租户试点验过的是 single，多租户隔离未验。
- [ ] 冒烟清单 `docs/m0-smoke-checklist.md` 重跑。
- [ ] 回滚演练：当前版本（非 M3c 时期）重跑一次回到上一镜像。
- [ ] B13 真库对账绿：`scripts/check-data-dependencies.mjs`（`data.dim_*` 列集与 lock 一致）。
- [ ] 依赖维表在**本租户**有数据：`data.dim_branch` / `data.dim_item` /
      `data.dim_settlement_order_line` 非空（清单与选单页的数据源）。

## 6. Gate 6：运营（可随业务滚动补齐）

- [ ] GC：openship job 补台账（`deploy/jobs.md`），或迁平台调度器（与 Wave 6/8 方向一致）。
- [ ] 审计：`aftersales.audit` 已落（#2748）——写操作与业务同事务留痕；运维可 `select * from
      aftersales.audit where org = '<org>' order by id desc` 查（detail 只含业务事实，无 PII 明文）。
- [ ] 通知：每日巡检「零收件人」（notify-preflight）。
- [ ] 附件：`STORAGE_REF_UNRESOLVED` 目前只有 60s 去重的 warn——升级为可告警信号。

## 7. 回迁通路（#151 挂起）

迁移脚本骨架保留、默认 dry-run；#151 不关闭。**越晚越痛**，三条已知：
1. **员工重复**：冷启动若有人自建/登记，补迁时需按手机号人工合并；
2. **规则两套**：导入的规则与后来手工建的规则语义可能重叠，需人工收敛；
3. **历史附件永久缺失**：源侧 COS 若被清理，补迁也补不回图片——需按需同步归档源侧。

重开条件：业务提出历史查询需求 / 数据合规要求 / 出现明确回迁窗口。
