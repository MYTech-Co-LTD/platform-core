-- 037_private_measure_bizday_param.sql — 私有测度补 `bizday` 查询参数（#1417）。
--
-- 为什么：私有测度此前把 `params` 写死为空对象 ⇒ `query_metric` 不接受任何过滤参数，
-- `bizday` 被 authorize 判 `unknown_param` ⇒ 只能给「全时段累计」，业务上不可用
-- （2026-11-05 真机：bot 回答「门店订单数 406,085 单（全时段）」并明确说明无法按日期筛）。
--
-- 编译点已改为「dims 含 bizday ⇒ 产出 date_range 参数」，本迁移只回填**存量**列级聚合行。
-- 幂等：只碰 `params = '{}'` 且 group_by 里确实有 bizday 的行；重跑无副作用。
update data.metrics
   set params = '{"bizday": {"type": "date_range", "column": "bizday"}}'::jsonb
 where basis = 'column_agg'
   and params = '{}'::jsonb
   and group_by like '%bizday%';
