- **`date_range` 是类型名，不是键名。** 传 `{"date_range": {"from":…,"to":…}}` 会被服务端 400 `unknown_param:date_range`；
  正确写法是 `{"bizday": {"from":"YYYY-MM-DD","to":"YYYY-MM-DD"}}`（闭区间，单日则 from=to）。
