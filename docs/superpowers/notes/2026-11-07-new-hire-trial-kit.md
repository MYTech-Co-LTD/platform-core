# 新人试用包：不动代码接一个采集源（30 分钟）

> **状态**：**待执行**（2026-11-07 备好，等人；追踪 issue #1584）
> **为什么要有它**：P0–P4 那套（manifest → 生成器 → 门禁 → scorecard → 处置计划 → 月度评审）全部是
> **agent 视角**设计并验证的。「新员工能不能自己走完」目前只是推断，没有任何真机样本。
> 这份包只做一件事：**让一个没碰过这套东西的人走一遍，把卡点记下来**。
> **它不是标准**——按团队规矩「无案例不立标准」，跑完 3–5 个人、卡点收敛后，再决定升级成什么。

---

## 1. 试用者的任务（一句话）

> 给你一个接口地址和一份样例响应，**只填一张 JSON（manifest）**，把它接成一条每天自动采集的管线。
> 不许写 SQL、不许改调度文件、不许问实现细节（可以问「这个字段是什么意思」）。

时间盒：**30 分钟**。超时也算结果（记「卡在哪、卡了多久」）。

## 2. 发给试用者的三件东西

| # | 东西 | 说明 |
|---|---|---|
| ① | **本文 §3 的填空指南** | 只讲「每个空填什么」，不讲原理 |
| ② | **一个真实源的样例**（§4） | 接口地址 + 一份真实响应的字段清单（避免卡在「响应长什么样」） |
| ③ | **空白 manifest**（§5） | 直接复制、只改值 |

**不给**：`docs/data-platform-handbook.md`、`source-manifest.md`、任何 skill。那些是给 agent 和评审看的。

## 3. 填空指南（给试用者）

| 要填的 | 一句话问法 | 例子 |
|---|---|---|
| `id` | 这张表叫什么？（`域.表`，小写） | `pilot.my_first_source` |
| `account` | 哪个账套？ | `3120` |
| `source.url` / `method` | 接口地址和方法 | `POST https://.../find` |
| `source.body` | 请求体（**原样贴**，只把页码写 `1`） | 见 §4 |
| `source.responsePath` | 数据在响应的哪个位置 | `/result` |
| `source.schema` | 响应里**每一个**字段的名字和类型 | 见 §4 的字段清单 |
| `source.pagination` | 一次能取完就 `none`；要翻页用 `static_pages` + `pages` | 见 §5 |
| `transform.sql` | 只写 `SELECT <你要的列> FROM input` | `SELECT order_no, order_time FROM input` |
| `sink.key` | 存到哪（照抄例子，改表名） | 见 §5 |
| `schedule.cron` | 每天几点跑（北京时间） | `0 3 * * *` |
| `owner` | 停更多久算异常 | `36h` |

> 三个**必须自己判断**的点（写错了数据就会错，所以要问）：
> 1. **窗口**：`date_from/date_to` 按哪一天？今天还是昨天？
> 2. **分页**：一页最多多少条？一天大概几页？
> 3. **身份**：这个凭据能看到哪些门店/账套？

## 4. 真实源样例（乐檬零售订单）

**接口**：`POST https://cloud.nhsoft.cn/agi/api/nhsoft.retail.ai.pos.posorder.find`
**请求体**：

```json
{"branch_nums": "${ENV:BRANCH_NUMS}", "date_from": "${date+8h}", "date_to": "${date+8h}",
 "time_from": "00:00:00", "time_to": "23:59:59", "page_number": 1, "page_size": 200}
```

**响应里 `result[]` 每行的字段**（10 个，一个不能少——少一个多页合并时会炸）：

```json
[
  {"name": "order_no",             "type": "string"},
  {"name": "state",                "type": "string"},
  {"name": "order_time",           "type": "timestamp"},
  {"name": "order_operate_time",   "type": "timestamp"},
  {"name": "order_source",         "type": "string"},
  {"name": "order_transaction_type","type": "string"},
  {"name": "order_ref_billno",     "type": "string"},
  {"name": "order_total_money",    "type": "float64"},
  {"name": "branch",               "type": "json"},
  {"name": "pos_order_details",    "type": "json"}
]
```

