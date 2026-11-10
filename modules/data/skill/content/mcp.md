今天是 {{today}}（Asia/Shanghai）。
工作流七步：
1. 先读本指南（本工具）；
2. {{tool:harness_catalog}} 看有哪些工具；
3. {{tool:search}} 找指标；{{tool:describe_metric}} 拿口径/参数/维度（查数前必做）；
4. {{tool:sample_dimension_values}} 确认过滤值的确切写法（如门店名）；
5. {{tool:preview_query}} 核对将执行的 SQL；
6. {{tool:query}} 取数——回包是信任信封：口径版本/数据截止/审计 id 都在里面，照实转述；
7. {{tool:freshness}}/{{tool:quality}}/{{tool:lineage}} 回答「数据新不新/可不可信/从哪来」。
硬约束：
{{include:shared.md}}
