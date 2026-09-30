-- audit_lemeng__retail__recon_return_attribution.sql — 退货归属判别式的**完备性**断言（对账判别式族）。
--
-- ★ 本文件**不挂指标**（同族先例：audit_lemeng__retail__recon_gift_hit.sql 头注——门禁规则 ⑦
--   是单向的「每个声明指标必须有对账文件」，本族是**对账判别式的湖侧自洽断言**，判别式正典 =
--   docs/superpowers/specs/2026-09-30-recon-zeroing-self-attribution.md §0）。
--
-- 判别式（**逐字照抄正典，勿改**）：
--   state='FINISHED' AND order_transaction_type != 'SALE_ORDER'
--   AND order_ref_billno → 原单的 bizday = D        ← 用 order_ref_billno join 回湖
--   语义：平台报表日 D 的 return_money = **原单销售日为 D** 的退货（与退货何时发生无关）。
--   归零公式据此按 (店,商品,原单日) 冲减：Σ return(D).sale。
--
-- ⚠️ **没有平台数据通路，本文件不假装在对平台账**：平台侧（itemsales.find 的
--   return_money/return_num）不在这条测试的可达面里（判别式的平台侧验证见正典 §1 的单日 21/21）。
--   这里守的是**湖侧自洽**：归零公式的输入（退货行集 + ref 归属）每天必须完备、可归属、
--   且与 staging 投影一致——任何一类破洞都会让公式**静默少冲减**，对账缺口悄悄回来。
--
-- 断言分部（任何一行出行 = 失败；行带 (账套,日,店,商品,ref) 与数量/金额，不红总数）：
--   ① 退货行集两侧一致性：parquet 复算 vs staging 投影，按 (账套,日,交易类型) 对拍行数与金额
--      ——staging 把 order_transaction_type/order_ref_billno cast 成 varchar，cast 漂了这里抓。
--   ② 缺 ref 硬闸：FULL/PARTIAL_ORDER_RETURN 行**必须有** order_ref_billno（这两类按定义
--      有关联原单）。2026-09-30 全湖实测 0 行 ⇒ 0 是唯一已见合法形态，出现即红。
--   ③ FINISHED 行交易类型不得为空：order_transaction_type 断供会让退货行**静默掉出**判别式
--      （`!= 'SALE_ORDER'` 对 NULL 求值为未知 ⇒ 行被排除，两边都不报错）。实测 0 行 ⇒ 红闸成立。
--   ④ NO_ORDER_RETURN 却带 ref：类型语义是「无原单退货」，带 ref 即矛盾。实测 0 行。
--   ⑤ 归属歧义硬闸：ref join 回湖后原单行必须落在**唯一** bizday（跨 >1 天 ⇒ 归属无法定义，
--      归零公式会按错日冲减）。实测 0 行。
--   ⑥ 空转自检：湖里有 FINISHED 行、但退货行集为空 = 判别式静默失明（txn 列死掉），
--      那个「绿」毫无信息量。依据：正典 §1 跨日实测两个账套每个观测日都有非 SALE 单。
--
-- 边界（正典 §3 已记载，**本文件不立闸、只在此声明**）：ref join 不回湖（原单在湖外）的行
--   **不是本闸的判据面**——2026-09-30 全湖实测 5 行（3 行湖首日边界 + 2 行 RW 前缀单号，原单在
--   本管线可达面之外），全量实测与口径裁决（按 B：结构闸红、已知盲区写档）见
--   docs/superpowers/specs/2026-09-30-audit-gift-return-assertions.md §5；裁决若改 A，
--   在本文件加一个 UNION 分部即可。本断言面保证的是「有 ref 的行一旦出现就能归属到唯一一天」。
--
-- ── 形态：与两条指标 audit 同一套实测形态（r['列名'] 取列 / 键显式 cast / 算术先 ::numeric；
--   三个坑的原文见 audit_lemeng__retail__recon_gift_hit.sql 头注 ①②③，2026-09-30 真机踩过）。
with lake_orders as (
    -- 原单侧：每个 order_no 在湖内的 bizday 集合（join 键 = order_ref_billno → order_no；
    -- 与 state 无关——归属要的是原单的销售日，原单行本身的状态不影响它在哪天卖出的事实）。
    select
        r['system_book']::varchar as system_book,
        r['order_no']::varchar    as order_no,
        r['bizday']::date         as bizday
    from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_retail_order_line_prefix") }}/system_book=*/**/*.parquet'
    ) r
),
returns_recheck as (
    -- 复算侧退货行集（判别式逐字）：直接打 parquet，不 ref staging。
    select
        r['system_book']::varchar              as system_book,
        r['bizday']::date                      as bizday,
        r['branch_num']::int                   as branch_num,
        r['item_num']::varchar                 as item_num,
        r['order_no']::varchar                 as order_no,
        r['order_transaction_type']::varchar   as txn_type,
        r['order_ref_billno']::varchar         as ref_billno,
        r['sale_money']::numeric               as sale_money
    from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_retail_order_line_prefix") }}/system_book=*/**/*.parquet'
    ) r
    where r['state'] = 'FINISHED'
      and r['order_transaction_type']::varchar is not null
      and r['order_transaction_type']::varchar <> 'SALE_ORDER'
),
returns_staging as (
    -- staging 侧退货行集：同一判别式独立再写一遍（cast 是 staging 已定型的类型）。
    select
        system_book,
        bizday,
        branch_num,
        item_num,
        order_no,
        order_transaction_type as txn_type,
        order_ref_billno       as ref_billno,
        sale_money
    from {{ ref('stg_lemeng_retail_order_line') }}
    where state = 'FINISHED'
      and order_transaction_type is not null
      and order_transaction_type <> 'SALE_ORDER'
),
recheck_by_type as (
    select system_book, bizday, txn_type, count(*) as n_rows, sum(sale_money) as amount
    from returns_recheck group by 1, 2, 3
),
staging_by_type as (
    select system_book, bizday, txn_type, count(*) as n_rows, sum(sale_money) as amount
    from returns_staging group by 1, 2, 3
)
-- ① 退货行集两侧不一致（cast 漂移 / 行丢失 / 当天窗口差一拍）
select
    coalesce(a.system_book, b.system_book)   as system_book,
    coalesce(a.bizday, b.bizday)             as bizday,
    null::int                                as branch_num,
    null::varchar                            as item_num,
    null::varchar                            as ref_billno,
    a.n_rows::int                            as recheck_value,
    b.n_rows::int                            as staging_value,
    (coalesce(a.amount::numeric(20,2), 0) - coalesce(b.amount::numeric(20,2), 0))::numeric(20,2) as amount_diff,
    '退货行集两侧不一致（类型=' || coalesce(a.txn_type, b.txn_type) || '）：staging 对 v2 列的投影漂了，或当天窗口两侧差一拍（新鲜度竞态）' as note
