# P1：零售 tick 懒扩容落地（#2713）

> spec：`docs/superpowers/specs/2026-11-23-retail-tick-lazy-tiers.md`。全部在 `deploy/duckle/console/` 下。

## Wave 1（生成 + 静态验证）

- [x] 1. 构建脚本产出 6 份管线 JSON：`pipelines/lemeng.retail_order_line.tick.json`（v2，就地改）+
      `pipelines/lemeng.retail_order_line.tick.t{2,3,4,5,6}.json`（新）。生成后脚本删掉，不进仓。
      - 段界 t1=1–4 / t2=5–8 / t3=9–16 / t4=17–32 / t5=33–64 / t6=65–128，保险丝 25,600 单/时；
      - 投影列 = 现申报 10 列（`order_no/state/order_time/order_operate_time/order_source/order_transaction_type/order_ref_billno/order_total_money/branch/pos_order_details`）；tier 子管线另加 `page` 常量列；投影**不 CAST**。
      - `_note` 重写（形态、段界、触发判据、checkpoint 仍 false、part 回收）。
- [x] 2. `duckle validate` 6 份 JSON（容器内，全过：130/66/34/18/10/44 节点）。
- [x] 3. `pnpm` 门禁本地跑（`check-compose`/相关 gates 不受影响；改的只有 duckle/ 与 docs/）。

## Wave 2（容器内行为验证——判据先于合并）

- [x] 4. mock 四案：不扩容（4 请求）/ 一级（8 请求）/ 全链（128 页）/ 保险丝（die 不写湖）——全过。
- [x] 5. 真机：生产阈值 + 峰值窗 2026-10-24 19 点 ⇒ 静态 800 + t2 自动 211 = **1,011 单逐单吻合**；落湖 1,480 明细行 / 1,007 单（零明细单口径）。
- [x] 6. 探针痕迹清理（runs/receipts/logs/locks/tmp 全清）。

## Wave 3（投递 + 生产验收）

- [ ] 7. PR（feat(data)，Closes #2713）→ CI 全绿 → 合并（避开长任务窗口）。
- [ ] 8. 投递五步链到两个账套 console（sync → seed 6 份 → 重启 → 验 `schedules`/catalog 不变 → 删旧 state 不需要：无增量节点）。
- [ ] 9. 生产验收：连续 ≥2 轮 tick 绿；湖回读 count 与 receipt 一致；`recon` 闭窗小时容差 0；
      `retail-tier/` 无残留；次日 scorecard GREEN。
- [ ] 10. 正典三处登记（§1.7 行、§1.6 案例、§5 验收）+ WeKnora 沉淀。

## 回退

单文件回滚 = git revert + 重投递（旧 12 页形态即恢复；无 schema/湖布局变更，无数据迁移）。
