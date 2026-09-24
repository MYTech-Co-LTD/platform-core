# `models/customers/` — 按客户扩展的约定

`common/` 是**所有客户共用**的域（当前只有乐檬）。本目录放**按客户**分叉的模型（交付/私有化时
某个客户的特有口径、特有源）。目录先建、约定先立——**里面有真模型之前不要建空的客户子目录**
（空目录在 dbt 里没有意义，只会让「这个客户接过没有」变成看不出来的事）。

## 1 目录形态

```
models/customers/
└── <客户标识>/            # 与交付/客户标识一致（如 shanhai）；**小写蛇形**
    ├── staging/           # 该客户特有的源 → 一对一 staging（命名仍受 ④ 机检约束）
    ├── marts/             # 该客户特有的口径模型
    └── schema.yml         # 列描述 + tests
```

- **客户目录里不复制 `common/` 的模型**。要改共用口径 ⇒ 改 `common/`（走 PR，被看见），
  不是在本目录 fork 一份 —— 口径只能有单一定义（layered §7 约束 4）。
- 客户模型引用共用层照旧 `{{ ref('stg_lemeng_retail_order_line') }}`（新湖、**现行**零售 staging；跨目录 ref 在
  dbt 里是正常的）。⚠️ 旧湖的 `stg_lemeng_retail_detail` 仍在仓里（**双轨期保留、待 S4 删**）——**别拿它当范例**：
  它的取列形态在本栈上取列即报错（见 `dbt/README.md` §3 第 1 行）。
- **命名空间用客户标识**：客户特有指标声明为 `<客户标识>:<指标名>`（如 `shanhai:net_sales`），
  与 `common` 域的指标放在同一份声明文件里（`dbt/semantics/l1_metrics.yml`）——
  **同名唯一**是全仓一条规则（静态门禁规则 ⑥），不因为分了目录就放宽。

## 2 加一个客户时要动的东西（同一个 PR，少一件即半接）

| # | 动什么 | 为什么 / 机检 |
|---|---|---|
| 1 | `models/customers/<客户>/staging/sources.yml` 声明源 | 规则 ④ 会要求同名 `stg_<source>_<table>.sql` 存在（双向） |
| 2 | 对应的 staging 模型（手写 cast，含 `r['` 取列） | 规则 ①（cast 规范见 `dbt/README.md` §3） |
| 3 | `marts/` 的口径模型（口径只定义一次） | 纪律，无机检 |
| 4 | `dbt/semantics/l1_metrics.yml` 里声明客户指标（六个必填字段齐全） | 规则 ⑤⑥ |
| 5 | 每个新声明指标一条 `dbt/tests/audit_<指标>.sql`（文件名用 `metricToAuditFileName()` 算，别手写） | 规则 ⑦（含映射无碰撞） |
| 6 | `dbt/README.md` §8「实证 vs 暂定」表补该客户的行 | 否则下一个接手的人分不清哪些是猜的 |

**只加源不加契约与管线 = 半接**：新增数据源的三件套（`contracts/` 采集契约 + `duckle/` 管线 + 本目录 staging）
必须同一个 PR（`docs/architecture.md` §5.1 第 2 条）。该纪律**当前没有静态门禁**，靠评审守。

## 3 私有化交付时的边界

- 客户特有的**路径/桶名/凭据**一律走 env（`profiles.example.yml` 登记的键名 + openship env(isSecret)），
  **不进仓**：本目录的任何文件里不许出现明文凭据（含注释）。
- 客户特有模型若只对某个客户成立，**在那个模型文件头注明**（谁、什么时候、为什么）——
  本目录里「看起来通用其实只对一个客户成立」的模型是最容易伤人的形态。
