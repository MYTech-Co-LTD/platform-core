// exprs.test.ts — 列级表达式解析器（#2683）：顶层切分、别名提取、JSON 路径。
import { describe, expect, it } from 'vitest'
import { firstSelectList, parseAliasedExprs, parseJsonPathSources, parseMeasureExprs, splitTopLevel, stripSqlNoise } from './exprs'

describe('splitTopLevel', () => {
  it('括号/引号内的逗号不切', () => {
    expect(splitTopLevel("a, coalesce(b, 0) as c, 'x,y' as d"))
      .toEqual(['a', 'coalesce(b, 0) as c', "'x,y' as d"])
  })
  it('数组下标内的逗号不切', () => {
    expect(splitTopLevel("r['a']::varchar as a, b")).toEqual(["r['a']::varchar as a", 'b'])
  })
})

describe('stripSqlNoise', () => {
  it('去 Jinja 与注释（Jinja 会破坏括号配对）', () => {
    const sql = "select a, {{ subject_org() }} as org -- 注释, 含逗号\nfrom t"
    expect(stripSqlNoise(sql)).not.toContain('{{')
    expect(stripSqlNoise(sql)).not.toContain('逗号')
  })
})

describe('firstSelectList', () => {
  it('取第一个顶层 select 到 from 之间的文本（嵌套 from 不算）', () => {
    const sql = 'select a, (select max(x) from y) as m from t where 1=1'
    expect(firstSelectList(sql)?.trim()).toBe('a, (select max(x) from y) as m')
  })
})

describe('parseAliasedExprs', () => {
  it('staging 形态：r[列]::type as 别名', () => {
    const sql = `
      select
        r['bizday']::date as bizday,
        {{ subject_org() }} as org,
        r['sale_money']::numeric(14,2) as sale_money
      from read_parquet('s3://x') r, read_parquet('s3://y') sealed
      where sealed['schema_version'] = 3`
    const exprs = parseAliasedExprs(sql)
    expect(exprs.bizday).toBe("r['bizday']::date")
    expect(exprs.sale_money).toBe("r['sale_money']::numeric(14,2)")
    // Jinja 表达式被剥掉后，别名仍在（值是空 → 该段被丢弃，不产条目）
    expect(exprs.org).toBeUndefined()
  })

  it('marts 形态：聚合表达式带内层逗号', () => {
    const sql = `select system_book, round(sum(detail_sum - order_total_money), 2) as swap_offset,
                        count(*) as swap_orders from per_order group by 1`
    const exprs = parseAliasedExprs(sql)
    expect(exprs.swap_offset).toBe('round(sum(detail_sum - order_total_money), 2)')
    expect(exprs.swap_orders).toBe('count(*)')
    expect(exprs.system_book).toBeUndefined() // 普通列不产条目（= 直通）
  })
})

describe('parseJsonPathSources', () => {
  it('管线 code.sql：湖字段 ← 源 JSON 路径', () => {
    const sql = `SELECT
      CAST(json_extract_string(u.d, '$.item_num') AS VARCHAR) AS item_num,
      json_extract_string(u.d, '$.branch_name') AS branch_name,
      CAST(o.order_no AS VARCHAR) AS order_no
    FROM input o CROSS JOIN UNNEST(...) AS u(d)`
    const src = parseJsonPathSources(sql)
    expect(src.item_num).toBe('$.item_num')
    expect(src.branch_name).toBe('$.branch_name')
    expect(src.order_no).toBe('CAST(o.order_no AS VARCHAR)') // 非 JSON 路径：保留表达式原文（CAST 也是逻辑）
  })
})

describe('parseMeasureExprs（l1_metrics.yml → 度量公式）', () => {
  const yml = `measures:
  sale_amount@order:
    expr: >-
      case when sum(case when state = 'FINISHED' then 1 else 0 end) = 0 then 0
      else sum(sale_money) end
    grain: [order]
    additivity: flow
    unit: CNY
    domain: sale_finished
  order_count:
    expr: 'count(distinct order_no)'
    grain: [order]
`
  it('解析度量名/expr（多行折叠）/grain/unit/domain', () => {
    const m = parseMeasureExprs(yml)
    expect(m['sale_amount@order'].expr).toContain("case when sum(case when state = 'FINISHED'")
    expect(m['sale_amount@order'].expr).toContain('else sum(sale_money) end')
    expect(m['sale_amount@order'].grain).toEqual(['order'])
    expect(m['sale_amount@order'].unit).toBe('CNY')
    expect(m['sale_amount@order'].domain).toBe('sale_finished')
    expect(m['order_count'].expr).toBe('count(distinct order_no)')
  })
  it('坏 YAML / 缺 measures ⇒ {}（不抛）', () => {
    expect(parseMeasureExprs('not: [valid')).toEqual({})
    expect(parseMeasureExprs('')).toEqual({})
  })
})
