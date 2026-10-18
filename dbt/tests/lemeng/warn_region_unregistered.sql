{{ config(severity='warn') }}
-- warn_region_unregistered.sql — **哨兵**：门店档案里出现了 `dim_region` 未登记的 `region_id`。
--
-- 与同目录 `assert_*` 的**根本差别**：本文件 `severity='warn'` ⇒ **告警不阻断**。
--   为什么（2026-10-18 用户裁决，#883）：新区出现**不影响存量指标的正确性**——战区名/一级是
--   **分组标签**，未登记只让那个新战区在报表上显示为 null，不会算错任何金额。用 error 会让
--   `dbt build` 非零退出 ⇒ `materialize.sh` 判本域失败 ⇒ **该域全部 relation 的新鲜度水位不落账**
--   （一次未登记的新区冻结整个域）。代价与收益不成比例，故 warn。
--   （本仓**首次**引入 `severity`；`materialize.sh` 的成败只看 `ERROR=` 计数与退出码，warn 不影响。）
--
-- 【它防的是什么】「随时更新」退化成「随时过期」。战区属性目前是**受控配置**：
--   二级名靠 `branchindicator` 年频枚举、一级名靠 UI 树读一次。乐檬侧开一个新区之后，
--   **没有任何东西会告诉我们**——除非有人碰巧看到报表上多了个 null。这条断言就是那个"东西"：
--   门店档案（`stg_lemeng_branch`，日更、`region_id` 覆盖 100%）每天给的 `region_id`
--   只要有一个不在 `dim_region` 里 ⇒ 当天告警「有新区，请归级」。
--   （唯一能返回完整区域树的接口 `nhsoft.user.ai.branch.region.find` 的 PAT 路由未配置 ⇒
--     自动归级做不到，**自动发现**是当前能达到的上限。见 seeds/schema.yml 的 `dim_region`。）
--
-- 【怎么处置】告警里点名了 `system_book` / `region_id` / 门店数与示例门店 ⇒ 拿去乐檬后台
--   查该区的名称与所属一级，按 `dbt/seeds/dim_region.csv` 的格式补一行走 PR。
--
-- 【为什么只判最新快照】历史快照里的 `region_id` 是**当时**的事实，不该按今天的维去追责
--   （否则每次归级都会让历史分区一起告警，哨兵立刻变成噪音）。
--   ⚠️ 反过来也说明本条**只覆盖"当前还在用的" region_id**：一个已无门店的旧区被改名不会被抓到。
--   那条要靠二级名的枚举比对，是另一条哨兵（见 #883「未做」）。
--
-- 【为什么不排除 region_id = 0】0 是**下游 fct 侧**的「未映射」哨兵值（见 `fct_contribution`
--   头注），不由本模型产生；源侧若真回 0，那正是一个未登记的战区，告警是对的。
select
    b.system_book,
    b.region_id,
    count(distinct b.branch_num) as branch_count,
    min(b.name) as example_branch_name
from {{ ref('stg_lemeng_branch') }} b
where b.region_id is not null
  and b.snapshot = (select max(snapshot) from {{ ref('stg_lemeng_branch') }})
  and not exists (
      select 1
      from {{ ref('dim_region') }} r
      where r.system_book = b.system_book
        and r.region_id = b.region_id
  )
group by
    b.system_book,
    b.region_id
