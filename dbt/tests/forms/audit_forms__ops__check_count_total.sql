{{ config(store_failures=true, tags=['audit_window']) }}
-- audit_forms__ops__check_count_total.sql — 指标 `forms:ops:check_count_total` 的**独立复算**（对账）。
--
-- ★ `store_failures=true`（仓内先例 audit_lemeng__retail__sales）：失败行落
--   `<目标 schema>_dbt_test_failures.audit_forms__ops__check_count_total`，可直接查差异格。
--
-- 契约：dbt 的 singular test **返回任何行即失败** ⇒ 本查询只在「复算 ≠ 物化结果」时出行。
-- 文件名由指标名经 `:` → `__` 映射得出（唯一事实源 = scripts/check-data-models.mjs 的
-- metricToAuditFileName()；规则 ⑥⑦ 机检）。
--
-- 独立复算（layered §7 硬约束 7：**cast 错了静默，只有它能抓**）：直接打湖上 parquet
-- （forms/submission），payload 逐字重提取 + 重 cast，**不 ref 摊平模型的提取链**——
-- 若复算走 ref(stg_forms_submission__ops_round_2026_11)，staging 的 cast 错会同时污染两边
-- ⇒ 对账恒等、永远绿。两侧过滤同一个 form_def_id 与同一个闭窗谓词，才是同量对比。
--
-- ★ **闭窗**（仓内纪律，同 audit_lemeng__* 的 ETag 竞态防护）：`bizday < audit_until_date()`
--   （审计上界 T-3）——今天的批次目录正被采集写，读侧撞 ETag 直接 ERROR；两侧同滤才是同量。
--
-- ★ **空集是合法初态**（与 lemeng 侧 audit 的「空转绿」红线**刻意不同**，勿照抄）：
--   摊平模型按 form_def_id 过滤，表单刚发布、提交还没采集进湖时两侧**都空**是正常形态
--   （bootstrap 缺陷的教训见 stg_forms_submission.sql 头注 #751——空湖一红，水位全冻结）。
--   聚合函数对零行返回 NULL，coalesce 成 0 后两侧相等 ⇒ 静默通过；
--   **非对称空**（复算有值/物化空 或 反之）会被 `abs(diff) > 0.01` 抓住 ⇒ 仍然响亮。
--
-- ★ 中间 cast 用 `decimal(38,10)` 不用裸 `::numeric`（DuckDB 裸 numeric=DECIMAL(18,3) 且除法
--   塌 DOUBLE，#761 两轮实测；本指标虽是加法，铸型纪律保持仓内一致）。
with recheck as (
    select sum(
        cast(json_extract_string(r['payload'], '$.check_count') as decimal(38,10))
    ) as v
    from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("forms_submission_prefix") }}/bizday=*/batch_id=*/all.parquet'
    ) r
    where r['form_def_id'] = 'ops-round-2026-11'
      and r['bizday']::date < {{ audit_until_date() }}
),
materialized as (
    select sum(f_check_count) as v
    from {{ ref('stg_forms_submission__ops_round_2026_11') }}
    where bizday < {{ audit_until_date() }}
)
select
    a.v as recheck_value,
    b.v as materialized_value,
    '复算与物化结果不一致（forms:ops:check_count_total，#2706 件①字段级通路）' as note
from recheck a
cross join materialized b
where abs(coalesce(a.v, 0) - coalesce(b.v, 0)) > 0.01
