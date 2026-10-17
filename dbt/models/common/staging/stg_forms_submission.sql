{{
    config(materialized='table', enabled=false)
}}
-- stg_forms_submission.sql — **表单提交** staging（M1.4 / issue #729，2026-10-16）。
--
-- ── ⚠️ 本模型当前**停用**（issue #751，2026-10-17）──────────────────────────────────────
-- **为什么**：读的是通配路径 `bizday=*/batch_id=*/all.parquet`——只要有**第一个**文件落下来，
--   glob 就永远匹配得上；但在那之前**每次 dbt build 必红**：
--     `IO Error: No files found that match the pattern ".../forms/submission/bizday=*/batch_id=*/all.parquet"`
--   这是 **bootstrap 缺陷**，不是「某天缺数据」。
-- **为什么现在必然红**（2026-10-17 山海生产实测）：平台 `forms.submission` 表存在但 **0 行**
--   ⇒ 导出 API 导不出东西；且 **forms 出湖管线没进任何排班**（`schedules/{3120,64188}.json`
--   里都 grep 不到 forms）⇒ 湖里不会有文件，**补排班也解决不了**（没数据可采）。
-- **为什么不能放着**：`scripts/lemeng/materialize.sh` 的契约是「dbt 非零 ⇒ MATERIALIZE_FAILED
--   + exit 1」，而 exit **发生在写 `load_log` 之前** ⇒ 物化其实成功了（PASS=185）却**不落水位**，
--   `data_as_of` 停在旧值 ⇒ **所有指标的新鲜度固定行一起退化**（数据是新的，报的却是旧的）。
-- **✅ 复 enable 的唯一条件**：湖里出现第一个 `forms/submission/bizday=*/batch_id=*/all.parquet`。
--   验证一条命令即可（数据面机）：列出该前缀，非空 ⇒ 删掉上面的 `enabled=false` 并跑一次 materialize。
-- **更正的形态**（留给 #729，不在本 PR）：采集在**空批次也落一个带申报 schema 的空 parquet**，
--   这样模型从第一刻起就能跑、排班后每天都有文件——那是治本，但要先验 duckle sink 在 0 行时的行为。
--
-- 【用途边界｜这是本模型的**全部价值主张**】通用域：出湖 schema **与业务无关**——任何表单的提交都进
--   这一张表，**新表单只是新的 `form_def_id` 值**（ADR-0005 §13.1）。故本模型**一次 PR 后不再改**：
--   新增表单 ⇒ 零改动自动可见。⚠️ **表单的字段级语义不进本模型**（`payload` 是动态 JSON，自动认证
--   = 在 dbt 价值最大化的地方挖洞：口径无 owner / 无测试 / 无 lineage）；逐字段口径留在**消费面的
--   运行时提取**（档一编译点 / Metabase SQL），那是**升级动作**不是默认路径。
--
-- 【采集形态】源 = forms 模块自建的导出 API（`GET /export/submissions`，键集游标），通路 = duckle
--   `src.rest`；采集日一次（正典 §1.1.7 的 L0 直连档）。⚠️ **本表的源是我方自建**（非第三方），
--   故「摸清源」与「建源」合并——探针四条对真实端点跑过（计划稿 docs/superpowers/plans/2026-10-16-forms-out-lake-m1.4.md）。
--
-- 【payload 为什么是 varchar 且必须显式 cast】ADR-0005 §13.1 ① 实测：**引擎默认行为是反的**——
--   不显式定型时 payload 落湖为「全字段并集 STRUCT」（schema 冻结到历史字段并集 + 运行时按并集补
--   null），后续表单出新字段下一轮写入即冲突。故契约声明整列 varchar（JSON 文本，schema-on-read），
--   管线侧必须 `CAST(to_json(payload) AS VARCHAR)`。本模型只做**类型回归**（::varchar），不改义。
--
-- 【分区键推断类型不合约 ⇒ 显式 cast】同 sources.yml 的注：hive 推断出的类型（bizday→date 尚可、
--   batch_id→varchar 尚可）仍统一显式 cast，理由是**别依赖推断**——推断规则随引擎版本变。
--   取列必须 `r['列名']::type` 点名形态（`select *` 能过、点名取列报 column does not exist，坑 #5）。
--
-- 【前缀单点】`forms/submission` 段不写死字面量 —— 用 `dbt_project.yml` 的同源 var
--   `forms_submission_prefix`（出处：contracts/common/forms.submission.json 的 layout.prefix）。
--
-- 【主体列】`org` **不在湖里**（本表与乐檬同构）：由 `subject_org()` 注入——它是行内主体列的
--   唯一定义点（值取部署租户的 env，空串 fail-closed）。理由与对 ADR §13.1 四元组的显式偏离
--   记在契约 description 里。
select
  r['batch_id']::varchar as batch_id,
  {{ subject_org() }}       as org,
  r['bizday']::date as bizday,
  r['submission_id']::bigint as submission_id,
  r['form_def_id']::varchar as form_def_id,
  r['submitted_at']::timestamptz as submitted_at,
  r['payload']::varchar as payload
from read_parquet(
  's3://{{ var("zos_bucket") }}/{{ var("forms_submission_prefix") }}/bizday=*/batch_id=*/all.parquet'
) r
