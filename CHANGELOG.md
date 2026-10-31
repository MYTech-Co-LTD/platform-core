# Changelog

> 本文件记录 platform-core 的**行为变化**（新增 / 修复 / 优化 / 破坏），按
> [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 维护，行内用
> **【新增】/【优化】/【修复】** 标注类型（公司开发纪律：可见变更必须有 CHANGELOG 行内标注）。
>
> **本文件自 M0 Task 22 起建立**：它由「部署面」这一任务新建（此前仓里没有任何 CHANGELOG 文件）。
> M0 的 Task 1–21（脚手架、auth-core、SDK、模块协议、宿主装配、console 壳、门禁与冒烟）在
> 本文件里**不追述**——历史可从 `git log --oneline --reverse` 逐条追溯，事后补写只会写出
> 一份与提交历史不同源的第二事实。是否回填留给 M1 计划决定。

## [Unreleased]

## [0.223.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.223.0...v0.223.1) - 2026-10-31
- 【修复】scripts: notify-worker 的 map 回调补 JSDoc 类型（gates typecheck:scripts 红） ([#1210](https://github.com/MYTech-Co-LTD/platform-core/pull/1210), [d241d7a](https://github.com/MYTech-Co-LTD/platform-core/commit/d241d7aed9ba1dc929ee284f036173ea828a60cd))


## [0.223.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.222.4...v0.223.0) - 2026-10-31
- 【新增】platform: 集成健康 Phase 2b——STALE 事件 + 装填位 + worker 消费 (#1208) ([#1209](https://github.com/MYTech-Co-LTD/platform-core/pull/1209), [e051b04](https://github.com/MYTech-Co-LTD/platform-core/commit/e051b04065132512c4bfc9609f005c8ff70163af))


## [0.222.4](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.222.3...v0.222.4) - 2026-10-31
- 【修复】platform: app.ts 的 registry 内联路径替换静默失败（#1205 补第二刀） ([#1207](https://github.com/MYTech-Co-LTD/platform-core/pull/1207), [337afc8](https://github.com/MYTech-Co-LTD/platform-core/commit/337afc8e7bee438c521b9b52dab0427070d76027))


## [0.222.3](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.222.2...v0.222.3) - 2026-10-31
- 【修复】data: 量级审计哨兵分支补齐 8 列（#1198） ([#1204](https://github.com/MYTech-Co-LTD/platform-core/pull/1204), [c4d26be](https://github.com/MYTech-Co-LTD/platform-core/commit/c4d26bec306e7aad7bb81675f209b7dafe7d4cfd))


## [0.222.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.222.1...v0.222.2) - 2026-10-31
- 【修复】platform: 集成探针 registry 路径少一层 ../（生产 ENOENT 空转）(#1205) ([#1206](https://github.com/MYTech-Co-LTD/platform-core/pull/1206), [7388693](https://github.com/MYTech-Co-LTD/platform-core/commit/73886932b9095a233b751ee9971e241ff9798d41))


## [0.222.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.222.0...v0.222.1) - 2026-10-31
- 【修复】data: 量级审计骤降判据两档化（#1198） ([#1203](https://github.com/MYTech-Co-LTD/platform-core/pull/1203), [9f401a2](https://github.com/MYTech-Co-LTD/platform-core/commit/9f401a23a7dc2bec7dc00c6bc3b0ed5a620b469b))


## [0.222.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.221.0...v0.222.0) - 2026-10-31
- 【新增】platform: 集成健康 Phase 2a——探针编排 + registry + 触发通路 (#1201) ([#1202](https://github.com/MYTech-Co-LTD/platform-core/pull/1202), [2ac32b5](https://github.com/MYTech-Co-LTD/platform-core/commit/2ac32b5d81a557c3e1265ba8dd1367d2d1fb8f8d))


## [0.221.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.220.0...v0.221.0) - 2026-10-31
- 【新增】data: 批发明细下钻——直读湖视图 + 指标三键（#1182） ([#1200](https://github.com/MYTech-Co-LTD/platform-core/pull/1200), [a33150d](https://github.com/MYTech-Co-LTD/platform-core/commit/a33150d15b29cfa71f8bb81aa4003e1a1a31204b))


## [0.220.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.219.3...v0.220.0) - 2026-10-31
- 【新增】platform: 集成健康 Phase 1——登记表 + 判据纯函数 + 读面 + 控制台一屏 (#1194) ([#1197](https://github.com/MYTech-Co-LTD/platform-core/pull/1197), [112ad13](https://github.com/MYTech-Co-LTD/platform-core/commit/112ad1382c49f96900b133af7982c09ef836c5ca))


## [0.219.3](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.219.2...v0.219.3) - 2026-10-31
- 【修复】data: 空 seed 列类型显式 cast（#1181） ([#1195](https://github.com/MYTech-Co-LTD/platform-core/pull/1195), [4d5a837](https://github.com/MYTech-Co-LTD/platform-core/commit/4d5a83751d5a11f8dae4452ad57ea92c6b4cfc21))


## [0.219.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.219.1...v0.219.2) - 2026-10-31
- 【修复】data: 零售 sale_money 契约闸放宽到 ±1000 万，容纳取消单占位值 (#1191) ([#1192](https://github.com/MYTech-Co-LTD/platform-core/pull/1192), [5377281](https://github.com/MYTech-Co-LTD/platform-core/commit/537728180920f043bff271853e932f2505a5d2e3))


## [0.219.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.219.0...v0.219.1) - 2026-10-30
- 【修复】notify: 未配置通道可见 + 部门选择器合一 + flaky 测试 (#1187, #1184) ([#1188](https://github.com/MYTech-Co-LTD/platform-core/pull/1188), [1351981](https://github.com/MYTech-Co-LTD/platform-core/commit/1351981dcc397bb1d2fef92be40d6cb0ad5eef0b))


## [0.219.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.218.3...v0.219.0) - 2026-10-30
- 【新增】data: 战区出库面——客户维 + 三分列 + 指标（#1181） ([#1186](https://github.com/MYTech-Co-LTD/platform-core/pull/1186), [e70066b](https://github.com/MYTech-Co-LTD/platform-core/commit/e70066ba0e41ac2902f790b3896fbabec497ed4e))


## [0.218.3](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.218.2...v0.218.3) - 2026-10-30
- 【修复】notify: resolveScopeHolders 收的是收件人档名，不是权限码（#1179 补） ([#1185](https://github.com/MYTech-Co-LTD/platform-core/pull/1185), [2739918](https://github.com/MYTech-Co-LTD/platform-core/commit/2739918b0369a7557fcbde7798bda2fa856d43b9))


## [0.218.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.218.1...v0.218.2) - 2026-10-30
- 【修复】notify: 控制台预检认 scope_holders——宿主地址解析器实现 resolveScopeHolders (#1179) ([#1180](https://github.com/MYTech-Co-LTD/platform-core/pull/1180), [77a67cf](https://github.com/MYTech-Co-LTD/platform-core/commit/77a67cf2d0e04a76b863616f3f9ee56c3a2b4195))


## [0.218.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.218.0...v0.218.1) - 2026-10-30
- 【修复】console: 部门树默认只展开第一层 + 限高滚动 (#1177) ([#1178](https://github.com/MYTech-Co-LTD/platform-core/pull/1178), [b230ca5](https://github.com/MYTech-Co-LTD/platform-core/commit/b230ca5c00eeb36e523ab85eafd17fdf79ae53cc))


## [0.218.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.217.0...v0.218.0) - 2026-10-30
- 【新增】notify: 推送部门接收人——发送时展开 + 审计三数 (#1174) ([#1176](https://github.com/MYTech-Co-LTD/platform-core/pull/1176), [1c8d7e2](https://github.com/MYTech-Co-LTD/platform-core/commit/1c8d7e2c7bf16b17a94193b6a05cf1ba5280f4c5))


## [0.217.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.216.0...v0.217.0) - 2026-10-30
- 【新增】data: 报表部门门——按组织架构子树授权可见性 (#1173) ([#1175](https://github.com/MYTech-Co-LTD/platform-core/pull/1175), [6bfbbfe](https://github.com/MYTech-Co-LTD/platform-core/commit/6bfbbfebb9812a022baa3dfff45ebe32329a8c89))


## [0.216.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.215.2...v0.216.0) - 2026-10-30
- 【新增】platform: 组织架构 Phase A——org 表 + 同步器 + 组织树切源 (#1171) ([#1172](https://github.com/MYTech-Co-LTD/platform-core/pull/1172), [674bda9](https://github.com/MYTech-Co-LTD/platform-core/commit/674bda981e4d0c9c1ca652c49be3dd42321ec61c))


## [0.215.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.215.1...v0.215.2) - 2026-10-30
- 【修复】data: 零售整天重采容量溢出变体（160 页 hp），春节峰日停机的出路 (#1168) ([#1169](https://github.com/MYTech-Co-LTD/platform-core/pull/1169), [ba38397](https://github.com/MYTech-Co-LTD/platform-core/commit/ba383975df63bae93a0a99e72d742be3a641dc0f))


## [0.215.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.215.0...v0.215.1) - 2026-10-29
- 【修复】data: 回填驱动超时 180s→600s，submit 超时改按 run 记录判真伪 (#1166) ([#1167](https://github.com/MYTech-Co-LTD/platform-core/pull/1167), [b43b6dd](https://github.com/MYTech-Co-LTD/platform-core/commit/b43b6ddc0d2236b9925cd32cbdf49a427cd45bdb))


## [0.215.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.214.1...v0.215.0) - 2026-10-29
- 【新增】data: 通用历史回填驱动（逐日串行 + 湖侧行数回读）(#1164) ([#1165](https://github.com/MYTech-Co-LTD/platform-core/pull/1165), [92dd3ee](https://github.com/MYTech-Co-LTD/platform-core/commit/92dd3eec65305bbdc0e366fe2a00a2c1a19ca498))


## [0.214.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.214.0...v0.214.1) - 2026-10-29
- 【修复】data: 回填驱动从 console 容器取 S3 凭据注入删热分区步骤 (#1162) ([#1163](https://github.com/MYTech-Co-LTD/platform-core/pull/1163), [38bd379](https://github.com/MYTech-Co-LTD/platform-core/commit/38bd3799c573df00e8dc79e6d132baf7cebd3cc8))


## [0.214.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.213.5...v0.214.0) - 2026-10-29
- 【新增】data: 补齐全量历史回填变体（13 个，双账套）(#1160) ([#1161](https://github.com/MYTech-Co-LTD/platform-core/pull/1161), [1ecd907](https://github.com/MYTech-Co-LTD/platform-core/commit/1ecd9077042c17010539162829ff8ebe39db9799))


## [0.213.5](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.213.4...v0.213.5) - 2026-10-28
- 【修复】dbt: 小时行数对账热腿排除今天，止住读热分区撞 ETag (#452) ([#1159](https://github.com/MYTech-Co-LTD/platform-core/pull/1159), [d442aed](https://github.com/MYTech-Co-LTD/platform-core/commit/d442aed11e55385bd5b9e7da89b96fa97b198ef2))


## [0.213.4](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.213.3...v0.213.4) - 2026-10-28
- 【修复】data: pg_duckdb mem_limit 2g→4g + dbt 物化串行化，止住崩溃恢复 (#1157) ([#1158](https://github.com/MYTech-Co-LTD/platform-core/pull/1158), [2838d3d](https://github.com/MYTech-Co-LTD/platform-core/commit/2838d3da3af86edfd86678d1066d5b77fa634767))


## [0.213.3](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.213.2...v0.213.3) - 2026-10-28
- 【修复】dbt: 补 union 哨兵行的 tolerance 列，修列错位 (#761) ([#1156](https://github.com/MYTech-Co-LTD/platform-core/pull/1156), [ca1c941](https://github.com/MYTech-Co-LTD/platform-core/commit/ca1c941716e21a1476cd7e4ef01ccfc398fcce99))


## [0.213.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.213.1...v0.213.2) - 2026-10-28
- 【修复】dbt: net_sales 对账改 1 分容差并把容差作为数据列 (#761) ([#1155](https://github.com/MYTech-Co-LTD/platform-core/pull/1155), [265e4b5](https://github.com/MYTech-Co-LTD/platform-core/commit/265e4b53ecf9c55548d13188710c0ee27ae3eebc))


## [0.213.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.213.0...v0.213.1) - 2026-10-28
- 【修复】dbt: 对账复算禁用裸 ::numeric（pg_duckdb 推成 DOUBLE 致 1 分假红，修 #761） ([#1154](https://github.com/MYTech-Co-LTD/platform-core/pull/1154), [56a349b](https://github.com/MYTech-Co-LTD/platform-core/commit/56a349b5e0269f1ab712c12c19ad00d0eebbb525))


## [0.213.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.212.0...v0.213.0) - 2026-10-28
- 【新增】data: 加成本覆盖率与零成本可复核清单 (#816) ([#1148](https://github.com/MYTech-Co-LTD/platform-core/pull/1148), [17fbdd1](https://github.com/MYTech-Co-LTD/platform-core/commit/17fbdd14709c570d2304380aa222d0d0d381f91c))


## [0.212.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.211.0...v0.212.0) - 2026-10-28
- 【新增】notify: 可送达性 D3+D4——配置期预检与 agent 自证 ([#1147](https://github.com/MYTech-Co-LTD/platform-core/pull/1147), [ab911b9](https://github.com/MYTech-Co-LTD/platform-core/commit/ab911b9e267608dacb5f38376e4291652d5d21a6))


## [0.211.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.210.4...v0.211.0) - 2026-10-28
- 【新增】notify: 可送达性 D1+D2——零结果成为状态并可告警 ([#1145](https://github.com/MYTech-Co-LTD/platform-core/pull/1145), [f40e420](https://github.com/MYTech-Co-LTD/platform-core/commit/f40e420b16fab81e784d1a2a8e4b8f068ae391cc))


## [0.210.4](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.210.3...v0.210.4) - 2026-10-28
- 【修复】auth: 登录审计 via 改白名单映射——未知/丢失不再冒充扫码 (#1139) ([#1143](https://github.com/MYTech-Co-LTD/platform-core/pull/1143), [e76afcb](https://github.com/MYTech-Co-LTD/platform-core/commit/e76afcbff42e5e0fa9258a57ad94ab96a483a35c))


## [0.210.3](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.210.2...v0.210.3) - 2026-10-28
- 【修复】data: item_price 生成器日常模式改按门店批扇出 + 补 to_json 归一 (#1073) ([#1140](https://github.com/MYTech-Co-LTD/platform-core/pull/1140), [18a2a09](https://github.com/MYTech-Co-LTD/platform-core/commit/18a2a09eed5943ede255a1007a4e49fb94dbfb68))


## [0.210.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.210.1...v0.210.2) - 2026-10-27
- 【修复】notify: worker 起只读 /healthz，镜像探活不再恒 unhealthy ([#1133](https://github.com/MYTech-Co-LTD/platform-core/pull/1133), [d3455d4](https://github.com/MYTech-Co-LTD/platform-core/commit/d3455d45db5de1e9abaf39401a8410d7bcfb26eb))


## [0.210.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.210.0...v0.210.1) - 2026-10-27
- 【修复】notify: notify-worker 用自己的心跳做健康检查（不再继承 HTTP 探活） ([#1132](https://github.com/MYTech-Co-LTD/platform-core/pull/1132), [911762c](https://github.com/MYTech-Co-LTD/platform-core/commit/911762c356b4db8290df4f750729b08b7e704851))


## [0.210.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.209.0...v0.210.0) - 2026-10-27
- 【新增】notify: scope_holders 真正解析（Casdoor 直挂 ∪ 角色展开） ([#1130](https://github.com/MYTech-Co-LTD/platform-core/pull/1130), [5a2de8a](https://github.com/MYTech-Co-LTD/platform-core/commit/5a2de8a8d13baaf72bc710118c6d22d926da0e7b))


## [0.209.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.208.0...v0.209.0) - 2026-10-27
- 【新增】notify: P3 收口——webhook 通道/限流/健康/保留期 ([#1126](https://github.com/MYTech-Co-LTD/platform-core/pull/1126), [033a466](https://github.com/MYTech-Co-LTD/platform-core/commit/033a4662f213e989301262a6a6b41e53a87d21f4))


## [0.208.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.207.0...v0.208.0) - 2026-10-27
- 【新增】notify: P2 产品面——模板/通道/console 六区/agent MCP ([#1124](https://github.com/MYTech-Co-LTD/platform-core/pull/1124), [e8af293](https://github.com/MYTech-Co-LTD/platform-core/commit/e8af2939d69537c2630e749a5598c310c7d6d4f4))


## [0.207.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.206.8...v0.207.0) - 2026-10-27
- 【新增】notify: 租户级通知基础设施（P0+P1） ([#1120](https://github.com/MYTech-Co-LTD/platform-core/pull/1120), [0003a54](https://github.com/MYTech-Co-LTD/platform-core/commit/0003a546c839ed8743bb638e4fe19dd04f190757))


## [0.206.8](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.206.7...v0.206.8) - 2026-10-27
- 【修复】ops: 权限持有者审计脚本展开角色授权 ([#1122](https://github.com/MYTech-Co-LTD/platform-core/pull/1122), [08e6984](https://github.com/MYTech-Co-LTD/platform-core/commit/08e69841806ee580e2701976f76b7c69e5c83e0e))


## [0.206.7](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.206.6...v0.206.7) - 2026-10-27
- 【修复】auth: 权限体系加固（JIT 零授权 / platformOnly / 禁用失效 / 订阅源 fail-closed） ([#1118](https://github.com/MYTech-Co-LTD/platform-core/pull/1118), [9a12fc1](https://github.com/MYTech-Co-LTD/platform-core/commit/9a12fc11b8f6ee4cc894517b441bb0cd00bf00a5))


## [0.206.6](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.206.5...v0.206.6) - 2026-10-27
- 【修复】data: 回退标签改「数据摘要」+ 提示词 v5 负数示例 (#1115) ([#1116](https://github.com/MYTech-Co-LTD/platform-core/pull/1116), [d1765c6](https://github.com/MYTech-Co-LTD/platform-core/commit/d1765c6994bc4dd547c12bac8f1597564fc1695a))


## [0.206.5](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.206.4...v0.206.5) - 2026-10-27
- 【修复】data: 提示词 narrative-v4，数字逐字复制 + temperature=0 (#1113) ([#1114](https://github.com/MYTech-Co-LTD/platform-core/pull/1114), [eebcab2](https://github.com/MYTech-Co-LTD/platform-core/commit/eebcab23c80cb9a4b2a1be5241b5bd7005b0a854))


## [0.206.4](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.206.3...v0.206.4) - 2026-10-27
- 【修复】data: SSE 增量校验在日期分块边界误判 (#1111) ([#1112](https://github.com/MYTech-Co-LTD/platform-core/pull/1112), [fc5ede5](https://github.com/MYTech-Co-LTD/platform-core/commit/fc5ede5b566e8b2af5a53dd3868cbfe2cea474a5))


## [0.206.3](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.206.2...v0.206.3) - 2026-10-27
- 【修复】data: 裸年份（2026 10月21日）也抹掉，修近7天仍回退 (#1109) ([#1110](https://github.com/MYTech-Co-LTD/platform-core/pull/1110), [80ea863](https://github.com/MYTech-Co-LTD/platform-core/commit/80ea863888671e9a4daddfa4a999c62dfb00194c))


## [0.206.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.206.1...v0.206.2) - 2026-10-27
- 【修复】data: 数字校验补齐「2026年」/空格/点号日期，修近7天回退模板 (#1107) ([#1108](https://github.com/MYTech-Co-LTD/platform-core/pull/1108), [deb3b31](https://github.com/MYTech-Co-LTD/platform-core/commit/deb3b31091a91ded161ed1ebb26925af9ae50909))


## [0.206.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.206.0...v0.206.1) - 2026-10-27
- 【修复】data: AI 文本缓存 GC 与同事实单飞 (#1105) ([#1106](https://github.com/MYTech-Co-LTD/platform-core/pull/1106), [a009383](https://github.com/MYTech-Co-LTD/platform-core/commit/a009383e0fc1635108d0d3c480fc90c3425cf5d5))


## [0.206.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.205.3...v0.206.0) - 2026-10-27
- 【新增】data: table 面板支持 columns 渲染投影，收口连续无业绩天数明细 (#1094) ([#1103](https://github.com/MYTech-Co-LTD/platform-core/pull/1103), [4a056ff](https://github.com/MYTech-Co-LTD/platform-core/commit/4a056ffc4b8a4d8af0782ac5d943ad5736eb39a6))


## [0.205.3](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.205.2...v0.205.3) - 2026-10-27
- 【修复】data: recon 改读封版天文件，修 T-3 永久缺失 ([#1100](https://github.com/MYTech-Co-LTD/platform-core/pull/1100), [356206f](https://github.com/MYTech-Co-LTD/platform-core/commit/356206f7563f3a2f2609b54e6043eaa89741bd89))


## [0.205.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.205.1...v0.205.2) - 2026-10-27
- 【修复】data: 64188 库存快照扩容到 90 数据页 ([#1098](https://github.com/MYTech-Co-LTD/platform-core/pull/1098), [7682488](https://github.com/MYTech-Co-LTD/platform-core/commit/7682488a12e08a2d2dde554bd6e8811e64ee238a))


## [0.205.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.205.0...v0.205.1) - 2026-10-27
- 【修复】data: AI 文本 P2——明细不进事实包/格式跟随 KPI/探测去重 (#1093) ([#1095](https://github.com/MYTech-Co-LTD/platform-core/pull/1095), [3669ba6](https://github.com/MYTech-Co-LTD/platform-core/commit/3669ba6c89819b936b4bf05f15e25411798c4521))


## [0.205.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.204.6...v0.205.0) - 2026-10-27
- 【新增】data: 64188 补采八类数据源（批发/配送明确不采） ([#1092](https://github.com/MYTech-Co-LTD/platform-core/pull/1092), [fe5f102](https://github.com/MYTech-Co-LTD/platform-core/commit/fe5f10263700b1e185350a1bd46974a0d49ab4cc))


## [0.204.6](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.204.5...v0.204.6) - 2026-10-27
- 【修复】data: 门店号/门店名数字进 AI 文本数字白名单 (#1089) ([#1090](https://github.com/MYTech-Co-LTD/platform-core/pull/1090), [79b8c89](https://github.com/MYTech-Co-LTD/platform-core/commit/79b8c899d3ac3fe24376d9e8d9c9433540062947))


## [0.204.5](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.204.4...v0.204.5) - 2026-10-27
- 【修复】data: AI 文本门店归属/标题跟随/费用净额/空态/KPI 原因 (#1085) ([#1088](https://github.com/MYTech-Co-LTD/platform-core/pull/1088), [d52ed31](https://github.com/MYTech-Co-LTD/platform-core/commit/d52ed31f93411a87e14c2cce4446e2657fd5e814))


## [0.204.4](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.204.3...v0.204.4) - 2026-10-27
- 【修复】data: 补 4 条湖侧新鲜度锚，堵停更无告警的 unknown 盲区 (#1086) ([#1087](https://github.com/MYTech-Co-LTD/platform-core/pull/1087), [2a331c2](https://github.com/MYTech-Co-LTD/platform-core/commit/2a331c2eeab9df3423fe12b29155fdc7b6e009e7))


## [0.204.3](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.204.2...v0.204.3) - 2026-10-27
- 【修复】data: AI 文本回退模板（中文日期误判/Date 串/回退缓存） (#1083) ([#1084](https://github.com/MYTech-Co-LTD/platform-core/pull/1084), [71b443c](https://github.com/MYTech-Co-LTD/platform-core/commit/71b443c5999ee2a68a0db7d47b6fed05128acab6))


## [0.204.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.204.1...v0.204.2) - 2026-10-26
- 【修复】data: 环比按数据覆盖度判定，对比期覆盖不足不出对比 ([#1080](https://github.com/MYTech-Co-LTD/platform-core/pull/1080), [d661d2e](https://github.com/MYTech-Co-LTD/platform-core/commit/d661d2e5be06cec094ce41f4a86cb0f95850b362))


## [0.204.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.204.0...v0.204.1) - 2026-10-26
- 【修复】data: 库存快照窗口退回 T-2 并加每日 T-3 兜底，修 7 天 35 轮空集 ([#1079](https://github.com/MYTech-Co-LTD/platform-core/pull/1079), [274e216](https://github.com/MYTech-Co-LTD/platform-core/commit/274e2160d9419e5cc5e7940cbdaa233c1e362c9e))


## [0.204.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.203.4...v0.204.0) - 2026-10-26
- 【新增】data: AI 文本组件 ai_text（流式生成 + 缓存） ([#1077](https://github.com/MYTech-Co-LTD/platform-core/pull/1077), [8c60d86](https://github.com/MYTech-Co-LTD/platform-core/commit/8c60d8661b059fe587d719f45cc35ba41b1a6711))


## [0.203.4](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.203.3...v0.203.4) - 2026-10-26
- 【修复】data: item_price staging 去重改内联 not exists，修 qualify 在 CTAS 外壳下解析失败 (#1071) ([#1074](https://github.com/MYTech-Co-LTD/platform-core/pull/1074), [40af834](https://github.com/MYTech-Co-LTD/platform-core/commit/40af834195993c2bbe8b00b78c3ff158638d23e7))


## [0.203.3](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.203.2...v0.203.3) - 2026-10-26
- 【修复】data: item_price staging 按事件键去重，修同日多轮重取导致的唯一性断言红 (#1071) ([#1072](https://github.com/MYTech-Co-LTD/platform-core/pull/1072), [de8702c](https://github.com/MYTech-Co-LTD/platform-core/commit/de8702c8c2599bad1f5be50b3fd2eb74f4f546aa))


## [0.203.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.203.1...v0.203.2) - 2026-10-26
- 【修复】data: item_price sink 按 run 分化目录，修同日多轮互相覆盖 (#1069) ([#1070](https://github.com/MYTech-Co-LTD/platform-core/pull/1070), [919257a](https://github.com/MYTech-Co-LTD/platform-core/commit/919257a3308f0cef088f6c38b8895961890a419b))


## [0.203.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.203.0...v0.203.1) - 2026-10-26
- 【修复】data: item_price 分页嵌套类型逐页 to_json 归一，修 10-23 起断供 ([#1068](https://github.com/MYTech-Co-LTD/platform-core/pull/1068), [20dbb3b](https://github.com/MYTech-Co-LTD/platform-core/commit/20dbb3b206777f2448b61b26f30481e31d678ecb))


## [0.203.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.202.1...v0.203.0) - 2026-10-26
- 【新增】data: 月度报表 B+C、版本管理与独立链接 ([#1066](https://github.com/MYTech-Co-LTD/platform-core/pull/1066), [7109da1](https://github.com/MYTech-Co-LTD/platform-core/commit/7109da14301635764f8d454b71c9a0c0a3100da1))


## [0.202.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.202.0...v0.202.1) - 2026-10-26
- 【修复】data: fct_branch_indicator 入口把 system_book 转 varchar，构件面归一 (#1047) ([#1064](https://github.com/MYTech-Co-LTD/platform-core/pull/1064), [8743f1f](https://github.com/MYTech-Co-LTD/platform-core/commit/8743f1ff669311fc79919534a74b1a4d13c2f5b9))


## [0.202.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.201.0...v0.202.0) - 2026-10-26
- 【新增】data: 配送金额 L1 语义层——fct_branch_indicator + 对账测试 + 词表条目 (#1047) ([#1063](https://github.com/MYTech-Co-LTD/platform-core/pull/1063), [5aea455](https://github.com/MYTech-Co-LTD/platform-core/commit/5aea4551e4e834420a3ad0cd52493fee58f598fe))


## [0.201.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.200.2...v0.201.0) - 2026-10-26
- 【新增】data: 乐檬 D10 门店指标日采集收口——契约+调度+新鲜度锚+回填变体 ([#1062](https://github.com/MYTech-Co-LTD/platform-core/pull/1062), [0408bcf](https://github.com/MYTech-Co-LTD/platform-core/commit/0408bcf5c81231fa206ed5d3e7cf3a1ebc753a53))


## [0.200.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.200.1...v0.200.2) - 2026-10-26
- 【修复】data: 会员汇总全店采集——summary_types 含 branch 等五处根因 ([#1061](https://github.com/MYTech-Co-LTD/platform-core/pull/1061), [a589b44](https://github.com/MYTech-Co-LTD/platform-core/commit/a589b444b586168903a9ea9bf00d164e6d4e8fd2))


## [0.200.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.200.0...v0.200.1) - 2026-10-26
- 【修复】auth: 深链登录回跳丢查询串——三层 next 透传（SDK/静默/回调） ([#1060](https://github.com/MYTech-Co-LTD/platform-core/pull/1060), [7432b85](https://github.com/MYTech-Co-LTD/platform-core/commit/7432b8564446538ad9c1d29883f0e8b7ff65e406))


## [0.200.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.199.1...v0.200.0) - 2026-10-26
- 【新增】data: 报表列表深链 ?open=<id>——列表就绪后自动打开自绘报表 (#1047) ([#1059](https://github.com/MYTech-Co-LTD/platform-core/pull/1059), [05b42bb](https://github.com/MYTech-Co-LTD/platform-core/commit/05b42bbf3eccb0f1081ad7bdf23a182a9ad14ec3))


## [0.199.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.199.0...v0.199.1) - 2026-10-26
- 【修复】data: 会员管线 w0 换 /agi/mcp + gate 放宽 order_sale_type——数据机实测五处修复回仓 (#1047) ([#1058](https://github.com/MYTech-Co-LTD/platform-core/pull/1058), [fb51bcb](https://github.com/MYTech-Co-LTD/platform-core/commit/fb51bcbeec47c2c8cac140cd908c340ed685423b))


## [0.199.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.198.0...v0.199.0) - 2026-10-26
- 【新增】data: 会员汇总全店采集——三批静态 branch_nums + BIZDAY 参数化回填管线 (#1047) ([#1056](https://github.com/MYTech-Co-LTD/platform-core/pull/1056), [b01c2da](https://github.com/MYTech-Co-LTD/platform-core/commit/b01c2da8c448af5fa964a0051c01e100128c79ce))


## [0.198.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.197.3...v0.198.0) - 2026-10-26
- 【新增】data: 报表页筛选栏——日期范围+门店下拉，覆盖 args 重查全面板 (#1047) ([#1055](https://github.com/MYTech-Co-LTD/platform-core/pull/1055), [6cebb2c](https://github.com/MYTech-Co-LTD/platform-core/commit/6cebb2cd8747430ee329e322ebb5c5f40eddaae2))


## [0.197.3](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.197.2...v0.197.3) - 2026-10-26
- 【修复】data: 报表表格卡窄屏横向滚动——overflowX+scroll.x 收敛在卡内，不再撑破页面 (#1047) ([#1054](https://github.com/MYTech-Co-LTD/platform-core/pull/1054), [fed555b](https://github.com/MYTech-Co-LTD/platform-core/commit/fed555b3779a7dc597de514a74bf4f08eb457545))


## [0.197.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.197.1...v0.197.2) - 2026-10-26
- 【修复】data: 报表面板参数面对齐——branch_num 进白名单 + args 放行 {from,to} 日期窗 (#1047) ([#1053](https://github.com/MYTech-Co-LTD/platform-core/pull/1053), [0dbb2ef](https://github.com/MYTech-Co-LTD/platform-core/commit/0dbb2eff12ab709dfdf52766d62989d0a41ec0aa))


## [0.197.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.197.0...v0.197.1) - 2026-10-25
- 【修复】web: 企微免登改跳服务端 /silent——客户端拼 Casdoor authorize 必 BAD_STATE 且 unused 变量挡构建 (#1047) ([#1051](https://github.com/MYTech-Co-LTD/platform-core/pull/1051), [b794c24](https://github.com/MYTech-Co-LTD/platform-core/commit/b794c24e7647997ca853c340c998bd84f0b10146))


## [0.197.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.196.1...v0.197.0) - 2026-10-25
- 【新增】web: 企微内自动静默免登——登录页 wxwork UA 自动跳企微授权 (#1047) ([#1050](https://github.com/MYTech-Co-LTD/platform-core/pull/1050), [ab564c7](https://github.com/MYTech-Co-LTD/platform-core/commit/ab564c799617a11917143e899be41614d84435f5))


## [0.196.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.196.0...v0.196.1) - 2026-10-25
- 【修复】data: 报损/会员 staging 四重大括号热修——lemeng 域物化冻结恢复 (#1047) ([#1049](https://github.com/MYTech-Co-LTD/platform-core/pull/1049), [871320c](https://github.com/MYTech-Co-LTD/platform-core/commit/871320c0dec478d0eac1b587c932f244dd2d5ab6))


## [0.196.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.195.2...v0.196.0) - 2026-10-25
- 【新增】data: 熊喵月度报告数据面补齐——费用回填+报损调整单采集与语义层 (#1047) ([#1048](https://github.com/MYTech-Co-LTD/platform-core/pull/1048), [9a18d3a](https://github.com/MYTech-Co-LTD/platform-core/commit/9a18d3a80df99dc06e773b54f52d691bb364901b))


## [0.195.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.195.1...v0.195.2) - 2026-10-25
- 【修复】data: item_price schema 申报 branch/pos_variant type json→string——提示文本行不再炸在上游解析 ([#1046](https://github.com/MYTech-Co-LTD/platform-core/pull/1046), [ce80f82](https://github.com/MYTech-Co-LTD/platform-core/commit/ce80f8246a5f4c4e90e2d0cf079142129c876a53))


## [0.195.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.195.0...v0.195.1) - 2026-10-24
- 【修复】data: item_price 批量节点 merge 入边 targetHandle 补唯一序号（ctl.merge 单端口多入需 main_N） ([#1042](https://github.com/MYTech-Co-LTD/platform-core/pull/1042), [ea12c8d](https://github.com/MYTech-Co-LTD/platform-core/commit/ea12c8da50f6871991f778a11e4c9cafbc329afb))


## [0.195.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.194.0...v0.195.0) - 2026-10-24
- 【新增】data: apply_pipeline_proposal——提案落盘并开 draft PR（#1003） ([#1041](https://github.com/MYTech-Co-LTD/platform-core/pull/1041), [faaceef](https://github.com/MYTech-Co-LTD/platform-core/commit/faaceeff15f5d6e33042bf9753612d761182e031))


## [0.194.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.193.2...v0.194.0) - 2026-10-24
- 【新增】auth: console 组织架构与角色管理后台 ([#1040](https://github.com/MYTech-Co-LTD/platform-core/pull/1040), [1778b15](https://github.com/MYTech-Co-LTD/platform-core/commit/1778b152f325a8d6f8370bcac51e9e0089f607c7))


## [0.193.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.193.1...v0.193.2) - 2026-10-24
- 【修复】data: 下钻条件列被列级掩码命中时整列缺席（#995） ([#1037](https://github.com/MYTech-Co-LTD/platform-core/pull/1037), [5d558d5](https://github.com/MYTech-Co-LTD/platform-core/commit/5d558d5d26fa3c99362419b5af818a292678a16c))


## [0.193.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.193.0...v0.193.1) - 2026-10-24
- 【修复】data: item_price 271 单店节点合并为 6 批量节点——乐檬 429 限流减量 98% ([#1036](https://github.com/MYTech-Co-LTD/platform-core/pull/1036), [3663d29](https://github.com/MYTech-Co-LTD/platform-core/commit/3663d29d680557b49304be9a6df6f50d601373cb))


## [0.193.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.192.0...v0.193.0) - 2026-10-24
- 【新增】data: 聚合面组件化 P3.3 影子波——4 族度量迁生成器（#1031） ([#1033](https://github.com/MYTech-Co-LTD/platform-core/pull/1033), [9c42efd](https://github.com/MYTech-Co-LTD/platform-core/commit/9c42efd13c731b742c7dd824fe9c3cb53416c4d3))


## [0.192.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.191.0...v0.192.0) - 2026-10-24
- 【新增】data: 沙箱草案保留策略——试跑后按 mtime 裁到最近 N 份（#1029） ([#1030](https://github.com/MYTech-Co-LTD/platform-core/pull/1030), [0ad82b0](https://github.com/MYTech-Co-LTD/platform-core/commit/0ad82b0e744c18eb01390841ff9c2f332e2cf87b))


## [0.191.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.190.1...v0.191.0) - 2026-10-24
- 【新增】data: P3.2 正式列切换——fct_retail_sale 度量列改由生成物产出（#1020） ([#1026](https://github.com/MYTech-Co-LTD/platform-core/pull/1026), [8810e2e](https://github.com/MYTech-Co-LTD/platform-core/commit/8810e2efd4568f2ce4fde5edde3803e8291cfe1e))


## [0.190.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.190.0...v0.190.1) - 2026-10-23
- 【修复】data: 沙箱执行面改走同步 /api/run——不再把「解析失败/没等到终态」谎报成 running ([#1022](https://github.com/MYTech-Co-LTD/platform-core/pull/1022), [de60ae8](https://github.com/MYTech-Co-LTD/platform-core/commit/de60ae80fcd60d2fde9f7deaf3b60567997e161f))


## [0.190.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.189.1...v0.190.0) - 2026-10-23
- 【新增】data: 聚合面组件化 P3.0——measure 对象形态 + 具名行域 + 影子对账（#1012） ([#1018](https://github.com/MYTech-Co-LTD/platform-core/pull/1018), [4c0cf89](https://github.com/MYTech-Co-LTD/platform-core/commit/4c0cf89a68ba3242adb7e00d824ce637b69794f2))


## [0.189.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.189.0...v0.189.1) - 2026-10-23
- 【修复】deploy: 沙箱执行面实证补两个缺口——共享卷交权 + 校验器补引擎必填字段 ([#1016](https://github.com/MYTech-Co-LTD/platform-core/pull/1016), [beb6263](https://github.com/MYTech-Co-LTD/platform-core/commit/beb6263a295824fa1c57c68b995f5c37774e0ed6))


## [0.189.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.188.0...v0.189.0) - 2026-10-23
- 【新增】data: 沙箱真执行面——sandbox-console + 组件策略 + 失败语义 (#1002) ([#1013](https://github.com/MYTech-Co-LTD/platform-core/pull/1013), [98e3039](https://github.com/MYTech-Co-LTD/platform-core/commit/98e3039926a5a98fec72060795b853a12f4695c1))


## [0.188.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.187.0...v0.188.0) - 2026-10-23
- 【新增】data: 下钻条件列 col 按契约列集校验（#1009） ([#1010](https://github.com/MYTech-Co-LTD/platform-core/pull/1010), [d47a468](https://github.com/MYTech-Co-LTD/platform-core/commit/d47a4686662a4c5e99c3fd95709f67c6e607b4f6))


## [0.187.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.186.2...v0.187.0) - 2026-10-23
- 【新增】data: 运行记录面接线——只读挂载 runs/ + 应用内文件读源 (#1001) ([#1008](https://github.com/MYTech-Co-LTD/platform-core/pull/1008), [658dd7d](https://github.com/MYTech-Co-LTD/platform-core/commit/658dd7d0f33008e5b58ac00bc75ac8fb0e14e833))


## [0.186.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.186.1...v0.186.2) - 2026-10-23
- 【修复】data: 沙箱写入面改按规范化路径判 + 写入组件 allowlist ([#1006](https://github.com/MYTech-Co-LTD/platform-core/pull/1006), [e16b7af](https://github.com/MYTech-Co-LTD/platform-core/commit/e16b7af1d2a398926f4c8908569a4d8c23705cfa))


## [0.186.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.186.0...v0.186.1) - 2026-10-22
- 【修复】data: 提案面尾部加固——拒绝出口的 incomplete 语义成文 + 驱动型豁免只认 transform ([#1004](https://github.com/MYTech-Co-LTD/platform-core/pull/1004), [4918950](https://github.com/MYTech-Co-LTD/platform-core/commit/4918950c2f78c891da65aa4fc14d6328e21e6bd2))


## [0.186.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.185.0...v0.186.0) - 2026-10-22
- 【新增】data: 数据面 MCP Wave 3——T1 提案面（7 工具，写闸 + 审计单点） ([#998](https://github.com/MYTech-Co-LTD/platform-core/pull/998), [311d9d2](https://github.com/MYTech-Co-LTD/platform-core/commit/311d9d2d2754cd8bd26f7aa2109b8dbbca2c426a))


## [0.185.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.184.2...v0.185.0) - 2026-10-22
- 【新增】data: bot 问数明细下钻 Phase 2 (#994) ([#996](https://github.com/MYTech-Co-LTD/platform-core/pull/996), [981a806](https://github.com/MYTech-Co-LTD/platform-core/commit/981a8063183990ede11c77fc39dbcbd605ee633f))


## [0.184.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.184.1...v0.184.2) - 2026-10-22
- 【修复】data: sample_dimension_values 外层别名撞内层 value 列——真库必炸 (#991) ([#992](https://github.com/MYTech-Co-LTD/platform-core/pull/992), [cdf5979](https://github.com/MYTech-Co-LTD/platform-core/commit/cdf5979b0afeff75fc19f41cf112814751a927d5))


## [0.184.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.184.0...v0.184.1) - 2026-10-22
- 【修复】openclaw: contracts.tools 补登 Wave 2 三工具 + 契约回归测试进 gates（网关拒载实锤，ref #989） ([#990](https://github.com/MYTech-Co-LTD/platform-core/pull/990), [18de78c](https://github.com/MYTech-Co-LTD/platform-core/commit/18de78c10f34fa95abeea1f477f40e984f9a3f37))


## [0.184.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.183.2...v0.184.0) - 2026-10-22
- 【新增】data: 数据面 MCP Wave 2——三通道同享（A/C 绑定） ([#987](https://github.com/MYTech-Co-LTD/platform-core/pull/987), [0e63364](https://github.com/MYTech-Co-LTD/platform-core/commit/0e63364d22ac3f928fe2e3445b0937e017caf36d))


## [0.183.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.183.1...v0.183.2) - 2026-10-22
- 【修复】data: retail audit recheck 补封版排除——封窗日双计 (#984) ([#986](https://github.com/MYTech-Co-LTD/platform-core/pull/986), [28ec2d6](https://github.com/MYTech-Co-LTD/platform-core/commit/28ec2d6c8c6b12317d11ddf98ff936c1a787e961))


## [0.183.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.183.0...v0.183.1) - 2026-10-22
- 【修复】server: PAT 存量回填 platform.api_key + 企微闸只拦企微意图 ([#983](https://github.com/MYTech-Co-LTD/platform-core/pull/983), [2ac7755](https://github.com/MYTech-Co-LTD/platform-core/commit/2ac77550c09a010ecf71f7b4ca7aba07c232a2e4))


## [0.183.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.182.0...v0.183.0) - 2026-10-22
- 【新增】data: bot 问数明细下钻 Phase 1——度量组件声明面 + query_detail 四通道 ([#980](https://github.com/MYTech-Co-LTD/platform-core/pull/980), [c0b0558](https://github.com/MYTech-Co-LTD/platform-core/commit/c0b05585ebf33ab37b3f70329c4da4e32e59a275))


## [0.182.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.181.1...v0.182.0) - 2026-10-21
- 【新增】data: 数据面 MCP 分析师面 Wave 1 (#978) ([#979](https://github.com/MYTech-Co-LTD/platform-core/pull/979), [80775ad](https://github.com/MYTech-Co-LTD/platform-core/commit/80775adeb7ab24e7a445074dd948270656db38a6))


## [0.181.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.181.0...v0.181.1) - 2026-10-21
- 【修复】data: 零售明细 day/window 关闭 checkpoint，本地状态不再无界增长 ([#976](https://github.com/MYTech-Co-LTD/platform-core/pull/976), [5b09c79](https://github.com/MYTech-Co-LTD/platform-core/commit/5b09c79e4e6b6df10663525e1daf43c4a39ab0be))


## [0.181.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.180.0...v0.181.0) - 2026-10-21
- 【新增】data: 零售明细直读湖视图 vw_*——bot 问数下钻 Phase 0 ([#973](https://github.com/MYTech-Co-LTD/platform-core/pull/973), [9fad0b0](https://github.com/MYTech-Co-LTD/platform-core/commit/9fad0b027c4365274c8c82794f6be5d096f79394))


## [0.180.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.179.3...v0.180.0) - 2026-10-21
- 【新增】data: 新增零售订单明细行 L1 指标，让 bot 能翻明细定位根因 ([#966](https://github.com/MYTech-Co-LTD/platform-core/pull/966), [2524fd0](https://github.com/MYTech-Co-LTD/platform-core/commit/2524fd00bd9b8b0428a19744364a3e659b1f083e))


## [0.179.3](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.179.2...v0.179.3) - 2026-10-21
- 【修复】askdata: 明确 date_range 是类型名不是键名（工具描述 + SKILL） ([#962](https://github.com/MYTech-Co-LTD/platform-core/pull/962), [9d9cf18](https://github.com/MYTech-Co-LTD/platform-core/commit/9d9cf1822b78d9f1964d67306e36af5dab96259a))


## [0.179.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.179.1...v0.179.2) - 2026-10-21
- 【修复】askdata: 轨迹采集改成遍历所有 agent + 每 agent 一份水位 ([#960](https://github.com/MYTech-Co-LTD/platform-core/pull/960), [e9c3662](https://github.com/MYTech-Co-LTD/platform-core/commit/e9c3662e565266c8cd64ef2c644013124be0ac32))


## [0.179.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.179.0...v0.179.1) - 2026-10-21
- 【修复】data: 销售额审计改 1 分容差（原为精确比较） ([#957](https://github.com/MYTech-Co-LTD/platform-core/pull/957), [3f2f4f7](https://github.com/MYTech-Co-LTD/platform-core/commit/3f2f4f7624dccce22c6a3d947da3920884c071ca))


## [0.179.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.178.0...v0.179.0) - 2026-10-21
- 【新增】data: 审计层改读「冷+热」两条路径，摘掉镜像 sink ([#956](https://github.com/MYTech-Co-LTD/platform-core/pull/956), [3b95bba](https://github.com/MYTech-Co-LTD/platform-core/commit/3b95bba30377dae017a9addb95058c7010a9931a))


## [0.178.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.177.0...v0.178.0) - 2026-10-20
- 【新增】data: 新增逐日迁移驱动 backfill-daily-partitions.py ([#954](https://github.com/MYTech-Co-LTD/platform-core/pull/954), [2627a65](https://github.com/MYTech-Co-LTD/platform-core/commit/2627a65bbfe074eac56b837bb1c2142681f1b3fa))


## [0.177.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.176.1...v0.177.0) - 2026-10-20
- 【新增】data: 整天重采同一份数据镜像到旧路径（供审计层单 glob 读取） ([#952](https://github.com/MYTech-Co-LTD/platform-core/pull/952), [3702c02](https://github.com/MYTech-Co-LTD/platform-core/commit/3702c0224956c1c3f7cee1f8f048fa4da14559fa))


## [0.176.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.176.0...v0.176.1) - 2026-10-20
- 【修复】data: 天文件挪 _DAY_DATA/ + 回填管线闸接线修复 ([#950](https://github.com/MYTech-Co-LTD/platform-core/pull/950), [40f3a3e](https://github.com/MYTech-Co-LTD/platform-core/commit/40f3a3e4ba537f1b68918a0302bb810f63173a84))


## [0.176.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.175.0...v0.176.0) - 2026-10-20
- 【新增】notify: trigger 前给订阅者挂 chat 渠道（ensureChannel，ADR 0008 ②） ([#947](https://github.com/MYTech-Co-LTD/platform-core/pull/947), [9920180](https://github.com/MYTech-Co-LTD/platform-core/commit/99201809d337e940bdeb5fc518b5dc2ea26d6d5c))


## [0.175.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.174.1...v0.175.0) - 2026-10-20
- 【新增】data: 零售明细小时分区→天分区（热/冷混合布局） ([#944](https://github.com/MYTech-Co-LTD/platform-core/pull/944), [19d97be](https://github.com/MYTech-Co-LTD/platform-core/commit/19d97be201ee6e53add0eea0513126f5fd287f64))


## [0.174.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.174.0...v0.174.1) - 2026-10-20
- 【修复】notify: notify-reconcile 的 Novu 装配传值不传函数（#929 回归） ([#938](https://github.com/MYTech-Co-LTD/platform-core/pull/938), [9aa1cd7](https://github.com/MYTech-Co-LTD/platform-core/commit/9aa1cd7103557b1efad55229b243b0534ffdc409))


## [0.174.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.173.2...v0.174.0) - 2026-10-20
- 【新增】data: 库存快照改查 T-1 + 空集记具名状态 SOURCE_NOT_PUBLISHED ([#939](https://github.com/MYTech-Co-LTD/platform-core/pull/939), [a96618b](https://github.com/MYTech-Co-LTD/platform-core/commit/a96618ba3088eb54932654640236a4690b298d97))


## [0.173.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.173.1...v0.173.2) - 2026-10-20
- 【修复】data: 排班门禁期望表随 #931 同步（main unit 红追补） ([#934](https://github.com/MYTech-Co-LTD/platform-core/pull/934), [4ae0697](https://github.com/MYTech-Co-LTD/platform-core/commit/4ae069705c4abe2f58203588dc89ba42f44d44d2))


## [0.173.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.173.0...v0.173.1) - 2026-10-20
- 【修复】data: 非销售采集排班统一到北京 14–24 点每 2 小时（修 ${date-1d} 的 UTC 偏一天） ([#932](https://github.com/MYTech-Co-LTD/platform-core/pull/932), [7c2bb9d](https://github.com/MYTech-Co-LTD/platform-core/commit/7c2bb9d1a8c82617fc49c121fa783bb3d178480a))


## [0.173.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.172.0...v0.173.0) - 2026-10-20
- 【新增】notify: 按租户（org）解析 Novu 凭据——方案 A env 映射 + 回落 ([#929](https://github.com/MYTech-Co-LTD/platform-core/pull/929), [475179b](https://github.com/MYTech-Co-LTD/platform-core/commit/475179b8e0e362f73ba7a21a0f22a3f43d322cf5))


## [0.172.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.171.0...v0.172.0) - 2026-10-19
- 【新增】data: 重述窗口调度——两账套 + 台账驱动 + T-3..T-9（#814 层 1+2+3） ([#925](https://github.com/MYTech-Co-LTD/platform-core/pull/925), [dbfa29f](https://github.com/MYTech-Co-LTD/platform-core/commit/dbfa29f89a5063480bec022b508d153a28857702))


## [0.171.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.170.5...v0.171.0) - 2026-10-19
- 【新增】forms: 指派与催办（T9/T11）——契约 assignees/due + 声明式对账 + openship job ([#907](https://github.com/MYTech-Co-LTD/platform-core/pull/907), [6117b88](https://github.com/MYTech-Co-LTD/platform-core/commit/6117b88f09f64befe70c9d74344e1929117316d8))
- 【新增】m1.1: dataDependencies 门禁判据 1 落地（形状校验 + B1 声明集豁免） ([#912](https://github.com/MYTech-Co-LTD/platform-core/pull/912), [905de1b](https://github.com/MYTech-Co-LTD/platform-core/commit/905de1bf9e103710d5456b5a4474c71aa3a38c2d))


## [0.170.5](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.170.4...v0.170.5) - 2026-10-19
- 【优化】data: 口径单源化（对账改消费者）+ duckle 原生优先立为正典与 skill（#920） ([#921](https://github.com/MYTech-Co-LTD/platform-core/pull/921), [9525341](https://github.com/MYTech-Co-LTD/platform-core/commit/9525341f3fe87bdd9ac3f85ee249ab18df00fcf0))


## [0.170.4](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.170.3...v0.170.4) - 2026-10-19
- 【修复】data: 退货侧赠品判别式补到对账两副本 + 口径五副本同源门禁（#917/#831） ([#918](https://github.com/MYTech-Co-LTD/platform-core/pull/918), [086f11a](https://github.com/MYTech-Co-LTD/platform-core/commit/086f11afdfff8de188d69f1b6ca71e043d89fd80))


## [0.170.3](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.170.2...v0.170.3) - 2026-10-18
- 【修复】auth: admin 会话 cookie 取最后一个 casdoor_session_id——新版 Casdoor 登录发两个（#915，承接 #911） ([#914](https://github.com/MYTech-Co-LTD/platform-core/pull/914), [87d0e85](https://github.com/MYTech-Co-LTD/platform-core/commit/87d0e85f92e670e0198363ad9487af2f568a3384))


## [0.170.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.170.1...v0.170.2) - 2026-10-18
- 【修复】auth: admin 会话登录与业务 application 解耦（#911） ([#913](https://github.com/MYTech-Co-LTD/platform-core/pull/913), [2154ea3](https://github.com/MYTech-Co-LTD/platform-core/commit/2154ea3ea16d41fe15e8f0b7b2351a38f49c53c7))


## [0.170.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.170.0...v0.170.1) - 2026-10-18
- 【修复】data: 净销售额退货侧补套赠品判别式——0 元单整退被反向加回（#908） ([#909](https://github.com/MYTech-Co-LTD/platform-core/pull/909), [75ac4f5](https://github.com/MYTech-Co-LTD/platform-core/commit/75ac4f510f8d2caa612418cbe1d99b41636d85b0))


## [0.170.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.169.0...v0.170.0) - 2026-10-18
- 【新增】data: 口径对账台账接告警面——探活断言 ⑪⑫⑬（advisory，照 ⑩ 同款形态）（#892） ([#905](https://github.com/MYTech-Co-LTD/platform-core/pull/905), [82966c8](https://github.com/MYTech-Co-LTD/platform-core/commit/82966c88bd22ff9a782dba756fc82dac6c316743))


## [0.169.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.168.0...v0.169.0) - 2026-10-18
- 【新增】platform: token 平台化——PAT 密钥表与解析上移宿主（#894） ([#904](https://github.com/MYTech-Co-LTD/platform-core/pull/904), [de46d79](https://github.com/MYTech-Co-LTD/platform-core/commit/de46d79a9a14743de65d5326129aa38473d581ac))


## [0.168.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.167.0...v0.168.0) - 2026-10-18
- 【新增】data: 一级战区汇总——fct_contribution 加 region_l1/region_l1_bucket + region_l1_net 指标（#902） ([#903](https://github.com/MYTech-Co-LTD/platform-core/pull/903), [5bc9667](https://github.com/MYTech-Co-LTD/platform-core/commit/5bc96678567bd45ced2baecd305db49e354b2944))


## [0.167.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.166.0...v0.167.0) - 2026-10-18
- 【新增】notify: 通知规则层——新模块 notify（两表 + 规则管道 + 声明派生 + AI 工具面 + console） ([#890](https://github.com/MYTech-Co-LTD/platform-core/pull/890), [a9cd217](https://github.com/MYTech-Co-LTD/platform-core/commit/a9cd217c319e3c62cf8d4be841daa89b1f8613b6))


## [0.166.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.165.0...v0.166.0) - 2026-10-18
- 【新增】data: 台账加源返回率列 source_cover_pct（#892 判据本体） ([#899](https://github.com/MYTech-Co-LTD/platform-core/pull/899), [4227ba6](https://github.com/MYTech-Co-LTD/platform-core/commit/4227ba6917c67974f6d0fa3ddabb42ab08909339))


## [0.165.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.164.1...v0.165.0) - 2026-10-18
- 【新增】data: 战区未登记哨兵接入告警面——探活断言 ⑩（advisory）+ 桥投递（#898） ([#900](https://github.com/MYTech-Co-LTD/platform-core/pull/900), [a7ec5cf](https://github.com/MYTech-Co-LTD/platform-core/commit/a7ec5cf339a4de4d952f1c6050ff467079b30929))


## [0.164.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.164.0...v0.164.1) - 2026-10-18
- 【修复】data: recon 父管线补收尾汇总 + 新鲜度锚换成父写的字面路径资产（#891） ([#895](https://github.com/MYTech-Co-LTD/platform-core/pull/895), [a099767](https://github.com/MYTech-Co-LTD/platform-core/commit/a0997670a159ad7fc9d34a5a38b38dd5d20ed1d5))


## [0.164.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.163.0...v0.164.0) - 2026-10-18
- 【新增】data: 战区维物化——dim_region 权威 + 门店维带战区标签（#883） ([#886](https://github.com/MYTech-Co-LTD/platform-core/pull/886), [c500768](https://github.com/MYTech-Co-LTD/platform-core/commit/c5007686430814ad8b5c366d5953c741b34fd2ff))


## [0.163.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.162.1...v0.163.0) - 2026-10-18
- 【新增】data: 口径对账回填变体 + 订正两条过时豁免 ([#888](https://github.com/MYTech-Co-LTD/platform-core/pull/888), [8bd40f3](https://github.com/MYTech-Co-LTD/platform-core/commit/8bd40f3c62fb2c166a65ab263c82bf897791b438))


## [0.162.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.162.0...v0.162.1) - 2026-10-18
- 【优化】data: authorize 的掩码词表改必填（原默认值 = 静默 fail-open） ([#885](https://github.com/MYTech-Co-LTD/platform-core/pull/885), [8da572c](https://github.com/MYTech-Co-LTD/platform-core/commit/8da572c684b757af19af9fd4ea1056e6106673be))


## [0.162.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.161.0...v0.162.0) - 2026-10-18
- 【新增】data: 审计掩码三态（含混合形）+ 与回包同源派生（#823） ([#881](https://github.com/MYTech-Co-LTD/platform-core/pull/881), [fbb4cfe](https://github.com/MYTech-Co-LTD/platform-core/commit/fbb4cfe92928e82414c919c9fbfad79e5b7faae1))


## [0.161.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.160.0...v0.161.0) - 2026-10-18
- 【新增】data: 口径对账排班 + 新鲜度锚——3120 补排班、湖资产进 owners ([#878](https://github.com/MYTech-Co-LTD/platform-core/pull/878), [1ea397a](https://github.com/MYTech-Co-LTD/platform-core/commit/1ea397add13eb364897feda689e1b4f53a7ccd46))


## [0.160.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.159.0...v0.160.0) - 2026-10-18
- 【新增】data: 掩码按列解析（全量 catalog）——L2 自动覆盖（#820） ([#879](https://github.com/MYTech-Co-LTD/platform-core/pull/879), [af60368](https://github.com/MYTech-Co-LTD/platform-core/commit/af60368eafd44a97600fdf7531445138ad0b43cf))


## [0.159.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.158.0...v0.159.0) - 2026-10-18
- 【新增】data: 值级脱敏 P2 Phase 0——共享 token 化 + 豁免码可查 + 默认档合成（#822 #821 #830） ([#854](https://github.com/MYTech-Co-LTD/platform-core/pull/854), [e964f9c](https://github.com/MYTech-Co-LTD/platform-core/commit/e964f9ce86b3de8c250ff071a2e5f223074769f2))


## [0.158.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.157.1...v0.158.0) - 2026-10-18
- 【新增】data: 口径对账台账 recon_run / recon_break + 容差 seed（消费面 spec §12.4） ([#874](https://github.com/MYTech-Co-LTD/platform-core/pull/874), [2f3d52d](https://github.com/MYTech-Co-LTD/platform-core/commit/2f3d52d64af0911b598cd25084fb9e51c444166b))


## [0.157.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.157.0...v0.157.1) - 2026-10-18
- 【修复】data: 切块整除改 floor——CAST(rn/100) 在 DuckDB 里是四舍五入 ([#872](https://github.com/MYTech-Co-LTD/platform-core/pull/872), [de930a4](https://github.com/MYTech-Co-LTD/platform-core/commit/de930a470f3719506686d5cb791109dd9ea0a8b0))


## [0.157.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.156.3...v0.157.0) - 2026-10-18
- 【新增】data: 问数回包回战区名与一级战区 ([#869](https://github.com/MYTech-Co-LTD/platform-core/pull/869), [75bc476](https://github.com/MYTech-Co-LTD/platform-core/commit/75bc476a19e7e4be06951791939f07c075c5eaa0))


## [0.156.3](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.156.2...v0.156.3) - 2026-10-18
- 【修复】data: dbt 测试按域分目录 + 逐域 build 用派生选择器（域开关管不到 dbt/tests） ([#864](https://github.com/MYTech-Co-LTD/platform-core/pull/864), [c482956](https://github.com/MYTech-Co-LTD/platform-core/commit/c48295611711ed998e5e4a55f0e653362136d7fb))


## [0.156.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.156.1...v0.156.2) - 2026-10-18
- 【修复】data: forms 管线 sink 补 connectionRef:zos（新建 console 写湖必报 NoSuchBucket） ([#862](https://github.com/MYTech-Co-LTD/platform-core/pull/862), [5aa8c3b](https://github.com/MYTech-Co-LTD/platform-core/commit/5aa8c3b3f94ddb6f04269695c9adc576c3821e16))


## [0.156.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.156.0...v0.156.1) - 2026-10-18
- 【修复】data: 切块只切了请求没切湖侧——diff 按本块门店集过滤 ([#860](https://github.com/MYTech-Co-LTD/platform-core/pull/860), [8ad3d8c](https://github.com/MYTech-Co-LTD/platform-core/commit/8ad3d8c44660b1458661964d7ea3b462167456c6))


## [0.156.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.155.0...v0.156.0) - 2026-10-18
- 【新增】data: 问数回包回品牌名与门店名——名称在维度层解析 ([#858](https://github.com/MYTech-Co-LTD/platform-core/pull/858), [e2362af](https://github.com/MYTech-Co-LTD/platform-core/commit/e2362af0061edf1ef72c58e40dcbe72b33517936))
- 【修复】data: 口径对账退役业务判据闸——采集不该因「数不一样」而死 ([#855](https://github.com/MYTech-Co-LTD/platform-core/pull/855), [3c87fd0](https://github.com/MYTech-Co-LTD/platform-core/commit/3c87fd0d68664296931f55d0ad0e6de3fca04165))


## [0.155.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.154.3...v0.155.0) - 2026-10-18
- 【新增】data: 口径对账落湖——父管线切块 + 子管线写 chunk 分区事实 ([#852](https://github.com/MYTech-Co-LTD/platform-core/pull/852), [25afc90](https://github.com/MYTech-Co-LTD/platform-core/commit/25afc90acf649ac67fabde2f9ac533abf7d6fd84))


## [0.154.3](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.154.2...v0.154.3) - 2026-10-18
- 【修复】data: 新鲜度 SLA 按实测发布时钟重新标定 ([#851](https://github.com/MYTech-Co-LTD/platform-core/pull/851), [5f83f82](https://github.com/MYTech-Co-LTD/platform-core/commit/5f83f82b78af5f56005c031c2195c1468c679400))


## [0.154.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.154.1...v0.154.2) - 2026-10-17
- 【修复】data: 新鲜度水位先按关系取最新行再取木桶 ([#847](https://github.com/MYTech-Co-LTD/platform-core/pull/847), [a6fb584](https://github.com/MYTech-Co-LTD/platform-core/commit/a6fb584e336fd0ebf6aeeba7c599b5ff52e512c9))


## [0.154.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.154.0...v0.154.1) - 2026-10-17
- 【优化】data: materialize 逐域跑 + 逐域落账（拆爆炸半径）（Refs #729） ([#841](https://github.com/MYTech-Co-LTD/platform-core/pull/841), [06b4a1f](https://github.com/MYTech-Co-LTD/platform-core/commit/06b4a1f3fc37704cc179683074be37e92ea91e76))


## [0.154.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.153.2...v0.154.0) - 2026-10-17
- 【新增】data: 答案自带射程与排除——scope_note 由平台自动附加（spec §12.6） ([#838](https://github.com/MYTech-Co-LTD/platform-core/pull/838), [7e3c60a](https://github.com/MYTech-Co-LTD/platform-core/commit/7e3c60a0ea2923158ef39177ed862c0aa38e438a))


## [0.153.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.153.1...v0.153.2) - 2026-10-17
- 【优化】data: dbt 树按域分目录 + 域开关（+enabled/env_var）+ fail-closed 域覆盖门禁（Refs #729） ([#835](https://github.com/MYTech-Co-LTD/platform-core/pull/835), [e937ab3](https://github.com/MYTech-Co-LTD/platform-core/commit/e937ab35d74360fc30ef69b05ff397ae9db80b94))


## [0.153.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.153.0...v0.153.1) - 2026-10-17
- 【修复】data: 零售净销售额口径改冲退货——构件拆三列 + 对账锚切换 ([#834](https://github.com/MYTech-Co-LTD/platform-core/pull/834), [72cf57a](https://github.com/MYTech-Co-LTD/platform-core/commit/72cf57a1d2b127bfdfcdfbc8216524ae4518c797))


## [0.153.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.152.2...v0.153.0) - 2026-10-17
- 【新增】data: 01-05 可比门店增长率——验证「问 0」不是只对一个指标成立 ([#833](https://github.com/MYTech-Co-LTD/platform-core/pull/833), [6b2c068](https://github.com/MYTech-Co-LTD/platform-core/commit/6b2c0684cf1ed83b96d3f79a12801f52630469fb))


## [0.152.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.152.1...v0.152.2) - 2026-10-17
- 【修复】data: P2 掩码 Minor 挂账清理（#824） ([#827](https://github.com/MYTech-Co-LTD/platform-core/pull/827), [d1c68ed](https://github.com/MYTech-Co-LTD/platform-core/commit/d1c68ed18c9cc700b8f2a8aa2848f9733368cb76))


## [0.152.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.152.0...v0.152.1) - 2026-10-17
- 【修复】data: 存量指标不再自动附合计——additivity 显式登记压过表达式形状 ([#829](https://github.com/MYTech-Co-LTD/platform-core/pull/829), [2a0786f](https://github.com/MYTech-Co-LTD/platform-core/commit/2a0786f7db60e349acd4efd1e351a6c24c4df920))


## [0.152.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.151.1...v0.152.0) - 2026-10-17
- 【新增】data: 门店×日骨架事实 + 03-05 连续无业绩天数——验证「日历可推导、不必等客户」 ([#826](https://github.com/MYTech-Co-LTD/platform-core/pull/826), [be69bf7](https://github.com/MYTech-Co-LTD/platform-core/commit/be69bf74f7f34cf020f697ffec5025efe35a0010))


## [0.151.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.151.0...v0.151.1) - 2026-10-17
- 【修复】data: 零成本暴露面把「成本 null」并进零成本——与自身文档及客户 04-06 口径矛盾 ([#817](https://github.com/MYTech-Co-LTD/platform-core/pull/817), [2912030](https://github.com/MYTech-Co-LTD/platform-core/commit/29120300f3ecd11d54af15f12f56088d0fcde898))


## [0.151.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.150.0...v0.151.0) - 2026-10-17
- 【新增】data: L2 不得基于被掩码的 L1 构建（fail-closed） ([#811](https://github.com/MYTech-Co-LTD/platform-core/pull/811), [ae377aa](https://github.com/MYTech-Co-LTD/platform-core/commit/ae377aa7e203b24e8e47503a6b0c15089ec8f393))


## [0.150.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.149.0...v0.150.0) - 2026-10-17
- 【新增】data: 审计记录掩码 + 指令面同步 ([#810](https://github.com/MYTech-Co-LTD/platform-core/pull/810), [13a75cd](https://github.com/MYTech-Co-LTD/platform-core/commit/13a75cd0b62f345518bcd0b97602726be64caea0))


## [0.149.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.148.0...v0.149.0) - 2026-10-17
- 【新增】data: 值级掩码在 authorize 里定点展开 + 回包 masking ([#807](https://github.com/MYTech-Co-LTD/platform-core/pull/807), [6c72b56](https://github.com/MYTech-Co-LTD/platform-core/commit/6c72b565058aa60befd488ada9d38fa7f29b0e4d))


## [0.148.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.147.0...v0.148.0) - 2026-10-17
- 【新增】data: 指标声明面开放 mask（值级脱敏） ([#798](https://github.com/MYTech-Co-LTD/platform-core/pull/798), [81da291](https://github.com/MYTech-Co-LTD/platform-core/commit/81da291ff72c5a116d76af9eefcd418667196bdf))


## [0.147.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.146.2...v0.147.0) - 2026-10-17
- 【新增】data: forms 域新鲜度锚 owners.forms.json——抓「没有失败的停更」（Refs #729） ([#803](https://github.com/MYTech-Co-LTD/platform-core/pull/803), [0a64d56](https://github.com/MYTech-Co-LTD/platform-core/commit/0a64d564ae900d5a95eaa90f649da00572daa0f4))


## [0.146.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.146.1...v0.146.2) - 2026-10-17
- 【修复】data: 客户级贡献率对账自检段列数对齐主段（10 列） ([#804](https://github.com/MYTech-Co-LTD/platform-core/pull/804), [aecf44b](https://github.com/MYTech-Co-LTD/platform-core/commit/aecf44b94172ba7e4d4d2ddfbe362cc3a4fc9d73))


## [0.146.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.146.0...v0.146.1) - 2026-10-17
- 【修复】data: 零售明细门店清单改 whoami 现算，新店自动纳入（#793） ([#801](https://github.com/MYTech-Co-LTD/platform-core/pull/801), [1e489b5](https://github.com/MYTech-Co-LTD/platform-core/commit/1e489b520f0a10005bd2699ff1929b55e9ffc173))


## [0.146.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.145.1...v0.146.0) - 2026-10-17
- 【新增】data: fct_client_contribution 客户级费用后贡献构件 + 两条 L1（#744） ([#800](https://github.com/MYTech-Co-LTD/platform-core/pull/800), [5ba233c](https://github.com/MYTech-Co-LTD/platform-core/commit/5ba233cbc11ce39835b1602d4dcf13abfa716dc2))


## [0.145.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.145.0...v0.145.1) - 2026-10-17
- 【修复】data: 复 enable stg_forms_submission——湖首文件已落（Closes #751） ([#799](https://github.com/MYTech-Co-LTD/platform-core/pull/799), [64f76fa](https://github.com/MYTech-Co-LTD/platform-core/commit/64f76fa0a57160099a350a8dbdf228b58791cc97))


## [0.145.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.144.1...v0.145.0) - 2026-10-17
- 【新增】data: fct_hq_outbound 扩 client_fid 第 6 粒度键，客户级口径就位（#744） ([#792](https://github.com/MYTech-Co-LTD/platform-core/pull/792), [13e9691](https://github.com/MYTech-Co-LTD/platform-core/commit/13e96914c244793ae9a7b04ebf7031db91340cb0))


## [0.144.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.144.0...v0.144.1) - 2026-10-17
- 【修复】data: POST /reports 也走发布门派生，堵住建成即已发布的旁路 ([#790](https://github.com/MYTech-Co-LTD/platform-core/pull/790), [9530000](https://github.com/MYTech-Co-LTD/platform-core/commit/9530000c6fca7ef65e48957ec69557f56d725481))


## [0.144.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.143.1...v0.144.0) - 2026-10-17
- 【新增】data: 血缘单调门——读了敏感源列的指标必须收窄 ([#789](https://github.com/MYTech-Co-LTD/platform-core/pull/789), [eb0c373](https://github.com/MYTech-Co-LTD/platform-core/commit/eb0c37352abd920652b8f57dc36a404e315aa35d))


## [0.143.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.143.0...v0.143.1) - 2026-10-17
- 【修复】data: 撤掉库存覆盖天数——D17×D07 在门店×商品上零重叠（#787） ([#788](https://github.com/MYTech-Co-LTD/platform-core/pull/788), [30a5ce8](https://github.com/MYTech-Co-LTD/platform-core/commit/30a5ce8bdca67dcd5aaa2b37cfe99a7a2281a39c))


## [0.143.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.142.1...v0.143.0) - 2026-10-17
- 【新增】data: L1 声明面开放 required_scope 与 reads，加 data:cost 权限码 ([#785](https://github.com/MYTech-Co-LTD/platform-core/pull/785), [abcbe9f](https://github.com/MYTech-Co-LTD/platform-core/commit/abcbe9f029d4e7506062185fbd3a1ba6936fc121))


## [0.142.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.142.0...v0.142.1) - 2026-10-17
- 【修复】data: console 排班闸期望集按「域」判——forms 不再污染乐檬账套书（Closes #782） ([#783](https://github.com/MYTech-Co-LTD/platform-core/pull/783), [05ea70b](https://github.com/MYTech-Co-LTD/platform-core/commit/05ea70b92d6d968be74994373afcb7d9e02e9f21))


## [0.142.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.141.0...v0.142.0) - 2026-10-17
- 【新增】data: 库存覆盖天数（月日均）+ 净销量扩到商品粒度 ([#776](https://github.com/MYTech-Co-LTD/platform-core/pull/776), [a816a81](https://github.com/MYTech-Co-LTD/platform-core/commit/a816a8169b3e440442c8f012e9efee34c673de29))


## [0.141.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.140.1...v0.141.0) - 2026-10-17
- 【新增】data: 契约列加 sensitivity 标记与闭集门禁 ([#777](https://github.com/MYTech-Co-LTD/platform-core/pull/777), [f51aa83](https://github.com/MYTech-Co-LTD/platform-core/commit/f51aa83a8c0440cba83c890eb94c49571467008f))
- 【新增】data: 报表 requiredScope 改为从面板派生，冲突时拒绝发布 ([#774](https://github.com/MYTech-Co-LTD/platform-core/pull/774), [5bcfcc5](https://github.com/MYTech-Co-LTD/platform-core/commit/5bcfcc52dbfed19630e450148a666f777e4df97a))


## [0.140.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.140.0...v0.140.1) - 2026-10-17
- 【修复】data: 净销量对账的 UNION 两臂少一列（9 vs 10） ([#772](https://github.com/MYTech-Co-LTD/platform-core/pull/772), [c6a5d1c](https://github.com/MYTech-Co-LTD/platform-core/commit/c6a5d1c005f5b078c66fe95e40232d19a898498f))


## [0.140.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.139.0...v0.140.0) - 2026-10-17
- 【新增】guard: 文档引用门禁——变更中的文档里 file:line 不得越界 ([#773](https://github.com/MYTech-Co-LTD/platform-core/pull/773), [5a994af](https://github.com/MYTech-Co-LTD/platform-core/commit/5a994aff0d66a81e78f42e34e3a16945d05641b3))


## [0.139.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.138.3...v0.139.0) - 2026-10-17
- 【新增】data: 零售净销量 L1（03-07 分母；覆盖天数待 X08 批准窗口 N） ([#770](https://github.com/MYTech-Co-LTD/platform-core/pull/770), [5e785bb](https://github.com/MYTech-Co-LTD/platform-core/commit/5e785bbf59fa6d7c2128181cec51e900b9b12663))


## [0.138.3](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.138.2...v0.138.3) - 2026-10-17
- 【修复】data-stack: pg_duckdb 卷改挂父目录——PG18 的 PGDATA 在版本子目录（Closes #765） ([#768](https://github.com/MYTech-Co-LTD/platform-core/pull/768), [4d6ff90](https://github.com/MYTech-Co-LTD/platform-core/commit/4d6ff906246b5f180a4a9d54726397d6aaf0e086))


## [0.138.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.138.1...v0.138.2) - 2026-10-17
- 【修复】data: 补齐 20 条 L1 的 sources——新鲜度固定行不再恒「未知」 ([#763](https://github.com/MYTech-Co-LTD/platform-core/pull/763), [76ad5a9](https://github.com/MYTech-Co-LTD/platform-core/commit/76ad5a96e79700219470139d2da7661d292e4909))


## [0.138.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.138.0...v0.138.1) - 2026-10-17
- 【修复】data: fct_purchase_concentration 的 item_num join 类型不匹配（text vs bigint） ([#760](https://github.com/MYTech-Co-LTD/platform-core/pull/760), [1c44219](https://github.com/MYTech-Co-LTD/platform-core/commit/1c44219648d6b6e0cdf495e4e5d5fd6fcc7e7d30))


## [0.138.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.137.1...v0.138.0) - 2026-10-17
- 【新增】data: 供应商集中度 CR5 L1 + 月度预聚合构件与对账（#744 W3） ([#759](https://github.com/MYTech-Co-LTD/platform-core/pull/759), [5c6e47c](https://github.com/MYTech-Co-LTD/platform-core/commit/5c6e47ca00de0d5ad11d827c9254dd8641b71dba))


## [0.137.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.137.0...v0.137.1) - 2026-10-17
- 【修复】data: 三条组合族对账把「缺行」误判为不一致（物化侧零值行 vs 复算侧缺行） ([#756](https://github.com/MYTech-Co-LTD/platform-core/pull/756), [66e20da](https://github.com/MYTech-Co-LTD/platform-core/commit/66e20da81e89e594f7bf0135100f544904cb53c3))


## [0.137.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.136.3...v0.137.0) - 2026-10-17
- 【新增】data: 费用后贡献/补损率/补贴率 L1 五条 + 对账（#744 W2） ([#755](https://github.com/MYTech-Co-LTD/platform-core/pull/755), [53d42ac](https://github.com/MYTech-Co-LTD/platform-core/commit/53d42ac9aa777c3ec3240b5959e0d7a49d3464cc))


## [0.136.3](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.136.2...v0.136.3) - 2026-10-17
- 【修复】openclaw: 问数不得用 exec/curl 探索——规则进 SKILL（防卷重建回退） ([#754](https://github.com/MYTech-Co-LTD/platform-core/pull/754), [9a3f52a](https://github.com/MYTech-Co-LTD/platform-core/commit/9a3f52ab3bcd0bebf96e0d215c34d1802ab7c273))


## [0.136.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.136.1...v0.136.2) - 2026-10-17
- 【修复】data: 停用 stg_forms_submission——源首个文件出现前它打挂 materialize（连带新鲜度水位冻结） ([#752](https://github.com/MYTech-Co-LTD/platform-core/pull/752), [158a301](https://github.com/MYTech-Co-LTD/platform-core/commit/158a30146e94183fa99085b6d51e230d8b20b23d))


## [0.136.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.136.0...v0.136.1) - 2026-10-17
- 【修复】askdata: #749 归因面订正——内层调度与指令面分离，兜底改 unknown ([#750](https://github.com/MYTech-Co-LTD/platform-core/pull/750), [28b8fef](https://github.com/MYTech-Co-LTD/platform-core/commit/28b8fef65cbfeeffa567feb999257849165cedc3))


## [0.136.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.135.0...v0.136.0) - 2026-10-16
- 【新增】askdata: #741 P1 阶段二——轨迹导出 / 撞墙判据 / 归因 / 统计面 / 定时化 ([#748](https://github.com/MYTech-Co-LTD/platform-core/pull/748), [19ecce3](https://github.com/MYTech-Co-LTD/platform-core/commit/19ecce36369daa7a54748ab6fe90efb392bb3ef2))


## [0.135.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.134.1...v0.135.0) - 2026-10-16
- 【新增】data: 乐檬采购退货率与零金额采购行 L1 两条 + 对账（#744 W1） ([#745](https://github.com/MYTech-Co-LTD/platform-core/pull/745), [acb4346](https://github.com/MYTech-Co-LTD/platform-core/commit/acb4346efecaa849c12416f9b2d928766f585ff5))


## [0.134.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.134.0...v0.134.1) - 2026-10-16
- 【修复】forms: bizday 取 Asia/Shanghai 日历日（${date+8h}）（Closes #739） ([#740](https://github.com/MYTech-Co-LTD/platform-core/pull/740), [1c43191](https://github.com/MYTech-Co-LTD/platform-core/commit/1c4319150cfaefbf615583600a8402051274124b))


## [0.134.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.133.2...v0.134.0) - 2026-10-16
- 【新增】forms: M1.4b 出湖管线三件——契约 + duckle 管线 + dbt 通用 staging（Closes #737） ([#738](https://github.com/MYTech-Co-LTD/platform-core/pull/738), [66586ec](https://github.com/MYTech-Co-LTD/platform-core/commit/66586ec7b31dd7a5fa25040515599afe4134d732))


## [0.133.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.133.1...v0.133.2) - 2026-10-16
- 【修复】deploy: 自证层挪进装依赖 RUN——不再白下最新版 pnpm（58MB 死重） ([#736](https://github.com/MYTech-Co-LTD/platform-core/pull/736), [edba34e](https://github.com/MYTech-Co-LTD/platform-core/commit/edba34e97dde74f2e792b0d338108cad28758e58))


## [0.133.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.133.0...v0.133.1) - 2026-10-16
- 【修复】deploy: 构建期镜像源真正落到 pnpm——补 .npmrc + 构建内自证断言 ([#735](https://github.com/MYTech-Co-LTD/platform-core/pull/735), [e7ac336](https://github.com/MYTech-Co-LTD/platform-core/commit/e7ac336edc9153b23f2f23facb67ab9ed06926d8))


## [0.133.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.132.3...v0.133.0) - 2026-10-16
- 【新增】forms: M1.4a 导出面 GET /export/submissions——出湖管线的源 ([#731](https://github.com/MYTech-Co-LTD/platform-core/pull/731), [59b0896](https://github.com/MYTech-Co-LTD/platform-core/commit/59b0896c6bce7fa1fa50651979bec7d0b8ef65f4))


## [0.132.3](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.132.2...v0.132.3) - 2026-10-16
- 【修复】server: wechat-oa 访客刷新断言去秒边界——改「新 sfa > 旧 sfa + 请求前下界」（Closes #459） ([#730](https://github.com/MYTech-Co-LTD/platform-core/pull/730), [5c2d9c6](https://github.com/MYTech-Co-LTD/platform-core/commit/5c2d9c62f7d5669dcb91a0ed54cf3968c43bc24f))


## [0.132.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.132.1...v0.132.2) - 2026-10-16
- 【修复】data: L2 写面加迭代结构预检——超深 expr 返回干净 400 而非 500（Closes #593） ([#728](https://github.com/MYTech-Co-LTD/platform-core/pull/728), [e6e61f2](https://github.com/MYTech-Co-LTD/platform-core/commit/e6e61f257b51602d8aff35c2f9e3a3c934005ce0))


## [0.132.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.132.0...v0.132.1) - 2026-10-16
- 【修复】guard: 加 shell-CJK 邻接守卫 + 修 7 处未收口变量（失败路径的 echo 会崩，#212） ([#727](https://github.com/MYTech-Co-LTD/platform-core/pull/727), [8bc9e4f](https://github.com/MYTech-Co-LTD/platform-core/commit/8bc9e4fac3c7cf6e62a39422d9aea37205e8ef76))


## [0.132.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.131.1...v0.132.0) - 2026-10-16
- 【新增】forms: AI 起草闭环——契约形状 {schema,uiSchema} + 生成器 + REST/MCP 面（Closes #724） ([#726](https://github.com/MYTech-Co-LTD/platform-core/pull/726), [3b3288d](https://github.com/MYTech-Co-LTD/platform-core/commit/3b3288de0d6374a6f8c97bebbec2b9d31fb6bbfd))


## [0.131.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.131.0...v0.131.1) - 2026-10-16
- 【修复】data: comparableOf 递归规范化键序——jsonb 读回键序被 PG 重排致 --check 恒判更新（Closes #700） ([#725](https://github.com/MYTech-Co-LTD/platform-core/pull/725), [5f5ebce](https://github.com/MYTech-Co-LTD/platform-core/commit/5f5ebce623d4acf9e5840c8de17220e5868d0716))


## [0.131.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.130.1...v0.131.0) - 2026-10-16
- 【新增】forms: readOnly 服务端复验（Closes #722） ([#723](https://github.com/MYTech-Co-LTD/platform-core/pull/723), [6fef05c](https://github.com/MYTech-Co-LTD/platform-core/commit/6fef05ceb1c858f549a864e33718f5074cd5ccd1))


## [0.130.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.130.0...v0.130.1) - 2026-10-16
- 【修复】openclaw: 新鲜度固定行确定性附加（message_sending strip+append + 入站清账） ([#721](https://github.com/MYTech-Co-LTD/platform-core/pull/721), [e75ee64](https://github.com/MYTech-Co-LTD/platform-core/commit/e75ee64e608c4f83667868038fbb349073687dc1))


## [0.130.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.129.2...v0.130.0) - 2026-10-16
- 【新增】forms: 填报与渲染面——console 页 + RJSF 渲染 + 条件字段护栏（Closes #718） ([#719](https://github.com/MYTech-Co-LTD/platform-core/pull/719), [d55a602](https://github.com/MYTech-Co-LTD/platform-core/commit/d55a6024d31497a451b11d49598f89d025acace6))


## [0.129.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.129.1...v0.129.2) - 2026-10-16
- 【修复】data: freshness_line 当日部分天变体——水位=今天改口「今日数据仍在累计中」（freshness fix round 2） ([#717](https://github.com/MYTech-Co-LTD/platform-core/pull/717), [79e50eb](https://github.com/MYTech-Co-LTD/platform-core/commit/79e50eb400e51946688a1a8b89cf563f7e199315))


## [0.129.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.129.0...v0.129.1) - 2026-10-16
- 【修复】forms: G0 量具去掉裸 SQL 全文件重放——并行 worker 下 DDL 重放 deadlock（Closes #714） ([#715](https://github.com/MYTech-Co-LTD/platform-core/pull/715), [adb94b7](https://github.com/MYTech-Co-LTD/platform-core/commit/adb94b7ef80b7665166968c2c4ea7336c1293810))


## [0.129.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.128.0...v0.129.0) - 2026-10-16
- 【新增】data: 新鲜度 SLA + 水位木桶 + freshness_line 固定展示行（业务大白话，spec §10.7） ([#712](https://github.com/MYTech-Co-LTD/platform-core/pull/712), [0084774](https://github.com/MYTech-Co-LTD/platform-core/commit/0084774ab2b1bd46d3f2131829c4b68ed0753b51))


## [0.128.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.127.0...v0.128.0) - 2026-10-16
- 【新增】forms: M1.2 受管数据集内核——生命周期 + 字典双档（P4）+ 绑定强度 ([#713](https://github.com/MYTech-Co-LTD/platform-core/pull/713), [1e47bfe](https://github.com/MYTech-Co-LTD/platform-core/commit/1e47bfe34f712339b6dfe4b59182404a3b9032e6))


## [0.127.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.126.0...v0.127.0) - 2026-10-16
- 【新增】forms: M1.1 模块骨架 + ManifestSchema 收 dataDependencies 与 .strict() ([#709](https://github.com/MYTech-Co-LTD/platform-core/pull/709), [82c047b](https://github.com/MYTech-Co-LTD/platform-core/commit/82c047b3ab6dbead9e2eee9d3d6a91454f0c54f7))


## [0.126.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.125.0...v0.126.0) - 2026-10-16
- 【新增】data: 时区统一——业务调度 Asia/Shanghai（23 条排班）+ data_as_of 北京时间（spec §10.6） ([#707](https://github.com/MYTech-Co-LTD/platform-core/pull/707), [b96e745](https://github.com/MYTech-Co-LTD/platform-core/commit/b96e7451aa864e2dc3afb70846746f6bec8243f0))


## [0.125.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.124.0...v0.125.0) - 2026-10-16
- 【新增】data: 问数新鲜度面——答案自带可信边界（物化落账/data_as_of/确定性截断，spec §10） ([#705](https://github.com/MYTech-Co-LTD/platform-core/pull/705), [f36f84d](https://github.com/MYTech-Co-LTD/platform-core/commit/f36f84d30aeff9da914635286eeab867ab508a54))


## [0.124.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.123.0...v0.124.0) - 2026-10-15
- 【新增】data: 问数 total 自动伴随——可加指标响应自带合计（真机模型不走开关的治本） ([#701](https://github.com/MYTech-Co-LTD/platform-core/pull/701), [6ba7a08](https://github.com/MYTech-Co-LTD/platform-core/commit/6ba7a08969c66e16d8074c8bd987dc435147127b))


## [0.123.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.122.0...v0.123.0) - 2026-10-15
- 【新增】data: 问数合计形态（args.total 单行聚合）+ 问数 SKILL v2（真机区间卡死治本） ([#699](https://github.com/MYTech-Co-LTD/platform-core/pull/699), [d3701e7](https://github.com/MYTech-Co-LTD/platform-core/commit/d3701e7e9df54b7ee4f0a014f97908860e3c6d56))


## [0.122.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.121.2...v0.122.0) - 2026-10-15
- 【新增】data: L1 问数参数面——等值/日期区间参数（openclaw 问数前置） ([#697](https://github.com/MYTech-Co-LTD/platform-core/pull/697), [05dafac](https://github.com/MYTech-Co-LTD/platform-core/commit/05dafaca84ad76349bf1394ca674ba2112b952a1))


## [0.121.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.121.1...v0.121.2) - 2026-10-15
- 【修复】data: #688 deploy/dbt/Dockerfile 补进数据面清单 + 定案「机器本机构建」 ([#692](https://github.com/MYTech-Co-LTD/platform-core/pull/692), [6746c15](https://github.com/MYTech-Co-LTD/platform-core/commit/6746c151b4ba19661e2eb2438ef208021833e9b3))


## [0.121.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.121.0...v0.121.1) - 2026-10-15
- 【修复】data: #683 清点作用域收窄到 manifest 目录型条目 + CI 漂移门禁 ([#687](https://github.com/MYTech-Co-LTD/platform-core/pull/687), [17876ed](https://github.com/MYTech-Co-LTD/platform-core/commit/17876ed821f32fcc9a2a10cc6343d5c8729063db))


## [0.121.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.120.1...v0.121.0) - 2026-10-15
- 【新增】data: sync-data-plane 加清点与 --prune，治检出孤儿永生（#683） ([#686](https://github.com/MYTech-Co-LTD/platform-core/pull/686), [8da6771](https://github.com/MYTech-Co-LTD/platform-core/commit/8da67715bca864be084a5b58b50f1aebe2cf4187))


## [0.120.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.120.0...v0.120.1) - 2026-10-15
- 【修复】data: 量级对账中位数改 percentile_cont（pg_duckdb 无 median，#682） ([#684](https://github.com/MYTech-Co-LTD/platform-core/pull/684), [f933de7](https://github.com/MYTech-Co-LTD/platform-core/commit/f933de710623a50cfa08f19b3eab8de91c38678d))


## [0.120.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.119.0...v0.120.0) - 2026-10-15
- 【新增】data: materialize job 命令抽成 scripts/lemeng/materialize.sh，全量执行去按需名单 ([#681](https://github.com/MYTech-Co-LTD/platform-core/pull/681), [2cca58a](https://github.com/MYTech-Co-LTD/platform-core/commit/2cca58ac6b2c0dbab0287b838801de43aaf5a025))


## [0.119.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.118.0...v0.119.0) - 2026-10-14
- 【新增】data: 乐檬要货满足率构件（D15×D16 店×商品×日对照 + 截止日满足率 L1） ([#678](https://github.com/MYTech-Co-LTD/platform-core/pull/678), [8debf57](https://github.com/MYTech-Co-LTD/platform-core/commit/8debf5782b6187c1f0f7121b0fa348f77a7a146a))


## [0.118.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.117.0...v0.118.0) - 2026-10-14
- 【新增】data: transfer_out/request_order/branch_expense 补容量哨兵页（9页×100=900，照 #674 先例） ([#676](https://github.com/MYTech-Co-LTD/platform-core/pull/676), [9ff7cd1](https://github.com/MYTech-Co-LTD/platform-core/commit/9ff7cd10a2a5a4f152eb32b859f6563821625275))


## [0.117.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.116.1...v0.117.0) - 2026-10-14
- 【新增】data: transfer_in 补容量哨兵页（9页×100=900 行/日，照 wholesale 先例） ([#674](https://github.com/MYTech-Co-LTD/platform-core/pull/674), [85f2c94](https://github.com/MYTech-Co-LTD/platform-core/commit/85f2c94efce7c912108ed430b2f6649491d16609))


## [0.116.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.116.0...v0.116.1) - 2026-10-14
- 【修复】data: transfer_in 明细 expr 改 u.d 展开级（首修用了订单级 o.） ([#670](https://github.com/MYTech-Co-LTD/platform-core/pull/670), [6e9b87b](https://github.com/MYTech-Co-LTD/platform-core/commit/6e9b87bf94b1a04cf3beff848a9fbe01323f4928))


## [0.116.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.115.5...v0.116.0) - 2026-10-14
- 【新增】data: transfer_in 回填变体（照 D02 先例）+ 修 gv 模板残留 ([#668](https://github.com/MYTech-Co-LTD/platform-core/pull/668), [85b92c7](https://github.com/MYTech-Co-LTD/platform-core/commit/85b92c7519369fc8ac2da1358ebd4931c350a9c4))


## [0.115.5](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.115.4...v0.115.5) - 2026-10-14
- 【修复】data: transfer_in 补采 lot_number/production_date（契约 v2） ([#666](https://github.com/MYTech-Co-LTD/platform-core/pull/666), [703f32b](https://github.com/MYTech-Co-LTD/platform-core/commit/703f32bfff7c59fe0e0f70830adc06303fd010f0))


## [0.115.4](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.115.3...v0.115.4) - 2026-10-13
- 【修复】data: inventory 对账 cast 带显式刻度（裸 ::numeric 默认 3 位小数） ([#662](https://github.com/MYTech-Co-LTD/platform-core/pull/662), [be4d13d](https://github.com/MYTech-Co-LTD/platform-core/commit/be4d13d1b4be5ca230e5ddf0ea16930bdc4d8bbe))


## [0.115.3](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.115.2...v0.115.3) - 2026-10-13
- 【修复】data: inventory 对账防 DOUBLE 求和尾差假差异 ([#661](https://github.com/MYTech-Co-LTD/platform-core/pull/661), [2982dff](https://github.com/MYTech-Co-LTD/platform-core/commit/2982dff0e7b52f1e8b9b0c97a1b0061f75f6635f))


## [0.115.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.115.1...v0.115.2) - 2026-10-13
- 【修复】data: purchase daycount 自检行 6 null（修正 #657 的过头修） ([#658](https://github.com/MYTech-Co-LTD/platform-core/pull/658), [75d8e63](https://github.com/MYTech-Co-LTD/platform-core/commit/75d8e63b19cfe50873b6784c0cf2f8ed265e8517))


## [0.115.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.115.0...v0.115.1) - 2026-10-13
- 【修复】data: 4 条对账自检行 UNION 列数对齐 ([#657](https://github.com/MYTech-Co-LTD/platform-core/pull/657), [3a004ea](https://github.com/MYTech-Co-LTD/platform-core/commit/3a004ea54b596a4a643d309ffb65ac9209285710))


## [0.115.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.114.0...v0.115.0) - 2026-10-13
- 【新增】data: 战区对照加一级（region_l1＝四向推导，杂项组不归属） ([#654](https://github.com/MYTech-Co-LTD/platform-core/pull/654), [dcdbc89](https://github.com/MYTech-Co-LTD/platform-core/commit/dcdbc89837cdd2fe942d3d2985ae18460fa1c20e))


## [0.114.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.113.1...v0.114.0) - 2026-10-13
- 【新增】data: 战区名称对照 seed（27 行，branchindicator 年频枚举自力获取） ([#653](https://github.com/MYTech-Co-LTD/platform-core/pull/653), [1412b40](https://github.com/MYTech-Co-LTD/platform-core/commit/1412b405eb88fd270c5027c00da3e7c2b93c16d1))


## [0.113.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.113.0...v0.113.1) - 2026-10-13
- 【优化】data: 门店→战区改以湖上 dim_branch 每日快照为准（裁4 收窄） ([#651](https://github.com/MYTech-Co-LTD/platform-core/pull/651), [4c72c14](https://github.com/MYTech-Co-LTD/platform-core/commit/4c72c14d398214127e51b44f20d887e73b80b0d6))


## [0.113.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.112.0...v0.113.0) - 2026-10-13
- 【新增】data: 裁9 回签（净费用=应付−应收）⇒ 6 条费用指标转 certified ([#648](https://github.com/MYTech-Co-LTD/platform-core/pull/648), [c7721a0](https://github.com/MYTech-Co-LTD/platform-core/commit/c7721a0ff430d6c98458c062e3d6b99611927e5a))


## [0.112.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.111.1...v0.112.0) - 2026-10-13
- 【新增】data: D11 采购源补新鲜度锚（湖侧 owners + 下游侧判据 ⑨） ([#645](https://github.com/MYTech-Co-LTD/platform-core/pull/645), [6ab0a9b](https://github.com/MYTech-Co-LTD/platform-core/commit/6ab0a9bc918f2d8588901028ee33e7e28212ddb0))


## [0.111.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.111.0...v0.111.1) - 2026-10-13
- 【修复】data: D11 管线 w0 补 schema 申报（空结果 Binder 报错） ([#643](https://github.com/MYTech-Co-LTD/platform-core/pull/643), [27efe43](https://github.com/MYTech-Co-LTD/platform-core/commit/27efe433bbefa33484c7eb0807dedb93151b8398))


## [0.111.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.110.4...v0.111.0) - 2026-10-13
- 【新增】data: D11 采购分析接源（itempurchase + fct_purchase + 采购族 6 条 L1） ([#641](https://github.com/MYTech-Co-LTD/platform-core/pull/641), [295234d](https://github.com/MYTech-Co-LTD/platform-core/commit/295234d48fde99843aacc8ddbcd12388355e5e8c))


## [0.110.4](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.110.3...v0.110.4) - 2026-10-13
- 【修复】data: 补新八源新鲜度锚（湖侧 owners） ([#638](https://github.com/MYTech-Co-LTD/platform-core/pull/638), [b00e16f](https://github.com/MYTech-Co-LTD/platform-core/commit/b00e16f4657edf6dcaa83f6c6e07e92005ce291e))


## [0.110.3](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.110.2...v0.110.3) - 2026-10-13
- 【修复】data: 三个 W3 staging 模型路径模板去多余斜杠 ([#635](https://github.com/MYTech-Co-LTD/platform-core/pull/635), [ebe46f4](https://github.com/MYTech-Co-LTD/platform-core/commit/ebe46f436129fcb5b33177e9dbedc9ac36719ac2))


## [0.110.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.110.1...v0.110.2) - 2026-10-13
- 【修复】data: D17 库存快照窗口改 ${date-2d} + 分页扩容防静默截断 ([#633](https://github.com/MYTech-Co-LTD/platform-core/pull/633), [49fdac0](https://github.com/MYTech-Co-LTD/platform-core/commit/49fdac0933223197aab6433e82792de2288c7e53))


## [0.110.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.110.0...v0.110.1) - 2026-10-13
- 【修复】data: 6 条指标波管线补排班 + 源头闸补完整性方向 ([#631](https://github.com/MYTech-Co-LTD/platform-core/pull/631), [e91f12c](https://github.com/MYTech-Co-LTD/platform-core/commit/e91f12cbf6a8a9cf36bdb59499ba4bbf5c29ac94))


## [0.110.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.109.0...v0.110.0) - 2026-10-13
- 【新增】data: 库存 L1 两条（quantity/money）+ 对账（W3 inventory 面） ([#629](https://github.com/MYTech-Co-LTD/platform-core/pull/629), [9f6f714](https://github.com/MYTech-Co-LTD/platform-core/commit/9f6f7142f19303b3f6ccb3a48401a25c5aae7ea9))


## [0.109.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.108.2...v0.109.0) - 2026-10-13
- 【新增】data: W3 要货/调入/库存快照接源与构件（D15/D16/D17 + fct_inventory_snapshot + X08） ([#627](https://github.com/MYTech-Co-LTD/platform-core/pull/627), [11fecc0](https://github.com/MYTech-Co-LTD/platform-core/commit/11fecc0e439d0fc648b5185e27af4cb4a6a36b1d))


## [0.108.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.108.1...v0.108.2) - 2026-10-13
- 【修复】data: branch 对账删除 where state_code 残留行（终局） ([#625](https://github.com/MYTech-Co-LTD/platform-core/pull/625), [e6cbd31](https://github.com/MYTech-Co-LTD/platform-core/commit/e6cbd318a50024aef87fcd5c00ad6819e3cd1df8))


## [0.108.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.108.0...v0.108.1) - 2026-10-13
- 【修复】data: branch 费用对账去掉湖上不存在的 state_code 过滤 ([#624](https://github.com/MYTech-Co-LTD/platform-core/pull/624), [792eb70](https://github.com/MYTech-Co-LTD/platform-core/commit/792eb70970018659f81e206a9d11c535651b56db))


## [0.108.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.107.0...v0.108.0) - 2026-10-13
- 【新增】data: 乐檬指标 W2 费用两件套（D04/D05 接源 + 费用构件 + L1 六条） ([#623](https://github.com/MYTech-Co-LTD/platform-core/pull/623), [9fa91c0](https://github.com/MYTech-Co-LTD/platform-core/commit/9fa91c0e418aac858c7b360fa6639f177a27671a))


## [0.107.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.106.13...v0.107.0) - 2026-10-13
- 【新增】data: 裁1/裁8 回签落地——10 条指标转 certified ([#621](https://github.com/MYTech-Co-LTD/platform-core/pull/621), [c9180b4](https://github.com/MYTech-Co-LTD/platform-core/commit/c9180b43244032642314fcbed6b96af5128aff7d))


## [0.106.13](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.106.12...v0.106.13) - 2026-10-12
- 【修复】data: union wholesale 臂 line_count 字面 0 改真值 ([#620](https://github.com/MYTech-Co-LTD/platform-core/pull/620), [16fc966](https://github.com/MYTech-Co-LTD/platform-core/commit/16fc966e867c485f819d1e413c43aedc45078678))


## [0.106.12](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.106.11...v0.106.12) - 2026-10-12
- 【修复】data: fct_hq_outbound.line_count 显式 ::bigint ([#619](https://github.com/MYTech-Co-LTD/platform-core/pull/619), [dec5fa0](https://github.com/MYTech-Co-LTD/platform-core/commit/dec5fa0bf0f48b22879350aaffabc76bd9c3c73a))


## [0.106.11](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.106.10...v0.106.11) - 2026-10-12
- 【修复】data: outbound 对账块字面 {now} 修正（#615 patch 残留） ([#618](https://github.com/MYTech-Co-LTD/platform-core/pull/618), [34a7154](https://github.com/MYTech-Co-LTD/platform-core/commit/34a71546be790920f61e493c703d78996e965c4a))


## [0.106.10](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.106.9...v0.106.10) - 2026-10-12
- 【修复】data: wholesale_lines CTE 顺序修正 ([#617](https://github.com/MYTech-Co-LTD/platform-core/pull/617), [3a11305](https://github.com/MYTech-Co-LTD/platform-core/commit/3a11305207189c8907cc336dcbfb5fe4520c3622))


## [0.106.9](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.106.8...v0.106.9) - 2026-10-12
- 【修复】data: transfer_lines 补 line_count 列 ([#616](https://github.com/MYTech-Co-LTD/platform-core/pull/616), [f7469df](https://github.com/MYTech-Co-LTD/platform-core/commit/f7469df9088414fecaf8575ee90e3fea4a852935))


## [0.106.8](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.106.7...v0.106.8) - 2026-10-12
- 【修复】data: 出库行数语义修正（行级行数，两域对账同构） ([#615](https://github.com/MYTech-Co-LTD/platform-core/pull/615), [375db85](https://github.com/MYTech-Co-LTD/platform-core/commit/375db85ac0dee0fc4c0ce852bc3392b3feb3b638))


## [0.106.7](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.106.6...v0.106.7) - 2026-10-12
- 【修复】data: 空转自检 null 行归一（冲突叠层残留终局清理） ([#614](https://github.com/MYTech-Co-LTD/platform-core/pull/614), [54f83d4](https://github.com/MYTech-Co-LTD/platform-core/commit/54f83d4152f5226b9aaadc871f3873a8d38a9264))


## [0.106.6](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.106.5...v0.106.6) - 2026-10-12
- 【修复】data: 清除对账文件冲突标记 + 空转 null 数全量对齐 ([#613](https://github.com/MYTech-Co-LTD/platform-core/pull/613), [537eb62](https://github.com/MYTech-Co-LTD/platform-core/commit/537eb629b3247a640a905ccb06ecd7b1ce3f484b))


## [0.106.5](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.106.4...v0.106.5) - 2026-10-12
- 【修复】data: 对账空转自检 null 数对齐（=主 select 列数−note） ([#612](https://github.com/MYTech-Co-LTD/platform-core/pull/612), [7793fc1](https://github.com/MYTech-Co-LTD/platform-core/commit/7793fc1fcd3e31048ee962c70c38e2a6790f382e))


## [0.106.4](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.106.3...v0.106.4) - 2026-10-12
- 【修复】data: rate 对账 recheck 派生列 + 空转自检列数对齐 ([#611](https://github.com/MYTech-Co-LTD/platform-core/pull/611), [1d02d72](https://github.com/MYTech-Co-LTD/platform-core/commit/1d02d72925134a715364920b09f28d263c1c6e3c))


## [0.106.3](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.106.2...v0.106.3) - 2026-10-12
- 【修复】data: W1 真机暴露两处（quality 模型 group by + rate 对账比较式） ([#610](https://github.com/MYTech-Co-LTD/platform-core/pull/610), [786ae8b](https://github.com/MYTech-Co-LTD/platform-core/commit/786ae8b2ccaf683b2ec11df758f0267272547488))


## [0.106.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.106.1...v0.106.2) - 2026-10-12
- 【修复】data: audit var 渲染修复 + D03 schema decimal（W1 验收发现两处） ([#609](https://github.com/MYTech-Co-LTD/platform-core/pull/609), [14539ff](https://github.com/MYTech-Co-LTD/platform-core/commit/14539fff4f3c5bb39789a92f9baa9a7117426a41))


## [0.106.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.106.0...v0.106.1) - 2026-10-12
- 【修复】data: 管线 schema 申报 object→decimal（duckle 枚举） ([#607](https://github.com/MYTech-Co-LTD/platform-core/pull/607), [7820812](https://github.com/MYTech-Co-LTD/platform-core/commit/7820812b5872824dbdb9804d1f7b605a3ba61637))


## [0.106.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.105.0...v0.106.0) - 2026-10-12
- 【修复】data: 生成器豁免回填变体管线（.backfill. 文件名） ([#606](https://github.com/MYTech-Co-LTD/platform-core/pull/606), [ae9a6c6](https://github.com/MYTech-Co-LTD/platform-core/commit/ae9a6c6096c163b0d13b4375d8d9b73494d9c539))
- 【新增】data: 批发销售回填变体管线（BIZDAY 参数化） ([#605](https://github.com/MYTech-Co-LTD/platform-core/pull/605), [129d847](https://github.com/MYTech-Co-LTD/platform-core/commit/129d8470caa993e271ae0e0a0da9c57c77016b7b))


## [0.106.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.105.0...v0.106.0) - 2026-10-12
- 【新增】data: 批发销售回填变体管线（BIZDAY 参数化） ([#605](https://github.com/MYTech-Co-LTD/platform-core/pull/605), [129d847](https://github.com/MYTech-Co-LTD/platform-core/commit/129d8470caa993e271ae0e0a0da9c57c77016b7b))


## [0.105.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.104.1...v0.105.0) - 2026-10-12
- 【新增】data: 乐檬指标 W1 transfer/wholesale 骨架（D03 接源 + 出域构件 + 首批 ratio） ([#604](https://github.com/MYTech-Co-LTD/platform-core/pull/604), [4491cdf](https://github.com/MYTech-Co-LTD/platform-core/commit/4491cdfd66f32ec03e7f14bf8eac6751cb2e9700))


## [0.104.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.104.0...v0.104.1) - 2026-10-12
- 【修复】openclaw: zh-thinking 换格式契约措辞，山海生产实证中文思考可控 ([#602](https://github.com/MYTech-Co-LTD/platform-core/pull/602), [282ac22](https://github.com/MYTech-Co-LTD/platform-core/commit/282ac22bb1c08e40e8aed65e47e9a63b217e1caf))


## [0.104.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.103.0...v0.104.0) - 2026-10-12
- 【新增】data: 乐檬指标 W0 语义基建（净额口径落地 + L1 ratio 支持） ([#599](https://github.com/MYTech-Co-LTD/platform-core/pull/599), [b7d11f0](https://github.com/MYTech-Co-LTD/platform-core/commit/b7d11f0a000d8b75fdf99456b570e042b9760dd4))


## [0.103.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.102.0...v0.103.0) - 2026-10-12
- 【新增】openclaw: 企微思考折叠定型——终帧思考正文同帧闭合、占位回归空块 (#596) ([#597](https://github.com/MYTech-Co-LTD/platform-core/pull/597), [81e2dc3](https://github.com/MYTech-Co-LTD/platform-core/commit/81e2dc3c4239bb8733fe32112becd22fb883c674))


## [0.102.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.101.0...v0.102.0) - 2026-10-12
- 【新增】openclaw: 企微占位改文字「思考中…」——去掉原生动画与「动画→文字」跳变 ([#595](https://github.com/MYTech-Co-LTD/platform-core/pull/595), [7b28ea2](https://github.com/MYTech-Co-LTD/platform-core/commit/7b28ea24d1c696733eadb23c1856038a895df73f))


## [0.101.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.100.1...v0.101.0) - 2026-10-12
- 【新增】data: L2 表达力放开到 B 中档（受限表达式）(#576) ([#591](https://github.com/MYTech-Co-LTD/platform-core/pull/591), [752ba53](https://github.com/MYTech-Co-LTD/platform-core/commit/752ba53db9ba7122087eb368aea3f30dd35eec6f))


## [0.100.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.100.0...v0.100.1) - 2026-10-12
- 【修复】openclaw: zh-thinking 钩子注册 API 用错——公开 API 是 api.on，加兼容垫片 ([#590](https://github.com/MYTech-Co-LTD/platform-core/pull/590), [6e91572](https://github.com/MYTech-Co-LTD/platform-core/commit/6e915721688409999921757bcae2c104f5ffe5be))


## [0.100.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.99.1...v0.100.0) - 2026-10-12
- 【新增】openclaw: 中文思考插件——before_prompt_build 钩子前置注入语言要求 ([#588](https://github.com/MYTech-Co-LTD/platform-core/pull/588), [f8ca44b](https://github.com/MYTech-Co-LTD/platform-core/commit/f8ca44b54cd29e9368fca2df937550a7401d612f))


## [0.99.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.99.0...v0.99.1) - 2026-10-12
- 【修复】openclaw: 思考内容不渲染——推理帧改闭合发送 + 节流 800→300ms ([#586](https://github.com/MYTech-Co-LTD/platform-core/pull/586), [02aed85](https://github.com/MYTech-Co-LTD/platform-core/commit/02aed859628956930e6674c09332aee66a36ade6))


## [0.99.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.98.4...v0.99.0) - 2026-10-12
- 【新增】openclaw: 思考过程流式桥——WS 路径注入 onReasoningStream + <think> 渲染（含 20480 字节正文优先） ([#584](https://github.com/MYTech-Co-LTD/platform-core/pull/584), [fc6d9ed](https://github.com/MYTech-Co-LTD/platform-core/commit/fc6d9ed789a1fcb40ef75c68e804e542e533fb1a))


## [0.98.4](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.98.3...v0.98.4) - 2026-10-12
- 【修复】openclaw: data-query 插件工具返回形状对齐 OpenClaw 契约（补 content[]） ([#578](https://github.com/MYTech-Co-LTD/platform-core/pull/578), [c01e843](https://github.com/MYTech-Co-LTD/platform-core/commit/c01e843e2610775018a1eb656ca1c48ad27c427e))


## [0.98.3](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.98.2...v0.98.3) - 2026-10-10
- 【修复】openclaw: Dockerfile.openclaw 的 FROM 行尾注释致 dockerfile 解析失败 ([#571](https://github.com/MYTech-Co-LTD/platform-core/pull/571), [9383f82](https://github.com/MYTech-Co-LTD/platform-core/commit/9383f82fbe3438793fc7c9c3bb5a200617907186))


## [0.98.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.98.1...v0.98.2) - 2026-10-10
- 【修复】openclaw: 插件改走构建期 COPY——相对 bind 被 openship 当卷名致容器建不起来 ([#569](https://github.com/MYTech-Co-LTD/platform-core/pull/569), [2ecb839](https://github.com/MYTech-Co-LTD/platform-core/commit/2ecb83971d3e15865e90720f53d9b9046724ed90))


## [0.98.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.98.0...v0.98.1) - 2026-10-10
- 【优化】server: 模块 userApp 静态面纳入缓存档（#564） ([#567](https://github.com/MYTech-Co-LTD/platform-core/pull/567), [a24e601](https://github.com/MYTech-Co-LTD/platform-core/commit/a24e601ad52e50d2dd778b33e61ea2af827039c4))


## [0.98.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.97.1...v0.98.0) - 2026-10-10
- 【新增】data: 告警覆盖门禁——被调度管线必须有含 failure 的规则覆盖（#565） ([#566](https://github.com/MYTech-Co-LTD/platform-core/pull/566), [2963777](https://github.com/MYTech-Co-LTD/platform-core/commit/29637776aba3c4078f859409c461b45647c681af))


## [0.97.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.97.0...v0.97.1) - 2026-10-10
- 【修复】data: 补 3120 账套专属 L0 管线失败告警规则（#538） ([#562](https://github.com/MYTech-Co-LTD/platform-core/pull/562), [cd9a9c4](https://github.com/MYTech-Co-LTD/platform-core/commit/cd9a9c4e0868796f94fe24e567a7e1c8e65328fd))


## [0.97.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.96.0...v0.97.0) - 2026-10-10
- 【新增】server: wechat-oa /silent 会话短路——入口即授权，SPA 只载一次 ([#561](https://github.com/MYTech-Co-LTD/platform-core/pull/561), [601f2a8](https://github.com/MYTech-Co-LTD/platform-core/commit/601f2a805e89a46d266ab47035a87bf6057523e0))


## [0.96.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.95.0...v0.96.0) - 2026-10-10
- 【新增】openclaw: shanhai 企微问数 bot——compose 单元 A + data-query 插件（通道 C 部署面） ([#559](https://github.com/MYTech-Co-LTD/platform-core/pull/559), [249dba5](https://github.com/MYTech-Co-LTD/platform-core/commit/249dba5bb9e41d42493dd2e7c01c134afaa51c51))


## [0.95.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.94.0...v0.95.0) - 2026-10-10
- 【新增】data: 探活⑧——dim_item_price 面新鲜度断言，补价目管线失败告警盲区 ([#538](https://github.com/MYTech-Co-LTD/platform-core/pull/538), [f8413c2](https://github.com/MYTech-Co-LTD/platform-core/commit/f8413c25d596252345295fefc0d3ab56c63c8b3f))


## [0.94.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.93.1...v0.94.0) - 2026-10-10
- 【新增】aftersales: 账户统一 Phase 1——绑定表+两态 session+自动匹配 (#555) ([#556](https://github.com/MYTech-Co-LTD/platform-core/pull/556), [bc39ceb](https://github.com/MYTech-Co-LTD/platform-core/commit/bc39cebe152efea25c677af004f97d6ae3e3764b))


## [0.93.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.93.0...v0.93.1) - 2026-10-10
- 【修复】data: 对账脚本字段偏移与 DEST 比对修正 ([#538](https://github.com/MYTech-Co-LTD/platform-core/pull/538), [780340d](https://github.com/MYTech-Co-LTD/platform-core/commit/780340d7ba16768e61059ac13120e65e41cc1de4))


## [0.93.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.92.0...v0.93.0) - 2026-10-10
- 【新增】data: OO 预警配置漂移对账——登记清单 + 审计脚本 ([#538](https://github.com/MYTech-Co-LTD/platform-core/pull/538), [a52580b](https://github.com/MYTech-Co-LTD/platform-core/commit/a52580ba531c494d69d0949f594fc1ea542f9887))


## [0.92.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.91.1...v0.92.0) - 2026-10-10
- 【新增】data: 桥接 v1.3 通道③——基建探活家族点火转发 ([#538](https://github.com/MYTech-Co-LTD/platform-core/pull/538), [dbb907e](https://github.com/MYTech-Co-LTD/platform-core/commit/dbb907ea89e1dadb945a2f3f84ef7ceb3fdf8cc2))


## [0.91.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.91.0...v0.91.1) - 2026-10-10
- 【修复】data: 探活判红行改逐行 POST——本 OO 构建 _json 端点拒多行 NDJSON 批 ([#538](https://github.com/MYTech-Co-LTD/platform-core/pull/538), [68fac21](https://github.com/MYTech-Co-LTD/platform-core/commit/68fac2178f301c378f0a8fc027ec9cad8317527e))


## [0.91.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.90.1...v0.91.0) - 2026-10-10
- 【新增】data: 探活逐断言判红行入 OO + 桥接 v1.2 双通道 ([#538](https://github.com/MYTech-Co-LTD/platform-core/pull/538), [a7b184c](https://github.com/MYTech-Co-LTD/platform-core/commit/a7b184cd0a2cb14cfaa025fe50763b55485dbe5d))


## [0.90.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.90.0...v0.90.1) - 2026-10-10
- 【修复】data: 桥接 v1.1——信号源改轮询 data_alerts 流新行 ([#538](https://github.com/MYTech-Co-LTD/platform-core/pull/538), [4bb2f8a](https://github.com/MYTech-Co-LTD/platform-core/commit/4bb2f8a6a612f5a81b1cfa48f4a1a5531addc5d6))


## [0.90.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.89.0...v0.90.0) - 2026-10-10
- 【新增】data: OO 告警桥接通知——元库新点火直发企微，过渡架构 ([#538](https://github.com/MYTech-Co-LTD/platform-core/pull/538), [9da39bc](https://github.com/MYTech-Co-LTD/platform-core/commit/9da39bcf8d976ce51934b44b6d084f8582b47aae))


## [0.89.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.88.5...v0.89.0) - 2026-10-10
- 【新增】data: OO 存活看门狗 v1 + Phase 0 流布局定案与状态回写 ([#538](https://github.com/MYTech-Co-LTD/platform-core/pull/538), [fc90a39](https://github.com/MYTech-Co-LTD/platform-core/commit/fc90a39604097e2553c6ba9cf6eb70d906901023))


## [0.88.5](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.88.4...v0.88.5) - 2026-10-10
- 【修复】data: 探活⑦取价面容差改时段感知——上海13点前-3后-2，对齐发布节奏 ([#534](https://github.com/MYTech-Co-LTD/platform-core/pull/534), [2e2b33a](https://github.com/MYTech-Co-LTD/platform-core/commit/2e2b33a97b9b0087393e44a6c0785835dc8ba252))


## [0.88.4](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.88.3...v0.88.4) - 2026-10-09
- 【修复】data: seed 期望集按账套后缀过滤 + console 排班完整性门禁（#531） ([#532](https://github.com/MYTech-Co-LTD/platform-core/pull/532), [d7a9e44](https://github.com/MYTech-Co-LTD/platform-core/commit/d7a9e44af053fb3f3c4c780dc8f495a4a94b6d39))


## [0.88.3](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.88.2...v0.88.3) - 2026-10-09
- 【修复】data: 回填管线加 bizday 闭窗守卫 + heal 常设旁路失效冻结 checkpoint（#528） ([#529](https://github.com/MYTech-Co-LTD/platform-core/pull/529), [1ee3ff4](https://github.com/MYTech-Co-LTD/platform-core/commit/1ee3ff40af41c1cc243311055187721da52d72e2))


## [0.88.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.88.1...v0.88.2) - 2026-10-09
- 【修复】data: #525 分批切片保持换行分隔（#526 follow-up，真机首跑实测） ([#527](https://github.com/MYTech-Co-LTD/platform-core/pull/527), [4a05438](https://github.com/MYTech-Co-LTD/platform-core/commit/4a05438f0aa168c589b748ca6b4a71e716e2bb76))


## [0.88.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.88.0...v0.88.1) - 2026-10-09
- 【修复】data: #525 recon-preagg 分批调用——报表端点单次 branch_nums ≤100 家，3120（147 家）必分批（真机实测） ([#526](https://github.com/MYTech-Co-LTD/platform-core/pull/526), [841db96](https://github.com/MYTech-Co-LTD/platform-core/commit/841db962e069e047225ce76fcb102bdce9b1b045))


## [0.88.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.87.3...v0.88.0) - 2026-10-09
- 【新增】aftersales: #500 ticket 自然键化 + 建单挂原单冻结 + 选单端点（含 mobile 选单链） ([#524](https://github.com/MYTech-Co-LTD/platform-core/pull/524), [9696b73](https://github.com/MYTech-Co-LTD/platform-core/commit/9696b737c2e259f398123ffad06745a1ba1ab237))


## [0.87.3](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.87.2...v0.87.3) - 2026-10-09
- 【修复】data: #517 wholesale 分支补选 m.org——union 列数对齐（#522 follow-up） ([#523](https://github.com/MYTech-Co-LTD/platform-core/pull/523), [23d23e7](https://github.com/MYTech-Co-LTD/platform-core/commit/23d23e7e1ae375667870b7ef0e41df6f8837e88b))


## [0.87.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.87.1...v0.87.2) - 2026-10-09
- 【修复】data: #517 取价面 transfer 分支补选 org（#521 follow-up，真机首跑实测） ([#522](https://github.com/MYTech-Co-LTD/platform-core/pull/522), [e334bc2](https://github.com/MYTech-Co-LTD/platform-core/commit/e334bc201ca7869fe057d36dccf2e9ca7189377b))


## [0.87.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.87.0...v0.87.1) - 2026-10-09
- 【修复】data: #517 override 空表 ⇒ node-pg 退简单协议 $1 无绑定——条件拼装 ov join（#520 首跑 follow-up） ([#521](https://github.com/MYTech-Co-LTD/platform-core/pull/521), [5fa4fd7](https://github.com/MYTech-Co-LTD/platform-core/commit/5fa4fd7eb4e0640a9cd5e55485c2951004ccbe1d))


## [0.87.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.86.0...v0.87.0) - 2026-10-09
- 【新增】data: #517 dim_settlement_order_line 归一取价面——transfer∪wholesale 经门店映射 ([#520](https://github.com/MYTech-Co-LTD/platform-core/pull/520), [9c9735b](https://github.com/MYTech-Co-LTD/platform-core/commit/9c9735b99f45acd0bb4759e601217463b61d41a8))


## [0.86.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.85.3...v0.86.0) - 2026-10-09
- 【新增】data: #516 lemeng.client 客户档案采集源——工单取价对照表（#500 段①） ([#519](https://github.com/MYTech-Co-LTD/platform-core/pull/519), [f6fd1f7](https://github.com/MYTech-Co-LTD/platform-core/commit/f6fd1f732ac455973d419c290f1f252a69973307))


## [0.85.3](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.85.2...v0.85.3) - 2026-10-08
- 【修复】data: wholesale 发布仓库查询 bizday::text——node-pg DATE→JS Date 长串进 date[] 解析炸（#511 收尾） ([#514](https://github.com/MYTech-Co-LTD/platform-core/pull/514), [347f8af](https://github.com/MYTech-Co-LTD/platform-core/commit/347f8afe6fe1e5aec43e1df8d886a89128891255))


## [0.85.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.85.1...v0.85.2) - 2026-10-08
- 【修复】data: 批发管线 date_type 改回 制单时间——组合反转实测（#511 修正） ([#513](https://github.com/MYTech-Co-LTD/platform-core/pull/513), [88bea26](https://github.com/MYTech-Co-LTD/platform-core/commit/88bea26cf516efc57ccb03d684447f56ed8f745a))


## [0.85.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.85.0...v0.85.1) - 2026-10-08
- 【修复】data: 批发管线补哨兵 die + 扩容 19 页——首跑实测单量打穿 9 页上限（#511 收尾） ([#512](https://github.com/MYTech-Co-LTD/platform-core/pull/512), [e127997](https://github.com/MYTech-Co-LTD/platform-core/commit/e12799721ce7b7d02a2c1207dc1daaa9b9f95321))


## [0.85.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.84.4...v0.85.0) - 2026-10-08
- 【新增】data: #499 R3 批发销售单采集——契约 + L0 管线 + staging + dim_wholesale_out 发布（3120） ([#510](https://github.com/MYTech-Co-LTD/platform-core/pull/510), [dd599a9](https://github.com/MYTech-Co-LTD/platform-core/commit/dd599a9c9a9783e56c7a77883ebdcca54cf82492))


## [0.84.4](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.84.3...v0.84.4) - 2026-10-08
- 【修复】data: transfer_out 发布两连修——insert 参数对齐 + bizday ::text（#499 收尾） ([#509](https://github.com/MYTech-Co-LTD/platform-core/pull/509), [c10591b](https://github.com/MYTech-Co-LTD/platform-core/commit/c10591ba22dee8b0b4b852ab27f6af47a2bae6d6))


## [0.84.3](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.84.2...v0.84.3) - 2026-10-08
- 【修复】data: dim_transfer_out 发布 insert 两处参数错位修正—— 空悬 + bizday 整列数组误入标量位 ([#508](https://github.com/MYTech-Co-LTD/platform-core/pull/508), [e17d288](https://github.com/MYTech-Co-LTD/platform-core/commit/e17d28898e10e0fe7fa3ae9ddb106b040b157130))


## [0.84.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.84.1...v0.84.2) - 2026-10-08
- 【修复】data: 调出单窗口改单段 date-1d——组合段替换层不生效（#499 R2 修正） ([#507](https://github.com/MYTech-Co-LTD/platform-core/pull/507), [dd73355](https://github.com/MYTech-Co-LTD/platform-core/commit/dd73355cb041067992a1fd1967024eda2b1f7f25))


## [0.84.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.84.0...v0.84.1) - 2026-10-08
- 【修复】data: merge 后漏重算 data-plane.lock——sources.yml 哈希过期致 check-data-plane-lock 红 ([#506](https://github.com/MYTech-Co-LTD/platform-core/pull/506), [4cb135e](https://github.com/MYTech-Co-LTD/platform-core/commit/4cb135eb8cc96368c2d8dcd3f6bf76e1eda1e4ba))


## [0.84.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.83.0...v0.84.0) - 2026-10-08
- 【新增】data: #499 R2 配送调出单采集——契约 + L0 管线 + staging + dim_transfer_out 发布（3120 单账套） ([#505](https://github.com/MYTech-Co-LTD/platform-core/pull/505), [3c7527e](https://github.com/MYTech-Co-LTD/platform-core/commit/3c7527e71b2f7668b95e76ad578aace03095dd50))


## [0.83.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.82.2...v0.83.0) - 2026-10-08
- 【新增】data: 价格批改增量模型——bizday 事件分区 + 请求侧水位（#499 R1） ([#504](https://github.com/MYTech-Co-LTD/platform-core/pull/504), [9066c23](https://github.com/MYTech-Co-LTD/platform-core/commit/9066c23b83f212d55c8aaa04b2d488fe581bf8a6))


## [0.82.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.82.1...v0.82.2) - 2026-10-08
- 【修复】data: 价格批扇出改逐店一节点——批载荷爆引擎 into_string 上限（#499 首跑实测二） ([#503](https://github.com/MYTech-Co-LTD/platform-core/pull/503), [269fafe](https://github.com/MYTech-Co-LTD/platform-core/commit/269fafe7c4cf8a9e3f14cf4841371e892764bd2e))


## [0.82.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.82.0...v0.82.1) - 2026-10-08
- 【修复】data: 价格批管线 w0 补 SSE 单列申报——首跑实测拦下（#499 收尾） ([#502](https://github.com/MYTech-Co-LTD/platform-core/pull/502), [d280354](https://github.com/MYTech-Co-LTD/platform-core/commit/d2803547384a0fc34676791a57119ad22f487dea))


## [0.82.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.81.1...v0.82.0) - 2026-10-08
- 【新增】data-stack: 价格批数据面——契约 + L0 管线（双账套）+ staging + dim_item_price 发布（#481 拆段 Part 1） ([#501](https://github.com/MYTech-Co-LTD/platform-core/pull/501), [8fef7d5](https://github.com/MYTech-Co-LTD/platform-core/commit/8fef7d5a04661420a713d541abf992f2c98bf0c2))


## [0.81.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.81.0...v0.81.1) - 2026-10-08
- 【修复】data: DELETE /reports/:id 分流顺序与 POST 不一致——自绘行在没配 Metabase 的环境删不掉（恒 503） ([#498](https://github.com/MYTech-Co-LTD/platform-core/pull/498), [cb88d6e](https://github.com/MYTech-Co-LTD/platform-core/commit/cb88d6eac196f6ea15d1d60a02412be9a133a569))


## [0.81.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.80.0...v0.81.0) - 2026-10-07
- 【新增】data: 报表 agent 制作通路——MCP 工具面（能提、不能发） ([#497](https://github.com/MYTech-Co-LTD/platform-core/pull/497), [9a4d2fc](https://github.com/MYTech-Co-LTD/platform-core/commit/9a4d2fcfe0dbe3dc07194e7d644aed579786bb5e))


## [0.80.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.79.0...v0.80.0) - 2026-10-07
- 【新增】data: 语义追溯——操作人 + 版本 + 变更审计（含指标页两列与历史抽屉） ([#491](https://github.com/MYTech-Co-LTD/platform-core/pull/491), [865ba9c](https://github.com/MYTech-Co-LTD/platform-core/commit/865ba9ccbdf36af78cbdd46299ba8af45307b5a0))


## [0.79.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.78.1...v0.79.0) - 2026-10-07
- 【新增】data: MCP 写面——/mcp-manage 三工具，门禁由声明施加 ([#487](https://github.com/MYTech-Co-LTD/platform-core/pull/487), [f60b7cd](https://github.com/MYTech-Co-LTD/platform-core/commit/f60b7cd199324e16d938a3b482afffe3757c449b))


## [0.78.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.78.0...v0.78.1) - 2026-10-07
- 【修复】aftersales: #483 夹具自愈改跑 data 包迁移——顺序无关（旧实现只执行 009，假定 data schema 已存在） ([#484](https://github.com/MYTech-Co-LTD/platform-core/pull/484), [89a71fe](https://github.com/MYTech-Co-LTD/platform-core/commit/89a71fefc05e360848cbd0c53bfe42f24b1a618e))


## [0.78.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.77.0...v0.78.0) - 2026-10-07
- 【新增】aftersales: #476 售后维表消费面换源——清单端点切 data.dim_* 发布快照 ([#480](https://github.com/MYTech-Co-LTD/platform-core/pull/480), [53c5131](https://github.com/MYTech-Co-LTD/platform-core/commit/53c513125a13dc56de820202dfbfd4f1a5c62f4e))


## [0.77.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.76.1...v0.77.0) - 2026-10-07
- 【新增】data: #476 发布维表改跨账套去重租户视图（口径①方案 C）+ 消费面实施计划 ([#479](https://github.com/MYTech-Co-LTD/platform-core/pull/479), [be3e8f0](https://github.com/MYTech-Co-LTD/platform-core/commit/be3e8f05ee5dee217ccc25290ba2f0a6cc66d801))


## [0.76.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.76.0...v0.76.1) - 2026-10-07
- 【修复】data: #476 发布脚本拆分 branch/item scope——UNION 合并会让 item 恒 0 行 ([#478](https://github.com/MYTech-Co-LTD/platform-core/pull/478), [4d7e2bf](https://github.com/MYTech-Co-LTD/platform-core/commit/4d7e2bfd7fbd5ee4732792e9b41df7595be016a6))


## [0.76.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.75.0...v0.76.0) - 2026-10-07
- 【新增】data: #476 维表发布面——data.dim_* 快照 + 发布脚本 + B1 只读豁免 + 探活⑥ ([#477](https://github.com/MYTech-Co-LTD/platform-core/pull/477), [1f9996b](https://github.com/MYTech-Co-LTD/platform-core/commit/1f9996b1281ca4c911c9a17d0d9c6cc02a2da752))


## [0.75.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.74.2...v0.75.0) - 2026-10-06
- 【新增】docs: #468 采集接源流程固化成 collect-source skill（A→I 判停门 + 公司化触发条件） ([#469](https://github.com/MYTech-Co-LTD/platform-core/pull/469), [95a3c8b](https://github.com/MYTech-Co-LTD/platform-core/commit/95a3c8bab7d4f3b8538f46e2a9102b89234962bd))


## [0.74.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.74.1...v0.74.2) - 2026-10-06
- 【修复】data: #452 A+E1——问数咽喉 ETag 重试恰一次 + 物化 job 错峰 ([#465](https://github.com/MYTech-Co-LTD/platform-core/pull/465), [6058f1d](https://github.com/MYTech-Co-LTD/platform-core/commit/6058f1d5215b593f687b152eb14468a5abef1958))


## [0.74.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.74.0...v0.74.1) - 2026-10-06
- 【修复】dbt: 对账四条 audit 只比已闭窗营业日——消读湖撞 tick 的 ETag 竞态（Closes #462） ([#463](https://github.com/MYTech-Co-LTD/platform-core/pull/463), [2fd1f1a](https://github.com/MYTech-Co-LTD/platform-core/commit/2fd1f1ac02208c834e05751e63ed144f800cd6d4))


## [0.74.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.73.0...v0.74.0) - 2026-10-06
- 【新增】contracts: 契约生成器 —— 契约一处改，管线投影与 staging 由生成器产出（B10 降级为保险丝） ([#461](https://github.com/MYTech-Co-LTD/platform-core/pull/461), [05fa858](https://github.com/MYTech-Co-LTD/platform-core/commit/05fa858bd79ee9a07a4c83f25ef171b11d554ab3))


## [0.73.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.72.0...v0.73.0) - 2026-10-06
- 【新增】dbt: 对账判别式落 audit——赠品命中集复算重落 + 换货半边输入形状守卫（Closes #444） ([#453](https://github.com/MYTech-Co-LTD/platform-core/pull/453), [83ad5fd](https://github.com/MYTech-Co-LTD/platform-core/commit/83ad5fd6c0e5c07d3efeb1cc3025239733b330da))


## [0.72.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.71.1...v0.72.0) - 2026-10-06
- 【新增】data: 「下游看得见」探测落地——探活链增 PG 新鲜度/词表非空断言 + 台账订正 ([#451](https://github.com/MYTech-Co-LTD/platform-core/pull/451), [0602d49](https://github.com/MYTech-Co-LTD/platform-core/commit/0602d49c10b798ae57c09c1b5a3d7796e5c6a6db))


## [0.71.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.71.0...v0.71.1) - 2026-10-06
- 【修复】lemeng: seed-console all 模式三件配置源路径补回 console 前缀（Closes #449） ([#450](https://github.com/MYTech-Co-LTD/platform-core/pull/450), [39fbec9](https://github.com/MYTech-Co-LTD/platform-core/commit/39fbec90b814b11da93e22842ee91d298d2a04ed))


## [0.71.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.70.3...v0.71.0) - 2026-10-06
- 【新增】data-plane: recon-preagg 判据迁入 console 接调度（首个判据类迁移案例） ([#447](https://github.com/MYTech-Co-LTD/platform-core/pull/447), [24f561b](https://github.com/MYTech-Co-LTD/platform-core/commit/24f561ba268173e1f938829e84a5bc7e4efcc197))


## [0.70.3](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.70.2...v0.70.3) - 2026-10-05
- 【修复】lemeng: recon-preagg 换口径（湖侧自算「送出半边」）+ 三份文档订正 ([#443](https://github.com/MYTech-Co-LTD/platform-core/pull/443), [ca5b022](https://github.com/MYTech-Co-LTD/platform-core/commit/ca5b022b5eb1fd7400ed5cfb92f7a70a50363e08))


## [0.70.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.70.1...v0.70.2) - 2026-10-05
- 【修复】lemeng: 迁移步——staging 补 order_total_money + 封版断言（consumerVersion 3） ([#442](https://github.com/MYTech-Co-LTD/platform-core/pull/442), [8d00070](https://github.com/MYTech-Co-LTD/platform-core/commit/8d000702c8f9d43f79bf091c218c7a4a8e59cc83))


## [0.70.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.70.0...v0.70.1) - 2026-10-05
- 【修复】lemeng: 补齐 src.rest 的 data.schema + B10 加「申报面」判据（#432 只改了 flatten） ([#440](https://github.com/MYTech-Co-LTD/platform-core/pull/440), [0c77eb4](https://github.com/MYTech-Co-LTD/platform-core/commit/0c77eb4f6aa2c801da529b921225a48062489645))


## [0.70.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.69.1...v0.70.0) - 2026-10-05
- 【新增】lemeng: seed-console.sh + 修 check-data-plane-lock 的目录条目误报 ([#438](https://github.com/MYTech-Co-LTD/platform-core/pull/438), [412fd7e](https://github.com/MYTech-Co-LTD/platform-core/commit/412fd7e11aa3d94809c95b959cea07959b4518ad))


## [0.69.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.69.0...v0.69.1) - 2026-10-05
- 【修复】lemeng: 展开期——staging 暂不投影 order_total_money（consumerVersion 2） ([#436](https://github.com/MYTech-Co-LTD/platform-core/pull/436), [77c133d](https://github.com/MYTech-Co-LTD/platform-core/commit/77c133d7947d09b9b5f05e09811265130fbe6579))


## [0.69.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.68.0...v0.69.0) - 2026-10-05
- 【新增】lemeng: 数据契约注册门禁（B10）+ 架构文档 §5.2 —— 湖 schema 演进四件套 ([#433](https://github.com/MYTech-Co-LTD/platform-core/pull/433), [61ba861](https://github.com/MYTech-Co-LTD/platform-core/commit/61ba861cba52c4793b68ef2a22e6a0db351a7690))


## [0.68.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.67.0...v0.68.0) - 2026-10-05
- 【新增】lemeng: 补采订单级 order_total_money（换货半边口径的事实源，24→25 列） ([#432](https://github.com/MYTech-Co-LTD/platform-core/pull/432), [16dc5b7](https://github.com/MYTech-Co-LTD/platform-core/commit/16dc5b7adfd44716ad3ab5de1b09820781a30d7a))


## [0.67.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.66.0...v0.67.0) - 2026-10-05
- 【新增】lemeng: 定稿线对账的失败动作——不平⇒自动回填⇒复验（闭环驱动） ([#427](https://github.com/MYTech-Co-LTD/platform-core/pull/427), [7deccdc](https://github.com/MYTech-Co-LTD/platform-core/commit/7deccdc3a0d59920e4bdf6cf9dc99f322b051438))


## [0.66.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.65.0...v0.66.0) - 2026-10-05
- 【新增】lemeng: 按 §1.4.1 补「量级」判据与定稿线对账（dbt 量级 audit + recon-day） ([#425](https://github.com/MYTech-Co-LTD/platform-core/pull/425), [86d11a4](https://github.com/MYTech-Co-LTD/platform-core/commit/86d11a48aab452ec5984059226e5349236d10f6a))


## [0.65.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.64.2...v0.65.0) - 2026-10-05
- 【新增】duckle: #419 owners/alerts 按源系统分文件（拆掉第二个源系统的唯一阻塞点） ([#420](https://github.com/MYTech-Co-LTD/platform-core/pull/420), [d4853af](https://github.com/MYTech-Co-LTD/platform-core/commit/d4853af55aea1f5c8ddc5e4c167090b9a0842390))


## [0.64.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.64.1...v0.64.2) - 2026-10-03
- 【修复】data: #412 嵌入 URL 改回 signed embedding 页径（原拼成公开分享页径，界面恒空图） ([#413](https://github.com/MYTech-Co-LTD/platform-core/pull/413), [44eb22a](https://github.com/MYTech-Co-LTD/platform-core/commit/44eb22a827b42c2a284ff0e3d0fd6f76dbfc39aa))


## [0.64.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.64.0...v0.64.1) - 2026-10-03
- 【修复】duckle: #414 回退 L0 的 _ops 投递（该链上 snk.webhook 恒发 Success:true） ([#415](https://github.com/MYTech-Co-LTD/platform-core/pull/415), [ed14511](https://github.com/MYTech-Co-LTD/platform-core/commit/ed14511f4b8f52abb53fabbdf31c2fdf055b01d0))


## [0.64.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.63.0...v0.64.0) - 2026-10-03
- 【新增】duckle: #410 _ops 观测行投递推广四条管线（windows/close/L0×2） ([#411](https://github.com/MYTech-Co-LTD/platform-core/pull/411), [e0b5194](https://github.com/MYTech-Co-LTD/platform-core/commit/e0b51944c75275754c743fef201df3e40a4b042b))


## [0.63.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.62.0...v0.63.0) - 2026-10-03
- 【新增】duckle: #406 tick L1 补 _ops 观测行投递（su→op→wh 投 OO retail_day） ([#407](https://github.com/MYTech-Co-LTD/platform-core/pull/407), [a6f162e](https://github.com/MYTech-Co-LTD/platform-core/commit/a6f162ed1d867a50dc4fa69522f53d960be67e6c))


## [0.62.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.61.0...v0.62.0) - 2026-09-30
- 【新增】data: #391 平台自绘——声明式规格/代码常量图型白名单/echarts 渲染器/判据同源数据通路 ([#401](https://github.com/MYTech-Co-LTD/platform-core/pull/401), [0d5345e](https://github.com/MYTech-Co-LTD/platform-core/commit/0d5345ece883595db9a13a9064daa1149458758a))


## [0.61.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.60.1...v0.61.0) - 2026-09-30
- 【新增】dbt: #394 读侧 Phase 2——staging 加契约 v2 的 6 列 ([#395](https://github.com/MYTech-Co-LTD/platform-core/pull/395), [77bf082](https://github.com/MYTech-Co-LTD/platform-core/commit/77bf082458ac4a0c635a6a454fdd28fc7476be63))


## [0.60.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.60.0...v0.60.1) - 2026-09-30
- 【修复】duckle: #392 回填工具两处缺口（判据排除当天 + runbook 前置补全） ([#393](https://github.com/MYTech-Co-LTD/platform-core/pull/393), [3f62f82](https://github.com/MYTech-Co-LTD/platform-core/commit/3f62f82cf4f9d5ae8afdc0ebb0609438cf55d299))


## [0.60.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.59.0...v0.60.0) - 2026-09-30
- 【新增】data: #389 语义的源维度——租户已接入源登记/投影/裁剪/写入闸 + 指标命名三段式 ([#390](https://github.com/MYTech-Co-LTD/platform-core/pull/390), [41d8bdf](https://github.com/MYTech-Co-LTD/platform-core/commit/41d8bdf2715554c8b648cf445aeca92bc193e091))


## [0.59.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.58.0...v0.59.0) - 2026-09-30
- 【新增】duckle: #387 分批回填工具链（两道 fail-closed 闸 + 五批降序 + 批后判据） ([#388](https://github.com/MYTech-Co-LTD/platform-core/pull/388), [3f59b1d](https://github.com/MYTech-Co-LTD/platform-core/commit/3f59b1d25f37ff60903226911f03a20d27d34ca9))


## [0.58.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.57.2...v0.58.0) - 2026-09-30
- 【新增】data: #377 报表写保护——两条版本通路必填 + 每对象一把锁 + 可解释 409 ([#385](https://github.com/MYTech-Co-LTD/platform-core/pull/385), [3c3f52d](https://github.com/MYTech-Co-LTD/platform-core/commit/3c3f52d8a03d61c498508989d4d7a16708473b78))


## [0.57.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.57.1...v0.57.2) - 2026-09-29
- 【修复】duckle: #383 close 层补新鲜度锚（首点成功后随批补） ([#384](https://github.com/MYTech-Co-LTD/platform-core/pull/384), [2b1d7f0](https://github.com/MYTech-Co-LTD/platform-core/commit/2b1d7f00dc86bd5e32ba6816ebf464db4725722c))


## [0.57.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.57.0...v0.57.1) - 2026-09-29
- 【优化】duckle: #379 退役最后一里——指针改向 + P7 断言事实源改向 ([#380](https://github.com/MYTech-Co-LTD/platform-core/pull/380), [f68029f](https://github.com/MYTech-Co-LTD/platform-core/commit/f68029f6d79e966270afa43daf0d1a68b5c3ad64))


## [0.57.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.56.2...v0.57.0) - 2026-09-29
- 【新增】duckle: #367 只读诊断工具 diagnose.sh（替代 recon/rb，P1–P7 落地） ([#368](https://github.com/MYTech-Co-LTD/platform-core/pull/368), [6966d95](https://github.com/MYTech-Co-LTD/platform-core/commit/6966d9549864933a7019b251b1405df5ecaf1254))


## [0.56.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.56.1...v0.56.2) - 2026-09-29
- 【修复】deploy: mb-proxy 启停闸门改为 openship 服务级 enabled（compose profiles 对部署无效，已致一次 crash loop） ([#372](https://github.com/MYTech-Co-LTD/platform-core/pull/372), [97b7bd6](https://github.com/MYTech-Co-LTD/platform-core/commit/97b7bd6e45dbe79a73ce587bdeb099d44d943b43))


## [0.56.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.56.0...v0.56.1) - 2026-09-29
- 【修复】duckle: #370 补 tick 新鲜度锚（首次用 expectedAfterSchedule） ([#371](https://github.com/MYTech-Co-LTD/platform-core/pull/371), [9f3fc7f](https://github.com/MYTech-Co-LTD/platform-core/commit/9f3fc7f4a60b58c9f855fbb198fad5d45863b8e8))


## [0.56.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.55.0...v0.56.0) - 2026-09-29
- 【新增】data: #346 报表编辑页反代会话——专用入口 / 一次性 handoff / deny-by-default 隔离 ([#366](https://github.com/MYTech-Co-LTD/platform-core/pull/366), [8743b8e](https://github.com/MYTech-Co-LTD/platform-core/commit/8743b8eaa43da7bbd4da4eebf3520fb9be21caf8))


## [0.55.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.54.0...v0.55.0) - 2026-09-29
- 【新增】duckle: #364 Wave D 薄壳退役批 + tick/close L1 激活 ([#365](https://github.com/MYTech-Co-LTD/platform-core/pull/365), [5bcb9b1](https://github.com/MYTech-Co-LTD/platform-core/commit/5bcb9b17c5cb04c8b0b02cc540c2958b4a31cc4d))


## [0.54.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.53.2...v0.54.0) - 2026-09-29
- 【新增】duckle: #361 64188 切流——L0/L1 接管、三条薄壳置停 ([#362](https://github.com/MYTech-Co-LTD/platform-core/pull/362), [4458686](https://github.com/MYTech-Co-LTD/platform-core/commit/4458686f4b6d3d7fd3ffa1d3a3c2f832140cd2b3))


## [0.53.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.53.1...v0.53.2) - 2026-09-29
- 【修复】duckle: 零售新鲜度锚换点（原湖 glob 机制上不参与评估） ([#358](https://github.com/MYTech-Co-LTD/platform-core/pull/358), [87f0634](https://github.com/MYTech-Co-LTD/platform-core/commit/87f0634deace457de099c0015abfb7c79545cdf3))


## [0.53.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.53.0...v0.53.1) - 2026-09-29
- 【修复】server: #310 loader.test.ts 间歇 5s 超时——无迁移模块不再抢全局迁移锁 ([#345](https://github.com/MYTech-Co-LTD/platform-core/pull/345), [e4aec6b](https://github.com/MYTech-Co-LTD/platform-core/commit/e4aec6b1bfd2cc8d1371fa81f2a4fb4877a62513))


## [0.53.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.52.1...v0.53.0) - 2026-09-29
- 【新增】data: #336 报表统一管理面——管理清单/页门/发布/回收 + 对账按行降级 + renderer 守卫 ([#338](https://github.com/MYTech-Co-LTD/platform-core/pull/338), [6979273](https://github.com/MYTech-Co-LTD/platform-core/commit/697927364aa8282184b5f3ba345208174c323069))


## [0.52.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.52.0...v0.52.1) - 2026-09-29
- 【修复】duckle: #334 retail 子管线 sink 补 bucket（修复新鲜度锚死规则）+ tick/close 薄壳声明置停 ([#335](https://github.com/MYTech-Co-LTD/platform-core/pull/335), [e899107](https://github.com/MYTech-Co-LTD/platform-core/commit/e89910719013a82ef0674b438599ab9ef18e55cb))


## [0.52.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.51.0...v0.52.0) - 2026-09-29
- 【新增】duckle: #332 Wave C——retail tick/close 以 L1 tick 形首建（含 tick misfire:skip 论证） ([#333](https://github.com/MYTech-Co-LTD/platform-core/pull/333), [95468cb](https://github.com/MYTech-Co-LTD/platform-core/commit/95468cbf50c060453baf907d0ee9045a90ad00b7))


## [0.51.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.50.0...v0.51.0) - 2026-09-29
- 【新增】data: 报表制作域写路径底座——迁移/登记/读全量合并写/内容指纹/发布三件套/对账 ([#329](https://github.com/MYTech-Co-LTD/platform-core/pull/329), [2c4c439](https://github.com/MYTech-Co-LTD/platform-core/commit/2c4c43978f3055ffc72a9e464b8edc6d7045410c))


## [0.50.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.49.0...v0.50.0) - 2026-09-29
- 【新增】duckle: #294 retail_order_line 补采 6 对账字段（契约 v2 + item_code 语义归位） ([#327](https://github.com/MYTech-Co-LTD/platform-core/pull/327), [91ea693](https://github.com/MYTech-Co-LTD/platform-core/commit/91ea69357024f994cefc100c09d5340815434aec))


## [0.49.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.48.0...v0.49.0) - 2026-09-29
- 【新增】duckle: Wave B——retail.windows 迁 L1（foreach 首飞，含截尾决策与双点火兜底实测） (#324) ([#325](https://github.com/MYTech-Co-LTD/platform-core/pull/325), [61f1632](https://github.com/MYTech-Co-LTD/platform-core/commit/61f163257a5e956f22aea1b7a4f7a52454aec529))


## [0.48.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.47.0...v0.48.0) - 2026-09-28
- 【新增】duckle: Wave A 切流——dim.item 改走 L0（薄壳停、L0 起） (#322) ([#323](https://github.com/MYTech-Co-LTD/platform-core/pull/323), [ca96345](https://github.com/MYTech-Co-LTD/platform-core/commit/ca963457a43621203a8ac2ac80febd29b0b98352))


## [0.47.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.46.0...v0.47.0) - 2026-09-28
- 【新增】duckle: item 采集 L0 形态管线（一条管线替代薄壳+shell 三层） ([#321](https://github.com/MYTech-Co-LTD/platform-core/pull/321), [f63c186](https://github.com/MYTech-Co-LTD/platform-core/commit/f63c186ebc797543502a3434d9b6a0be754479d7))


## [0.46.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.45.0...v0.46.0) - 2026-09-28
- 【新增】duckle: Wave 1 切流——branch 采集改走 L0（薄壳调度停、L0 调度起） ([#317](https://github.com/MYTech-Co-LTD/platform-core/pull/317), [efdc005](https://github.com/MYTech-Co-LTD/platform-core/commit/efdc005f8b52e47b6344e0040fe5079a47414e2c))


## [0.45.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.44.0...v0.45.0) - 2026-09-28
- 【新增】duckle: Wave 1 L0 观测面接线（告警规则 + 新鲜度锚 + 运行记录口径） ([#314](https://github.com/MYTech-Co-LTD/platform-core/pull/314), [1550954](https://github.com/MYTech-Co-LTD/platform-core/commit/1550954132c96a5651259d62ff6f6d912e4fd732))


## [0.44.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.43.0...v0.44.0) - 2026-09-28
- 【新增】duckle: branch 采集 L0 管线（一条管线替代薄壳+shell 三层，凭据走 connectionRef） ([#312](https://github.com/MYTech-Co-LTD/platform-core/pull/312), [0456dc5](https://github.com/MYTech-Co-LTD/platform-core/commit/0456dc5fbaefbedfb77d345a7023110417a73910))


## [0.43.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.42.2...v0.43.0) - 2026-09-28
- 【新增】duckle: 加密连接一次性 setup 脚本（connectionRef 写入方·路径 iii 自封） ([#306](https://github.com/MYTech-Co-LTD/platform-core/pull/306), [5408672](https://github.com/MYTech-Co-LTD/platform-core/commit/5408672c364012cb4b5477262caf9355cb2dce3d))


## [0.42.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.42.1...v0.42.2) - 2026-09-28
- 【修复】ops: 平台↔仓库两条易失接线固化——幂等重做脚本 + 只读复查，三种反向测试都真红 ([#304](https://github.com/MYTech-Co-LTD/platform-core/pull/304), [de3edfe](https://github.com/MYTech-Co-LTD/platform-core/commit/de3edfe246fb3515971cac2cce7ef67aef1a4ee1))


## [0.42.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.42.0...v0.42.1) - 2026-09-28
- 【修复】lemeng: authoring-ws REPO_ROOT 上跳两层——裸调不再误报未知账套 (#289) ([#290](https://github.com/MYTech-Co-LTD/platform-core/pull/290), [5711c18](https://github.com/MYTech-Co-LTD/platform-core/commit/5711c18661f89a63b56524b8e984c1491e738a8d))


## [0.42.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.41.0...v0.42.0) - 2026-09-28
- 【新增】lemeng: tick 对账口径 recon 模式与正典同步 (#260) ([#284](https://github.com/MYTech-Co-LTD/platform-core/pull/284), [5420bdb](https://github.com/MYTech-Co-LTD/platform-core/commit/5420bdbe8a5b8c0f385e970f71d1372f88783d3f))


## [0.41.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.40.0...v0.41.0) - 2026-09-28
- 【新增】duckle: 零售 tick 告警与新鲜度规则（192/天级重推导） (#260) ([#283](https://github.com/MYTech-Co-LTD/platform-core/pull/283), [bf0d960](https://github.com/MYTech-Co-LTD/platform-core/commit/bf0d9608ce6737e6e72979680989ea38a6413257))


## [0.40.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.39.0...v0.40.0) - 2026-09-28
- 【新增】lemeng: 零售日采集 wrapper 新增 tick 模式（当日增量+闭窗尾款） (#260) ([#282](https://github.com/MYTech-Co-LTD/platform-core/pull/282), [fa5795a](https://github.com/MYTech-Co-LTD/platform-core/commit/fa5795a206efc41368a74de9785a0bbe33851c4d))


## [0.39.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.38.0...v0.39.0) - 2026-09-28
- 【新增】duckle: 零售 5min tick/close 管线与调度定义（3120 试点、64188 备用） (#260) ([#281](https://github.com/MYTech-Co-LTD/platform-core/pull/281), [20e1513](https://github.com/MYTech-Co-LTD/platform-core/commit/20e15137c49a5de5daa29fcd945aa981c0e82545))


## [0.38.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.37.1...v0.38.0) - 2026-09-28
- 【新增】duckle: 3120 零售调度切 console 正典落账 + W2 计划/手动触发口径 ([#279](https://github.com/MYTech-Co-LTD/platform-core/pull/279), [09092ea](https://github.com/MYTech-Co-LTD/platform-core/commit/09092ea5ac732cf8111ae59712c9943c45bb004c))


## [0.37.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.37.0...v0.37.1) - 2026-09-27
- 【修复】lemeng: authoring-ws 重管线平铺装配（桌面按根目录 id 解析，#275） ([#274](https://github.com/MYTech-Co-LTD/platform-core/pull/274), [7d61c57](https://github.com/MYTech-Co-LTD/platform-core/commit/7d61c5772bcd7b140c293da81909e34f0403bac7))


## [0.37.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.36.1...v0.37.0) - 2026-09-27
- 【修复】lemeng: 薄管线 qa 节点 type 改 transform（桌面画布兼容，#272） ([#273](https://github.com/MYTech-Co-LTD/platform-core/pull/273), [b6755f9](https://github.com/MYTech-Co-LTD/platform-core/commit/b6755f94d11862ae0823c60bc30103c49175c2a4))
- 【新增】lemeng: authoring 工作区组装/回收工具（资产面⑧.a 配套） ([#271](https://github.com/MYTech-Co-LTD/platform-core/pull/271), [1f33728](https://github.com/MYTech-Co-LTD/platform-core/commit/1f337280f07c1809c5fdfb61088e3479073c29a0))


## [0.36.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.36.0...v0.36.1) - 2026-09-26
- 【修复】dbt: schema.yml 的 description 里不许调项目 macro（它把生产物化 job 打红了） ([#262](https://github.com/MYTech-Co-LTD/platform-core/pull/262), [29ee651](https://github.com/MYTech-Co-LTD/platform-core/commit/29ee651b543a18b2fa3f5fbefd63434691dd1a6b))


## [0.36.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.35.1...v0.36.0) - 2026-09-26
- 【新增】data-stack: 数据面主体列 org 落地 + dbt 侧门禁（Closes #257） ([#258](https://github.com/MYTech-Co-LTD/platform-core/pull/258), [42efc4b](https://github.com/MYTech-Co-LTD/platform-core/commit/42efc4be121ab1f4024e75eb977be1faaba988ca))


## [0.35.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.35.0...v0.35.1) - 2026-09-26
- 【修复】data-stack: 新湖零售读路径改通配两账套（64188 落湖却进不了物化） ([#253](https://github.com/MYTech-Co-LTD/platform-core/pull/253), [c910cca](https://github.com/MYTech-Co-LTD/platform-core/commit/c910cca1e2db7c80be55e32e054a30dc170db775))


## [0.35.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.34.2...v0.35.0) - 2026-09-26
- 【新增】lemeng: 64188（品品甜）零售排班进仓——console-64188 加 retail，直接启用 ([#251](https://github.com/MYTech-Co-LTD/platform-core/pull/251), [685f624](https://github.com/MYTech-Co-LTD/platform-core/commit/685f624ca499fa7327e7a9ed68ebdcd7461768f4))


## [0.34.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.34.1...v0.34.2) - 2026-09-26
- 【修复】deploy: dbt 挂载去掉 :ro——否则 dbt build 写不了 target/logs ([#248](https://github.com/MYTech-Co-LTD/platform-core/pull/248), [ce35190](https://github.com/MYTech-Co-LTD/platform-core/commit/ce3519069db3e5f0b26cf62705fe9234bacace7e))


## [0.34.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.34.0...v0.34.1) - 2026-09-26
- 【修复】lemeng: wrapper 自带失败窗重试——把 job 的 retry 语义收回，解「迁 console 即丢自愈」 ([#245](https://github.com/MYTech-Co-LTD/platform-core/pull/245), [5b7687f](https://github.com/MYTech-Co-LTD/platform-core/commit/5b7687fbad57b0f874c3d438bf95acf87a0fff9b))


## [0.34.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.33.2...v0.34.0) - 2026-09-26
- 【新增】lemeng: 零售采集的调度定义进仓——薄管线 + 排班（enabled:false，未切流） ([#241](https://github.com/MYTech-Co-LTD/platform-core/pull/241), [0efde0a](https://github.com/MYTech-Co-LTD/platform-core/commit/0efde0af500e6e5f833922330d0048559509950d))


## [0.33.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.33.1...v0.33.2) - 2026-09-26
- 【修复】duckle: 镜像里装 curl——wrapper 全程用它，容器内实测 curl: not found ([#235](https://github.com/MYTech-Co-LTD/platform-core/pull/235), [fc20664](https://github.com/MYTech-Co-LTD/platform-core/commit/fc20664d3f5ff07be672f769abbe52758d173396))


## [0.33.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.33.0...v0.33.1) - 2026-09-26
- 【修复】lemeng: 告警客户端 curl→python3（演练实测：镜像里没有 curl，告警永远发不出去） ([#233](https://github.com/MYTech-Co-LTD/platform-core/pull/233), [ab39e4e](https://github.com/MYTech-Co-LTD/platform-core/commit/ab39e4e6188c4f054e7c9e2370aa253fcf3868fb))


## [0.33.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.32.0...v0.33.0) - 2026-09-26
- 【新增】lemeng: 调度失败告警——接在 wrapper 的 EXIT trap（含「该发/不该发」的测试） ([#231](https://github.com/MYTech-Co-LTD/platform-core/pull/231), [cdfe240](https://github.com/MYTech-Co-LTD/platform-core/commit/cdfe240619138c816a4aa970b7dfd1664ac84940))


## [0.32.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.31.0...v0.32.0) - 2026-09-26
- 【新增】lemeng: compose 加两个常驻 duckle console（每账套一个，只绑回环） ([#229](https://github.com/MYTech-Co-LTD/platform-core/pull/229), [c6ff3ec](https://github.com/MYTech-Co-LTD/platform-core/commit/c6ff3ec8ada791407d4734c7d059186bb376e705))


## [0.31.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.30.0...v0.31.0) - 2026-09-26
- 【新增】lemeng: console 的声明式定义——薄管线 + 两账套调度（并纳入投递清单） ([#227](https://github.com/MYTech-Co-LTD/platform-core/pull/227), [b02ce60](https://github.com/MYTech-Co-LTD/platform-core/commit/b02ce600bdf1123ed146e061d3d4999629107bb1))


## [0.30.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.29.0...v0.30.0) - 2026-09-26
- 【新增】lemeng: wrapper 加「容器内调用模式」——调度下沉到 duckle 自带调度器的前置件 ([#224](https://github.com/MYTech-Co-LTD/platform-core/pull/224), [ae8a0dd](https://github.com/MYTech-Co-LTD/platform-core/commit/ae8a0dd95b27e556e8152e6ab48a298a396848ea))


## [0.29.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.28.1...v0.29.0) - 2026-09-26
- 【新增】lemeng: S2-a 维度面——门店维/商品维三件套（双账套全量快照） ([#215](https://github.com/MYTech-Co-LTD/platform-core/pull/215), [325c3ad](https://github.com/MYTech-Co-LTD/platform-core/commit/325c3ad534d26bcbad044b3689fa090bf12bfae8))


## [0.28.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.28.0...v0.28.1) - 2026-09-25
- 【修复】lemeng: windows 改「逐窗尽力采 + 末尾判红」——「一窗失败即停」会让当天剩余窗口永久缺失 ([#211](https://github.com/MYTech-Co-LTD/platform-core/pull/211), [5b321a3](https://github.com/MYTech-Co-LTD/platform-core/commit/5b321a38877e16c17591bf1657edb1dd70736813))


## [0.28.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.27.1...v0.28.0) - 2026-09-25
- 【新增】lemeng: 采集 job 启动自证——凭据↔账套 / 门店清单↔账套（fail-loud） ([#208](https://github.com/MYTech-Co-LTD/platform-core/pull/208), [9f28ec9](https://github.com/MYTech-Co-LTD/platform-core/commit/9f28ec97241a1686b20e95770196cbbfc74158d9))


## [0.27.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.27.0...v0.27.1) - 2026-09-25
- 【修复】duckle: 零售链路页容量 8→12，静默通过阈值 1400→2200 单/时 ([#201](https://github.com/MYTech-Co-LTD/platform-core/pull/201), [740c1fa](https://github.com/MYTech-Co-LTD/platform-core/commit/740c1fa9503267cf06cba226c43e7830683019b2))


## [0.27.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.26.0...v0.27.0) - 2026-09-25
- 【新增】data-plane: 工件投递升为「清单 + 就地核验同步 + 版本标记」+ CI 守卫 ([#200](https://github.com/MYTech-Co-LTD/platform-core/pull/200), [0b8fdf5](https://github.com/MYTech-Co-LTD/platform-core/commit/0b8fdf579ae1aafa97bf62835ce17b4b74347252))


## [0.26.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.25.2...v0.26.0) - 2026-09-25
- 【新增】lemeng: 乐檬门店销售明细采集链路 S1（5 分钟粒度 → duckle → ZOS parquet 湖 → pg_duckdb → dbt） ([#198](https://github.com/MYTech-Co-LTD/platform-core/pull/198), [eef2456](https://github.com/MYTech-Co-LTD/platform-core/commit/eef245685a5fc189918888167dc82c91af455fb4))


## [0.25.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.25.1...v0.25.2) - 2026-09-23
- 【修复】data-stack: T6 真机收尾——Jinja 注释/dbt 版本配对/services 三坑登记/gate 销账 (#150) ([#187](https://github.com/MYTech-Co-LTD/platform-core/pull/187), [3148390](https://github.com/MYTech-Co-LTD/platform-core/commit/314839036eb58256af2cedaad1a379d08038bbd3))


## [0.25.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.25.0...v0.25.1) - 2026-09-23
- 【修复】data: 测试夹具竞态——deleteStaleL1Metrics 用例的 keepIds 并入兄弟文件夹具 ([#186](https://github.com/MYTech-Co-LTD/platform-core/pull/186), [9b30e62](https://github.com/MYTech-Co-LTD/platform-core/commit/9b30e6283850016131eb81ff7a84e1ec0c8d07c7))


## [0.25.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.24.0...v0.25.0) - 2026-09-22
- 【新增】aftersales: /rules /employees /stores 补 total，与 /products 同形（M-T8-3） ([#160](https://github.com/MYTech-Co-LTD/platform-core/pull/160), [0f24864](https://github.com/MYTech-Co-LTD/platform-core/commit/0f2486400108b1e52401dcef78d358f43ffb803e))


## [0.24.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.23.0...v0.24.0) - 2026-09-22
- 【新增】aftersales: M2b 迁移脚本骨架（纯核可测 + 默认 dry-run） ([#159](https://github.com/MYTech-Co-LTD/platform-core/pull/159), [aaa9849](https://github.com/MYTech-Co-LTD/platform-core/commit/aaa9849198b64c91dd84c3b1c3720075feda4ab3))


## [0.23.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.22.2...v0.23.0) - 2026-09-22
- 【新增】aftersales: 孤儿附件 GC——deleteObject + manage 端点 + 行锁先行单行事务 ([#158](https://github.com/MYTech-Co-LTD/platform-core/pull/158), [2aa4e8b](https://github.com/MYTech-Co-LTD/platform-core/commit/2aa4e8bb1b45e5f619008162c516080bfa579aa0))


## [0.22.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.22.1...v0.22.2) - 2026-09-22
- 【修复】auth-core: resetUserPassword 改走 Casdoor 专用改密端点 set-password ([#149](https://github.com/MYTech-Co-LTD/platform-core/pull/149), [38e0c9e](https://github.com/MYTech-Co-LTD/platform-core/commit/38e0c9ee577e2d9e1211dc80a309aa280eea494a))


## [0.22.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.22.0...v0.22.1) - 2026-09-21
- 【修复】web: 控制台路由层吃 config；模块 admin 页路由套 AdminGate 组门 ([#147](https://github.com/MYTech-Co-LTD/platform-core/pull/147), [30a4471](https://github.com/MYTech-Co-LTD/platform-core/commit/30a447135c42eecf6731b32bb5da5276a1464f72))


## [0.22.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.21.0...v0.22.0) - 2026-09-21
- 【新增】data: 问数三通道——一个授权核心 + 系统内会话/个人 Key/企微三通道 ([#146](https://github.com/MYTech-Co-LTD/platform-core/pull/146), [ca648d6](https://github.com/MYTech-Co-LTD/platform-core/commit/ca648d67d189aa61c36112ddfd3b205562640c6c))


## [0.21.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.20.0...v0.21.0) - 2026-09-20
- 【新增】sdk: 模块管理页协议与存储配置能力联动 ([#125](https://github.com/MYTech-Co-LTD/platform-core/pull/125), [45a4bdd](https://github.com/MYTech-Co-LTD/platform-core/commit/45a4bdd45c3f83e970a225e69974ff57aef9ede0))


## [0.20.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.19.1...v0.20.0) - 2026-09-20
- 【新增】web: 登录页改版——参考 Casdoor 浅色分栏风格 ([#123](https://github.com/MYTech-Co-LTD/platform-core/pull/123), [607a5ff](https://github.com/MYTech-Co-LTD/platform-core/commit/607a5fff89c176eda079a73248955c6185bc458e))


## [0.19.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.19.0...v0.19.1) - 2026-09-19
- 【修复】auth-core: 共享 Casdoor 首建三缺陷——ensureOrg 漏 owner/passwordType、ensureAnchorUser 漏 signupApplication、写响应吞 (Closes #117) ([#118](https://github.com/MYTech-Co-LTD/platform-core/pull/118), [0666cae](https://github.com/MYTech-Co-LTD/platform-core/commit/0666cae8aca40d750a14630d5094f93ecdeb1e7c))


## [0.19.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.18.1...v0.19.0) - 2026-09-19
- 【新增】cli: 企微三参补交付写入入口——provision-tenant 加 --wecom-* (Closes #115) ([#116](https://github.com/MYTech-Co-LTD/platform-core/pull/116), [a47611e](https://github.com/MYTech-Co-LTD/platform-core/commit/a47611ebc180228516d0cf1c655bed35824798d6))


## [0.18.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.18.0...v0.18.1) - 2026-09-17
- 【修复】scripts: smoke-load 先起 mock 再取宿主端口——消除端口撞车 (Closes #112) ([#114](https://github.com/MYTech-Co-LTD/platform-core/pull/114), [b76b289](https://github.com/MYTech-Co-LTD/platform-core/commit/b76b289f4d59baa42dcf0323391ae3a4c5b40397))


## [0.18.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.17.1...v0.18.0) - 2026-09-17
- 【新增】aftersales: M3c 步 4 原子切换——按请求解析存储配置 + 读写 storage_ref + 端到端断言 ([#108](https://github.com/MYTech-Co-LTD/platform-core/pull/108), [35c185c](https://github.com/MYTech-Co-LTD/platform-core/commit/35c185c442c421444eeab0bd7e2fd0514eb5e3a9))


## [0.17.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.17.0...v0.17.1) - 2026-09-17
- 【修复】web: 管理台挂 antd <App> 提供者——14 个 message 调用点不再抛 TypeError (Closes #106) ([#107](https://github.com/MYTech-Co-LTD/platform-core/pull/107), [b9386d5](https://github.com/MYTech-Co-LTD/platform-core/commit/b9386d5e326ed912f47851fc0f88a688ed381026))


## [0.17.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.16.0...v0.17.0) - 2026-09-17
- 【新增】server: M3c 步 3——租户存储行列 + 投影三态 + 附件 storage_ref（生产行为零变化） ([#105](https://github.com/MYTech-Co-LTD/platform-core/pull/105), [d280c74](https://github.com/MYTech-Co-LTD/platform-core/commit/d280c7476074c1e679f36e9c0641f244cc49ffb0))


## [0.16.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.15.2...v0.16.0) - 2026-09-17
- 【新增】sdk: M3c 步 2 宿主机制——存储配置协议面 + manifest storage 可选字段 + loader 投影中间件 ([#104](https://github.com/MYTech-Co-LTD/platform-core/pull/104), [53096f1](https://github.com/MYTech-Co-LTD/platform-core/commit/53096f1e0343c52e77d8c9af80af981f628f4ee8))


## [0.15.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.15.1...v0.15.2) - 2026-09-17
- 【修复】discipline: CHANGELOG 守卫改三点 diff——落后于 main 不再误报，并改掉有害的补救建议 (Closes #99) ([#100](https://github.com/MYTech-Co-LTD/platform-core/pull/100), [eff4893](https://github.com/MYTech-Co-LTD/platform-core/commit/eff4893d9b06408642d6e587c42f8f18b96f945f))


## [0.15.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.15.0...v0.15.1) - 2026-09-17
- 【修复】test-util: MockCasdoor 权限路径补形状（model/StoredPerm/种子 displayName）(Refs #68) ([#95](https://github.com/MYTech-Co-LTD/platform-core/pull/95), [fd54314](https://github.com/MYTech-Co-LTD/platform-core/commit/fd5431416cd74e9656537e2a896c1275d2e8bab0))


## [0.15.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.14.1...v0.15.0) - 2026-09-17
- 【新增】ci: 租户隔离门禁补 T2——org 列必须 not null（对齐正典）(Refs #77) ([#98](https://github.com/MYTech-Co-LTD/platform-core/pull/98), [5ebc0b4](https://github.com/MYTech-Co-LTD/platform-core/commit/5ebc0b4fcc3b1f3b0b150f26d252f390c03f1825))


## [0.14.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.14.0...v0.14.1) - 2026-09-17
- 【优化】test: issue #68 Step2——两侧链式化，testClient() 不再塌成 unknown (Refs #68) ([#92](https://github.com/MYTech-Co-LTD/platform-core/pull/92), [e6e3c26](https://github.com/MYTech-Co-LTD/platform-core/commit/e6e3c2642964b2c8140dea577847de3df9f1d983))


## [0.14.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.13.0...v0.14.0) - 2026-09-16
- 【新增】scripts: 补私有化试点的交付阻断——公众号参数写入入口 + runbook 三处订正 ([#89](https://github.com/MYTech-Co-LTD/platform-core/pull/89), [6f248cb](https://github.com/MYTech-Co-LTD/platform-core/commit/6f248cbdb083b16bce7bdd54d428a178a9e216a3))


## [0.13.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.12.1...v0.13.0) - 2026-09-16
- 【新增】ci: 租户隔离门禁——模块 migrations 建表必须有 org（真库对账，按累积终态判） ([#87](https://github.com/MYTech-Co-LTD/platform-core/pull/87), [0e73e1f](https://github.com/MYTech-Co-LTD/platform-core/commit/0e73e1fb24b3c2022babd44c8a4e9468d047bc5e))


## [0.12.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.12.0...v0.12.1) - 2026-09-16
- 【修复】server: runMigrations 加 session 级 advisory lock——并发迁移不再撞主键 ([#86](https://github.com/MYTech-Co-LTD/platform-core/pull/86), [f63c748](https://github.com/MYTech-Co-LTD/platform-core/commit/f63c74845d7e1a970acf418c78e9976507e9af08))


## [0.12.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.11.0...v0.12.0) - 2026-09-16
- 【新增】aftersales: M3b-2 移动端 userApp 整迁——Vite 壳 + 三 shim + 两页（含四处宿主/构建面） ([#85](https://github.com/MYTech-Co-LTD/platform-core/pull/85), [e9ca836](https://github.com/MYTech-Co-LTD/platform-core/commit/e9ca8365ebe279651c16c7651423b50e3bc3d49d))


## [0.11.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.10.0...v0.11.0) - 2026-09-16
- 【新增】aftersales: M3b-1 员工登记与审批——新表 + 5 端点 + console 审批页签 ([#82](https://github.com/MYTech-Co-LTD/platform-core/pull/82), [3b751a9](https://github.com/MYTech-Co-LTD/platform-core/commit/3b751a9d1f831e0064fc2642d755bb9492240e1c))


## [0.10.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.9.0...v0.10.0) - 2026-09-16
- 【新增】aftersales: M3a console 管理端——5 页收进 1 条目 + 模块内 tabs ([#80](https://github.com/MYTech-Co-LTD/platform-core/pull/80), [0cf5213](https://github.com/MYTech-Co-LTD/platform-core/commit/0cf521351488244311f72bbf89389b44d545f03d))


## [0.9.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.8.0...v0.9.0) - 2026-09-16
- 【新增】aftersales: M2a 模块后端——域 API + 建表 + 天翼 ZOS 预签名 ([#74](https://github.com/MYTech-Co-LTD/platform-core/pull/74), [912dff4](https://github.com/MYTech-Co-LTD/platform-core/commit/912dff4005c0590adbdeedab7c08d05fa3f2ce8d))


## [0.8.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.7.0...v0.8.0) - 2026-09-15
- 【新增】auth: wechat-oa 访客登录路 + userApp 停用闸门 + guest 码协议（售后 M1） (#66) ([#67](https://github.com/MYTech-Co-LTD/platform-core/pull/67), [868fe80](https://github.com/MYTech-Co-LTD/platform-core/commit/868fe800552e09bf4f99cd1afbc715a60ca9df14))


## [0.7.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.6.0...v0.7.0) - 2026-09-14
- 【新增】scripts: provision CLI 三债 + 私有化交付 runbook（spec-3） (#63) ([#64](https://github.com/MYTech-Co-LTD/platform-core/pull/64), [b00e64b](https://github.com/MYTech-Co-LTD/platform-core/commit/b00e64b4ab938b7fa889b726b7baf01efbd2455a))


## [0.6.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.5.3...v0.6.0) - 2026-09-14
- 【新增】demo: 模块租户数据隔离 + provision 批量发放（spec-1） (#61) ([#62](https://github.com/MYTech-Co-LTD/platform-core/pull/62), [903a2e2](https://github.com/MYTech-Co-LTD/platform-core/commit/903a2e266452064d4817f0c0cc9cc4f2083578a3))


## [0.5.3](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.5.2...v0.5.3) - 2026-09-14
- 【修复】scripts: 迁移脚本 pg 经 createRequire 锚 apps/server 解析；用法订正为 tsx (#3 关联) ([#57](https://github.com/MYTech-Co-LTD/platform-core/pull/57), [b346e8e](https://github.com/MYTech-Co-LTD/platform-core/commit/b346e8e91f9651e09164548db2d45a4b2dcee3e3))


## [0.5.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.5.1...v0.5.2) - 2026-09-14
- 【修复】auth-core: upsertSubscription update 补 ?id= 定位 + 回读验 state（真机形状，替身收严）(#50) ([#51](https://github.com/MYTech-Co-LTD/platform-core/pull/51), [e262813](https://github.com/MYTech-Co-LTD/platform-core/commit/e2628131348047d431d840a73b2d78e78f711d88))


## [0.5.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.5.0...v0.5.1) - 2026-09-13
- 【修复】console: 管理页创建/授权成功后立即刷新列表——reload 提前，去除卸载竞态下的 resetFields (#49) ([#48](https://github.com/MYTech-Co-LTD/platform-core/pull/48), [cc95942](https://github.com/MYTech-Co-LTD/platform-core/commit/cc95942ffebef3d8ca00a01a463a8aec53e5425a))


## [0.5.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.4.1...v0.5.0) - 2026-09-13
- 【新增】M3 租户管理员后台——console 三张页 + Casdoor 代理锁 org + tenant:admin 门禁 (#46) ([#47](https://github.com/MYTech-Co-LTD/platform-core/pull/47), [6e4c619](https://github.com/MYTech-Co-LTD/platform-core/commit/6e4c61985d29c79433ae8db952e428e42d0226fd))


## [0.4.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.4.0...v0.4.1) - 2026-09-13
- 【修复】auth-core: 桶文件 type-only 导出修复 + 运行时加载护栏（生产事故热修） ([#44](https://github.com/MYTech-Co-LTD/platform-core/pull/44), [f3af194](https://github.com/MYTech-Co-LTD/platform-core/commit/f3af194213c620e30c1bb3f3f16a548475082de1))


## [0.4.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.3.1...v0.4.0) - 2026-09-13
- 【新增】SaaS 管理域 M1——订阅进 Casdoor、config 双源、迁移与租户开通 CLI ([#41](https://github.com/MYTech-Co-LTD/platform-core/pull/41), [3f8b81e](https://github.com/MYTech-Co-LTD/platform-core/commit/3f8b81e3ca0e81c7ca83b5a31d7f121c9257a70d))


## [0.3.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.3.0...v0.3.1) - 2026-09-13
- 【修复】console: 根路径与未知路径重定向 /console，删除「工作台建设中」占位页 ([#38](https://github.com/MYTech-Co-LTD/platform-core/pull/38), [1bdd6de](https://github.com/MYTech-Co-LTD/platform-core/commit/1bdd6dee7dbfb8ed095f3d04310f7cf70d169e21))


## [0.3.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.2.0...v0.3.0) - 2026-09-13
- 【新增】console: console SaaS 化改造——Pro v6 风格落现有壳（mix 布局/菜单位置规则/工作台/暗色切换） ([#36](https://github.com/MYTech-Co-LTD/platform-core/pull/36), [cc70fb1](https://github.com/MYTech-Co-LTD/platform-core/commit/cc70fb150516a5a705303a4faa341ef6b1935502))


## [0.2.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.1.0...v0.2.0) - 2026-09-13
- 【新增】auth-core: 企微直连登录 JIT 自动建号——租户级旗标默认关，Casdoor OIDC 路永不 JIT (#32) ([#33](https://github.com/MYTech-Co-LTD/platform-core/pull/33), [a8a0c1d](https://github.com/MYTech-Co-LTD/platform-core/commit/a8a0c1dea8815a5b9e2601a57a9fb235ceee32b6))


## [0.1.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.0.3...v0.1.0) - 2026-09-13
- 【新增】auth-core: 扫码登录改自建应用直连企微——经 Casdoor 时回跳落在 sso，与自家可信域名永远对不上 ([#31](https://github.com/MYTech-Co-LTD/platform-core/pull/31), [ead9c9d](https://github.com/MYTech-Co-LTD/platform-core/commit/ead9c9dbb64b31789063a998c5c7a3dccddac1ec))


## [0.0.3](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.0.2...v0.0.3) - 2026-09-13
- 【修复】auth-core: 企微 provider 名改租户级配置——写死的 provider_wecom 与共享 Casdoor 的全局唯一名冲突 ([#28](https://github.com/MYTech-Co-LTD/platform-core/pull/28), [f609944](https://github.com/MYTech-Co-LTD/platform-core/commit/f609944f29af835081612e59ed9fdcdcf3e1d0e0))


## [0.0.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.0.1...v0.0.2) - 2026-09-13
- 【修复】auth-core: 权限供给新建时 name 用净化后的码——真 Casdoor 拒收冒号，供给失败会让进程起不来 ([#26](https://github.com/MYTech-Co-LTD/platform-core/pull/26), [9d3a0ec](https://github.com/MYTech-Co-LTD/platform-core/commit/9d3a0ece55fc0cd8ecae689020e5cce733be5609))


## [0.0.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.0.0...v0.0.1) - 2026-09-12
- 【修复】ci: main-guard 的 PR 关联查询加重试退避——修索引竞态导致的假阳性 ([#23](https://github.com/MYTech-Co-LTD/platform-core/pull/23), [b8bde09](https://github.com/MYTech-Co-LTD/platform-core/commit/b8bde09ab943ad0ff71ea4d8aaabc2f44162eb36))


### Added / Fixed - M1 闭债 R5：静态缓存分档 / 宿主端口绑回环 + B7 端口门禁 / CI web 间歇失败（issue #3 + #12）

> 本小节由 R5 复审修复轮**补记**：R5 计划写着「本轮 CHANGELOG 由 T4 统一收口」，但该轮只派了
> T1–T3、**T4 从未创建** ⇒ R5 的可见变更此前一行未落（`git log <R5 起点>..<R5 头> -- CHANGELOG.md`
> 为空）。以下条目**对照实现**逐条写，不是照抄计划。

- 【新增】**静态响应按产物类型分档 `Cache-Control`**（`apps/server/src/app.ts`）：此前全仓
  `Cache-Control` **零命中**，vite 产物与 SPA 兜底一视同仁，浏览器只能吃启发式缓存——**带内容
  哈希的产物每次白重验**，而 `index.html` 又可能被缓存住 ⇒ 发版后用户拿到旧壳去请求已删除的旧
  assets，**页面白屏**。分档判据取**实际吐出的产物类型**（响应 `content-type`），不用"路径里
  有没有点"那类会随 vite 配置漂移的启发式：
  - `text/html`（`index.html`——无论来自 `/`、`/login`、`/console` 深链，还是 `/assets/` 下
    未命中而落 **SPA 兜底**的那一份）⇒ `no-cache`（可重验）
  - 其余**仅 `/assets/` 前缀**（= vite 带内容哈希的产物）⇒
    `public, max-age=31536000, immutable`；别的一律可重验
  - **`/api/*` 与 `/healthz` 不受影响**（不被打标）。这条靠一个**隐式**事实成立：缓存中间件是
    `app.use('*')` 且注册在静态托管**之前**，而 Hono 的中间件只对其后注册的路由生效——全部
    `/api/*` 与 `/healthz` 都在它之前注册完。正因为它隐式，两层各钉了一条断言（进程内
    `app.test.ts` + 冒烟真进程）：将来有人把它上移成"真全局"，就会覆盖路由自己设的头，认证类
    端点的 `no-store` 被改写成 `no-cache` 属**静默的安全弱化**
  - ⚠️ **`no-cache` 的代价要说准**（本轮订正了一处断言了本栈不存在机制的注释）：本栈的静态托管
    （`@hono/node-server` 的 `serveStatic`）**不发 ETag、也不处理条件请求**（实现只有 Range 分支，
    不看 `If-None-Match` / `If-Modified-Since`）。**实测**：首响应 `etag=null`；拿同一
    `Last-Modified` 回发 `If-Modified-Since` 仍得 `200` + **全量 body** ⇒ `no-cache` 在这里的真实
    含义是**每次 200 全量重传**，**不是**"命中则 304"——后来者别据此判断"重验很便宜"。实测代价
    可接受（`index.html` 约 461B），这也是选 `no-cache` 而非 `max-age=0, must-revalidate` 的
    **唯一书面依据**（两者语义等价，`no-cache` 是各家代理/CDN 都认的写法）
    - 【优化】冒烟在**真产物 + 真进程**上补了缓存断言：此前四条缓存断言全跑在**注入的 fixture
      dist** 上（CI 的 `unit` job 从不构建 web，dist 相关工作归 `smoke` job）⇒ 真产物这条路径
      **一条 `Cache-Control` 断言都没有**，谁把中间件摘了都会单测全绿而线上退化。同时补
      `/api/*` 与 `/healthz` 的负例（**不得**带 `Cache-Control`）。测试侧的注入缝是
      `BuildAppOverrides.webDistDir`（缺省仍是 `apps/web/dist`，生产与冒烟路径一字未变）
- 【修复】**宿主端口绑回环**（`deploy/docker-compose.yml`）：`server` 13000 与 `postgres` 5432
  **两条**映射都改为 `127.0.0.1:` 前缀——此前绑 `0.0.0.0`（IPv4 与 IPv6 双栈），**任何能访问宿主
  该端口的人可绕过 edge**（丢掉证书、限速与访问控制）。**DB 那条尤其重**：库一旦落在宿主网络上
  就是**裸暴露一个可直连的 PG**（口令即全部防线），且没有任何应用层日志会告诉你这件事。
  收窄对本地路径零影响（冒烟、`dev-stack`、冒烟清单走的都是 `127.0.0.1`）。原先"生产 adopt 时
  把 postgres 那条删掉"的口径**一并撤掉**——它把安全性寄托在"靠人记得做"上
  - 【新增】adopt runbook 的人工核对项从**一条映射扩到两条**（`deploy/openship-adopt.md` 第 0 步）：
    生产走 openship 的 **services 模式**，它会不会把 compose 里这段 host_ip 前缀重写掉（改回
    `0.0.0.0` 等），本仓**无法在本地验证**（R5 起直到现在仍是**唯一没能独立验证**的一环）。
    重写的后果是**静默的**：edge 照常反代、冒烟照常绿，"可绕过 edge"这条又回来了。此前只点名
    server/13000，DB 那条漏在外面——而 DB 被重写的后果更重（见上）
- 【新增】**B7 新增宿主端口回环门禁**（`scripts/check-compose.mjs` 规则二）：文件里的 ports 映射
  须以 `127.0.0.1:` 起头。此前守卫只按**文件名**判唯一性、**从不读内容** ⇒ 把
  `127.0.0.1:5432:5432` 改回 `5432:5432` 全绿通过（评审变异实证）。三条判据：
  - a) 文件里**所有** ports 条目都须绑回环——不只看 `postgres` / `server` 两个字面服务名：只覆盖
    这两个名字时，往文件里加第三个服务并暴露 `8080:8080` **会全绿**，而本规则的目的正是"宿主
    端口不许留绕过 edge 的面"
  - b) 两个受管服务**若还在文件里**，各自至少一条条目。**整份删掉服务不报**——adopt 文档
    「生产差异」选项 2（不留 postgres、`DATABASE_URL` 指向托管库）是明列的生产路径，报它等于
    **报错理由与事实相反**（服务都不存在了，无从谈"缺端口"）
  - c) 认不出的 ports 写法（flow 形式 `ports: ['1:2']`）fail-closed：判据 a 扩到"所有条目"之后，
    这类写法会**一条条目都解析不出来**，不显式拦就等于静默放行一个可能绑在 `0.0.0.0` 的映射
  - **不在覆盖内**：`network_mode: host` 的服务——该模式下 compose **忽略 ports**，宿主的真实
    绑定取决于进程自己的 listen 地址，守卫读文本读不出来（本仓不用该模式）
- 【修复】**CI 的 web job 间歇性以退出码 1 收场**（issue #12。处置**只落在测试侧**：
  `apps/web/src/pages/Console.test.tsx`，产品代码一字未动）：上游 `@ant-design/pro-components` 的
  `MenuItemTooltip` 在 `useEffect` 里调度 400ms `setTimeout` 却**不返回 cleanup** ⇒ 组件卸载后
  定时器仍存活；等它触发时 vitest 可能已把 happy-dom 环境拆掉（`window` 没了）⇒ React 的更新
  路径读 `window` 抛 `ReferenceError`。它不是断言失败，而是**用例之外的未捕获异常**——所以
  **24 条全过、进程却退出码 1**（同一 commit `rerun --failed` 即变绿，纯属"拆除 ↔ 定时器到期"
  的赛跑，CI 慢机更易输）。处置为**显式收尸**（登记定时器 id + 在拆除点 `clearTimeout`）：
  **不吞异常、不碰退出码、不改断言强度**——只是不让第三方调度的回调活过它所属的环境
  - 【新增】配套 ★ 回归用例先把根因钉死：断言"菜单挂载后**确实**登记到了那条 antd 定时器"，再走
    与 `afterEach` **完全相同**的拆除路径，并**模拟 CI 的 `window` 已消失时序**等过 400ms 窗口，
    要求无任何遗留回调触发。前置断言认的是**延迟 400ms + 回调体 `setCollapsed`** 这条定时器，
    **不是**"在册定时器数量 > 0"——那一刻在册的另有 4 条与本缺陷无关的（RTL `waitFor` 1000ms /
    SWR 3000ms + 2000ms / deferred 0ms），只数个数在"上游修好"的变异下仍会全绿
- 【修复】复核轮订正的**注释保真**问题（不影响行为，但本轮主题恰是"照实写"）：`apps/web` 的
  定时器登记表注释原称"happy-dom 环境下全局 `setTimeout` 返回 number"——**与实测不符**（探针：
  键 `typeof === 'object'`、构造名 `Timeout`；第一版探针 `JSON.stringify` 打它直接因循环引用
  抛错）。现按实型描述（Node `Timeout` 对象，非 number），Map 键类型同步放宽（写 `number` 等于
  照抄 DOM lib 那个与运行时不符的声明）

### Fixed - M1 闭债 R4：平台底座欠账批处理（issue #3，HEAD 探活 / 请求体上限 / 停用模块语义 / 替身保真）

- 【修复】**已声明的 GET 端点用 `HEAD` 探活恒 403**：`declaredScopeGate`
  （`packages/platform-sdk/src/module.ts`）比对 `(d.method, c.req.method)` 查表。Hono 按 **GET**
  派发 HEAD（路由匹配走 GET），但 `c.req.method` 仍是 **`'HEAD'`** ⇒ 已声明 GET 的端点被 HEAD
  一探就查不到、落进 fail-closed 分支返 **403**（对探活/LB 探测器是"这个端点用 HEAD 不可达"）。
  修法是**查表前把 HEAD 归一到 GET**——只归查表，**不动身份与 scope 判定**：**未声明 GET 的路径
  照样 403**（只声明 POST 的路径上 HEAD 仍 403，两条负例钉在 `anonymous-probe.test.ts`），
  不等于"放行一切 HEAD"
- 【修复】**`/api/*` 此前没有请求体上限**（`apps/server/src/app.ts`）：只有登录路做了有界读取
  （`readBodyBounded`，上限 8192），**其余 `/api/*` 端点无任何上限** ⇒ 未认证请求即可用大 body
  撑内存。改用 hono 自带的 `body-limit` 在 `/api/*` 挂 **1 MiB**（`MAX_API_BODY_BYTES`；取值为
  已知最大正当载荷——便签正文 2000 字符——的两个数量级余量），超限返
  **`413 {error:'PAYLOAD_TOO_LARGE'}`**。登录路更严的 8192 仍然生效。闸门挂在**租户中间件之前**
  （拒绝超大载荷不该先做 DB 查询）、并注册在全部 `/api/*` 路由之前（Hono 中间件只对其后注册的
  路由生效）
- 【修复】**超限必须以 413 收场，不能以连接重置告终**（同上的 `bodyLimit.onError`，本轮评审
  must-fix）：首版 onError 直接回 413，但 `@hono/node-server` 下客户端 body 还没写完就拿到
  **ECONNRESET/EPIPE** ⇒ **真 HTTP 下 25–35% 的超限请求根本看不到那个 413**（进程内
  `app.request()` 没有 socket，这条**在单测里结构性看不见**，回归面因此另建在真 socket 上）。
  修法是 onError 里**先把请求体流 `cancel()` 掉再回 413**（`catch` 吞掉 cancel 的抛错，不让它
  盖过 413）。改后 keep-alive 客户端从不 cancel 的 26/40 回到 **40/40**（与"从不碰 body"的对照
  基线一致）
- 【修复】**停用模块（`platform.tenant_module.enabled=false`）的 API 此前照常可达**
  （`apps/server/src/loader.ts` 的 `mount()`）：停用此前**只影响 `/api/platform/config` 的清单**
  （该租户在清单里看不到这个模块），**模块 API 本身照常可达**、只受 scope 约束 —— "停用"只落了
  一半。现在在挂载时按租户挂**请求期启用闸门**，未启用返 **404 `{error:'NOT_FOUND'}`**；
  **不用 403**——403 会明说"存在但被停用"，404 与"这个模块压根不存在"**同形**，于是**模块 API
  面内**停用状态不可枚举（作用域仅限模块 API 面：`/config` 是**有意的披露面**，它匿名公开本租户
  的启用清单，属存量行为、非本轮引入）。闸门与 `/config` **同源**（同一份 `enabledForImpl`，
  写两遍必然漂移），**不做缓存** ——「停用后多久生效」不留隐式窗口。两条放行路径：无租户上下文
  放行；**无 identity（匿名）放行** —— 闸门在模块自身门卫之前，匿名反正是 401，放行可避免把
  改动前的"匿名命中模块 API 0 次 DB"变成每请求 1 次、被用来放大 DB 压力（匿名打停用/启用模块
  都是门卫那条逐字相同的 401，放行**不**削弱上面的不可枚举性；已登录用户照旧 404）
  - ⚠️ **闸门只覆盖模块 API 半边**（**存量缺口，本轮不改行为**）：`frontend.userApp` 静态目录
    另挂在 manifest 的 mount 路径下、**不经过闸门** ⇒ 显式 `enabled=false` 后 API 返 404 而
    `<mount>/index.html` 仍 200。当前**休眠中**（仓内唯一模块 `modules/demo` 只声明了
    `console`，无可观测面），将来有模块启用 `userApp` 时必须一并补闸——否则"停用 = 看不到这个
    模块"会被读成绝对规则（见 `docs/module-protocol.md` 的「停用语义」节）
- 【修复】**>1 MiB 的登录请求到不了登录路的三层限速器**（同上闸门的取舍，口径已写死在
  `app.ts` 注释）：全局上限挂在租户解析之前、限速器在 `authRoutes` 里 ⇒ 被这道闸门拒掉的登录
  请求**一层限速器都不计**（不读体、不写 audit、不调 Casdoor）。这是刻意的：1 MiB 这个量级已
  明确是滥用流量，为它保留"先解析出 username 再按用户维度计数"等于让滥用者用最大成本换最精确
  的计数。**与 `auth.ts` 里"超限计数照记"不矛盾**——那句管的是**它自己** 8192 那道有界读取
- 【优化】**测试替身与真机保真**（`packages/auth-core/src/test-util/mock-casdoor.ts` 等）：
  - **`get-user` 的 `id` 为空不再报错，改回 `ok + data:null`**（真机实测三态同形：`?id=`、不传
    id、裸 `?id=` 全是 `200 {status:'ok',data:null}`）。旧替身把空 id `split` 出 1 段 ⇒ 判非法
    返 `wrong token count` —— **方向与真机相反**，把"用户不存在（客户端清 cookie 登出）"演成
    "上游报错（客户端降级用旧 scopes）"，两个相反的分支；**含空段的两段照进查找**
    （`id=/admin`、`id=built-in/`、`id=/` ⇒ `ok+null`），只按**段数≠2** 拒
  - **`get-permissions` 的段数判别改成与 `get-user` 同一套**（真机两个端点共用上游
    `GetOwnerAndNameFromId`）：旧实现在这里多判了 `!segs[0] || !segs[1]`，同一个 `id` 在两条
    端点上"一个判非法、一个照查"，是"两套判别"的典型形状
  - **未授权文案按端点区分**（真机：`get-user` 回 `Please login first`，`get-permissions` 等回
    `Unauthorized operation`）：客户端不按文案分支，这里纯为保真
  - **冷却/降级窗口用例去掉真实墙钟依赖**：`CasdoorClient` 与 `sessionMiddleware` 新增**可注入
    时钟**（`CasdoorClientOptions.now` / `SessionMiddlewareDeps.now`），两条"窗口会随时间重开"
    的用例改为**手动推进时钟**，不再 `await setTimeout(窗口 + 100)`。注入时钟**只**供这两处冷却
    窗口取值，不参与验签/过期/续期任何时间决策；**缺省路径与改动前逐值一致，无行为变更**
    （先例：`createLoginLimiter({ now })`）

### Fixed - M1 闭债 R3：Casdoor「错误」与「不存在」不再混为一谈（issue #3 第三节，真机已确认）

- 【修复】**静默登出通道**：`getUser` 此前把 Casdoor 的一切 `status:error` 折叠成 `null`，
  而 `null` 在会话中间件里是**唯一清 cookie 的分支**。真机实测（`sso.hookflow.cn`）：
  用户不存在回的是 `200 + {status:'ok', data:null}`，而 `status:error` 覆盖的是**与"不存在"
  无关**的情形——id 非 `<org>/<name>` 两段、**admin 会话失效**（`Please login first`）、
  org 不存在、org 非公开且权限不过、DB/角色扩展出错。⇒ admin 会话一旦失效，
  **全体终端用户会在会话刷新时被静默登出，且永久持续**（死 cookie 被永久缓存）
- 【修复】**admin 会话自愈**：`#adminRequest` 只在 **HTTP 401** 重取会话，而真机把会话失效
  回成 **200 + `status:error`** ⇒ 该重试永不触发、缓存的死 cookie 永不刷新。改为响应体
  `status:error` 时**强制重登一次并重试**（不匹配文案——任何 error 都重试一次，真错的第二次照样错）
- 【修复】**登录不再发"空 scopes 会话"**：密码已验证通过却查无此人时，此前会发出一个
  没有角色派生 scopes 的会话（表现为"登录成功但每个模块 API 都 403"）；改为 **502 fail loudly**
- 【修复】**测试替身与真机对齐**（同类病的第二次）：`MockCasdoor` 对未知用户回的是
  `status:error`，而真机回 `ok + data:null` —— 代码照 mock 写，**缺陷因此在测试里结构性看不见**。
  已把 mock 改回真机形状，并新增 `get-user` 故障注入（`error` / `errorOnce`）与
  `adminLoginCalls` 计数，让"会话失效清 cookie""自愈重登"两件事都有机检面

#### R3 异种评审返工（2 条必须改 + 4 条建议改，全部落地）

> 两条必须改都是**替身/注释仍按旧口径**的漏改（不是运行期缺陷）。第 2 条尤其重要：
> 它正是"替身锁住旧形状 ⇒ 门禁结构性失明"的**第三次**复发，故本次不只改 mock，
> 还补了"默认形状必须是真机形状"的负例断言，防止再漂回去。

- 【修复】**mock 的默认会话失效形状对齐真机**：`#unauthorized` 回 `HTTP 401`，而真机实测
  （本机 curl，无凭据）一律回 **`HTTP 200 + {status:'error',...}`**，**没有一条 401**。
  这正是 401-retry 变死码的成因，也是同类回归仍可能被遮蔽的原因。已改为 200；
  401 作为「客户端防御契约」改由**显式注入** `setHttpFault('unauthorized401')` 提供
  （真机不产生该形状，不得当默认）。客户端的 401 分支**保留**（仍是合法防御面）
- 【修复】**登录路径的降级不再完全静默**（`session-middleware`）：修好「静默登出」后，
  "admin 会话死掉"不再表现为登出，而是**每请求、永久、零信号**地降级用旧 scopes ⇒
  该真问题从此不可观测。现在降级时打一条 `console.warn`（带 org 与原因、说清后果），
  并**按 org 每 60s 最多一条**去重，避免日志成为新的无界增长点
- 【优化】**强制重登加短冷却（5s）**：持续故障下此前"每个失败请求各触发一次重登"
  （评审实测：3 次失败 = 3 次额外登录，8 并发 = 8 次），且**非会话类**错误也照样重登 ⇒
  在**共享 SSO** 上按请求数放大登录压力。现在同一窗口内最多重登一次，调用方语义不变
  （仍是拿到本次 error 后按既有口径降级）。未采用 single-flight（复杂度不划算）
- 【修复】**mock 的 `get-user` 按 (org,name) 命中**：真机按 owner 归属用户
  （实测 `get-user?id=shanhai/admin` ⇒ `ok+null`，尽管 `built-in/admin` 存在），
  旧 mock 只按 name 命中 ⇒ 跨 org 同名被误命中这类缺陷结构性看不见。同步修正各测试/
  冒烟种子的用户归属（`acme` 租户的用户归 `acme`），冒烟新增 beta 自有管理员与
  「acme 用户登 beta ⇒ 502」的端到端负例
- 【修复】**注释口径订正**：`session-middleware` 那条"清 cookie 唯一分支"的注释仍复述被修掉的
  旧口径（`2xx + status:error`）⇒ 下一个改动者极易照它回退；`auth.ts` 登录路注释称与企微路
  `NO_ACCOUNT`「同风格」，但两者呈现不同（此处上游不一致 ⇒ 502，企微路是真无账户 ⇒ 401）。
  两处已按实际口径改写（502 本身正确，未改行为）

### Fixed - PR#5 评审 R3（终轮）：最后一处漏记出口 + 预算/上界口径如实化 + 断言回补

> 1 条必须改 + 3 条建议改，全部落地。必须改的那条是同一族缺陷的**最后一处**：R2 已把
> 「本路由上除"被限速本身"以外每一个失败出口都要 record」立成口径，唯独 `getUser` 这条漏了。

- 【修复】**企微回调 `getUser`/`getPermissions` 的 `catch` 出口不 record**（`apps/server/src/routes/auth-wecom.ts`）：
  `name` 已解析成功、正准备做那对出站调用时上游一抛错就 `302 CASDOOR_UNAVAILABLE` 走人，计数
  不增长 ⇒ **永不 429**，而上游退化期间每个请求照旧打 **2 次**共享 SSO（`getUser` +
  `getPermissions`）——比无出站的 `WECOM_NOT_CONFIGURED` 高一档。可达性实测：注入 `getUser`
  恒抛错的 casdoor 工厂 + 每枚新签发的有效 OIDC code 连打 `TENANT_FAIL_LIMIT`（300）次，
  **第 301 次仍是 `CASDOOR_UNAVAILABLE`**（前置 `check` 本该在这之前把它拦成 `TOO_MANY_REQUESTS`）。
  现补 `limiter.record`（只动内存计数、不写 audit）——R2 那条"每一个失败出口都要 record"至此才成立
- 【优化】**拆桶的预算口径如实化**（`rate-limit.ts` / `routes/auth.ts` / `app.ts` 注释 + 本文件）：
  R2 的措辞"分的是**桶的键**、不是实例"读起来像"不劈预算"，与实测相反——第 2/3 层的额度是每
  `(tenantId, door)` 一份，故**聚合预算 ×门数**。代价已写进上面的【破坏】段（300→600、1000→2000）
- 【优化】**请求体上界的探针数字如实化**（`routes/auth.ts` + 本文件 R2/R1 两段）：R2 括号里的
  "8 KiB 上限下 `pull=9`、读了 9216 B"取的是 1 KiB 块长的**最有利**情形；可控块长实测 1 MiB 块
  ⇒ 内存 ≈1 MiB。上界随传输块**线性放大**，故撤掉具体数字（真实 HTTP 下 undici 按块交付，量级
  约 8 KiB + 一个 ~64 KiB 传输块）
- 【修复】**补回被 R2 换掉的状态码断言**（`apps/server/src/routes/auth-wecom.test.ts`）：坏 state
  用例的"第 N+1 次"断言此前只剩 `location`（原先是 `expect(...status).toBe(429)`）——若哪天被拦
  响应退回 JSON 却恰好带上 `Location`，这条回归会静默通过。现与本文件同类用例同口径：先断
  `302`、再断 `location`

### Fixed - PR#5 评审 R2：企微限速两处死角 + 第 2/3 层桶按「门」拆分 + 措辞收窄

> 第 2 轮评审把 PR 当一个整体看：上一轮修的限速**只修对了一半**——补上的 record 漏掉了真正
> 会走的那条分支，而已有的计数又因为按租户不分门，把企微回调的洪泛放大成了**全租户登录封锁**。

- 【修复】**企微回调的 `catch` 分支不计数 ⇒ `via=silent` 路与"上游退化"路**永不 429**
  （`apps/server/src/routes/auth-wecom.ts`）：`wecomUserIdForCode` 对坏 code 是**抛错**、不返回
  null（`packages/auth-core/src/wecom.ts`），所以 silent 路**永远到不了** `name === null`——
  它落在 `catch` → `WECOM_UNAVAILABLE`，而那条分支没有 record（`:262` 那次 record 对 silent 是
  死代码）。qr 路在上游退化（Casdoor 5xx/非 JSON）时同样落这里。后果实测：silent 路 300 次请求
  → **300 次出站 fetch**（每次打一次腾讯 getuserinfo / 共享 SSO），计数不增长、第 301 次仍 302
  ——**"上游一出问题刹车就失效"**。`WECOM_NOT_CONFIGURED` 出口一并补上（无出站、危害低一档）。
  口径从此统一：**这条路由上除"被限速本身"以外的每一个失败出口都要 record**
- 【修复】**企微回调被限速时的 429 呈现破坏该路由自陈的导航契约**（同上）：回调恒为浏览器导航
  （Casdoor/企微 302 落地），JSON 错误体是用户死胡同，而限速判定排在 `isIframe`/`fail` 定义
  **之前**、走的是 `rate-limit.ts` 的 JSON 429。实测后果：qr 路让扫码区直接显示一坨 JSON
  （`Login.tsx` 的 `WecomQrTab` 只认 `sso-done`/`sso-fail` 两种 postMessage，`onError` 永不触发，
  用户既无提示也无法重试）；silent 路整页落到 JSON 文本、连 `/login?error=` 兜底都没有。现在
  判定挪到 `fail` 之后、429 同走 `fail`（iframe 拿到对称的 `sso-fail`，顶层 302 回登录页），
  `Retry-After` 与 `console.warn` 告警均保留（为此把告警从响应里拆成 `warnRateLimitDeny`）；
  `apps/web/src/lib/api.ts` 的 `ERROR_TEXTS` 补 `TOO_MANY_REQUESTS` 文案
- 【破坏】**第 2/3 层（租户失败数 / 租户全部尝试）的桶键由 `tenantId` 改为 `(tenantId, door)`**
  （`apps/server/src/rate-limit.ts`）：`Door = 'password' | 'wecom'`。此前不分门，于是 **300 次
  匿名 `GET /wecom/callback?code=x&state=<不匹配>`（连 state cookie 都不需要）就推满租户失败桶，
  同租户的 `POST /login` 一起 429** ⇒ 打企微回调即可锁死该租户的**两种**登录入口，且可持续打
  = 永久锁死（探针实测：攻击前 `POST /login` → `200 {"ok":true}`；300 次匿名回调后同一正确凭据
  → `429 {"error":"TOO_MANY_REQUESTS"}`）。现在爆炸半径缩回"哪扇门被灌，哪扇门自己挨"。
  **"两扇门共用同一实例"这条不变**（`app.ts` 一个实例传两处）——拆的是**桶的键**，不是实例。
  **拆桶的代价如实写明（PR#5 终轮评审 S1）：聚合预算 ×门数**——第 2/3 层的额度是每
  `(tenantId, door)` 一份，故每租户每分钟可写 audit 的失败行数由 **300 变 600**、全部尝试由
  **1000 变 2000**（收益是爆炸半径 ÷门数）。这是有意的取舍：只按租户建一个跨门总闸，等于把
  本轮修的"打一扇门即锁死两扇门"原样复现。第 1 层（`(tenantId, username)`）**未**拆门，故
  拆桶严格优于拆实例。
  阈值常量全部冻结不动（5/15min、300/min、1000/min、`USER_BUCKET_CAP=8192`、`MAX_KEY_LEN=256`）；
  第 1 层（单账号失败）**不分门**，仍是 `(tenantId, username)`（企微路本就没有用户名维度）。
  调用方签名变为 `check(tenantId, door, username)` / `record(tenantId, door, username, ok)`
- 【优化】**收窄一处过强的自陈**（`apps/server/src/routes/auth.ts` + 本文件 R1 段）：「超出部分
  一个字节都不进内存」不成立——流式读取的粒度是传输块，越界那一刻已落在内存里的那一块退不回去。
  **截断本身是真的**（伪造 `Content-Length` 也不影响，只认真实读到的字节数），故改为
  「超出部分立即中止读取，上界 = 上限 + 至多一个传输块」。
  括号里的具体数字**已撤掉**（PR#5 评审 R3 段 S2）：上界随传输块线性放大，8 KiB/9216 B 只是
  1 KiB 块长的最有利情形
- 【优化】**`docs/module-protocol.md` 补三条与实现对齐的说明**：① 兜底门卫把"未声明但模块会处理"
  的路径从 **404 变成 401/403**（**仅**对注册过通配 ALL 的模块，这是有意的 fail-closed——404 与
  403 的差别会泄露路径是否存在）；② 声明路径里写 `*`（如 `GET /files/*`）时，**一条声明授权整棵
  子树**（Hono 的 `use('/files/*')` 匹配整棵子树），「逐字一致」在该形态退化为「整棵子树对得上」；
  不在 schema 里拒绝 `*` 是因为 `app.get('/files/*', h)` 是合法 Hono 写法（取舍已写明）；
  ③ **已知放松**：非终结 `use(path, mw)`（无任何 handler）也能满足逐 method 声明 ⇒ 装载通过而
  运行期 404。装载器**无法区分**它与合法的 `app.all(path, h)`（`router.routes` 里同一条 `'ALL'`
  记录），故不加装载期 warn（会对合法写法误报），改为在 `loader.test.ts` 钉死行为 + 本项写明

### Fixed - PR#5 评审 R1：ALL 路由绕过门卫 + 企微限速空转 + 登录请求体上限

> 这一轮修的六条都是**任务级评审看不见、只有把 PR 当一个整体看才暴露**的跨任务缺陷，且都源自
> 计划/规范文本（实现忠实于计划）——故修完必须回到计划侧同步（`docs/module-protocol.md`、
> `deploy/openship-adopt.md`、本文件）。

- 【修复】**`app.all('/secret', h)` / `use('/backdoor', 终结 handler)` 可**匿名**到达**
  （`apps/server/src/loader.ts`）：Hono 把 `app.all()` 与 `app.use()` 同记 `'ALL'`
  （`hono-base.js` 的 `#addRoute('ALL', …)`），而装载器把 `'ALL'` 当成"模块自己的中间件"整条
  滤掉——于是这类路由**既不参与双向核对、又拿不到声明路径上的门卫**，与 PR 的核心承诺
  "未声明 = 不可达"直接相悖（实测：`GET/POST /api/modules/demo/secret` → 匿名 200）。现在：
  无通配的 ALL 端点**路径必须逐字等于某条声明路径**，否则**装载失败**；逐 method 声明的
  `app.all('/multi', h)` 是合法写法（落在这些声明的门卫下，未声明的 method 照旧 403）
- 【修复】**通配 ALL（`use('*')` / `use('/prefix/*')` / `mount()`）覆盖面大于声明面时的那条缝**：
  这类路由匹配的路径集合比任何一条声明路径都大，逐条声明的门卫盖不住（如 `/files/*` 下的
  `/files/b` 会直达模块 handler）。现在只在模块确实注册了通配 ALL 时另挂一道**兜底门卫**：
  没被任何声明门卫放行的请求一律 401/403——没用通配 ALL 的模块行为**逐字不变**（既有 82 条
  server 测试原样通过）。不能直接给通配路径挂 `declaredScopeGate`：那里 `c.req.routePath`
  恒为通配模式本身 ⇒ 恒 403，会把合法中间件形态打坏
- 【修复】**企微回调限速结构性空转 ⇒ 永不 429，且每次请求都是一次对共享 SSO 的出站调用**
  （`apps/server/src/routes/auth-wecom.ts`）：`check` 是**只读**的，deny 只能由既有计数触发，
  而回调里唯一会 `record` 的分支只有 NO_ACCOUNT 与成功。攻击者用 `GET /wecom/qr` 取一枚
  `wecom_state` 后循环打 `GET /wecom/callback?code=<垃圾>&state=<同一 uuid>`：每次通过 state
  校验、每次经 `casdoorCodeToName` 向共享 SSO 发一次 `POST /api/login/oauth/access_token`、
  每次返回 `BAD_CODE`——计数恒不增长。`BAD_STATE` 分支同样无计数（连 state 都不需要）。现在
  `BAD_STATE` 与 `BAD_CODE` 在 `fail(...)` 前各补一次 `limiter.record(t.id, null, false)`：
  **只动内存计数、不写 audit**（"被拒请求不灌审计表"的既有语义不受影响）。同类漏记的账密路
  `!username || !password` → 401 分支一并补上（不产生出站调用，危害低一档）
- 【修复】**登录请求体无上限**（`apps/server/src/routes/auth.ts`）：全仓此前没有任何请求体上限，
  未认证攻击者仍可单请求把内存撑爆——T1 只截断了"限速桶的 Map 键"，"请求体本身"这条同源路径
  没堵。现在登录体**有界读取**（边读边计，越界即中止读取流并返 `413 {error:'PAYLOAD_TOO_LARGE'}`），
  上限 8 KiB；同时把租户维度的 `check` 前移到读体之前。
  附更正（PR#5 评审 R2）：初稿写的"超限部分一个字节都不进内存"**过强**——上界实为
  「上限 + 至多一个传输块」（流式读取按块交付，越界那块已在内存里，退不回去）。
  再更正（PR#5 评审 R3 段 S2）：这个上界**不写具体数字**——它随传输块线性放大（可控块长实测
  1 MiB 块 ⇒ 内存 ≈1 MiB）；真实 HTTP 下 undici 按块交付，量级约 8 KiB + 一个 ~64 KiB 传输块。
  仅查 `Content-Length` 不够——它可缺失（chunked）也可伪造，故只作为"连读都不读"的快速拒绝前置
- 【修复】**`manifest.api.internal[].path` 放行裸 `/`**（`packages/platform-sdk/src/manifest.ts`）：
  裸 `/` 能过 schema、也能过装载期核对，但门卫被注册成 `use('/')`（Hono 展开为 `/*`），运行期
  `routePath === '/*'` 而比对表里是 `/api/modules/<id>/` ⇒ **恒 403 且无人知晓**。正则收紧为
  `^\/(?!$)`，与"声明一个自己没有的 scope"同族，由 schema 直接拒绝
- 【修复】**匿名探测回归网与实现共享同一个盲区**（`packages/platform-sdk/src/test-util/anonymous-probe.ts`）：
  探测工具用与装载器**逐字相同**的 `method !== 'ALL'` 过滤条件，于是"装载出的模块每条路由都不可
  匿名到达"这条断言对 ALL 形态结构性地看不见（缺陷态下全绿）。现在 ALL 条目也探测（用 `GET`
  代表，`method` 原样回 `'ALL'`），并补了"无门卫的 ALL 必须被报成 200"的反向用例

### Added / Fixed / Changed - M1 闭债 R2：登录限速 + 审计保留 + 模块 scope 声明即授权（issue #3 第四节）

- 【新增】**登录端点限速**（`apps/server/src/rate-limit.ts`）：租户内三层——单账号失败 5 次/15 分、
  租户失败总数 300/分、租户全部尝试 1000/分。**限速判定先于 audit 写入**，被拦请求不落审计行，
  返 `429 {error:'TOO_MANY_REQUESTS'}` + `Retry-After`，改经 `console.warn` 让攻击在日志侧可见。
  账密与企微回调**两扇门共用同一实例**（分实例会与分桶一样把额度按份数放大，却额外放大第 1
  层，无收益——预算口径见 `apps/server/src/rate-limit.ts` 的 `Door` 注释）。计数器为进程内存、**不引入
  客户端 IP 维度**（openship edge 当前不转发 `X-Forwarded-For`，按 IP 限速会退化成全局限速；
  多副本场景下各副本各算一份是已知取舍）。桶键按用户名截断到 256（与 `auth.ts` 的
  `MAX_USERNAME_LEN` 同源），**键长**由限速器自己保证有界——这句话此前写成"调用方无法靠超长串
  撑爆内存"是**过强的**：它只覆盖了内存桶的键，没覆盖"请求体本身"这条同源路径（`POST /login`
  在 T1 仍是无上限地 `await c.req.json()`；PR#5 评审 R1 指出并已修，见本轮的【修复】条目）
- 【修复】**`platform.audit` 无界增长**：此前既无限速、又**每次登录尝试（成功/失败）都写一行**，
  且表上无 `at` 索引、全仓无清理逻辑，增长速率完全由攻击者决定。补 `002_audit_retention.sql`
  （`at` 索引 + `platform.prune_audit(days)`），由 openship job 定时调用，默认保留 90 天
- 【破坏】**`manifest.api.internal[]` 形状变更**：`{name, scope}` → `{method, path, scope}`。
  旧形状没有 path/method，**无法被任何消费者机械使用**（全仓零消费者、零文档），已按新形状重定义。
  **迁移动作（必做）**：升级前对每个模块逐条补 `method`/`path`/`scope`，用
  `pnpm exec tsx scripts/check-manifests.mjs` 一次列全清单；装载期双向核对让"没补上"的后果是
  **宿主进程启动即死**（不是"少一道鉴权"）——见 `deploy/openship-adopt.md` 已知陷阱 5
- 【破坏】**模块不再手写 `requireScope`**：API 鉴权改由宿主按 manifest 声明施加门卫。
  此前漏写一次就是**匿名可读**——不报错、不告警、CI 不红
- 【新增】**装载期双向核对**：`router.routes` 与声明集合双向比对，注册未声明/声明未注册
  一律**装载失败**（fail-fast）。「改了代码忘了改 manifest」的后果从此是起不来，而非静默漏鉴权。
  实现用**包裹层**（新建 Hono → 先挂门卫 → 再 `route('/', router)`）而非对模块 router 补 `use()`
  ——后者在 Hono 里门卫永不执行，会造出「代码里有门卫、运行时永不生效」的静默洞
- 【新增】**schema 约束 `api.internal[].scope` ∈ 本模块 `permissions[].code`**：否则该路径
  恒 403 而无人知晓——同一种病的变种；同 `(method,path)` 重复声明同样被拒（否则门卫二义）
- 【新增】**匿名探测回归网**（`@platform/sdk/test-util/anonymous-probe`，导出面
  `@platform/sdk/test-util/*`）：对每条已注册路由发匿名请求并返回实测状态码，测的是
  "门卫真的生效"而非"代码里写了什么"；装载器测试用它锁住"装载出的模块每条路由都不可匿名到达"。
  冒烟另有**真进程层面**的匿名不可达断言（`scripts/smoke-load.mjs`，发真 HTTP 请求而非进程内
  调用同一个 app 对象）
- 【新增】**模块协议文档** `docs/module-protocol.md`：`api.internal` 这个字段此前**死于零文档**
  ——仓里查不到任何一处描述它，于是没人知道它该长什么样、也没人发现它没人消费。本文补齐声明
  写法、装载期核对规则、门卫判定顺序与三条已实证的 Hono 挂载陷阱

### Fixed - M1 闭债 R1：multi 形态的模块权限供给 + 冒烟失明（issue #3 第一、二节）

- 【修复】**multi 形态下除 `PLATFORM_ORG` 所指租户外，其余租户模块 API 全线 403**：权限码是
  平台级能力，但 Casdoor 的权限记录按 org（`owner=`）存储，而**写侧只往一个 org 写、读侧按
  租户 org 读**，两侧不同源。原实现 `app.ts` 拿 `config.platformOrg` 当供给 org——该值在 multi
  下本不参与租户解析，multi 冒烟又传空串 ⇒ 整条 upsert 被 warn 跳过。改为**装载器遍历
  `platform.tenant` 的每个 `casdoor_org` 各建一套码**（权威租户清单来自 DB，`PLATFORM_ORG`
  自本轮起只服务 single 的租户解析）
  - 附更正：本段初稿曾以「`config.ts` 自己写明『multi 模式恒为空串』，属自我违背」立论——那句
    **注释与代码不符**（`optional('PLATFORM_ORG') ?? ''` 并不强制清空），复评指出后已把该注释
    改成事实描述，本段的论证也随之改为只讲"写读不同源"这一条（它不依赖那句注释即成立）
- 【修复】**启动次序：`seedDemo` 必须先于 `loadModules`**。改成从 DB 取租户 org 后，原次序
  （装载 ② → 种子 ③）在全新库上会**一个权限码都建不出来**，要等下次重启才供给。这是本次
  改动**引入**的缺陷（`tenant_module.module_id` 无外键，seed 不依赖装载器，重排安全）
- 【修复】**测试门禁对上述故障结构性失明**（三条成因逐条对治）：① `MockCasdoor` 的
  `get-permissions` 此前**忽略 `owner=`**（自陈"mock 单 org"）⇒ 改为按 org 分桶，且 owner
  缺失直接 `status:error`，绝不给"忽略形参回全部"的旧形状留活口；② 冒烟把 `p-demo-view`/
  `p-demo-note` **预种**进 mock ⇒ 装载器查重必命中、`add-permission` 全程零调用 ⇒ 撤掉预种，
  改由冒烟以**租户管理员身份走真 HTTP**（`POST /api/update-permission`）授权，使「装载器建码」
  与「管理员授权」两件事各自可见；③ 冒烟的 multi 只驱动 `acme.test`、**从不驱动 beta** ⇒
  补驱动 `beta.test` 并断言其 403（码在、授权不在 ⇒ 403 是授权在拦，而非路由不存在）
- 【新增】**multi 冒烟把 `PLATFORM_ORG` 设为诱饵值 `NOT-ACME-ORG`**（不指向任何租户）：
  修复前这条**因错误原因通过**（读侧根本不用它），修复后必须因正确原因通过。
  它能排除的只是"供给 org 退回取 `config.platformOrg`"这一种回退，**不是**写读同源的完整
  证明——完整证明在 beta 那两条（码存在 + scopes 缺失），详见本节末评审修复轮的说明
- 【新增】**mutation 红检留档**：把供给查询改成 `limit 1`（复现原始缺陷形状）时，冒烟红在
  「装载器经 add-permission 建码覆盖两个租户 org（实际 `[acme]`）」——证明新断言咬住的正是
  这个 bug，不是碰巧
- 【优化】**跳过供给时的 warn 说清后果**：从"跳过权限 upsert"改为点名哪些租户 org 的用户
  将全部 403——只报"少做了一步"会让 403 的归因成本全部留给排障者
- 【新增】**装载器导出 `provisionModulePermissions`**：未来的租户创建入口直接复用它，
  避免「新增租户只能靠重启」成为死路（本轮不造租户创建 API）
- 【优化】**`deploy/openship-adopt.md` 同步**：决策表/`TENANT_MODE` 行/已知陷阱 2 原写
  「`multi` 跳过启动期权限 upsert」已不成立；陷阱 2 的适用条件从「`single` + `PLATFORM_ORG`
  非空」扩展为**两种模式**

### Fixed - M1 闭债 R1 评审修复轮（异种评审 2 名 → 4 条必须改 + 3 条关键建议改）

- 【修复】**`scripts/dev-stack.mjs` 的两条权限预种漏改 ⇒ `pnpm dev:stack` 的 demo 模块由 200 变
  403**。上一轮的分桶改动只扫了测试文件，漏了这个脚本：它的预种没标 `owner`，落进 `MOCK_ORG`
  桶而租户 org 是 `acme` ⇒ 装载器另建一枚 `users` 为空的码 ⇒ admin1 `scopes` 恒空。
  **`docs/m0-smoke-checklist.md` 的 C1 复现路径正押在这里**，而 CI 不跑 `dev:stack` ⇒ 无门禁咬住。
  已实测：修复后 `scopes` 含 `demo:view/demo:note`、`ping` 200、对照组 viewer1 仍 403
- 【修复】**未配 admin 凭据时的行为自相矛盾**：`app.ts` 无条件把工厂传给装载器 ⇒
  `CasdoorClient` 抛 `adminUser/adminPwd not configured` ⇒ 进程起不来；而 `config.ts` 把这两个
  键设为可选、`.env.example` 出厂即空、demo 模块确实声明了 2 条权限。**`multi` 是本次引入的
  回归**（改前传 `undefined` ⇒ warn 后继续启动）。
  首次修法是"未配凭据则不把工厂交给装载器（只 warn 跳过）"，但该修法援引的前提
  「『只登录不管理』是合法部署形态」**被复评证伪**（登录签发前必调 getUser + getPermissions，
  两者都走 admin 会话 ⇒ 缺凭据时无人能拿到会话——即便凭据正确也签不出：签发前 502；错凭据仍是 401）。故最终改为
  **凭据在 config 层必填、启动期 fail-fast**——见下方评审修复轮 R2
- 【修复】**冒烟的 `addPermissionCalls.length >= 2` 抓得住"恒为 0"那种形状，抓不住 `limit 1`
  这种形状**：demo 恰好 2 条码、租户恰好 2 个 ⇒ 正常态 4 次、单 org 缺陷态 2 次，`>= 2` 在
  两者下**都为真**（它声明要抓的"0 次"确实抓得住，我初稿写成"抓不住它自称要抓的缺陷"是
  说大了，复评指正后收敛）。改为断言 org **集合**等于 `{acme,beta}`——实测在该缺陷态下
  红为 `实际 [acme]`，即真的能区分
- 【优化】**诱饵 `PLATFORM_ORG` 断言的效力收敛**：它排除的只是「供给 org 退回取
  `config.platformOrg`」这一种回退，不是"写读同源"的完整证明（同源由 beta 码存在 + beta
  scopes 缺失两条合起来证）。spec §4.4 与代码注释同步改写，并说明它与 beta 断言在该形状下冗余
- 【优化】**权限码供给改为每 org 只拉一次 `get-permissions`**（`CasdoorClient.upsertPermissions`
  批量接口）：单码版每码全量拉一次，租户数 × 码数 是乘法开销，租户扩张下启动期很贵
- 【修复】**并发启动竞态**：`upsertPermission` 是 check-then-add，滚动发布/多副本下两实例可能
  同时判"码不存在"并双双 add，输的那个报错 ⇒ 启动失败。本轮的供给次数从「码数」扩到
  「租户数×码数」，竞态窗口同步放大，故一并处理——**具体做法见 R2**（首版实现有缺陷）
- 【修复】**`config.ts` 的 `platformOrg` 注释与代码不符**（原写「multi 模式恒为空串」，实际
  `optional() ?? ''` 并不强制清空）——上一轮的论证曾引用该注释，已改为事实描述

### Fixed - M1 闭债 R1 评审修复轮 R2（第 2 轮异种评审 2 名 → 3 条必须改）

R1 的修复本身被复评出了三个问题——其中两个是**我在修复轮里新引入的**：

- 【修复】**批量供给的"占位记录"会抹掉既有授权**：R1 为了在同批内去重，把刚建的码拼一条
  `{owner, name, resources}` 塞进本地列表；该记录缺 `users/roles/model`，被 `#upsertOne`
  当成真记录消费（`existing?.users ?? []`）⇒ 同批内同一 code 出现第二次时走 update 把服务端
  的 `users` 清空。旧单码版每次重取服务端、拿到的是**真**记录，**这是 R1 引入的语义退化**。
  改为用 `Set` 去重，不伪造记录（实测：旧写法同批两次会发 2 次写请求，新写法 1 次）
- 【修复】**duplicate 容忍把"响亮的失败"换成了"静默的永久故障"**：R1 无条件容忍 add 路径上的
  duplicate，但 add 被拒有两种来源且**不重读无法区分**——①并发实例刚建了同一个码（容忍正确）；
  ②已有一条 `name === code` 但 `resources` 不含它的记录（**码此刻并不在**）。②时装载器报成功、
  日志无一行、码永远不供给 ⇒ 该租户全站 403 且无从归因。**修复前这是启动期硬崩**——即 R1 为治
  并发竞态，亲手把本 PR 全程在批判的「静默失明」引了回来。改为**不按错误文案判断**：add 失败后
  重读 `get-permissions`，码确实在 `resources` 里 ⇒ 视为成功，不在 ⇒ 原样抛。顺带消掉了
  「`/duplicate/i` 正则源自 MockCasdoor 自造文案」的循环论证（该正则在真机上有退化成凭空崩溃
  重启的风险）
- 【修复】**「未配 admin 凭据」的后果被写错，且被钉进了测试**：R1 的注释/warn/CHANGELOG/runbook
  均称后果是"各租户全线 403"，实测是**登录签不出会话（凭据正确也 502，错凭据仍是 401）**（登录签发前必调 getUser + getPermissions，
  两者都走 admin 会话 ⇒ 缺凭据时无人能拿到会话）。R1 据此写下的「『只登录不管理』是合法部署
  形态」**不成立**——缺凭据的实例起得来也毫无用处。**故把 spec §3.5 的方向反转**：
  `CASDOOR_ADMIN_USER`/`_PWD` 改为 config 层**必填**（启动期 fail-fast），而不是"起得来但全员
  用不了"。`config.ts` 里「纯登录场景不需要」那句错话（**R1 之前就存在**）一并更正
- 【新增】**`upsertPermissions` 的三条直接测试**：该接口 R1 引入时**零直接测试**，这正是上面
  两个缺陷没被任何红检咬住的原因。三条分别覆盖"同批重复 code 只发一次写请求"、"撞码时抛错
  而非静默洗掉授权"、"并发竞态下码已存在则视为成功且不洗对方 users"。红检留档：还原 R1 写法后
  分别红为 `expected 2 to be 1` 与 `promise resolved "undefined" instead of rejecting`
- 【优化】**装载器的 warn 不再替调用方断言 HTTP 状态**：原写"用户将全部 403"——装载器无从知道
  宿主有没有配凭据（那决定用户能否登录），写死状态码是在许一个自己证明不了的承诺
- 【新增】**`apps/server/src/app.test.ts`**（**R2 已删除**，见下）：曾作为宿主装配的唯一直接
  测试，锁「凭据闸门」这一对行为（未配凭据 ⇒ 装配成功 + warn 点名租户；配了凭据 ⇒ 确实去供给），
  红检留档为 `CasdoorClient: adminUser/adminPwd not configured`。
  R2 把凭据改为必填后，「凭据闸门」这个行为**已被否决**，锁它的测试随之删除——否则就是拿测试
  钉住一个不该存在的行为。
  **但同文件另一条用例被误删**：见 R3（那条与凭据有无无关、至今成立，已恢复）

### Fixed - M1 闭债 R1 评审修复轮 R3（第 3 轮异种评审 2 名 → 代码零缺陷，4 条文档/覆盖问题）

第 3 轮评审在**代码层面找不到必须改的点**（R2 的两处实质修复经复核方向与实现均正确），
4 条必须改全是"文档/注释仍在陈述被 R2 亲手否决的事实"，外加一条**我在 R2 造成的覆盖回归**：

- 【修复】**R1 段 CHANGELOG 仍写着 R2 已删除的 `app.test.ts`**，且描述的正是 R2 否决掉的行为
  （「未配凭据 ⇒ 装配成功」）——同一 PR 内自相矛盾。四守卫都不校验 CHANGELOG 提到的文件是否
  存在 ⇒ **无门禁咬住**，而它位于 `[Unreleased]` 段内，会被当成下个版本的事实陈述
- 【修复】**`loader.ts` 的 `casdoorFor` 注释仍写「保留『只登录不管理』的部署形态」**——正是 R2
  判为不存在的前提。R2 改了同文件的 warn 文案与 `config.ts` 的同类错话，漏了这一处；照它读
  会把 `app.ts` 的 `canProvision` 闸门重新加回来
- 【修复】**`deploy/README.md` 与 `docs/m0-smoke-checklist.md` 仍写「纯本地可用 `TENANT_MODE=multi`
  + 空 `PLATFORM_ORG` 跳过 upsert」**——该逃生口已两重失效（供给根本不看这两个变量；凭据还是
  必填）。照它操作会得到「缺少必填环境变量」的崩溃循环，而文档说这条路「跳过 upsert」。
  已改为事实描述：想跳过启动期 Casdoor 依赖应**不设 `SEED_DEMO`**（租户表为空 ⇒ 供给循环不
  执行），但凭据仍必填、登录仍需 Casdoor 可达
- 【修复】**恢复被误删的启动期 fail-fast 测试**：R2 删 `app.test.ts` 时**整文件删掉**，但其中
  「配了凭据 + Casdoor 鉴权失败 ⇒ `buildApp` 拒绝」那条与凭据有无**无关、至今成立**，且是
  runbook 已知陷阱 2 / spec §3.4（「连不上 Casdoor 就起不来」）**唯一的直接断言**——
  `loader.test.ts` 没有一条断言 upsert 失败会上抛，smoke 只跑绿路径。已恢复（只留下这一条，
  断言锁在 `/casdoor admin login failed/` 而非裸 `rejects.toThrow()`），并在文件头写明历史，
  免得后来者再连它一起删
- 【修复】**「缺凭据 ⇒ 登录一律 502」是夸大**（复评用真 `routes/auth.ts` + 真 `CasdoorClient` +
  真 MockCasdoor 实测）：**凭据正确**时确实 502，但**错凭据仍是 401**（那是对的）。方向
  （不是 403）与结论（无人能拿到会话）都成立，错的只是"一律"。已按实测口径改写 `.env.example` /
  `config.ts` / `config.test.ts` / `openship-adopt.md` / `deploy/README.md` / smoke 清单 / spec §3.5
- 【优化】**撞码用例不再锁错误文案**：生产代码刚刚专门去掉了对 Casdoor 文案的依赖，测试层再把
  `/duplicate/i` 押回 mock 自造的那句字符串就是同一耦合换个位置（mock 文案一改，行为完全正确
  时测试也会红）。改为裸 `rejects.toThrow()`，真正的判据是「既有记录的 `users` 未被洗掉」
- 【优化】**供给失败的错误带上 org/code 与处置线索**：撞码时 add 会**永久**失败（平台起不来，
  不只是某租户 403），而 Casdoor 原文只有一句 duplicate，运维无从反推出"共享 Casdoor 里有一
  条同名异物记录"。同时把"重读也失败"的二级故障原因挂上（用 `cause`），别让它凭空消失
- （留证·未改）`getPermissions` 的 `pageSize=100` 无翻页：供给的重读分辨力只在窗口内成立，
  已写进代码注释；翻页能力本 PR 声明在范围外。另：同批重复 code 的 `displayName` 取首个——
  根因是 manifest 未校验 `permissions[].code` 唯一性，应在模块协议层收口（另立）

### Added - 分支保护软替代：本地拦 + 事后可见（free 私有仓无服务端分支保护）

- 【新增】**四层提交纪律机制**。起因：本仓是私有仓 + org plan=free，GitHub 的 branch protection
  与 rulesets **在该 tier 上不可用**（实测 `gh api .../branches/main/protection` → 403
  `Upgrade to GitHub Pro or make this repository public`；同一身份 `permissions.admin=true`
  却仍 403 ⇒ 是 tier 限制、管理员也开不了，不是权限问题）。服务端拦不住直推，改为：
  **①** `.githooks/pre-push` 拦本机直推 `main`/`master`（含删除推送；放行口
  `PLATFORM_ALLOW_DIRECT_PUSH=1` 须显式打、且放行时出声）；**②** 根 `prepare` →
  `scripts/install-git-hooks.mjs`，让同事 clone 后 `pnpm install` 即自动装上（`core.hooksPath`
  **不随 clone 继承**，光把钩子放进仓里没用）；**③a** CI `gates` 增「校验装置完好」步；
  **③b** 新增 `main-guard` job（push 到 main 后的事后绊线）
- 【新增】**`main-guard` 的判据是 associated-pulls，不是"数父提交有几个"**：squash / rebase 合并
  产生的新提交同样是单父的。用本仓真实提交实测——`241ed3a`（PR #1 **squash 合并**）与
  `eec7791`（历史**直推**）**父提交数都是 1**，按"数父"判两者结论完全相同、判据等于废掉；
  `/commits/{sha}/pulls` 才能分开（1 vs 0）。此结论写进了 ci.yml 注释
- 【新增】**装置行为测试 20 条**（`scripts/git-hooks.test.ts`）：除纯 spawn 外专设一档
  **经真 git 真推**（建裸 origin + 工作仓）锁住钩子赖以工作的 stdin 契约——只对着自造 fixture
  断言，等于用自己的假设验证自己的假设。另含两条**特征化测试**，把「`--no-verify` 可一步绕过」
  与「对任意远端名都拦（推 fork / 备份仓会误伤）」钉在代码里，免得日后有人以为它滴水不漏
- 【修复】**`install-git-hooks.mjs` 的仓根改取 `--show-toplevel`**（原先从脚本位置倒推）。git 把
  `core.hooksPath` 当"仓根下的相对路径"解析，倒推的目录与之不一致时会去写**错的仓库**——最坏
  情形是本包被当依赖装进别人的仓库，那会把对方**所有**钩子指向一个它那里不存在的 `.githooks`，
  该仓钩子集体静默失效。同时把 `readdirSync` 收进 try：头注承诺"任何失败都不阻断安装"是**绝对**
  承诺，而列目录失败（`.githooks` 是普通文件 ⇒ ENOTDIR）曾会让 `pnpm install` 以退出码 1 挂掉
- 【新增】**`deploy/branch-protection-runbook.md` 重写**：原版把上述 tier 限制误记为「权限问题、
  待管理员执行」，**前提就是错的**。新版记录 403 原文、四层机制、**七条局限**（首条即
  `git push --no-verify` 一步绕过——最省事的绕过方式，不该藏起来），以及将来升级 Pro / Team
  后切回真保护的完整操作单，含两条会自相矛盾或卡死 PR 的坑（`enforce_admins` 必须为 true，
  否则"验证直推被拒"这一步自己就失败；push-only 的 `main-guard` **不能**放进 required contexts，
  否则每个 PR 都卡在 "Expected — Waiting for status to be reported"）。README 补「提交纪律」段
- 【修复】**`main-guard` 的「首次推送」分支自己会挂（bash 3.2）**：那条 `echo` 里 `$BEFORE`
  紧跟全角右括号「）」，而 bash 3.2（macOS 自带 `/bin/bash`）在 UTF-8 locale 下把 0x80 以上
  的字节**也算作变量名字符**——`$BEFORE）` 被解析成变量 `BEFORE）`，`set -u` 下直接
  "unbound variable" 退出 1。也就是说，**这条本意是「安全跳过」的分支，反而会把 job 弄挂**。
  CI 用的是 bash 5（实测 5.2.37 解析正确），所以只坑本地复跑；已改为 `${BEFORE}`，两种
  bash 上都正确。**这条是靠"把 run 块抽出来用真 bash 跑一遍"发现的**——纸面推演和自造夹具
  看不见 shell 解析器本身的行为，这正是它当初没被审出来的原因
- 【修复】**本条改动最初漏记 CHANGELOG**：首次提交时把它误判为「此仓无 CHANGELOG 机制」——
  该判断是错的（本文件自 M0 Task 22 建立，其头部正是「可见变更必须有 CHANGELOG 行内标注」）。
  那句错误判断作为既成事实留在 git 历史里，在此更正

### Added - 部署面：Dockerfile / compose / OpenShip 接入 runbook / M0 手工冒烟清单（M0 Task 22）

- 【新增】**`deploy/Dockerfile.server`**：node:22-alpine 多阶段宿主镜像。build 阶段
  `corepack enable`（pnpm 版本取自 package.json 的 `packageManager`，不在 Dockerfile 里写第二份）
  + `pnpm install --frozen-lockfile && pnpm -r --if-present build`；runtime 阶段**逐目录 COPY**
  （root 清单 / 根 TS 工程 / scripts / packages / apps / modules / deploy），非 `COPY . .` ——
  漏一个目录就是一类启动期故障（gateway 漏 COPY 新模块 crash loop 三次的教训）。非 root 运行，
  镜像内置 HEALTHCHECK 打容器内 `$PORT/healthz`
- 【新增】**`deploy/docker-compose.yml`**（全仓唯一 compose，约束 B7）：`postgres`（healthcheck +
  命名卷）与 `server`（build 上面的 Dockerfile、`depends_on: service_healthy`、宿主 13000）。
  顶层 **`name: platform-core` 是必需的**：compose 默认项目名取自 compose 文件所在**目录名**，
  本文件在 `deploy/` 下，与任何同样把 compose 放 `deploy/` 的仓库共用项目名与卷名——
  实测已发生「本仓 `up -d postgres` 把另一个项目的容器就地 Recreate」的事故
- 【新增】**`.dockerignore`**：挡住宿主 `node_modules`（darwin 产物 + 悬空 workspace 链接）与
  陈旧 `apps/web/dist`——后者会伪装成「构建成功但页面正常」的假绿，镜像里的 dist 必须出自构建阶段
- 【新增】**`deploy/openship-adopt.md`**：OpenShip adopt + 生产部署的操作单（前置决策、env 13 键
  清单与生产取值、卷/域名/证书、生产差异、部署触发、验证、回滚、四个已知陷阱）
- 【新增】**`docs/m0-smoke-checklist.md`**：M0 手工冒烟清单。含「容器日志不得出现
  `[web] … 不存在，跳过静态托管`」这一条（静态托管静默降级 = 白屏前兆，而 `/healthz` 照绿）；
  企微真机两用例标注**待企微配置后补验**并写清前置条件，不留空勾选框
- 【新增】**`ci.yml` 的 `deploy` job**（CD 触发，默认惰性）：四个门禁 job 全绿后
  `POST /api/deployments {projectId, commitSha}` 让 openship 按 commit 部署。闸门用 repo variable
  `OPENSHIP_PROJECT_ID`——GitHub 的 job 级 `if` 读不到 `secrets` 上下文，「配了 secret 就跑」
  这个写法不成立；未设该变量时 job 显示 skipped，不产生任何控制面请求
- 【优化】**`deploy/README.md` / 根 `README.md`**：从「部署编排占位」改为指向真实产物
  （compose / Dockerfile / 两份 runbook / 冒烟清单），CI job 数从四个改为四个门禁 + 一个惰性 CD

### Fixed - 冒烟清单的复现路径与 C1 浏览器验证（Task 22 fix-1）

- 【修复】**`docs/m0-smoke-checklist.md` C1**：原文以「Orca CLI 这个版本没有 browser 子命令」
  为由把 console 演示页浏览器验证留成待人工——**这个理由不成立**（Orca CLI 1.4.197 有一整组
  Browser Automation 命令，`orca browser` 只是帮助里的分组标题而非子命令）。已**实际跑完**并记录
  结果：登录页渲染 → `admin1/pw` 登录落 `/console` → 左菜单「演示」→ `/console/demo` 便签列表
  从 `/api/modules/demo/notes` 渲染 → 深链 `reload` 不 404 → 全程 `/api/*` 200、零未捕获 JS 异常。
  截图落 `docs/img/console-demo-notes.png`
- 【修复】**A2 的复现路径**：原文标 ✅ 但照着做复现不了——它依赖一个**未提交、被 gitignore** 的
  `.tmp/mock-casdoor-net.ts` TCP 转发（MockCasdoor 只绑 `127.0.0.1`，容器够不着宿主环回），
  且没写 `CASDOOR_URL` 必须容器可达、也没交代实际跑的是 `HOST_PORT=13001` 而非文中写的 13000。
  已在 A2 内补齐这三条前置，并新增**容器内那一遍的坑记账**
- 【新增】**`scripts/dev-stack.mjs`（`pnpm dev:stack`）**：本地长驻开发栈——一次起 MockCasdoor
  + 宿主进程 + 本机 PG，打印可点的登录页/控制台/演示页 URL，长驻到 Ctrl-C 后收净（宿主进程组 +
  mock）。**自持全部 env、不读 `.env`、不依赖任何未提交的临时文件**，因此 A2 与 C1 都能从
  克隆下来的仓库直接复现。缺 `apps/web/dist` 时它**先死**——半启动会得到「`/healthz` 照绿而页面
  全白」的假绿，那正是本仓被坑过一次的那类问题
- 【优化】**冒烟清单 A 节前置**：把两条起栈路（`pnpm dev:stack` 看页面 / `docker compose` 验镜像）
  分开写清，并补上共用的两条前置——**PG 端口冲突**（本机 5432 常年被别的容器占着，A4 的复跑命令
  现在直接跑会失败）与 **Casdoor 可达性**（容器内 `127.0.0.1` ≠ 宿主 `127.0.0.1`）
- 【优化】**`.env.example`**：新增 `DEV_STACK_PORT`（仅 `pnpm dev:stack` 读，默认 13100，
  避开 13000 这个 `pnpm dev` / compose 的默认端口）；`package.json` 增 `dev:stack` 脚本别名

### 已知留白（不假装已完成）

- Dockerfile **没有** `ARG NPM_REGISTRY` 构建源入口：境内生产机构建可能被限速，届时按
  `data-platform-scaffold/core/gateway/Dockerfile` 的先例补（见 `deploy/openship-adopt.md` 陷阱 3）
- 生产 adopt **未执行**：需先由人拍板目标服务器与 PG 策略（`deploy/openship-adopt.md` 的
  「前置决策」与「为什么没在 Task 22 里直接 adopt」）
