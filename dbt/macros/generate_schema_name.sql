{#
  generate_schema_name.sql — 每租户一个 schema（issue #150 / 计划 Task 11；spec §11.5 #3 的
  「per-schema + `search_path`」与 §11.2 #6 的「每租户一个 schema」）。

  ── 它解决什么 ────────────────────────────────────────────────────────────────────────
  pg_duckdb 的 secret/连接身份只能按 **PG role** 分，而 Metabase OSS 的逐用户隔离是零
  （spec §6.1）。所以租户隔离的主力不在消费层，在**数据面**：每个租户一组
  （role、桶内前缀、schema）。本 macro 是**每租户 schema 名的唯一定义点**：
  同名视图各指各的数据，会话绑哪个 schema 就只能看到哪个租户。

  ── 怎么用（多租户跑法）───────────────────────────────────────────────────────────────
  openship job 循环租户打（拍板 #4：物化调度 = openship jobs，零新常驻组件）：

      dbt run --select <…> --vars '{tenant: <租户键>}'

  **租户键 = `platform.tenant.casdoor_org`**（不是 slug）——理由是身份面一致：模块里的
  `identity.orgId` 就是 casdoor org，marts 表里的 org 列也是它 ⇒ 「数据面 schema / 会话绑定 /
  行内 org」三者同源。取值口径与取法见 dbt/README.md「多租户跑法」节。

  ⚠️ **测试替身/单租户不用管**：不给 `tenant` var ⇒ **逐字回到 dbt 内置行为**（见下），
  P1 私有化单租户跑法（`profiles.example.yml` 的 `schema: staging`）零变化。

  ── 三个实现判断（免得后来者当成疏漏）────────────────────────────────────────────────
  ① **归一只有两条：折小写 + `-` → `_`**。casdoor org 允许连字符（如 `acme-org`），而
     `tenant_acme-org` 在 PG 里是个**必须处处加双引号**才成立的标识符 —— 少加一处就是
     `schema "tenant_acme" does not exist` 一类误导性报错，不如在名字里就避开。
     归一后**仍然**含别的字符（`. / 空格 / 非 ASCII`）⇒ **`raise_compiler_error` 响亮失败**，
     不静默拼出一个坏名字（fail-closed：宁可这一轮物化起不来，也不要一个「看着建好了、
     其实谁都查不到」的租户 schema）。
     空 tenant var（`--vars '{tenant: ""}'`）与**没给** var 走同一条路（都回内置行为）——
     「显式给空」不是「建一个叫 tenant_ 的 schema」。
  ② **`-` 之外的字符一律不归一**（不做 unicode 折写、不做空格压缩）：英文名归一规则越多，
     越容易出现「两个不同的 org 归一到同一个 schema」这种**静默串租户**。
     ⚠️ **但这条派生仍然不是单射**（评审 I1）：`acme-org` 与 `Acme-Org` 都归一到
     `tenant_acme_org` —— 归一小到两条也躲不掉。而**本 macro 看不见这件事**：
     `dbt run --vars '{tenant: …}'` 一次只喂**一个**键，撞名要同时看到全部平台键才判得出来。
     ⇒ 「宁可失败」这句话由**能看见全部键的那一侧**兑现：`scripts/reconcile-data-tenants.mjs`
     的 `collisions` 桶（**撞名 ⇒ 显式逐条报出 + exit 1**，绝不报 clean）。改动派生规则时
     **两处必须同步**（见 scripts/reconcile-data-tenants.mjs 头注「与 macro 的同源纪律」）。
  ③ **不给 tenant var 时调 `generate_schema_name_for_env()`** —— 那是 dbt-core 内置
     `generate_schema_name` 自己委托的宏，等于「原样保留内置行为」（含它的 `target.name == 'prod'`
     与 `custom_schema_name` 规则），比在这里重写一份默认实现更不会漂。
     ⚠️ **未验**：本机没有 dbt ⇒ 「这个宏名在目标 dbt 版本里存在」与「本条 fallback 真跑通」
     **都未实测**（dbt/README.md「未验清单」同性质）⇒ 真机首次 `dbt parse/run` 核对归 T6。
     它失败是**响亮**的（未定义宏 ⇒ 编译错），不是静默 —— 故不构成假绿风险。
     ⚠️ **与对账脚本的一处有意分歧（空键）**：空 tenant var 在本 macro 走「回内置行为」
     （**不报错**：不给 var 是 P1 单租户的合法形态），而对账脚本的 `tenantSchemaName('')` **抛**
     （在它那里「没有键」= 会拼出所有租户共用的 `tenant_`）。两者各自正确，分歧**已被 fixture 记录**
     （`scripts/check-data-models.test.ts` 的 T11 修复笔段：断言 script 抛 + 本分支不 raise）。
  ④ 单引号在本文件里**只许出现在这两个位置**：`'tenant_'` 前缀与 `var('tenant')` 的键名。
     任何**整名**形态的 schema 字面量（形如 `'tenant_acme'`）都会被
     `scripts/check-data-models.test.ts` 的 T11 格①当场判红 —— 整名直写 = 派生被架空 =
     所有租户共用同一个 schema，是这条 macro 存在的意义的反面。
#}
{% macro generate_schema_name(custom_schema_name, node) -%}
    {%- set tenant = var('tenant', '') | trim -%}
    {%- if tenant == '' -%}
        {{ generate_schema_name_for_env(custom_schema_name, node) }}
    {%- else -%}
        {%- set schema = 'tenant_' ~ (tenant | lower | replace('-', '_')) -%}
        {%- if modules.re.search('[^a-z0-9_]', schema) -%}
            {{ exceptions.raise_compiler_error(
                "租户键归一后仍不是合法的 PG 标识符：" ~ schema
                ~ "。租户键只允许 [A-Za-z0-9_-]（归一 = 折小写 + 连字符改下划线），"
                ~ "带别的字符的名字会拼出一个必须处处加引号才成立的 schema 名 ——"
                ~ "那是静默的地址漂移，故在这里响亮失败而不是建一个查不到的 schema。") }}
        {%- endif -%}
        {{ schema }}
    {%- endif -%}
{%- endmacro %}
