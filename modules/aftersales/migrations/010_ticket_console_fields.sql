-- 010_ticket_console_fields.sql — 工单页对齐无极：小数数量 / 基本数量 / 售后意见 / 水印时间
-- （2026-11-26，issue #2884，spec docs/superpowers/specs/2026-11-26-ticket-console-wuji-alignment-design.md §1）
--
-- ① damage_quantity integer → numeric(12,2)：移动端提单页早已按两位小数收（按公斤计的商品
--    生产约 4700 个），而服务端 SubmitBody 是 z.number().int() ⇒ 小数恒 400 INVALID_BODY。
--    精度取 12,2 = 10 位整数 + 2 位小数，**完整容纳旧 int4 上界**（2,147,483,647.99）——
--    服务端的业务上界仍是 MAX_DAMAGE_QUANTITY（int4），列型不能比 API 窄，否则边界值 500。
--    整数存量值无损转换（using 显式 cast，避免依赖隐式赋值转换）。
--
-- ② basic_quantity integer → numeric(14,6)：与 data.dim_settlement_order_line.quantity
--    同精度。语义从「免赔门槛的基数（此前恒 0）」变成「建单时所选结算行的采购数量」——
--    比例公式 (报损数量 − 基本数量 × 比例) × 单价 从此真正生效。
--    存量 pending 单该值保持 0（不跨表回填：依赖 data 表先就绪，装机会失败；是否手工补
--    由用户当场定，见 spec §8）。
--
-- ③ opinion：处理人的售后意见。此前处理写 remark，把店员填的报损原因覆盖掉了
--    （spec §3.1「报损原因和售后意见共用一列」）。新列与 remark 分开，处理不再写 remark。
--
-- ④ watermark_at date：照片水印上的日期，处理时必填；存量行为空。
--
-- 幂等：alter column type 天然可重复；列用 if not exists；约束用 DO 块（PG 不支持
-- `add constraint if not exists`，与 008 同款）。
alter table aftersales.ticket
  alter column damage_quantity type numeric(12,2) using damage_quantity::numeric(12,2),
  alter column basic_quantity  type numeric(14,6) using basic_quantity::numeric(14,6),
  add column if not exists opinion      text not null default '',
  add column if not exists watermark_at date;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'aftersales_ticket_damage_qty_chk'
       and conrelid = 'aftersales.ticket'::regclass
  ) then
    alter table aftersales.ticket
      add constraint aftersales_ticket_damage_qty_chk
      check (damage_quantity >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'aftersales_ticket_basic_qty_chk'
       and conrelid = 'aftersales.ticket'::regclass
  ) then
    alter table aftersales.ticket
      add constraint aftersales_ticket_basic_qty_chk
      check (basic_quantity >= 0);
  end if;
end $$;
