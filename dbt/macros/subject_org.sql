{#
  subject_org.sql — 数据面**主体列**（`org`）的唯一定义点。
  设计正典：docs/superpowers/specs/2026-09-26-subject-org-column-design.md

  ── 它解决什么 ──────────────────────────────────────────────────────────────────────
  `modules/data/domain/authz.ts` 的 `authorize()` **恒拼** `<select_sql> WHERE <主体列> = '<orgId>'`，
  而主体列写死为 `org`（scripts/sync-data-semantics.mjs 的 `L1_SUBJECT_COLUMN`）。
  主体列在**真实关系里不存在**时，拼出的 SQL 必然以仓库错误（502）收场（issue #176 缺口 A）
  ⇒ 本 macro 就是让那一列存在。

  ── 值从哪来 ────────────────────────────────────────────────────────────────────────
  值 = **该部署租户的 casdoor_org**，经 env 键 `LEMENG_SUBJECT_ORG` 注入。
  **不落仓、不进 argv、不进文档**（取值口径与取法见 dbt/README.md「多租户跑法」节）。

  ── 两道 fail-closed（为什么不能直接写 env_var）─────────────────────────────────────
  `env_var('X')` 在 **X 未定义**时报错，但在 **X 已定义且为空串**时**正常返回 `''`** ⇒ 那种形态会把
  「配了但配错」放行成**静默的空 org**：写入侧看着成功、读取侧 `where org = $1` 一行都查不到
  （空串不是 NULL，非空约束也拦不住）。所以空串这道断言必须由本 macro 自己响亮失败。

  ── 与 var('tenant') 的分工（刻意解耦）──────────────────────────────────────────────
  `var('tenant')` 决定**物化落点**（schema 名，见 macros/generate_schema_name.sql）；
  本 macro 决定**行内主体**。两者在多租户跑法下同源，但单租户（P1 私有化）跑法下**必须分叉**：
  那份配置**不给** `tenant` var 是合法形态（dbt/README「多租户跑法」节），而 org 列
  **任何时候都必须有值** ⇒ 不用 `var('tenant')` 承担 org。
#}
{% macro subject_org() -%}
    {%- set o = env_var('LEMENG_SUBJECT_ORG') | trim -%}
    {%- if o == '' -%}
        {{ exceptions.raise_compiler_error(
            "LEMENG_SUBJECT_ORG 为空：org 是行级授权的主体列，空串不是 NULL —— "
            ~ "它会静默写进行里，让 where org = $1 一行都查不到（写成功、读不到，最难查）。"
            ~ "把该部署租户的 casdoor_org 配进 env（键名与取法见 dbt/README.md 多租户跑法节）再跑。") }}
    {%- endif -%}
    '{{ o }}'
{%- endmacro %}