## 5. 空白 manifest（复制后只改值）

```json
{
  "id": "pilot.<你的表名>",
  "domain": "pilot",
  "account": "3120",
  "source": {
    "connectionRef": "lemeng",
    "url": "<接口地址>",
    "method": "POST",
    "headers": { "Content-Type": "application/json" },
    "body": "<请求体，页码写 1>",
    "responsePath": "/result",
    "schema": [ "<§4 那样的字段清单>" ],
    "pagination": { "type": "static_pages", "pages": 3, "pageParam": "page_number",
                    "pageSizeParam": "page_size", "pageSize": 200, "truncationGuard": true },
    "retryAttempts": 2,
    "retryBackoffMs": 2000
  },
  "transform": { "sql": "SELECT <列1>, <列2> FROM input" },
  "gate": { "rules": { "<非空列>": "not_null" } },
  "sink": {
    "type": "minio",
    "connectionRef": "zos",
    "bucket": "${ENV:ZOS_BUCKET}",
    "key": "pilot/<你的表名>/system_book=${ENV:SYSTEM_BOOK}/snapshot=${date+8h}/chunk=seg1.parquet",
    "format": "parquet", "mode": "overwrite", "compression": "zstd"
  },
  "schedule": { "cron": "0 3 * * *", "timezone": "Asia/Shanghai", "enabled": false },
  "owner": { "owner": "data-eng", "match": "minio://*/pilot/<你的表名>/system_book=*/snapshot=*/chunk=*.parquet",
             "maximumAge": "36h" },
  "alerts": { "on": ["failure", "recovery"] }
}
```

## 6. 观察表（我填，不引导试用者）

> **铁律：只记录，不提示。** 试用者卡住时，先等 2 分钟；只有他主动问才回答，回答只答「这个字段是什么意思」，不答「你应该怎么填」。

| 项 | 记录什么 |
|---|---|
| 总耗时 | 从拿到材料到交付 manifest |
| **卡点清单** | 每个卡点：停在第几步 / 停了多久 / 他问了什么 / 我怎么回答的 |
| 需要问的问题数 | 越少越好（0–2 = 指南够用；≥5 = 指南要重写） |
| 字段级误解 | 哪些字段他理解错了（尤其窗口、分页、身份三问） |
| 交付质量 | manifest 一次通过校验？还是要我改几处？改的都在哪 |
| 他的原话 | 「我以为……」这类句子最有价值 |

## 7. 成功判据（三档）

| 档 | 判据 | 含义 |
|---|---|---|
| **通过** | 30 分钟内交付，`check-source-manifests` 一次过，三问都自己答对 | 指南可用 |
| **勉强** | 交付了，但要我改 1–2 处 / 三问里错 1 个 | 指南要补该处 |
| **不通过** | 超时 / 卡死 / 三问错 ≥2 | 设计问题，不是人的问题 |

**补充判据（比「能不能填完」更重要）**：填完之后，他能不能**自己说清楚**「这条管线什么时候跑、跑哪一天的数据、错了会怎样」。

## 8. 跑完之后做什么

1. 卡点按频次排序 → 前 3 名改写指南（不是加文档，是**改问法**）；
2. 如果 3 个人里有 2 个卡在同一处 ⇒ 那是设计缺陷，回改 manifest 字段或生成器，别只改文档；
3. 卡点收敛后再谈「升级成标准」——现在这份只是试用包。

## 9. 我（agent）在这件事里的角色

- 准备材料、搭环境、跑 `gen-pipeline` / `validate` / canary、记录观察；
- **不代填 manifest**（代填就失去意义）；
- 试用结束后：把卡点整理成上面的观察表 + 提改进 PR。
