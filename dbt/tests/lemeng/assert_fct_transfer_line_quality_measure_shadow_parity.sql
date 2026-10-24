-- assert_fct_transfer_line_quality_measure_shadow_parity.sql — 影子列 vs 现有列的对账（聚合面组件化
-- P3.3 影子波 Task 4；plan 2026-10-24-aggregate-face-p33-shadow-wave / issue #1031）。
--
-- 契约同全仓 singular test：**返回任何行即失败**。
--
-- ── 它守什么 ────────────────────────────────────────────────────────────────────────────
-- `fct_transfer_line_quality` 里并行输出了两套同口径的度量：
--   · `zero_cost_amount` = **现有基线**（手写聚合逐字未动；它的真值由
--     `audit_lemeng__transfer__zero_cost_exposure_amount` 独立复算兜，不是本测试判的对象）；
--   · `zero_cost_amount__gen` = `l1_metrics.yml` 的 `tq_zero_cost_amount@order` measure 编译版
--     （**影子波唯一的两阶段族**：先逐单求 `measure_value`、再上卷店日，`scripts/gen-fct-measures.mjs`
--     生成）。`state_code/out_branch_num` 谓词在生成侧**上移到基面 domain**，数值上与手写 base
--     同款 where 等价；本测试就是这条等价性的证明：红 = domain 谓词 / expr（含 `subtotal = 0`
--     的 null 排除——与 missing_cost_amount **互斥**的锚）/ 分组键与手写链漂了，
--     **不许靠调容差抹平**。
-- 本测试按 fct 粒度（账套 × 业务日 × 门店）**逐行**比这两套值：任一分差 > 0.01 即红。
--
-- 比的是**同一行上的两列**（同一张 fct 表）⇒ 不需要 full join：行集由最终 SELECT 的驱动基面
-- （旧实现的全量分组）保证——gen_agg 行域与 base 全分组域**相等**（阶段 1 `else 0` 全单出行、
-- 阶段 2 全组出值，无零成本组也出 0.00 行，不是缺行）⇒ left join 恰 1:1 不增删最终行；
-- 粒度行集另有 `assert_fct_transfer_line_quality_grain_unique.sql` 钉住。
--
-- ⚠️ **NULL 必须显式判红**：两侧都 `coalesce(…, 0)`，只比差值的话「影子列变 NULL、旧列是 0」
--    会算成 0 = 0 而**静默绿**（P3.0 修过的 I1 缺陷同型：单侧缺行输出 NULL，差值判据结构性
--    看不见它）。故失败谓词里单列一条 `zero_cost_amount__gen is null`；schema.yml 的 `not_null`
--    是同一件事的结构守卫，口径容差仍是 1 分、不放宽。
--    （#1019 订正说明）现形态下最终 SELECT 已把影子列 `coalesce(…, 0)` 归零 ⇒ 物化列恒非空，
--    本 `is null` 分支是**防御性死分支**：它守的是「归零被移除」的将来态（真发生时 schema.yml
--    的 not_null 先红）；活的对账判据是上面的分差谓词。
--
-- ── 本测试**不**守什么（免得把绿读成「整条链都对」）────────────────────────────────────
-- · **声明漂移**：`l1_metrics.yml` 改了而 fct 生成区没重生成（或反之），本测试看不见——
--   它只比**物化后的数值**。那一层由 `gen-fct-measures.mjs --check`（逐字节）与
--   `scripts/sync-data-semantics.test.ts`（声明↔同步面）守。
-- · **阶段 1 分组键的漂移（本族特有盲区，如实记）**：本 expr **纯可加**（sum + 常量 else 0，
--   无除法 / max），sum 的结合律使「阶段 1 键多一把或少一把」在店日上**数值不可见**——
--   两阶段「键对不对」由生成器单测（`scripts/gen-fct-measures.test.ts` 逐字钉 keys）与
--   声明自洽校验守，本测试只守数值等价。带除法与 max 的逐单公式属**净额族**（fct_retail_sale
--   的逐单 measure，键漂即红）；同场的 retail_quantity 影子列同为纯可加 `sum(quantity)`，
--   **与本族一样有**这条盲区——别把「净额族键漂即红」的判读搬到任何纯可加族头上
--   （原注「retail 族没这条盲区」指代不清，2026-10-24 终审 F-2 订正）。
-- · **fct 粒度以下的差异**：对账在 (账套 × 业务日 × 门店) 上做，逐单互相抵消的错在这里不可见。
-- · **谁对**：这是**等价性**测试，两侧同错也绿。旧列是不是真值由
--   `audit_lemeng__transfer__zero_cost_exposure_amount` 独立复算兜。
-- · **窗口外**：14 天以外的历史分区不复检（旧分区被重写的回归抓不到）。
--
-- ── 为什么是 1 分容差 ───────────────────────────────────────────────────────────────────
-- 两侧的算术路径其实**同构**：旧侧 `sum(case…end)::numeric(20,2)` 一次 cast；影子侧阶段 1
-- **不 cast**、店日上卷时一次 cast——PG decimal 求和精确可结合 ⇒ 理论上逐位相等。
-- 1 分是全仓金额对账的**家族惯例地板**（#957 实测结论：全精度直比过强必假红），不收紧、不放宽。
--
-- ── 为什么窗口是 14 天、且只取闭窗日 ───────────────────────────────────────────────────
-- 被比列挂的唯一指标 `lemeng:transfer:zero_cost_exposure_amount` 是 **certified**
-- （tier 见 `dbt/semantics/l1_metrics.yml`）⇒ 窗口取影子波**家族惯例** 14 天
-- （比更短窗口只会让红来得更晚，没有收益）。
-- 只测 `bizday < 上海今天`：当日分区被 tick 持续重写，两侧时点不同不可比（同 `audit_*` 的闭窗约定）。
--
-- ── 空转绿守卫 ─────────────────────────────────────────────────────────────────────────
-- 窗口内一行都没有时，`where` 在空集上「通过」是**空转绿**（不是对上了）。故显式补一行失败。
-- 守卫是**整窗**级的：单个账套整段空窗不会触发（「账套级覆盖」归水位/新鲜度机制，不归本测试）。
--
-- ⚠️ 本测试是 **P3.3 影子期的桥**：切列波把消费面切到 `zero_cost_amount__gen` 之后，两列同源、
--    本对账失去参照 ⇒ 那时的计划必须改写或移除它，**不要留成空转绿**。
with cmp as (
    select system_book, bizday, branch_num,
           zero_cost_amount, zero_cost_amount__gen
    from {{ ref('fct_transfer_line_quality') }}
    where bizday < CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE)
      and bizday >= CAST(now() AT TIME ZONE 'Asia/Shanghai' AS DATE) - 14
)
select *,
       case when zero_cost_amount__gen is null
            then '影子列为 NULL（coalesce 归零后会算成 0 = 0 的静默绿，故显式判红）'
            else '影子列与现有列不一致（zero_cost_amount，1 分容差）'
       end as note
from cmp
where abs(coalesce(zero_cost_amount,0) - coalesce(zero_cost_amount__gen,0)) > 0.01
   or zero_cost_amount__gen is null

union all

select null, null, null, null, null,
       '空转绿：窗口内一行都没有' as note
where (select count(*) from cmp) = 0
