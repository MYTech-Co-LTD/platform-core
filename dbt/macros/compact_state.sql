{% macro compact_state(source) %}
{#
  湖封版分区压缩的**编译期状态**（C 设计 §5）：返回 {enabled, sha, boundary}。

  为什么在编译期查库：两腿视图的活跃腿必须是**字面量下界**（`date 'YYYY-MM-01'`）——
  写成子查询会让 pg_duckdb 放弃文件裁剪（同族实测 >120s）；而边界每个月才前进一次，
  而 `tables` 档每天重建视图 ⇒ 编译期取一次完全够。

  失效方向（安全侧）：
    · 表不存在 / 无行 / 契约 sha 取不到 ⇒ enabled=false，视图退化为**单腿读原始**（慢但正确）；
    · 有行但边界月文件缺失 ⇒ 冷腿读到 0 行会丢数据 —— 所以边界取的是**索引里最大的整数月**，
      而索引只由记账 job 在验过行数后写入（见 scripts/lemeng/lake-compact-index.mjs）。

  用法（模型里）：
    {% set cs = compact_state('business_collection_receive') %}
    ... {%% if cs.enabled %%} 冷腿 ... {%% endif %%}
    ... 活跃腿 where r['bizday']::date >= date '{{ cs.boundary }}'
#}
  {% set res = {'enabled': false, 'sha': '', 'boundary': '1900-01-01', 'tail_prefix': ''} %}
  {% if execute %}
    {% set q %}
      select contract_sha, max(ym) as ym
        from data.lake_compact_index
       where source = '{{ source }}' and status = 'ok'
       group by 1
       order by ym desc
       limit 1
    {% endset %}
    {% set rows = run_query(q).rows %}
    {% if rows | length > 0 and rows[0][0] and rows[0][1] %}
      {% set ym = rows[0][1] %}
      {% set y = ym[0:4] | int %}
      {% set m = ym[5:7] | int %}
      {% set ny = y + 1 if m == 12 else y %}
      {% set nm = 1 if m == 12 else m + 1 %}
      {% set tail = '%04d-%02d' | format(ny, nm) %}
      {% do res.update({
        'enabled': true,
        'sha': rows[0][0],
        'boundary': ym ~ '-01',
        'tail_prefix': tail,
      }) %}
    {% endif %}
  {% endif %}
  {{ return(res) }}
{% endmacro %}
