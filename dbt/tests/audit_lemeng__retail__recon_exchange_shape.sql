-- audit_lemeng__retail__recon_exchange_shape.sql — 换货「送出半边」公式的**输入形状守卫**（对账判别式族）。
--
-- ★ 承 #444：#398 那条「退货归属完备性」的基准已随 2026-10-05 口径订正**撤下**——
--   平台的 sale_money **不冲退货单**（`order_transaction_type <> 'SALE_ORDER'` 的单本来就不进 gross），
--   要扣的是**换货单的「送出半边」**：net(店,日) = Σ_订单[(Σ非赠品行额 + order_total_money)/2] − Σ分摊折扣。
--   断言对象因此从「退货归属」改成公式的两个输入前提（本文件），判别式本身（赠品侧）在
--   `audit_lemeng__retail__recon_gift_hit.sql`。
--
-- ★ 本文件**不假装在对账**：audit 没有平台数据通路，「湖侧自算 vs 预聚合端点」的真对账在
--   recon-preagg（console 管线 + scripts/lemeng/recon-preagg.sh，2026-10-05 真机 5 天逐分归零）。
--   本文件守的是**我方公式自洽的输入前提**——按 #444 的两条：
--   part1  **形状**：FINISHED 且 SALE_ORDER 的行，order_total_money 与 payment_money 必须
--          **非空且 ≥ 0**。order_total_money 是换货半边公式的加数：恒空/缺失 ⇒
--          (Σ + 总额)/2 **静默退化成** Σ/2，等价换货与差价换货不再可分，**无任何报错**。
--          payment_money 是「等价换货」识别式的另一半（= 0 且 total = 0），同守。
--   part2  **识别自检（空转）**：全湖 FINISHED+SALE_ORDER 里「total=0 且 payment=0」的
--          等价换货若**零命中**、而湖里明明有销售行 ⇒ 识别式静默失明（两列断供 / 改名）。
--          依据：2026-10-05 的口径定案就建立在**真实换货数据**上（双账套 5 天逐分归零），
--          全湖零等价换货不是已见过的合法形态。
--          （边界：真停了换货会假红——那是要人来判的事，不是静默放行的事。）
--
-- ★ 本文件**不挂指标**（同族约定，见 recon_gift_hit 头注）：规则 ⑦ 单向，
--   文件名带 `recon_` 段以示「对账判别式族」。
--
-- ── 形态坑（与同族文件同一套实测形态，出处见 recon_gift_hit 头注 ①②③）────────────────
--   r['列'] 算术先 ::numeric；键/字面量 coalesce 先 cast；read_parquet 只认位置参数。
with src_pq as (
    select
        r['system_book']::varchar          as system_book,
        r['bizday']::date                  as bizday,
        r['order_total_money']::numeric    as total_money,
        r['payment_money']::numeric        as pay_money
    from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_retail_order_line_prefix") }}/system_book=*/**/*.parquet'
    ) r
    where r['state'] = 'FINISHED'
      and r['order_transaction_type'] = 'SALE_ORDER'
      -- 只比已闭窗营业日：今天的分区被 tick 重写 ⇒ 与物化建表互撞 ETag 竞态而报 ERROR
      -- （实测 2026-10-06 run `jrun_dtyVWZnnFaQ_pCCN` attempt 1）。两侧都滤，才是同量。
      and r['bizday']::date < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
),
src_stg as (
    select
        system_book,
        bizday,
        order_total_money as total_money,
        payment_money     as pay_money
    from {{ ref('stg_lemeng_retail_order_line') }}
    where state = 'FINISHED'
      and order_transaction_type = 'SALE_ORDER'
      and bizday < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
),
bad_pq as (
    select
        system_book,
        bizday,
        count(*)                                       as bad_rows,
        count(*) filter (where total_money is null)    as total_null,
        count(*) filter (where pay_money  is null)     as pay_null,
        count(*) filter (where total_money < 0)        as total_neg,
        count(*) filter (where pay_money  < 0)         as pay_neg
    from src_pq
    where total_money is null or pay_money is null or total_money < 0 or pay_money < 0
    group by 1, 2
),
bad_stg as (
    select
        system_book,
        bizday,
        count(*)                                       as bad_rows,
        count(*) filter (where total_money is null)    as total_null,
        count(*) filter (where pay_money  is null)     as pay_null,
        count(*) filter (where total_money < 0)        as total_neg,
        count(*) filter (where pay_money  < 0)         as pay_neg
    from src_stg
    where total_money is null or pay_money is null or total_money < 0 or pay_money < 0
    group by 1, 2
)
-- part1（parquet 复算侧）：按 (账套,日) 出坏行计数——列真死了会是全量行，
-- 按日聚合既保住诊断信息又不至于把失败输出炸成百万行。
select
    system_book,
    bizday,
    'parquet'                                                        as side,
    bad_rows, total_null, pay_null, total_neg, pay_neg,
    '换货半边公式的输入形状违规（FINISHED+SALE_ORDER：order_total_money / payment_money 空或负）——恒空 ⇒ 公式静默退化成 Σ/2' as note
from bad_pq

union all

-- part1（staging 物化侧）：同一形状在投影/cast 之后再验一遍——湖里有、投丢了也能抓。
select
    system_book,
    bizday,
    'staging'                                                        as side,
    bad_rows, total_null, pay_null, total_neg, pay_neg,
    '换货半边公式的输入形状违规（staging 投影后仍空/负）——湖有而投丢 = 投影/cast 漂了' as note
from bad_stg

union all

-- part2 空转自检：湖里有销售行、而等价换货识别式全湖零命中 ⇒ 识别式静默失明。
select
    null::varchar, null::date, 'selfcheck', null::bigint, null::bigint, null::bigint, null::bigint, null::bigint,
    '全湖 FINISHED+SALE_ORDER 有行、但「order_total_money=0 且 payment_money=0」的等价换货零命中：识别式静默失明（两列断供/改名），公式输入不可证'
where not exists (
        select 1 from src_pq where total_money = 0 and pay_money = 0
    )
  and exists (
        select 1 from src_pq
    )
