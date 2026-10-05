-- audit_lemeng__retail__hour_row_count.sql — 「量级」判据（§1.4.1 的分工：**量级落管线外**）。
--
-- 契约：dbt singular test，**返回任何行即失败**。
--
-- ★ 与本目录另两条 audit 是**两种判据**，别混：
--   · `audit_…__net_sales` / `…__order_count` = **独立通道**（同一个数的两条算法：复算 vs 物化）；
--   · 本条 = **量级**（同一个量在两个时点：今天 vs 历史）。
--   两者同属 §1.4「缺一层不算过」，但抓的东西不同 —— 前者抓口径/cast，后者抓「**丢了**」
--   （某个小时本该有数据却骤降/归零）。为什么量级不放在采集管线内，见 §1.4.1 的三条理由。
--
-- ★ 为什么文件名不属于任何指标：规则 ⑦ 只机检「**指标 → 对账文件**」这一个方向
--   （`metricToAuditFileName()` 是唯一事实源），本条不对应任何指标 ⇒ 不进 `l1_metrics.yml`，
--   也不会与 `:` → `__` 的映射碰撞（已核：无 `lemeng:retail:hour_row_count` 这个指标）。
--
-- ★ **本条属哪一档**（§1.4.1 定稿线）：本条的判据对象是「最后一个已跑完日批的营业日」= **未定稿档**，
--   角色是**量级早警**（宽带宽容差、只抓断崖、失败只告警不阻断）。
--   **已定稿档（T-3 及更早）的「完整对账」是另一条**：与源**同问句**重拉、逐单比对、**容差 0**、
--   不平即**触发回填** —— 那不是 dbt 能做的（要打网关/独立通道），**本条不代替它**。
--   （为什么必须有 T-3 那条：湖里 T-1 两次点火后就冻结，而源更久之后仍在变 ⇒ 冻住的湖会永久短于
--   稳态的源，见 §1.4.1「定稿线」。）
--
-- ★ **已知边界**（2026-10-05 代码评审登记，别当已解决）：
--   ① **判据对象假设「昨天的日批已跑完」**（即 §1.4.1 的「第二次点火之后」），而**本条无法自证
--      这个前提**：若在第二次点火之前被跑（或日批延迟），昨天还是半成品 ⇒ 误报。
--      ⇒ 只能由**调度**保证顺序（排在日批之后）；SQL 侧不猜运行时机。
--   ② **全湖扫描**：路径不带日期下界，成本随历史线性涨（现只两周数据，尚可）。
--      ⇒ 待办：加日期下界/分区裁剪（另两条 audit 同此形态，宜一并改）。
--   ③ **占用「指标对账」的文件名范式**：将来若真声明指标 `lemeng:retail:hour_row_count`，
--      门禁规则 ⑦（每个指标必须有对账）会被这条**不相干**的测试蒙过。
--      ⇒ 届时给本条**改名**（它算量级/断崖，不是指标的独立复算）。
--
-- ── 形态：与另两条 audit **同一套实测形态**（2026-09-24 数据面真机）──────────────────────
--   ① 取列用 `from read_parquet('…') r` + `r['列名']`（别名挂函数调用上；CTE 形态取列报
--      `cannot subscript type record`）；
--   ② `hive_partitioning` **不能**写成 read_parquet 的形参（pg_duckdb 的 read_parquet 是 PG 函数、
--      只认位置参数）；分区推断默认生效，`system_book` 推断成 bigint ⇒ 本文件显式 cast；
--   ③ **通配两账套**（与 staging 同路径），否则只看了 3120（issue #250）。
--
-- ── 容差为什么这么宽（**别收紧**，2026-10-05 实跑标定）────────────────────────────────
-- 本条只抓**断崖**：低于同小时历史中位数的一半（factor 0.5）。实跑证据（当日真库）：
--   · factor 0.5 → **0 行**（不误报）；factor 0.95 → 出行（证明它**能**开火，不是恒绿）。
--   · 同窗口**按天总行数在 8,534 ↔ 27,145 之间摆动**（3120，09-23~10-05）：09-24 换源后
--     量级整档下移（09-23/24/25 约 20~27k，09-26 起约 9~13k）⇒ **尾随中位数会跨越「档位切换」
--     被抬高**，于是新档位的每一天都「看起来低了一档」（实测普遍落在中位数的 0.75~0.90）。
--   · 国庆假期等季节性同样落在这个形态里。
-- ⇒ 结论：**这是「灾难探测器」，不是「漂移探测器」。** 小幅漂移 / 档位切换 / 季节性**本就不该由它抓**
--   （应由口径对账 + 人工解释）。收紧到 0.9 会在正常日子里天天红。
-- 另两类**合法**波动也要求宽带：
--   · 门店在凌晨/非营业小时**合法为空** ⇒ 常态中位数为 0 的窗**直接跳过**，不判；
--   · 「0 明细单」的取消单让行数小幅起落（整单不落湖，见 §1.4.1 引的引擎实测）；
--   · **源侧事后仍在变**（实测同一窗 8 小时内 472 → 476 → 482）。
with landed as (
    -- 湖里每个 (账套, 营业日, 小时) 实际落了行数
    select
        r['system_book']::varchar as system_book,
        r['bizday']::date         as bizday,
        r['hour']::int            as hour,
        count(*)                  as rows_landed
    from read_parquet(
        's3://{{ var("zos_bucket") }}/{{ var("lemeng_retail_order_line_prefix") }}/system_book=*/**/*.parquet'
    ) r
    group by 1, 2, 3
),
newest as (
    -- 每个账套湖里**最新**的营业日
    select system_book, max(bizday) as bizday
    from landed
    group by 1
),
latest as (
    -- 判据对象 = **最新那个的前一天**，即「最后一个已跑完日批的营业日」。
    -- ⚠️ 为什么不能用最新那天（本文件首版就是这么写的，**实跑当场误报 3 行**）：
    --   5min tick 会**持续往最新那天追写**（它采的是「当前小时」），所以最新那天的
    --   晚些小时**根本还没采**，拿它比完整日必然报「骤降」。判据必须在**数据定稿之后**求值 ——
    --   这正是 §1.4.1「求值时机」那条的由来（案例即此处）。
    -- ⚠️ 边界（如实记）：若某账套**整天没采**（日批也没跑），本判据看不到它 —— 那属于
    --   「整日缺失」，是 `qa.freshness` / 湖对象锚那一层的事，不归本条。
    select l.system_book, max(l.bizday) as bizday
    from landed l
    join newest n on l.system_book = n.system_book
    where l.bizday < n.bizday
    group by 1
),
today as (
    select l.system_book, l.bizday, l.hour, l.rows_landed
    from landed l
    join latest u on l.system_book = u.system_book and l.bizday = u.bizday
),
history as (
    -- 同小时在**过去 14 天**的中位数（中位数抗单日异常），并记历史天数
    select
        l.system_book,
        l.hour,
        median(l.rows_landed) as median_rows,
        count(*)              as history_days
    from landed l
    join latest u
      on l.system_book = u.system_book
     and l.bizday < u.bizday
     and l.bizday >= u.bizday - 14
    group by 1, 2
)
-- ⚠️ **从 history 左连到 today**（不是内连接）：整块缺席的小时在 `today` 里**根本没有行**，
--    内连接会把它悄悄丢掉 —— 而「一个本该繁忙的小时整块没落」正是最该抓、也最静默的那种「丢了」。
select
    h.system_book,
    u.bizday      as bizday,
    h.hour,
    t.rows_landed as today_rows,
    h.median_rows as history_median,
    h.history_days,
    case when t.system_book is null
         then '本小时在目标营业日**整块缺席**（历史常态有量）——最严重的那种「丢了」（§1.4.1）'
         else '本小时行数较同小时历史中位数骤降（量级判据，§1.4.1）' end as note
