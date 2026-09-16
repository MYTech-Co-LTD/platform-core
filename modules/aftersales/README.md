# `modules/aftersales` — 售后域（platform-core 第一个真业务模块）

设计与分期见 `docs/superpowers/specs/2026-09-15-aftersales-module-design.md`；
M2a（本模块当前形态）实施计划见 `docs/superpowers/plans/2026-09-15-aftersales-m2a-module-backend.md`。

## 表分类声明（`docs/module-protocol.md`「租户数据隔离」要求）

**本模块没有全局表**：`001_init.sql` 建的全部 7 张表
（`ticket` / `ticket_rule` / `ticket_attachment` / `store` / `product` / `employee` / `region`
及后续增量）都是**租户数据表**，每张都带 `org text not null`，读写一律 `where org = $1`。

按纪律，**全局表**（字典/配置类跨租户共享）才需要在本文声明理由——本模块无此类表，故无豁免项。
评审时请按此核对：若将来新增无 `org` 列的表，必须在本文补「为什么它可以是全局表」。

## 没有的东西（别当成疏漏）

- **数据迁移不在本模块**：全量拉取/清洗/入库/对账是 M2b，另出计划、择业务空闲窗口跑。
- **`archive_order` / `archive_order_item` / `department` 不在这里**：归 M2b 建（无实测样本 / 无源表）。
- **console 页面与移动端 userApp 不在这里**：归 M3。
