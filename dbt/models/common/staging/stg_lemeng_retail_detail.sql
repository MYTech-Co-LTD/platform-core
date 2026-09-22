{{
    -- 物化落点 gate 2 的**显式表态**：staging 必须落在 PG 可见关系上（表/视图），
    -- 不能是 read_parquet 的裸扫描结果 —— 裸扫描不进 pg_class ⇒ Metabase 与任何 PG 客户端看不见
    -- （spec §9.4）。项目的缺省已是 table，这里再钉一次是为了「改项目缺省时不静默改变本模型语义」。
    config(materialized='table')
}}

-- stg_lemeng_retail_detail.sql — 乐檬零售明细 staging（layered §3：**一对一、只规范化不改义**）。
--
-- 分层纪律：③ 层的职责是把原始 VARCHAR 定型，**不做聚合、不做 join、不改口径**（口径只在 ④ marts 定义一次）。
--
-- 拍板 1（2026-09-22）的由来：存量 parquet 列**全是 VARCHAR**（坑 #1，实测金额形如 "12.79"），
-- 决定**不重落盘**、cast 全部在本层手写；正确性靠 dbt tests + 对账 singular tests 兜
-- —— 原文口径：**cast 错了不报错，只有断言能抓**。
--
-- 四处已知坑（layered §9 五条里的四条，逐条对应到本文件）：
--   坑 #5 读 parquet 必须 `r['列名']` + 别名 `r`：`SELECT *` 能过、**点名取列报 column does not exist**，
--     而 `SELECT *` 的成功会掩盖它 ⇒ 写新 staging 的人必然踩（本层是全仓唯一碰原始类型的地方，
--     所以这条纪律落在这里；scripts/check-data-models.mjs 的规则 ① 静态拦）。
--   坑 #4 **DOUBLE 不是 pg_duckdb 可用的 cast 目标**（报 `type "double" is only a shell`）
--     ⇒ 金额用 numeric、浮点用 float（静态门禁规则 ② 拦：`::double` **与** `CAST(... AS double)`
--       —— 同一坑 #4、同一类型名查找路径（两种写法都是拿裸 `double` 去查类型名），故同拦；
--       放行 PG 原生的 `double precision`（不做类型名查找，与本条要拦的不是同一个东西））。
--   坑 #3 同一张表里**两个时间列两种格式**（`order_time` = '2026-07-01 10:02:34'；`order_detail_bizday` = '20260707'）。
--   坑 #2 列集漂移（同域不同日 46 vs 43 列，supplier_* 时有时无）⇒ **禁 `union_by_name` 兜**
--     （静态门禁规则 ③ 拦），显式分组策略见下。
--
-- ⚠️ **本文件的列全集【暂定】**：以 ZOS 实测样本为准（坑 #2 的 46/43 漂移意味着「列清单照猜写必然错」）。
--   本任务交付的是**模式 + 实证样例列**，列全集在 T6 真机首跑时按样本钉死并回填（T6 有对应核对步）。
--   逐列的证据等级（实证 / 暂定）见 dbt/README.md「实证 vs 暂定」对照表 —— **别把暂定当已定**。
--
-- ⚠️ **跨列集读取的显式分组策略（本文件当前形态的适用边界，T6 gate）**：
--   下面的 `/**/*.parquet` 一次读全窗（本账套全部日期）。它**只在窗口内列集一致时成立**；
--   一旦窗口里混进 43 列的日子，DuckDB 的 binder 会因为 schema 不一致而**响亮报错**（这正是我们要的
--   —— 比 `union_by_name` 悄悄补一堆 NULL 然后算出一个错的口径强）。届时按 README「漂移策略」的
--   显式分组读（按列集分组的路径列表 → 各自 read_parquet → `union all` 时**显式**给缺失列补 NULL::<type>）
--   并在本文件里把分组清单写死。**分组清单与 `read_parquet` 的分组形参形态待 T6 按实测钉死**
--   （是否透传 `columns=` 一类形参在 pg_duckdb 下**未实测**，不预写）。
with r as (
    -- pg_duckdb 把 read_parquet 委托给 DuckDB 执行。裸扫描结果**不是 PG 关系、不进 pg_class**
    -- （spec §9.4 可见性坑）⇒ 它只出现在 staging 模型内部，物化落点由上面的 config + 项目缺省保证
    -- 是 PG 可见关系（gate 2，见 README）。
    select * from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_retail_prefix") }}/{{ var("account_book") }}/**/*.parquet'
    )
)
select
    -- ── 【实证】金额：存量是 VARCHAR（实测值形如 "12.79"）⇒ 本层手写 cast 定型 ──────────────
    -- numeric（**不是** `::double`：坑 #4）。金额一律 numeric，保住精度与对账的逐位比对。
    r['amount']::numeric                        as amount,

    -- ── 【实证】两个时间列两种格式（坑 #3）⇒ **各自 try、各自成列** ────────────────────────
    -- ⚠️ 与计划范文块的一处**有意偏离**：范文把两列 coalesce 成一个 order_time。但它们是**两列**、
    --    两种语义（交易时间 vs 业务日），coalesce 会把两种语义压成一个字段并静默丢掉一半信息
    --    （同一行两个值都在时，后一个永远不可见）。故这里各自定型、各自成列。
    --    两处都 try_strptime：解析失败给 NULL 而不是整跑失败（脏数据要能被 dbt tests 抓出来，
    --    见 schema.yml 的 not_null）；「哪种格式对应哪列」的实测口径以 T6 样本复核。
    try_strptime(r['order_time'], '%Y-%m-%d %H:%M:%S')::timestamptz  as order_time,
    try_strptime(r['order_detail_bizday'], '%Y%m%d')::date           as bizday,

    -- ── 【暂定·待 T6 按样本核对列名】单号：order_count 指标（按单号去重）的唯一依赖列 ──────────
    -- 列名与去重语义都要按实测样本复核；若样本里没有稳定的单号列，`retail:order_count` 这个声明
    -- 应该**删掉**而不是换成别的近似口径（口径不能猜）。
    r['order_no']                               as order_no,

    -- ── 【实证·路径形态】账套（= 主体维度）────────────────────────────────────────────────
    -- 值来自**路径**、不在数据里（handbook §4 欠账「账套只在路径、数据里没有」/ 标准 C3 身份跟着数据走）。
    -- 存量阶段由 dbt var `account_book` 供值（每个账套跑一份）；**路径解析进列**
    -- （`filename=true` + 正则取 `<账套>/` 段）是目标形态，**待 T6 按实测路径钉死** ——
    -- 好处是「身份跟着数据走」：一次读全部账套也不会串。
    '{{ var("account_book") }}'                 as system_book
    -- …【暂定】列全集按 T6 实测样本补齐，每列注明来源列名与证据等级（README 的对照表同步更新）
from r
