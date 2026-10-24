-- assert_fct_branch_expense_measure_shadow_parity.sql — 影子列 vs 现有列的对账（聚合面组件化
-- P3.3 影子波 Task 2；plan 2026-10-24-aggregate-face-p33-shadow-wave / issue #1031）。
--
-- 契约同全仓 singular test：**返回任何行即失败**。
--
-- ── 它守什么 ────────────────────────────────────────────────────────────────────────────
-- `fct_branch_expense` 里并行输出了两套同口径的度量：
--   · `ep_payable` / `er_receivable` = **现有基线**（手写 `agg`，case-when 判别式逐字未动；
--     它们的真值由 `audit_lemeng__expense__branch_payable` / `branch_receivable` 独立复算兜，
--     不是本测试判的对象）；
--   · `*__gen` = `l1_metrics.yml` 的 measure 编译版（flat 单层直聚，`scripts/gen-fct-measures.mjs`
--     生成）。方向过滤在生成侧**上移到基面 domain**（`direction = '应付'` / `'应收'`），
--     数值上与旧 case-when 的 `else 0` 等价——本测试就是这条等价性的证明：
--     红 = domain 谓词 / expr / 分组键与手写 CTE 漂了，**不许靠调容差抹平**。
-- 本测试按 fct 粒度（账套 × 业务日 × 门店 × 费用项目）**逐行逐列**比这两套值：任一分差 > 0.01 即红。
--
-- 比的是**同一行上的两列**（同一张 fct 表）⇒ 不需要 full join：行集由最终 SELECT 的驱动基面
-- `agg`（旧实现的全量分组）保证——gen_agg 的行域是它的子集，left join 不增删最终行；
-- 粒度行集另有 `assert_fct_branch_expense_grain_unique.sql` 钉住。
--
-- ⚠️ **NULL 必须显式判红**：两侧都 `coalesce(…, 0)`，只比差值的话「影子列变 NULL、旧列是 0」
--    会算成 0 = 0 而**静默绿**（P3.0 修过的 I1 缺陷同型：单侧缺行输出 NULL，差值判据结构性
--    看不见它）。故失败谓词里单列一条 `*__gen is null`；schema.yml 的 `not_null` 是同一件事的
--    结构守卫，口径容差仍是 1 分、不放宽。
--    （#1019 订正说明）现形态下最终 SELECT 已把影子列 `coalesce(…, 0)` 归零 ⇒ 物化列恒非空，
--    本 `is null` 分支是**防御性死分支**：它守的是「归零被移除」的将来态（真发生时 schema.yml
--    的 not_null 先红）；活的对账判据是上面的分差谓词。
--
-- ── 本测试**不**守什么（免得把绿读成「整条链都对」）────────────────────────────────────
-- · **声明漂移**：`l1_metrics.yml` 改了而 fct 生成区没重生成（或反之），本测试看不见——
--   它只比**物化后的数值**。那一层由 `gen-fct-measures.mjs --check`（逐字节）与
--   `scripts/sync-data-semantics.test.ts`（声明↔同步面）守。
-- · **fct 粒度以下的差异**：对账在 (账套 × 业务日 × 门店 × 费用项目) 上做，逐单互相抵消的错
--   在这里不可见。
-- · **谁对**：这是**等价性**测试，两侧同错也绿。旧列是不是真值由
--   `audit_lemeng__expense__branch_payable` / `branch_receivable` 独立复算兜。
-- · **窗口外**：14 天以外的历史分区不复检（旧分区被重写的回归抓不到）。
--
-- ── 为什么是 1 分容差 ───────────────────────────────────────────────────────────────────
-- 两侧都落 `numeric(20,2)` 且都是单次求和后同点 cast（金额列 decimal(14,2) 精确算术，旧侧
-- case-when 的 `else 0` 只是往和里加零，生成侧的方向过滤只是**选行**不改求和路径 ⇒ 逐位
-- 相等本应成立）；1 分是 #957 的**全仓金额对账家族惯例**地板，这里沿惯例不收紧也不放宽
-- （原注「算术路径不同 / 舍入时点不同」说法不准，2026-10-24 终审 F-3 订正，与 client 版统一措辞）。
--
-- ── 为什么窗口是 14 天、且只取闭窗日 ───────────────────────────────────────────────────
-- 本表三条指标（branch_payable / branch_receivable / branch_net）在 `l1_metrics.yml` 全
-- `tier: certified`（branch_net 的裁9 客户已回签 2026-10-13）⇒ 窗口取 certified 硬要求
-- 14 天（spec §9.1；比更短窗口只会让红来得更晚，没有收益。原注「全 experimental / 待裁9」
-- 与声明面矛盾，2026-10-24 终审 F-1 订正——窗口数值本来就合规，错的是理由）。
-- 只测 `bizday < 上海今天`：当日分区被 tick 持续重写，两侧时点不同不可比（同 `audit_*` 的闭窗约定）。
--
-- ── 空转绿守卫 ─────────────────────────────────────────────────────────────────────────
-- 窗口内一行都没有时，`where` 在空集上「通过」是**空转绿**（不是对上了）。故显式补一行失败。
-- 守卫是**整窗**级的：单个账套整段空窗不会触发（「账套级覆盖」归水位/新鲜度机制，不归本测试）。
--
-- ⚠️ 本测试是 **P3.3 影子期的桥**：切列波把消费面切到 `*__gen` 之后，两列同源、本对账失去参照
--    ⇒ 那时的计划必须改写或移除它，**不要留成空转绿**。
with cmp as (
    select system_book, bizday, branch_num, expense_type,
           ep_payable, ep_payable__gen,
           er_receivable, er_receivable__gen
    from {{ ref('fct_branch_expense') }}
    where bizday < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
      and bizday >= CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE) - 14
)
select *,
       case when ep_payable__gen is null or er_receivable__gen is null
            then '影子列为 NULL（coalesce 归零后会算成 0 = 0 的静默绿，故显式判红）'
            else '影子列与现有列不一致（ep/er，1 分容差）'
       end as note
from cmp
where abs(coalesce(ep_payable,0)   - coalesce(ep_payable__gen,0))   > 0.01
   or abs(coalesce(er_receivable,0) - coalesce(er_receivable__gen,0)) > 0.01
   or ep_payable__gen   is null
   or er_receivable__gen is null

union all

select null, null, null, null, null, null, null, null,
       '空转绿：窗口内一行都没有' as note
where (select count(*) from cmp) = 0