from recheck_by_type a
full join staging_by_type b using (system_book, bizday, txn_type)
where a.n_rows is distinct from b.n_rows
   or a.amount is distinct from b.amount

union all

-- ② 缺 ref 硬闸：FULL/PARTIAL_ORDER_RETURN 必须带 ref（缺 = 无法归属，公式静默少冲减）
select
    system_book,
    bizday,
    branch_num,
    item_num,
    null::varchar as ref_billno,
    count(*)::int as recheck_value,
    null::numeric as staging_value,
    sum(sale_money)::numeric(20,2) as amount_diff,
    'FULL/PARTIAL_ORDER_RETURN 行缺 order_ref_billno：按定义必有关联原单，缺 ref 即归属断链（按 店,商品,日 计数与金额）' as note
from returns_recheck
where txn_type in ('FULL_ORDER_RETURN', 'PARTIAL_ORDER_RETURN')
  and (ref_billno is null or ref_billno = '')
group by 1, 2, 3, 4

union all

-- ③ FINISHED 行交易类型为空：这些行静默掉出判别式（!= 'SALE_ORDER' 对 NULL 为未知）
select
    r['system_book']::varchar as system_book,
    r['bizday']::date         as bizday,
    r['branch_num']::int      as branch_num,
    r['item_num']::varchar    as item_num,
    null::varchar             as ref_billno,
    count(*)::int             as recheck_value,
    null::numeric             as staging_value,
    null::numeric(20,2)       as amount_diff,
    'FINISHED 行 order_transaction_type 为空：判别式对它失明（≠ SALE_ORDER 对 NULL 求值为未知 ⇒ 行被静默排除）' as note
from read_parquet(
    's3://{{ var("zos_bucket") }}/{{ var("lemeng_retail_order_line_prefix") }}/system_book=*/**/*.parquet'
) r
where r['state'] = 'FINISHED'
  and r['order_transaction_type']::varchar is null
group by 1, 2, 3, 4

union all

-- ④ NO_ORDER_RETURN 却带 ref：类型语义矛盾
select
    system_book,
    bizday,
    branch_num,
    item_num,
    ref_billno,
    1::int        as recheck_value,
    null::numeric as staging_value,
    sale_money::numeric(20,2) as amount_diff,
    'NO_ORDER_RETURN 行带 order_ref_billno：无原单退货却带原单号，类型语义矛盾，归属口径需人工裁决' as note
from returns_recheck
where txn_type = 'NO_ORDER_RETURN'
  and ref_billno is not null
  and ref_billno <> ''

union all

-- ⑤ 归属歧义：ref join 回湖后原单行跨 >1 个 bizday（归属无法定义）
select
    t.system_book                     as system_book,
    min(t.bizday)::date               as bizday,
    null::int                         as branch_num,
    null::varchar                     as item_num,
    t.ref_billno                      as ref_billno,
    count(*)::int                    as recheck_value,
    (count(distinct o.bizday))::int  as staging_value,
    null::numeric(20,2)               as amount_diff,
    '退货 ref 归属歧义：原单 ' || t.ref_billno || ' 的行跨 ' || (count(distinct o.bizday))::varchar || ' 个 bizday，归零公式无法按唯一原单日冲减' as note
from returns_recheck t
join lake_orders o
  on o.system_book = t.system_book
 and o.order_no = t.ref_billno
group by t.system_book, t.ref_billno
having count(distinct o.bizday) > 1

union all

-- ⑥ 空转自检：有 FINISHED 行、但退货行集为空 = 判别式静默失明
select
    null::varchar as system_book,
    null::date    as bizday,
    null::int     as branch_num,
    null::varchar as item_num,
    null::varchar as ref_billno,
    null::int     as recheck_value,
    null::numeric as staging_value,
    null::numeric(20,2) as amount_diff,
    '湖里有 FINISHED 行、但退货行集为空：txn 列死掉会让判别式静默失明（≠ SALE_ORDER 全部落空），不是对上了' as note
where not exists (select 1 from returns_recheck)
  and exists (
      select 1
      from read_parquet(
          's3://{{ var("zos_bucket") }}/{{ var("lemeng_retail_order_line_prefix") }}/system_book=*/**/*.parquet'
      ) r
      where r['state'] = 'FINISHED'
  )