from history h
join latest u
  on u.system_book = h.system_book
left join today t
  on t.system_book = h.system_book
 and t.hour        = h.hour
where h.history_days >= 3                                   -- 历史不够不判（冷启动不误伤）
  -- **只判「常态繁忙」的小时**（下限 50 行/小时）。为什么不写 `median_rows > 0`：
  --   实测（2026-10-05 变异确认）有小时**历史上就只有零星几行**（如 3120 的 01 时中位数 3、
  --   07 时中位数 12；64188 的 07 时中位数 2.5，8 天里大半为 0）——这种小时「今天没有」是正常，
  --   不是丢数。门槛取 >0 会把它们全报成「整块缺席」。
  --   ⚠️ 这个 50 是按**真实分布标定**的（繁忙小时数百~上千行、零星小时个位数），不是拍的；
  --      换源/换账套后应重新标定。
  and h.median_rows  >= 50
  and (t.system_book is null                                 -- ① 整块缺席
       or t.rows_landed < h.median_rows * 0.5)               -- ② 骤降（低于中位数一半）

union all

-- 空集自检**三连**（同族：另两条 audit 与本仓 check-tenant-isolation 都有这一段）。
-- 只自检 `landed` 为空是不够的：`landed` 非空、而 `today`/`history` 为空时（冷启动、或目标日
-- 整天没落），主查询恒不出行 = 「通过」，而那个通过**什么都没比过**。三种空都要显式出行。
select
    null, null, null, null, null, null,
    '湖里一行都没有：空集上「通过」是空转绿（不是对上了）'
where not exists (select 1 from landed)

union all

select
    null, null, null, null, null, null,
    '目标营业日一行都没有（today 为空）：没有任何小时进入判据——空转绿（不是对上了）'
where not exists (select 1 from today)

union all

select
    null, null, null, null, null, null,
    '没有任何历史可作基线（history 为空）：判据从未跑过——空转绿（不是对上了）'
where not exists (select 1 from history)
