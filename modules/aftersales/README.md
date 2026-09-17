# `modules/aftersales` — 售后域（platform-core 第一个真业务模块）

设计与分期见 `docs/superpowers/specs/2026-09-15-aftersales-module-design.md`；
M2a（本模块当前形态）实施计划见 `docs/superpowers/plans/2026-09-15-aftersales-m2a-module-backend.md`。

## 表分类声明（`docs/module-protocol.md`「租户数据隔离」要求）

**本模块没有全局表**：`001_init.sql` 建的全部 7 张表
（`ticket` / `ticket_rule` / `ticket_attachment` / `store` / `product` / `employee` / `region`
及后续增量）都是**租户数据表**，每张都带 `org text not null`，读写一律 `where org = $1`。

按纪律，**全局表**（字典/配置类跨租户共享）才需要在本文声明理由——本模块无此类表，故无豁免项。
评审时请按此核对：若将来新增无 `org` 列的表，必须在本文补「为什么它可以是全局表」。

## 存储配置：按请求解析（M3c 步 4 起）

附件桶**不再来自进程 env 的装载期常量**（那份形态的后果是「多租户同进程必然共用一份配置」）。
现在的取法是：宿主按请求把**本租户**的配置投影进 context 键 `TENANT_STORAGE`（模块在
`manifest.yaml` 声明 `storage: { kind: s3 }` 才有），模块侧 `c.get(TENANT_STORAGE)` 取用。

- **写侧**只认注入值：没有 ⇒ `503 ZOS_NOT_CONFIGURED`。**绝不**回落平台桶
  （回落 = 数据位置被误述 + 平台替租户承担成本）。
- **读侧**按**行上记录的 `storage_ref`**（`<kind>|<endpoint>|<bucket>`，不含凭据）选配置，
  候选 = 注入值 + 平台默认（env 五键；早期行的归属）。四种读侧状态：
  ref 与注入值一致 ⇒ 用租户桶；`''`（本列引入前的行）⇒ 平台默认；非空但等于平台默认 ⇒ 平台桶；
  两边都对不上 ⇒ `503 STORAGE_REF_UNRESOLVED`（**显式失败，绝不拿当前配置硬签**）。
- 工单详情里**单件**附件签不出来 ⇒ 只让该项 `url` 为 null（降级，工单数据仍可用），
  并在服务端留一条按 `org|ref` 去重 60s 的 warn——那是该故障在平台侧的唯一信号。
- `storage_ref` 的业务说明（为什么不含 AK/SK、空串的定义）见
  `migrations/003_attachment_storage_ref.sql`。

## 没有的东西（别当成疏漏）

- **数据迁移不在本模块**：全量拉取/清洗/入库/对账是 M2b，另出计划、择业务空闲窗口跑。
- **`archive_order` / `archive_order_item` / `department` 不在这里**：归 M2b 建（无实测样本 / 无源表）。
- **console 页面与移动端 userApp 不在这里**：归 M3。
- **「配了但连不上」不在本模块**：预签名是 SigV4 **纯本地计算**，本模块在请求路径上**永远**
  发现不了配置坏。连通性验证在管理端（保存时探测 + 显式「测试连接」，见 `apps/server/src/storage-probe.ts`）。
