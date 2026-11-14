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

## [0.282.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.281.0...v0.282.0) - 2026-11-14
- 【修复】data: 管线地图区分「父管线驱动」与「未接入」 (#2228) ([#2229](https://github.com/MYTech-Co-LTD/platform-core/pull/2229), [162da62](https://github.com/MYTech-Co-LTD/platform-core/commit/162da6213cccaba4fe452d5e206aed0974717fc0))
- 【新增】data: 管线地图——未调度管线清单入口 (#2226) ([#2227](https://github.com/MYTech-Co-LTD/platform-core/pull/2227), [ffbf558](https://github.com/MYTech-Co-LTD/platform-core/commit/ffbf5587d20baa982ea1a58ebe47112fe87c19d4))


## [0.281.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.280.0...v0.281.0) - 2026-11-14
- 【新增】data: R2 锚点自证（审阅面数据水位/SLA） (#2224) ([#2225](https://github.com/MYTech-Co-LTD/platform-core/pull/2225), [fb18fc1](https://github.com/MYTech-Co-LTD/platform-core/commit/fb18fc148fcc084be5bfb9a697f9ab61faed5fb5))


## [0.280.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.279.0...v0.280.0) - 2026-11-14
- 【新增】data: 管线地图——单条管线的完整运行历史 (#2222) ([#2223](https://github.com/MYTech-Co-LTD/platform-core/pull/2223), [342c697](https://github.com/MYTech-Co-LTD/platform-core/commit/342c6975ad9ba3edf90be927831a17bd2ef7c930))


## [0.279.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.278.1...v0.279.0) - 2026-11-14
- 【修复】ci: 发布门接受全角 PR 引用 + 无文本引用时问 API ([#2220](https://github.com/MYTech-Co-LTD/platform-core/pull/2220), [f00254b](https://github.com/MYTech-Co-LTD/platform-core/commit/f00254b8f54a773179debe21f31600c40106ea45))
- 【新增】data: 管线地图 KPI 改服务端出数，消除前端重算 (#2215) ([#2218](https://github.com/MYTech-Co-LTD/platform-core/pull/2218), [a668599](https://github.com/MYTech-Co-LTD/platform-core/commit/a668599a2fc01f7f73e8de785dbdc1157e28797f))
- 【优化】data: R4 事实包构建 p95 分项基线（台账 + 面板） (#2214) ([#2217](https://github.com/MYTech-Co-LTD/platform-core/pull/2217), [6810297](https://github.com/MYTech-Co-LTD/platform-core/commit/6810297e06628044922b93438fdbd31171498f1a))
- 【修复】data: 管线地图「断点」KPI 与 domain 口径对齐（视图消费不算断点）(#2213) ([#2212](https://github.com/MYTech-Co-LTD/platform-core/pull/2212), [fb88b6c](https://github.com/MYTech-Co-LTD/platform-core/commit/fb88b6c7331c810034a3f420e478cfb0c7ecab5b))
- 【新增】data: 平台内置调度器——排班/台账/执行器/健康（Wave 6 P1） ([#2207](https://github.com/MYTech-Co-LTD/platform-core/pull/2207), [fb88f72](https://github.com/MYTech-Co-LTD/platform-core/commit/fb88f72293baa810dbe7d8b8b728afd59c73ecf0))
- 【新增】data: R6 报表访问台账与 30 天零访问提醒 (#2210) ([#2211](https://github.com/MYTech-Co-LTD/platform-core/pull/2211), [f242501](https://github.com/MYTech-Co-LTD/platform-core/commit/f242501c5094ce37b3294e56165d2bb3732a2701))
- 【修复】data: 管线地图把视图消费算作下游，假断点归零 (#2208) ([#2209](https://github.com/MYTech-Co-LTD/platform-core/pull/2209), [40a98c6](https://github.com/MYTech-Co-LTD/platform-core/commit/40a98c677e2ce7e742fcd35f5def9bb39b0a8b64))
- 【修复】data: 管线地图健康只算在跑的管线，未调度的历史失败不染红 (#2205) ([#2206](https://github.com/MYTech-Co-LTD/platform-core/pull/2206), [f8bb0e3](https://github.com/MYTech-Co-LTD/platform-core/commit/f8bb0e3682af40d4175f0797f9dda57e57f151da))
- 【新增】data: R2 console 模板选择入口（选模板 → 填指标 → 建草稿） (#2203) ([#2204](https://github.com/MYTech-Co-LTD/platform-core/pull/2204), [02f4dcf](https://github.com/MYTech-Co-LTD/platform-core/commit/02f4dcf4f596c7b2cd8617d8aabf0cd9c4e3ae27))
- 【新增】data: 管线地图接入运行态——健康描边、只看异常、最近 3 次 run (#2198) ([#2199](https://github.com/MYTech-Co-LTD/platform-core/pull/2199), [b601f9c](https://github.com/MYTech-Co-LTD/platform-core/commit/b601f9c96c132faa1d70619bfa5e9021145f84a8))
- 【优化】data: R4 事实包查询去重与构建观测 (#2195) ([#2197](https://github.com/MYTech-Co-LTD/platform-core/pull/2197), [c97b0a3](https://github.com/MYTech-Co-LTD/platform-core/commit/c97b0a3b68b1fabd185e5b5049fd66c5dd063da8))
- 【新增】data: report_versions 库级不可变（R6 / 049） ([#2193](https://github.com/MYTech-Co-LTD/platform-core/pull/2193), [c69c304](https://github.com/MYTech-Co-LTD/platform-core/commit/c69c304a8f3b5d0611eb4fc7e3626d41522edc87))
- 【新增】data: R3 打印全部（等待 AI/KPI 落定的一次性整份打印） (#2188) ([#2189](https://github.com/MYTech-Co-LTD/platform-core/pull/2189), [efd9d5b](https://github.com/MYTech-Co-LTD/platform-core/commit/efd9d5b1e495a34693dd9f2290c0a0a2478637db))
- 【新增】data: R5 叙事质量运维面板与阈值 (#2174) ([#2175](https://github.com/MYTech-Co-LTD/platform-core/pull/2175), [0c7f3c9](https://github.com/MYTech-Co-LTD/platform-core/commit/0c7f3c90b093710b4bb73e42df67362d738c6b85))
- 【修复】data: fct_retail_comparable_growth bounds 加闭窗读，避免白天撞活分区 ETag ([#2159](https://github.com/MYTech-Co-LTD/platform-core/pull/2159), [76cfe15](https://github.com/MYTech-Co-LTD/platform-core/commit/76cfe155bbb22a26862bfb0f7d6820c3c41d8df4))
- 【优化】data: R4 跨面板查询合并（同 body 只发一次） (#2170) ([#2171](https://github.com/MYTech-Co-LTD/platform-core/pull/2171), [282a8a9](https://github.com/MYTech-Co-LTD/platform-core/commit/282a8a9b85ebaf01dbdf3e5fc3a657ca6ba3df5c))
- 【新增】data: R3 文本语义内嵌 token（L2） (#2167) ([#2168](https://github.com/MYTech-Co-LTD/platform-core/pull/2168), [d200bac](https://github.com/MYTech-Co-LTD/platform-core/commit/d200bacb55c72cdd2eec401c7167301c538c2677))
- 【新增】data: R3 多页编排与打印版式 (#2163) ([#2165](https://github.com/MYTech-Co-LTD/platform-core/pull/2165), [86521e6](https://github.com/MYTech-Co-LTD/platform-core/commit/86521e6e13abd2b729b32d868a0145f4d91afe80))
- 【新增】data: R3 组件⑤ 可折叠明细（table 行展开） (#2160) ([#2162](https://github.com/MYTech-Co-LTD/platform-core/pull/2162), [7c08ba4](https://github.com/MYTech-Co-LTD/platform-core/commit/7c08ba4b0fb75872d12ae89de8d8a554b5057827))
- 【新增】data: 指标下线提案——使用统计接评审（候选池项） ([#2157](https://github.com/MYTech-Co-LTD/platform-core/pull/2157), [4546768](https://github.com/MYTech-Co-LTD/platform-core/commit/45467681ecf79729c04938803ad2b9d490326aad))
- 【修复】data: 真正换掉链路水位的手写 SQL（#2151 只加了 import，查询没换）(#2156) ([#2155](https://github.com/MYTech-Co-LTD/platform-core/pull/2155), [efc316e](https://github.com/MYTech-Co-LTD/platform-core/commit/efc316e6c73efd56a226c3f24966829fef65f671))
- 【新增】data: R3 组件④ KPI 迷你趋势 sparkline (#2153) ([#2154](https://github.com/MYTech-Co-LTD/platform-core/pull/2154), [124aeaa](https://github.com/MYTech-Co-LTD/platform-core/commit/124aeaabc29408d5d01ea27228327072f81a5052))
- 【修复】data: 指标链路水位改用 #844 订正后的唯一拼装点 (#2152) ([#2151](https://github.com/MYTech-Co-LTD/platform-core/pull/2151), [354c096](https://github.com/MYTech-Co-LTD/platform-core/commit/354c09613728bc58dd804610296f7354c7cf0ee3))
- 【新增】data: R3 组件③ 目标对比卡 (#2145) ([#2147](https://github.com/MYTech-Co-LTD/platform-core/pull/2147), [4ee809e](https://github.com/MYTech-Co-LTD/platform-core/commit/4ee809e5dd381ea90ba5d753c0ee12fb52741c35))
- 【修复】data: 链路与管线地图改用契约前缀（dim_* 资产不再误判断点） ([#2143](https://github.com/MYTech-Co-LTD/platform-core/pull/2143), [52c726e](https://github.com/MYTech-Co-LTD/platform-core/commit/52c726ed1c4922a70391e41fec67acce31ef8b98))
- 【新增】data: 指标语义治理 P6——证据与治理收口 ([#2141](https://github.com/MYTech-Co-LTD/platform-core/pull/2141), [67604c9](https://github.com/MYTech-Co-LTD/platform-core/commit/67604c932ea0b8cc540f4693b429b2494765b7d7))
- 【新增】data: 指标链路条 + 管线地图（资产→staging→marts） ([#2139](https://github.com/MYTech-Co-LTD/platform-core/pull/2139), [c627a04](https://github.com/MYTech-Co-LTD/platform-core/commit/c627a04dffc8ad8b478a704c52eb59f8f9699d7d))
- 【新增】data: R3 组件② 瀑布图——环比差异分解 (#2137) ([#2138](https://github.com/MYTech-Co-LTD/platform-core/pull/2138), [3f3e92e](https://github.com/MYTech-Co-LTD/platform-core/commit/3f3e92eece8130d24900fca68c91f2e7b53180cd))
- 【新增】data: R3 组件① 交叉表 (#2135) ([#2136](https://github.com/MYTech-Co-LTD/platform-core/pull/2136), [6daffa7](https://github.com/MYTech-Co-LTD/platform-core/commit/6daffa714c88349ad10675930b53d1c3cdc59444))
- 【新增】data: R3 V5 存储保留 v2，读面归一 v1 (#2133) ([#2134](https://github.com/MYTech-Co-LTD/platform-core/pull/2134), [ef92f50](https://github.com/MYTech-Co-LTD/platform-core/commit/ef92f50fc08258906fa32d78d1c110b045a1af76))
- 【新增】data: R3 V4b 共享筛选 UI 与叙事透传 (#2130) ([#2132](https://github.com/MYTech-Co-LTD/platform-core/pull/2132), [c0f8022](https://github.com/MYTech-Co-LTD/platform-core/commit/c0f802217f9308f7f29b81e266358840dd13074f))
- 【新增】data: R3 V4a 共享筛选数据通路 (#2128) ([#2129](https://github.com/MYTech-Co-LTD/platform-core/pull/2129), [c86328d](https://github.com/MYTech-Co-LTD/platform-core/commit/c86328d4e25631bfd2f32cf489d8b6190ba17af9))
- 【新增】data: R3 V3 facts 消费 ReportPlan (#2126) ([#2127](https://github.com/MYTech-Co-LTD/platform-core/pull/2127), [f56dd7f](https://github.com/MYTech-Co-LTD/platform-core/commit/f56dd7f63f764f2ec2f8e48c262cb5e0014640c3))
- 【新增】data: R3 V2 渲染器改消费 ReportPlan (#2120) ([#2121](https://github.com/MYTech-Co-LTD/platform-core/pull/2121), [2ceaf4c](https://github.com/MYTech-Co-LTD/platform-core/commit/2ceaf4c6f0b6590f6b45a5a89c4b1f9c8bc5511d))
- 【新增】data: R3 V1 IR v2 输入——datasets/blocks 解析并扁平化为 v1 (#2117) ([#2118](https://github.com/MYTech-Co-LTD/platform-core/pull/2118), [aa42537](https://github.com/MYTech-Co-LTD/platform-core/commit/aa42537ed3ae1661f85297edab886aa3ae01616d))
- 【新增】data: R3 V0 报表 plan 规范化层 (#2115) ([#2116](https://github.com/MYTech-Co-LTD/platform-core/pull/2116), [5528531](https://github.com/MYTech-Co-LTD/platform-core/commit/55285310efac0c7be60b3232d5caf7dd768f4457))
- 【新增】data: 指标语义治理 P5——报表×指标（发布门/渲染闸）+ declaration 档恢复 ([#2109](https://github.com/MYTech-Co-LTD/platform-core/pull/2109), [38426c5](https://github.com/MYTech-Co-LTD/platform-core/commit/38426c504ed5ad61a4fe5954459529b6d6463ba0))
- 【新增】data: R6 发布前可见面预览 (#2110) ([#2111](https://github.com/MYTech-Co-LTD/platform-core/pull/2111), [327b863](https://github.com/MYTech-Co-LTD/platform-core/commit/327b86375549cf2c29ac76b1bf728072d62b529b))
- 【新增】data: 体系地图搬进控制台并画成本体图 (#2105) ([#2106](https://github.com/MYTech-Co-LTD/platform-core/pull/2106), [563c0fa](https://github.com/MYTech-Co-LTD/platform-core/commit/563c0fae2fd4d8c0e709be50800e52b34cc08b3c))
- 【新增】data: R3 共享富文本——受限语法 + text 面板 markdown 档 (#2107) ([#2108](https://github.com/MYTech-Co-LTD/platform-core/pull/2108), [db69501](https://github.com/MYTech-Co-LTD/platform-core/commit/db695013649970a4c898434bd6edf7a43ec990c0))
- 【新增】data: R5 叙事运行台账 + 统计端点 + 20 条金标 (#2103) ([#2104](https://github.com/MYTech-Co-LTD/platform-core/pull/2104), [cc95ad8](https://github.com/MYTech-Co-LTD/platform-core/commit/cc95ad8c816f409280579f75dca45c343a65f81c))
- 【新增】data: R4 同请求内并发去重——相同 SQL 只执行一次 (#2101) ([#2102](https://github.com/MYTech-Co-LTD/platform-core/pull/2102), [7badbfe](https://github.com/MYTech-Co-LTD/platform-core/commit/7badbfe7cf75f8e4819544bb958e630de477cfe8))
- 【新增】data: R4 查询结果缓存——主计划与合计按 SQL+数据版本缓存 (#2099) ([#2100](https://github.com/MYTech-Co-LTD/platform-core/pull/2100), [ea04444](https://github.com/MYTech-Co-LTD/platform-core/commit/ea04444dda2a14681c6eef07642d9973a8375817))
- 【新增】data: R2 MCP 模板模式——模板折进 propose_report，工具面不增 (#2096) ([#2097](https://github.com/MYTech-Co-LTD/platform-core/pull/2097), [9253386](https://github.com/MYTech-Co-LTD/platform-core/commit/9253386dcbed2e08b9dba62f74418c4465fa9d50))
- 【新增】data: R2 报表模板与槽位——从模板编译 spec (#2092) ([#2093](https://github.com/MYTech-Co-LTD/platform-core/pull/2093), [df4ba76](https://github.com/MYTech-Co-LTD/platform-core/commit/df4ba766b455fe5ff84aebc0e46aaedaaa71ed77))
- 【新增】data: R2 审阅面——diff + 说明书 + lint (#2087) ([#2088](https://github.com/MYTech-Co-LTD/platform-core/pull/2088), [847960d](https://github.com/MYTech-Co-LTD/platform-core/commit/847960d02f8e759957bf6084f096b63469deb0fe))
- 【新增】data: 指标语义治理 P4——写面收口 ([#2086](https://github.com/MYTech-Co-LTD/platform-core/pull/2086), [1c30d83](https://github.com/MYTech-Co-LTD/platform-core/commit/1c30d83aa1a6c6e13423fc5283a0fad4863c732e))
- 【新增】data: R2 语义 lint——报表结构自洽的发布门 (#2084) ([#2085](https://github.com/MYTech-Co-LTD/platform-core/pull/2085), [a271732](https://github.com/MYTech-Co-LTD/platform-core/commit/a27173217fb6e3c34b2c6c473c8501b4e4c8b224))
- 【新增】data: R1 明细行导出——凭证抽屉下载逐笔 CSV (#2080) ([#2081](https://github.com/MYTech-Co-LTD/platform-core/pull/2081), [b0d373d](https://github.com/MYTech-Co-LTD/platform-core/commit/b0d373d5414ad27b33fe8b8c22cfde6d40683906))
- 【新增】data: R1 差异分解——用户输入值按连续子区间解释 (#2076) ([#2078](https://github.com/MYTech-Co-LTD/platform-core/pull/2078), [94b695f](https://github.com/MYTech-Co-LTD/platform-core/commit/94b695fb47e0218331d2286bef3b230ff8ad5cf4))
- 【新增】data: R1 计算凭证——KPI 口径/窗口/按日组成 + CSV 导出 (#2076) ([#2077](https://github.com/MYTech-Co-LTD/platform-core/pull/2077), [d7b1dc0](https://github.com/MYTech-Co-LTD/platform-core/commit/d7b1dc091809f5ecc21257fb2538f0108d546c79))
- 【优化】data: 窗口/对比收敛为 report-period 唯一实现（R0） (#2074) ([#2075](https://github.com/MYTech-Co-LTD/platform-core/pull/2075), [639f8f0](https://github.com/MYTech-Co-LTD/platform-core/commit/639f8f0efea41f453a0a1ed285b7362815bb6229))
- 【新增】data: 指标语义治理 P3——解析与澄清 ([#2066](https://github.com/MYTech-Co-LTD/platform-core/pull/2066), [000b1d7](https://github.com/MYTech-Co-LTD/platform-core/commit/000b1d7348ddcebd7f9ae31e7d8d152100178c0c))
- 【新增】data: 指标语义治理 P2——指标可见性 ([#2062](https://github.com/MYTech-Co-LTD/platform-core/pull/2062), [f9a3f1b](https://github.com/MYTech-Co-LTD/platform-core/commit/f9a3f1b72b3ccf59ce70da234ab3f6105ad981e7))
- 【新增】data: 指标语义治理 P1——概念归属+同名互斥+缓办销账+override 档 ([#2058](https://github.com/MYTech-Co-LTD/platform-core/pull/2058), [f27240d](https://github.com/MYTech-Co-LTD/platform-core/commit/f27240d73514a6170dd29012eae41faad9cb28d4))
- 【新增】web: 设计语言统一为 DeepSeek 风格，落 DESIGN.md (#2054) ([#2055](https://github.com/MYTech-Co-LTD/platform-core/pull/2055), [2f83205](https://github.com/MYTech-Co-LTD/platform-core/commit/2f832057487a8627f1b3718e6bddd5246418c1f2))
- 【新增】data: 指标页返工——回表格 + 详情抽屉 (#2052) ([#2053](https://github.com/MYTech-Co-LTD/platform-core/pull/2053), [1b209da](https://github.com/MYTech-Co-LTD/platform-core/commit/1b209da48c3b45646ad12cbffea1de4a89467880))
- 【新增】data: 指标页改「左列表 + 右详情」布局（B 方案试点） (#2050) ([#2051](https://github.com/MYTech-Co-LTD/platform-core/pull/2051), [c6fc90e](https://github.com/MYTech-Co-LTD/platform-core/commit/c6fc90e9da005aebc4eb69acd4a4db2a2cd8cff2))
- 【新增】data: 指标语义治理 P0——变更单+试算+采纳驳回 ([#2046](https://github.com/MYTech-Co-LTD/platform-core/pull/2046), [0c415f8](https://github.com/MYTech-Co-LTD/platform-core/commit/0c415f8405198c3c19ac8456c460fdb262073ccb))
- 【新增】web: 体系地图改为左侧菜单项（模块外链） (#2044) ([#2045](https://github.com/MYTech-Co-LTD/platform-core/pull/2045), [f06338f](https://github.com/MYTech-Co-LTD/platform-core/commit/f06338f49a40587ff5a890938f1038a1f2983898))
- 【新增】data: 指标页顶部给「候选指标待采用」入口 (#2042) ([#2043](https://github.com/MYTech-Co-LTD/platform-core/pull/2043), [c34b496](https://github.com/MYTech-Co-LTD/platform-core/commit/c34b4961df5572cbc1d0076883230b2b485be1ed))
- 【新增】web: 数据范围入口移到「管理 → 角色与权限」 (#2040) ([#2041](https://github.com/MYTech-Co-LTD/platform-core/pull/2041), [6ba5bf5](https://github.com/MYTech-Co-LTD/platform-core/commit/6ba5bf51ae8c43370e5585ead0e157c9f5591f57))
- 【新增】data: 数据范围页加「怎么用」说明，试算前置并给结论 (#2036) ([#2039](https://github.com/MYTech-Co-LTD/platform-core/pull/2039), [04693e0](https://github.com/MYTech-Co-LTD/platform-core/commit/04693e032f60b5ec8d76d146488d77b9c7049d49))
- 【修复】web: 模块页取最长前缀条目 + 补售后/通知页说明文案 (#2033) ([#2034](https://github.com/MYTech-Co-LTD/platform-core/pull/2034), [0005bc2](https://github.com/MYTech-Co-LTD/platform-core/commit/0005bc291eaa5bb4d9ddc6dd33ffb47a2d24eedc))
- 【新增】web: 控制台风格统一——个人 Key 归账号设置、模块页统一页头、补 UI 约定 (#2031) ([#2032](https://github.com/MYTech-Co-LTD/platform-core/pull/2032), [5407c82](https://github.com/MYTech-Co-LTD/platform-core/commit/5407c8270152f89dfbc8a24d3d8a45d2af9b1f91))
- 【优化】data: 指标创建收口——移除人工新建入口，实现面交给 agent ([#2030](https://github.com/MYTech-Co-LTD/platform-core/pull/2030), [22f6d16](https://github.com/MYTech-Co-LTD/platform-core/commit/22f6d167e0ab33df4f5d59a08bba99c55ee73fae))
- 【新增】data: 部门范围支持「含下级 / 仅直属」，战区内分级可用 (#2027) ([#2028](https://github.com/MYTech-Co-LTD/platform-core/pull/2028), [f8e7a20](https://github.com/MYTech-Co-LTD/platform-core/commit/f8e7a2088b3840d158cadc9c611c699f0be354f1))
- 【新增】data: 单页双层 4.4——术语词典 + 全站 Explain 问号 ([#2025](https://github.com/MYTech-Co-LTD/platform-core/pull/2025), [e053e58](https://github.com/MYTech-Co-LTD/platform-core/commit/e053e5842f1697f4685732c960852549e6e033ce))
- 【新增】data: 单页双层 4.3——指标页口径列 + 报表页「这个数怎么来的」 ([#2022](https://github.com/MYTech-Co-LTD/platform-core/pull/2022), [2952e44](https://github.com/MYTech-Co-LTD/platform-core/commit/2952e4471df83ba32e44f53edb2f2c0dc4138735))
- 【新增】data: 数据范围主体补「组织节点」（dept），人随部门继承 (#2017) ([#2018](https://github.com/MYTech-Co-LTD/platform-core/pull/2018), [fa06778](https://github.com/MYTech-Co-LTD/platform-core/commit/fa067789968aac910d21d57244c07ae147b4a9fc))
- 【修复】data: console 菜单项与页面脱节——补「可能的指标」、删「问数」 ([#2016](https://github.com/MYTech-Co-LTD/platform-core/pull/2016), [24cafe1](https://github.com/MYTech-Co-LTD/platform-core/commit/24cafe191c63f63dde25bdf69b2bd0570ccaca3e))
- 【新增】data: 下线站内问数面——问数只走 MCP（openclaw / 三方 agent） ([#2013](https://github.com/MYTech-Co-LTD/platform-core/pull/2013), [c8451a3](https://github.com/MYTech-Co-LTD/platform-core/commit/c8451a365c8dcb5166f439baf529337b882840ed))
- 【新增】data: 单页双层 P0——技术细节组件 + 错误码人话 + 候选池改业务说法 ([#2011](https://github.com/MYTech-Co-LTD/platform-core/pull/2011), [fc83ed8](https://github.com/MYTech-Co-LTD/platform-core/commit/fc83ed814b7588bfc96ac3158b33dfb3af6f9a32))
- 【新增】web: 左侧多级菜单 + 成员权限配置动线 (#1953) ([#2009](https://github.com/MYTech-Co-LTD/platform-core/pull/2009), [3161603](https://github.com/MYTech-Co-LTD/platform-core/commit/31616035340291be830d3e2a8fb487a7566a6b31))
- 【新增】data: 契约元 schema 校验器落地（Wave 2.2 残项） ([#1993](https://github.com/MYTech-Co-LTD/platform-core/pull/1993), [2e3c84e](https://github.com/MYTech-Co-LTD/platform-core/commit/2e3c84e979d7d11cbf622e1e13253eea0c8c07f2))
- 【新增】data: 候选池 console 页（Wave 2.3 残项） ([#1991](https://github.com/MYTech-Co-LTD/platform-core/pull/1991), [d426ec0](https://github.com/MYTech-Co-LTD/platform-core/commit/d426ec0887bd51d27756be5a09218037d319a24c))
- 【修复】notify: notify-health 的 dead 判据改成 7 天时间窗 ([#1987](https://github.com/MYTech-Co-LTD/platform-core/pull/1987), [45dcb7a](https://github.com/MYTech-Co-LTD/platform-core/commit/45dcb7ad01656d547009ae3ff767c79d1ecb14b6))
- 【修复】notify: 表单指派/催办接通投递链（Wave 2.3）——声明≠开通 ([#1980](https://github.com/MYTech-Co-LTD/platform-core/pull/1980), [28e6e33](https://github.com/MYTech-Co-LTD/platform-core/commit/28e6e336c1e853c3f364ab1c9dcf283d5b87a80a))
- 【修复】web: 管理台按任务重组菜单，每页给出一眼可操作入口 (#1953) ([#1978](https://github.com/MYTech-Co-LTD/platform-core/pull/1978), [58f9669](https://github.com/MYTech-Co-LTD/platform-core/commit/58f9669219923b2bf015009265529895fbd5c0ed))
- 【新增】data: 契约跨字段六条机检 Wave 2.2b（README §4.2 补校验器） ([#1976](https://github.com/MYTech-Co-LTD/platform-core/pull/1976), [24918fe](https://github.com/MYTech-Co-LTD/platform-core/commit/24918fe0bb06cc44ae3f8abaa0869e766133ec7e))
- 【新增】data: 契约版本门 Wave 2.2——skill contract 装载期版本/形状校验 ([#1974](https://github.com/MYTech-Co-LTD/platform-core/pull/1974), [8eabae2](https://github.com/MYTech-Co-LTD/platform-core/commit/8eabae29762c4b3ac44a8766ff591bfbd20f0348))
- 【新增】data: 自动推导 Wave 1.4——候选 list/reject + 生成调度与回归 job 入仓 ([#1971](https://github.com/MYTech-Co-LTD/platform-core/pull/1971), [e88b54b](https://github.com/MYTech-Co-LTD/platform-core/commit/e88b54bddca6d64568dbce7d7a5a6edc93adef1a))
- 【新增】data: 接入乐檬商品类别树采集源（#1913） ([#1966](https://github.com/MYTech-Co-LTD/platform-core/pull/1966), [b257055](https://github.com/MYTech-Co-LTD/platform-core/commit/b257055e07f50c3c06730a09293bd2cee616b2c8))
- 【修复】data: 信任链补真 Wave 1——证据真值 + 来源补齐 ([#1967](https://github.com/MYTech-Co-LTD/platform-core/pull/1967), [96c73ce](https://github.com/MYTech-Co-LTD/platform-core/commit/96c73cee8d9b705010864ee28e0ca64f78366f2d))
- 【修复】web: 管理页剩余三项——说明收纳/空态动作/表格卡片化（#1953） ([#1963](https://github.com/MYTech-Co-LTD/platform-core/pull/1963), [c426692](https://github.com/MYTech-Co-LTD/platform-core/commit/c4266920402895877829cf6c5feb626a741d3f92))
- 【修复】web: 管理页统一页面头 ConsolePage（#1953） ([#1962](https://github.com/MYTech-Co-LTD/platform-core/pull/1962), [bf0c504](https://github.com/MYTech-Co-LTD/platform-core/commit/bf0c5046b5c85cbf3ee1cca84917a131794dbb57))
- 【修复】monitor: 告警有效性 Wave 0.4——⑯ 豁免 12h 冷却 + OO 口径订正 ([#1961](https://github.com/MYTech-Co-LTD/platform-core/pull/1961), [95d1408](https://github.com/MYTech-Co-LTD/platform-core/commit/95d14086890efb38a10e2363ef245fd23e214a70))
- 【修复】data: 权限收口 Wave 0.3——明细/探索面接入数据范围 ([#1958](https://github.com/MYTech-Co-LTD/platform-core/pull/1958), [a1d8671](https://github.com/MYTech-Co-LTD/platform-core/commit/a1d8671ef0659411720d4ae938604e97f07aef84))
- 【修复】data: 缓存正确性 Wave 0.2——键含数据版本 + TTL=0 真关闭 ([#1956](https://github.com/MYTech-Co-LTD/platform-core/pull/1956), [fc9c920](https://github.com/MYTech-Co-LTD/platform-core/commit/fc9c9209c0e6145760858b7cfeec9c437df5b171))
- 【修复】web: 租户管理后台布局审计——侧栏图标/表单宽度/内容区节奏（#1953） ([#1954](https://github.com/MYTech-Co-LTD/platform-core/pull/1954), [0fab70e](https://github.com/MYTech-Co-LTD/platform-core/commit/0fab70e3173a4e554311478550564493b706bc0f))
- 【新增】data: 资源准入 Wave 0.1——连接池预算 + 明细并发闸 ([#1952](https://github.com/MYTech-Co-LTD/platform-core/pull/1952), [ce6011e](https://github.com/MYTech-Co-LTD/platform-core/commit/ce6011ee151a1fd5ad0b1bb847223de4069ff730))
- 【新增】data: 明细结果缓存（直读 ZOS 下唯一的毫秒级手段） ([#1948](https://github.com/MYTech-Co-LTD/platform-core/pull/1948), [eab0163](https://github.com/MYTech-Co-LTD/platform-core/commit/eab01639594856aecb11ed98da33a6bab43c15c3))
- 【新增】data: 历史范围走「只月文件」视图，逼近直读 ZOS 地板 ([#1946](https://github.com/MYTech-Co-LTD/platform-core/pull/1946), [b32344b](https://github.com/MYTech-Co-LTD/platform-core/commit/b32344b58c24ad4d76e2209b1474d21876535fd4))
- 【修复】data: selector 与 grain 的 region 层级错位经 dim_region 映射（#1901） ([#1944](https://github.com/MYTech-Co-LTD/platform-core/pull/1944), [258aff5](https://github.com/MYTech-Co-LTD/platform-core/commit/258aff5296808652808da347578466b776ea82b6))
- 【新增】data: 月感知服务视图 + drill 按范围选路（P2 收口） ([#1943](https://github.com/MYTech-Co-LTD/platform-core/pull/1943), [9230a5d](https://github.com/MYTech-Co-LTD/platform-core/commit/9230a5d52736e6d641a6a59ad6584a329a6fdb5e))
- 【修复】data: 品类覆盖全集即 all（源把三组写成三条资源）（#1901） ([#1941](https://github.com/MYTech-Co-LTD/platform-core/pull/1941), [143c9fe](https://github.com/MYTech-Co-LTD/platform-core/commit/143c9feb1f306ea218beff81d1f32a6d55d354ba))
- 【修复】data: 补回两条腿之间的 union all（删补腿时误删） ([#1940](https://github.com/MYTech-Co-LTD/platform-core/pull/1940), [873f03c](https://github.com/MYTech-Co-LTD/platform-core/commit/873f03c210d21ce6b9d6a462faa2d7ab7ef9cbdb))
- 【修复】data: 品类只对总部——门店层级 category=all、品类|* 映 all（#1901） ([#1938](https://github.com/MYTech-Co-LTD/platform-core/pull/1938), [794cbc7](https://github.com/MYTech-Co-LTD/platform-core/commit/794cbc70498d7b2aaa095a2a98f2421cfef57228))
- 【修复】data: 热腿改「月文件感知」，去掉无法裁剪的日文件补腿 ([#1937](https://github.com/MYTech-Co-LTD/platform-core/pull/1937), [605471e](https://github.com/MYTech-Co-LTD/platform-core/commit/605471e1c4e84e6aa6d94dccf781b9693465c971))
- 【新增】data: enforce 前预检脚本 scope-preflight（#1901） ([#1935](https://github.com/MYTech-Co-LTD/platform-core/pull/1935), [cc2d2c0](https://github.com/MYTech-Co-LTD/platform-core/commit/cc2d2c046728abb3219f1efd3886577b524fa85b))
- 【修复】data: DATA_SCOPE_MODE 拼错时启动期告警（避免 enforce 静默失效）（#1901） ([#1934](https://github.com/MYTech-Co-LTD/platform-core/pull/1934), [053d7d6](https://github.com/MYTech-Co-LTD/platform-core/commit/053d7d6898cbfa7ff7eabaa615c7a8115d02768a))
- 【新增】data: 明细读路径切月度文件（P2） ([#1933](https://github.com/MYTech-Co-LTD/platform-core/pull/1933), [d00c6de](https://github.com/MYTech-Co-LTD/platform-core/commit/d00c6de7124bdc85ba4ae5a3e468765445174c32))
- 【修复】data: 月度读取按 r['列'] 投影（pg_duckdb read_parquet 返回复合列） ([#1931](https://github.com/MYTech-Co-LTD/platform-core/pull/1931), [bb34b26](https://github.com/MYTech-Co-LTD/platform-core/commit/bb34b2623ea391ce94a1b716f343255e44a84634))
- 【修复】data: 月度读取改 pg_duckdb + lake_config（ENV 不进 SQL） ([#1928](https://github.com/MYTech-Co-LTD/platform-core/pull/1928), [c363758](https://github.com/MYTech-Co-LTD/platform-core/commit/c36375880c36b179db621180e1ebbdcc756bd1f7))
- 【新增】data: scope 判定入审计 + enforce 端到端测试 + 变更历史读面（#1901） ([#1926](https://github.com/MYTech-Co-LTD/platform-core/pull/1926), [94a0501](https://github.com/MYTech-Co-LTD/platform-core/commit/94a050177a7f3943378b8de5a3478207a39df5aa))
- 【修复】data: 合并子管线守卫移到月读取之后（原挂在锚点后只数 1 行标记） ([#1925](https://github.com/MYTech-Co-LTD/platform-core/pull/1925), [8f23581](https://github.com/MYTech-Co-LTD/platform-core/commit/8f2358119865ba691a125f594967bd33f612faa4))
- 【修复】data: 月度合并读取改锚点+code.sql 原生 glob ([#1923](https://github.com/MYTech-Co-LTD/platform-core/pull/1923), [54b0c74](https://github.com/MYTech-Co-LTD/platform-core/commit/54b0c7446eab6ececcbee0e07950b7883d9d2276))
- 【新增】data: console「数据范围」页签——scope 管理 UI（#1901） ([#1921](https://github.com/MYTech-Co-LTD/platform-core/pull/1921), [ff715c2](https://github.com/MYTech-Co-LTD/platform-core/commit/ff715c211d2fe7010bd4af84e2fbd8fcaebca8f1))
- 【修复】data: 月度合并 glob 的 ? 通配改 *（httpfs 把 ? 当 URL query 分隔符） ([#1920](https://github.com/MYTech-Co-LTD/platform-core/pull/1920), [1f186b4](https://github.com/MYTech-Co-LTD/platform-core/commit/1f186b4b81358a42c95bfb2a5d9df2f83d1952e5))
- 【新增】data: 月度合并层 P1——_MONTH 布局 + lake_month_index + 合并管线 ([#1917](https://github.com/MYTech-Co-LTD/platform-core/pull/1917), [a25b036](https://github.com/MYTech-Co-LTD/platform-core/commit/a25b0361c9dfd20bfdba92d7563667f0363c1004))
- 【新增】data: scope 管理面六端点（CRUD/整组替换/有效预览）（#1901） ([#1918](https://github.com/MYTech-Co-LTD/platform-core/pull/1918), [a0b4635](https://github.com/MYTech-Co-LTD/platform-core/commit/a0b4635a05208fa6607b6029234c0843f70aebdb))
- 【修复】data: 迁移脚本补陈超的全店 scope（Phase 0 拍板）（#1901） ([#1915](https://github.com/MYTech-Co-LTD/platform-core/pull/1915), [63fb799](https://github.com/MYTech-Co-LTD/platform-core/commit/63fb799a97daf1c6f611acee2599b9ba02bec38c))
- 【修复】dbt: 品类祖先缺口降为 warn + tables 档并建 seed（#1901） ([#1914](https://github.com/MYTech-Co-LTD/platform-core/pull/1914), [e493306](https://github.com/MYTech-Co-LTD/platform-core/commit/e4933061e7c8b1528d25ffd5adc39166c271c3aa))
- 【修复】data: 封版表加 checked_at，⑯ 活性判据不再误报 ([#1912](https://github.com/MYTech-Co-LTD/platform-core/pull/1912), [e87a049](https://github.com/MYTech-Co-LTD/platform-core/commit/e87a049560a04af64a83cb0831f006632b3f431a))
- 【修复】data: ⑱ 探针改 select *（PG 解析不了 duckdb.query() 的列名） ([#1910](https://github.com/MYTech-Co-LTD/platform-core/pull/1910), [13132a7](https://github.com/MYTech-Co-LTD/platform-core/commit/13132a7268b5c51ea3bd16a60e006b2529a3bbc8))
- 【新增】data: 热小时对象回收水位探针 ⑱ ([#1909](https://github.com/MYTech-Co-LTD/platform-core/pull/1909), [3c83560](https://github.com/MYTech-Co-LTD/platform-core/commit/3c835600f22bd317097c02b1125ffbdd5cd2250c))
- 【新增】data: 热小时对象每日回收 job（薄壳 + 手册登记） ([#1907](https://github.com/MYTech-Co-LTD/platform-core/pull/1907), [549252b](https://github.com/MYTech-Co-LTD/platform-core/commit/549252b9d74955adb3a50aadbfea019fd7375edd))
- 【修复】data: 热小时对象清理工具兼容两代天文件布局 ([#1906](https://github.com/MYTech-Co-LTD/platform-core/pull/1906), [1d7dcdc](https://github.com/MYTech-Co-LTD/platform-core/commit/1d7dcdc4a6d1b09885f42ca2b793390565a9a5fb))
- 【新增】data: 会话通道写入 roles（role-level 数据范围生效）（#1901） ([#1904](https://github.com/MYTech-Co-LTD/platform-core/pull/1904), [cd6fded](https://github.com/MYTech-Co-LTD/platform-core/commit/cd6fdedc605e8fa87aa3654664360a7fbf68ddf6))
- 【修复】data: 日报正文不再泄漏字段名与内部维度，根因行改人话 (#1902) ([#1903](https://github.com/MYTech-Co-LTD/platform-core/pull/1903), [c2f959b](https://github.com/MYTech-Co-LTD/platform-core/commit/c2f959bf49a6d55ffd4ecbc2bd7351a560f8a097))
- 【新增】data: 数据范围 scope 模型与 authorizeCore 接线（#1883） ([#1900](https://github.com/MYTech-Co-LTD/platform-core/pull/1900), [1310f1e](https://github.com/MYTech-Co-LTD/platform-core/commit/1310f1e3a049d6b98e78508dbac19506c6e1fd94))
- 【修复】data: freshness 测试冻结时钟，避免跨北京零点假红 (#1897) ([#1898](https://github.com/MYTech-Co-LTD/platform-core/pull/1898), [e75b250](https://github.com/MYTech-Co-LTD/platform-core/commit/e75b250aabad11a4b0ec16dbea5c664c03dc220c))
- 【修复】data: 移动端页面标题改为「报表经营分析」 (#1893) ([#1894](https://github.com/MYTech-Co-LTD/platform-core/pull/1894), [4752ea7](https://github.com/MYTech-Co-LTD/platform-core/commit/4752ea797974ac68ad0473ca45d3d632c3759a41))
- 【新增】data: 移动数据 App 视觉重做（报表/指标/问数） (#1890) ([#1891](https://github.com/MYTech-Co-LTD/platform-core/pull/1891), [7a74745](https://github.com/MYTech-Co-LTD/platform-core/commit/7a7474527918d9038670d4095ab20d9a6b4229af))
- 【修复】data: ⑰ 断言注释去掉反引号（被 shell 当命令替换，eval 报 where: not found） ([#1889](https://github.com/MYTech-Co-LTD/platform-core/pull/1889), [eb14bc5](https://github.com/MYTech-Co-LTD/platform-core/commit/eb14bc5e693f8edca671b7b1c7b76f47be8e73eb))
- 【新增】data: 封版 manifest 效果监控（探活断言 ⑯⑰） ([#1887](https://github.com/MYTech-Co-LTD/platform-core/pull/1887), [29ea6f2](https://github.com/MYTech-Co-LTD/platform-core/commit/29ea6f26a33682ff873207ffebec1a078346880a))
- 【修复】data: 移动底部菜单去 emoji；体系地图仅管理页可见 (#1881) ([#1882](https://github.com/MYTech-Co-LTD/platform-core/pull/1882), [323587d](https://github.com/MYTech-Co-LTD/platform-core/commit/323587d95e38419246920bb2bb99707db1cca234))
- 【修复】data: 明细读路径改用封版 manifest 表，去掉 _DAILY glob ([#1880](https://github.com/MYTech-Co-LTD/platform-core/pull/1880), [dc50e16](https://github.com/MYTech-Co-LTD/platform-core/commit/dc50e163e4154097d6461bf4bda06b7f1642b8d6))
- 【优化】data: 对比查询按视口懒加载 + /query 慢查询日志 (#1878) ([#1879](https://github.com/MYTech-Co-LTD/platform-core/pull/1879), [4ff4af4](https://github.com/MYTech-Co-LTD/platform-core/commit/4ff4af493f4a91a3534b3e53710a6cf1f1891e81))
- 【优化】data: KPI 合计缓存 + 图表对比延后限流 (#1875) ([#1876](https://github.com/MYTech-Co-LTD/platform-core/pull/1876), [ed067e5](https://github.com/MYTech-Co-LTD/platform-core/commit/ed067e55fa7ae6d1f4995ec7becffc20e883f618))
- 【修复】data: 图表图例移到底部，避免压住折线/柱体 (#1873) ([#1874](https://github.com/MYTech-Co-LTD/platform-core/pull/1874), [f4ef4d3](https://github.com/MYTech-Co-LTD/platform-core/commit/f4ef4d3fddf7a0641a39b988de0dad1a18a6f9dc))
- 【新增】data: 折线/柱状图叠加历史对比（上期 + 去年同期） (#1870) ([#1871](https://github.com/MYTech-Co-LTD/platform-core/pull/1871), [669ae05](https://github.com/MYTech-Co-LTD/platform-core/commit/669ae057257d73c1e078bc45dc08938698e0df3f))
- 【新增】data: KPI 卡同时展示环比与同比 (#1868) ([#1869](https://github.com/MYTech-Co-LTD/platform-core/pull/1869), [ad2d6b2](https://github.com/MYTech-Co-LTD/platform-core/commit/ad2d6b2c2d3606584b6b9396f3850861ffb52375))
- 【修复】notify: channel-probe 测试按 org 隔离，消除并行 flake ([#1867](https://github.com/MYTech-Co-LTD/platform-core/pull/1867), [0059fec](https://github.com/MYTech-Co-LTD/platform-core/commit/0059fecbbdb0a43c318bd6ac505ae25788bfa942))
- 【优化】data: 收敛 provenance 共享类型与构造器 ([#1865](https://github.com/MYTech-Co-LTD/platform-core/pull/1865), [3a6761d](https://github.com/MYTech-Co-LTD/platform-core/commit/3a6761db2892e5224f287f1f47bef1a2442c5d0a))
- 【修复】data: explore_recipe 证据锚点改为度量合计 ([#1864](https://github.com/MYTech-Co-LTD/platform-core/pull/1864), [5eee1a1](https://github.com/MYTech-Co-LTD/platform-core/commit/5eee1a19ea6206290a3d44d4eecb8d8a8a3d554c))
- 【修复】data: 流式校验只在句子闭合时执行；单日默认跟到昨天 (#1861) ([#1862](https://github.com/MYTech-Co-LTD/platform-core/pull/1862), [0eca93f](https://github.com/MYTech-Co-LTD/platform-core/commit/0eca93f4bdcba5ee69bc8a45f8de7bfcf7089ee0))
- 【新增】data: explore 回包增加 provenance 结果来源 ([#1860](https://github.com/MYTech-Co-LTD/platform-core/pull/1860), [2dd11f8](https://github.com/MYTech-Co-LTD/platform-core/commit/2dd11f8f67ac24f2f0c39f7d3f4d67b80a8f4cb1))
- 【修复】data: 本月/近7天/自定义日报按区间汇总分析 (#1857) ([#1858](https://github.com/MYTech-Co-LTD/platform-core/pull/1858), [eab9c29](https://github.com/MYTech-Co-LTD/platform-core/commit/eab9c29b553781420cae0e13c58e902c4787154c))
- 【修复】data: 数字白名单允许 % 与 pp 互换，修复本月/近7天/自定义回退模板 (#1855) ([#1856](https://github.com/MYTech-Co-LTD/platform-core/pull/1856), [2d940ad](https://github.com/MYTech-Co-LTD/platform-core/commit/2d940add7dd1a812967e66e10e65f82538b334d4))
- 【修复】data: 流式日报数字白名单补商品名数字/百分号，maxTokens 对齐 (#1853) ([#1854](https://github.com/MYTech-Co-LTD/platform-core/pull/1854), [aa8fc1b](https://github.com/MYTech-Co-LTD/platform-core/commit/aa8fc1be79628ffe07c777e9aa35216fc3f9af28))
- 【修复】platform: org-sync CLI 建号使用 CASDOOR_APPLICATION + 记录生产 job key（#1851） ([#1852](https://github.com/MYTech-Co-LTD/platform-core/pull/1852), [8e085d8](https://github.com/MYTech-Co-LTD/platform-core/commit/8e085d87d4a34e93430e158df10546d9f3f5ccf1))
- 【修复】data: 商品名补全 + 动作去重 + 日报阅读层级 (#1849) ([#1850](https://github.com/MYTech-Co-LTD/platform-core/pull/1850), [fe9ea9f](https://github.com/MYTech-Co-LTD/platform-core/commit/fe9ea9f8f5a4ed779f60e5667770178eb48f464b))
- 【新增】platform: 组织同步自动建号（企微有/Casdoor 无），不反写企微（#1847） ([#1848](https://github.com/MYTech-Co-LTD/platform-core/pull/1848), [436fb40](https://github.com/MYTech-Co-LTD/platform-core/commit/436fb408c2ef4d0354e2a79252cd09c78375ad14))
- 【修复】data: 日报建议段截断补全 + 正文粗体强调 (#1845) ([#1846](https://github.com/MYTech-Co-LTD/platform-core/pull/1846), [1bf4d3e](https://github.com/MYTech-Co-LTD/platform-core/commit/1bf4d3ecee88b5e70d2d0aa314e306411a8c18dc))
- 【修复】data: 日报数字校验放行负数绝对值，修正商品名/断段/期间标签/页脚 (#1843) ([#1844](https://github.com/MYTech-Co-LTD/platform-core/pull/1844), [c2a460d](https://github.com/MYTech-Co-LTD/platform-core/commit/c2a460d69f5d330fcedad083b0244a05416d2c76))
- 【修复】data: recon_ledger_cover 目标日改固定 T-4（restate 挪到 23:25 后中午必红） ([#1842](https://github.com/MYTech-Co-LTD/platform-core/pull/1842), [3788b0f](https://github.com/MYTech-Co-LTD/platform-core/commit/3788b0f757c3c56c485a89d8a0bf13e9d561a7c2))
- 【修复】deploy: 构建镜像源切换至腾讯镜像并增加拉取超时重试 (#1839) ([#1840](https://github.com/MYTech-Co-LTD/platform-core/pull/1840), [63618f2](https://github.com/MYTech-Co-LTD/platform-core/commit/63618f2d8e6cdb04aa9164d7b71271f7632f6ad2))
- 【新增】data: 明细下钻回包增加 provenance 结果来源 ([#1835](https://github.com/MYTech-Co-LTD/platform-core/pull/1835), [0654f75](https://github.com/MYTech-Co-LTD/platform-core/commit/0654f75c12f8a9c99bcb582351e3c30bd80cd4cc))
- 【修复】platform: 集成探针关闭时打 warn，缺 env 不再静默（#1832） ([#1833](https://github.com/MYTech-Co-LTD/platform-core/pull/1833), [6d64a74](https://github.com/MYTech-Co-LTD/platform-core/commit/6d64a74a61d5458b3a6e06573cf0a5dacffe6615))
- 【修复】data: AI 日报面板动效/排版/日期过滤/新鲜度去重（#1830） ([#1831](https://github.com/MYTech-Co-LTD/platform-core/pull/1831), [d47468b](https://github.com/MYTech-Co-LTD/platform-core/commit/d47468b3ea795a9e9b04f07c06af23e5ff8b7461))
- 【新增】data: 问数结果按供应商分组时显示供应商名（supplier_num → supplier_name） ([#1828](https://github.com/MYTech-Co-LTD/platform-core/pull/1828), [bedd113](https://github.com/MYTech-Co-LTD/platform-core/commit/bedd1133bd1812685b563a6573d1e890a481c0e4))
- 【新增】data: 根因商品拆解销量/价格/成本 ([#1827](https://github.com/MYTech-Co-LTD/platform-core/pull/1827), [86240f3](https://github.com/MYTech-Co-LTD/platform-core/commit/86240f39df1c58e31ae4b29fbe3385886c86a90e))
- 【新增】platform: 组织同步定时 job + 新鲜度探活 + runbook（#1819） ([#1823](https://github.com/MYTech-Co-LTD/platform-core/pull/1823), [ad85e5d](https://github.com/MYTech-Co-LTD/platform-core/commit/ad85e5de6cc177b1b1631fff201fcf0d7c06ace6))
- 【修复】data: 自然分析不再追加驱动/建议模板段（#1817） ([#1818](https://github.com/MYTech-Co-LTD/platform-core/pull/1818), [54204b5](https://github.com/MYTech-Co-LTD/platform-core/commit/54204b5118b03be08f693c6c3f91d5ec02347e76))
- 【新增】data: 日报改自然分析，不再固定小标题（#1815） ([#1816](https://github.com/MYTech-Co-LTD/platform-core/pull/1816), [3b87c4a](https://github.com/MYTech-Co-LTD/platform-core/commit/3b87c4a91beac2d3eabd93cbf9f6166c2d8869bc))
- 【修复】data: 日报建议必须回应根因商品（#1813） ([#1814](https://github.com/MYTech-Co-LTD/platform-core/pull/1814), [bc43788](https://github.com/MYTech-Co-LTD/platform-core/commit/bc437880c2f6b4c9f96a909a8743155300bb052c))
- 【修复】data: 天气单位纳入数字白名单（#1811） ([#1812](https://github.com/MYTech-Co-LTD/platform-core/pull/1812), [73cc8d5](https://github.com/MYTech-Co-LTD/platform-core/commit/73cc8d56091cf46a71228ee1cfef0b73fbf4abaf))
- 【新增】data: 统一 MCP 指令面与 openclaw SKILL 管理 ([#1808](https://github.com/MYTech-Co-LTD/platform-core/pull/1808), [ca24788](https://github.com/MYTech-Co-LTD/platform-core/commit/ca24788cde35b8344f0e2e01a422d0495f65678e))
- 【新增】data: 日报补天气背景（Open-Meteo）（#1809） ([#1810](https://github.com/MYTech-Co-LTD/platform-core/pull/1810), [c8111e8](https://github.com/MYTech-Co-LTD/platform-core/commit/c8111e8c74bb8e044013c65eca80cb3b9b0a7af5))
- 【新增】data: 日报增加经营判断层与洞察提示词（#1806） ([#1807](https://github.com/MYTech-Co-LTD/platform-core/pull/1807), [f12b4cb](https://github.com/MYTech-Co-LTD/platform-core/commit/f12b4cb8a0b4adc947ebfa7984a6c970d0ec3d5b))
- 【修复】data: 根因探针按报表账套过滤（#1804） ([#1805](https://github.com/MYTech-Co-LTD/platform-core/pull/1805), [46e1c14](https://github.com/MYTech-Co-LTD/platform-core/commit/46e1c14175e33667353e4a866d01cf43d990c439))
- 【修复】data: 日报 LLM 截断时补齐驱动/根因/建议（#1802） ([#1803](https://github.com/MYTech-Co-LTD/platform-core/pull/1803), [09d49d1](https://github.com/MYTech-Co-LTD/platform-core/commit/09d49d1c7a346c6eaa1c57a94b5cd46712ba7215))
- 【修复】data: 日报补目标百分比与商品号白名单（#1800） ([#1801](https://github.com/MYTech-Co-LTD/platform-core/pull/1801), [f49f644](https://github.com/MYTech-Co-LTD/platform-core/commit/f49f644171786323d9f96dff7bd131243e53f709))
- 【新增】data: 零售商品毛利事实 + 日报商品级根因（#1798） ([#1799](https://github.com/MYTech-Co-LTD/platform-core/pull/1799), [cfad06a](https://github.com/MYTech-Co-LTD/platform-core/commit/cfad06a36a4cb207657e44dea8cbf3250d369189))
- 【修复】data: 日报补目标百分比白名单与商品根因候选（#1796） ([#1797](https://github.com/MYTech-Co-LTD/platform-core/pull/1797), [2343b9b](https://github.com/MYTech-Co-LTD/platform-core/commit/2343b9b0bf9e0bf113fff8fb3bd8151b3b041745))
- 【修复】data: daily_review 补数字白名单并接入有界根因 ([#1795](https://github.com/MYTech-Co-LTD/platform-core/pull/1795), [5999388](https://github.com/MYTech-Co-LTD/platform-core/commit/5999388b90a92fd8442468cc12882f5c953d5c8b))
- 【修复】data: daily_review 使用独立提示词基线（#1787） ([#1788](https://github.com/MYTech-Co-LTD/platform-core/pull/1788), [65859cf](https://github.com/MYTech-Co-LTD/platform-core/commit/65859cfad5bcbfa5eadb9fd2132f4901d1fc8099))
- 【新增】data: ai_text 增加 daily_review 日报经营体检（#1785） ([#1786](https://github.com/MYTech-Co-LTD/platform-core/pull/1786), [e52affa](https://github.com/MYTech-Co-LTD/platform-core/commit/e52affafbdf4c6b3afe03b4c2b37cb647c1063cc))
- 【新增】data: 报表期间增加单日模式（#1783） ([#1784](https://github.com/MYTech-Co-LTD/platform-core/pull/1784), [9db9e6f](https://github.com/MYTech-Co-LTD/platform-core/commit/9db9e6f167186ef4e6ad937c911dad5332124d43))
- 【修复】data: 回滚 lemeng.retail.day.backfill 到父管线形态 ([#1781](https://github.com/MYTech-Co-LTD/platform-core/pull/1781), [19c2570](https://github.com/MYTech-Co-LTD/platform-core/commit/19c257064123e34b60d311c944fd8981b2c8c8f1))
- 【修复】data: item_profit 日更改双轮，09:05 取 T-1（#1777） ([#1780](https://github.com/MYTech-Co-LTD/platform-core/pull/1780), [5688ab5](https://github.com/MYTech-Co-LTD/platform-core/commit/5688ab5322ae072180d93c1c40b8bf8d90f7dc85))
- 【修复】data: 零售回填管线按当前生成器重生成，补回 order_transaction_type 投影 ([#1779](https://github.com/MYTech-Co-LTD/platform-core/pull/1779), [3d59177](https://github.com/MYTech-Co-LTD/platform-core/commit/3d5917740b85bdc5f8fa9b24da1327b4ab354958))
- 【修复】data: 零售毛利对账 system_book 统一转 int（#1775） ([#1776](https://github.com/MYTech-Co-LTD/platform-core/pull/1776), [a344ec9](https://github.com/MYTech-Co-LTD/platform-core/commit/a344ec94d50a34e440cf2a7f61e4211b0c282b3c))
- 【新增】data: 零售毛利事实与 L1 指标（P0） ([#1773](https://github.com/MYTech-Co-LTD/platform-core/pull/1773), [8a47e8a](https://github.com/MYTech-Co-LTD/platform-core/commit/8a47e8a54e890835b0268a112cd31a4f6b1e06e2))
- 【修复】data: fct_outbound_region 客户键落空串哨兵，避免 NULL 键增量重复插入 ([#1771](https://github.com/MYTech-Co-LTD/platform-core/pull/1771), [bca0fe7](https://github.com/MYTech-Co-LTD/platform-core/commit/bca0fe75b06c19f33a6acd8efc796d247f6126d2))
- 【修复】data: 战区出库面加客户粒度后 region_net 对账先按通道×桶汇总 ([#1769](https://github.com/MYTech-Co-LTD/platform-core/pull/1769), [ca75e8c](https://github.com/MYTech-Co-LTD/platform-core/commit/ca75e8cb5a2bbb809a86e8e544ebf56833e86dad))
- 【新增】data: 外部批发金额按客户下钻（fct_outbound_region 加 client_fid 粒度） ([#1767](https://github.com/MYTech-Co-LTD/platform-core/pull/1767), [6fd1d81](https://github.com/MYTech-Co-LTD/platform-core/commit/6fd1d813b51a58edbb7db1dc6b612c4aa944201d))
- 【修复】data: 根因探针按报表门店过滤 + 排除 bizday 退化维 ([#1765](https://github.com/MYTech-Co-LTD/platform-core/pull/1765), [986fa59](https://github.com/MYTech-Co-LTD/platform-core/commit/986fa5992ff559720f896410696a3db1cfa128ea))
- 【修复】data: 根因明细探针按单日切窗（首屏 >120s） ([#1763](https://github.com/MYTech-Co-LTD/platform-core/pull/1763), [dfa0df4](https://github.com/MYTech-Co-LTD/platform-core/commit/dfa0df461020d0740a504d823b26de86e0b9411b))
- 【新增】data: 问数结果按客户分组时显示客户名（client_fid → client_name） ([#1761](https://github.com/MYTech-Co-LTD/platform-core/pull/1761), [b94c61f](https://github.com/MYTech-Co-LTD/platform-core/commit/b94c61f0b2f4c507ddac4159a3b48022834b7ab1))
- 【新增】data: 报表 AI 根因有界分析（ai_text focus=root_cause） ([#1758](https://github.com/MYTech-Co-LTD/platform-core/pull/1758), [9877cde](https://github.com/MYTech-Co-LTD/platform-core/commit/9877cdea4b69a94ef6a68e70d2980ce53e231538))
- 【修复】data: 子集切片放行 orderBy value 并进外层 SQL（Top-N 直达） ([#1757](https://github.com/MYTech-Co-LTD/platform-core/pull/1757), [c8f9793](https://github.com/MYTech-Co-LTD/platform-core/commit/c8f9793018933f7fc13a63c8cd7a4ca0fbe54333))
- 【修复】openclaw: data-query 插件引号转义（v210+ 容器重启） ([#1754](https://github.com/MYTech-Co-LTD/platform-core/pull/1754), [85bad62](https://github.com/MYTech-Co-LTD/platform-core/commit/85bad621c058fbc74dd71c387ad4c0a11195106d))
- 【修复】data: no_detail_binding 的 alternative 取业务维度 ([#1752](https://github.com/MYTech-Co-LTD/platform-core/pull/1752), [c05573d](https://github.com/MYTech-Co-LTD/platform-core/commit/c05573dc1b846ff494147fa3c46345abf9a5f992))
- 【修复】data: 4 条非窗口口径的对账退回每日全史档（hourly 恒红） ([#1750](https://github.com/MYTech-Co-LTD/platform-core/pull/1750), [332f61e](https://github.com/MYTech-Co-LTD/platform-core/commit/332f61e8480ed0be81e1058e789649a103d2e040))
- 【新增】data: 问数能力位与明细替代路径 + 评估集补充（P1/P2） ([#1748](https://github.com/MYTech-Co-LTD/platform-core/pull/1748), [b717743](https://github.com/MYTech-Co-LTD/platform-core/commit/b7177435f0a8cb6178e71031c61a1508f8a4d644))
- 【修复】data: fct_order_event 补闭窗读守卫（撞活分区 ETag 致整轮 hourly 判红） ([#1745](https://github.com/MYTech-Co-LTD/platform-core/pull/1745), [2d59338](https://github.com/MYTech-Co-LTD/platform-core/commit/2d593388f4c1d24a37ba53482558bbb1cc23fa6c))
- 【修复】data: search_catalog 按匹配强度排序（标题命中优先于说明） ([#1743](https://github.com/MYTech-Co-LTD/platform-core/pull/1743), [20fb147](https://github.com/MYTech-Co-LTD/platform-core/commit/20fb1473ad07611d7fe23fb576e3d19031e2c27d))
- 【修复】data: tables 档 load_log 落账改成「真建成的 table 模型」 ([#1741](https://github.com/MYTech-Co-LTD/platform-core/pull/1741), [c90cc52](https://github.com/MYTech-Co-LTD/platform-core/commit/c90cc52135a5a8dac03d857b5404efde28a8d0af))
- 【新增】data: 问数检索/覆盖区间/Top-N 优化（yangwei 真实问题） ([#1739](https://github.com/MYTech-Co-LTD/platform-core/pull/1739), [46cca42](https://github.com/MYTech-Co-LTD/platform-core/commit/46cca42c343cea63c87931e60200049c8dd3eabf))
- 【修复】ops: sync 拒把文件 mv 进同名目录 + diagnose 回读 helper 非文件即红 ([#1737](https://github.com/MYTech-Co-LTD/platform-core/pull/1737), [0f4c242](https://github.com/MYTech-Co-LTD/platform-core/commit/0f4c2425ee8c24a6e287ede74b274cc72f5dd968))
- 【新增】data: 指标管理页支持全额声明与口径覆盖（W8 P3） ([#1734](https://github.com/MYTech-Co-LTD/platform-core/pull/1734), [0ea4d0a](https://github.com/MYTech-Co-LTD/platform-core/commit/0ea4d0a0e37e3c5af12a7d5774aca9cd33adad2e))
- 【修复】data: recon-day 诊断的「天文件」回读路径补 _DAY_DATA 段 ([#1735](https://github.com/MYTech-Co-LTD/platform-core/pull/1735), [d2ad7d6](https://github.com/MYTech-Co-LTD/platform-core/commit/d2ad7d61f7ada897d6a54598945e68fdfe540004))
- 【修复】ops: 登记 OO 告警 guokuan_health_missing（对账 job 每 30 分钟红一次） ([#1728](https://github.com/MYTech-Co-LTD/platform-core/pull/1728), [2c68f3d](https://github.com/MYTech-Co-LTD/platform-core/commit/2c68f3dba68be9da01a0d2162d2214a36a53554d))
- 【修复】data: 租户声明的 EXPLAIN 校验补 GROUP BY（W8 真机烟测暴露） ([#1727](https://github.com/MYTech-Co-LTD/platform-core/pull/1727), [ad2ef14](https://github.com/MYTech-Co-LTD/platform-core/commit/ad2ef14d388e71148b7bd302fb88eafc46dcb345))
- 【修复】data: 7 条窗口对账去掉 audit tag（hourly 的 --exclude tag:audit 会把双 tag 的也排除掉） ([#1725](https://github.com/MYTech-Co-LTD/platform-core/pull/1725), [41849e5](https://github.com/MYTech-Co-LTD/platform-core/commit/41849e52397b6773188b4193559d94e06af23309))
- 【新增】data: 覆盖平台口径的草稿→确认→生效（W8 P2） ([#1724](https://github.com/MYTech-Co-LTD/platform-core/pull/1724), [ee8a4b4](https://github.com/MYTech-Co-LTD/platform-core/commit/ee8a4b4453773f9afd12d1f48cc2c3a5f706dfc5))
- 【新增】data: 租户新建声明的写入口与六道校验（W8 P1） ([#1723](https://github.com/MYTech-Co-LTD/platform-core/pull/1723), [030abff](https://github.com/MYTech-Co-LTD/platform-core/commit/030abffb2628a4973a11a89d85eb66ffac235022))
- 【修复】data: 7 条增量 mart 对账接窗口宏（全史必红 → 并入 hourly 窗口档） ([#1722](https://github.com/MYTech-Co-LTD/platform-core/pull/1722), [5516aa5](https://github.com/MYTech-Co-LTD/platform-core/commit/5516aa5083c1f183b8bfd05cecabda5f722b7762))
- 【新增】data: 租户口径覆盖的读侧优先级与标注（W8 P0） ([#1720](https://github.com/MYTech-Co-LTD/platform-core/pull/1720), [fa97b84](https://github.com/MYTech-Co-LTD/platform-core/commit/fa97b84d97832ee94a7bae5a7458ccb4ae262874))
- 【修复】data: config_drift 拆方向——新店降级为 config_new_store，门店消失仍判红 ([#1719](https://github.com/MYTech-Co-LTD/platform-core/pull/1719), [9d36d8e](https://github.com/MYTech-Co-LTD/platform-core/commit/9d36d8e13b2baa4394a77395b3b0a703fcfdbedd))
- 【修复】ops: 删掉 owners.lemeng.json 里 metric-profile-summary 孤儿资产（64188 恒 stale） ([#1715](https://github.com/MYTech-Co-LTD/platform-core/pull/1715), [ed353d3](https://github.com/MYTech-Co-LTD/platform-core/commit/ed353d357715898ac839c1055140faea1cb9dcb4))
- 【修复】data: 门店配送两源口径表述修正（D10 ≠ transfer_out 逐日等值） ([#1712](https://github.com/MYTech-Co-LTD/platform-core/pull/1712), [90bf7e6](https://github.com/MYTech-Co-LTD/platform-core/commit/90bf7e631a7ac70f9932ee7217a080105aa4a833))
- 【修复】ops: console-gc 补 logs/ 回收（实测 15k 文件 / 676MB；保留 7 天，绝不删 duckle_metrics.prom） ([#1710](https://github.com/MYTech-Co-LTD/platform-core/pull/1710), [f7401bf](https://github.com/MYTech-Co-LTD/platform-core/commit/f7401bf5024ffe8470ca2a84c1afdc8a777c1087))
- 【新增】data: 出库金额两分口径 + 营业额双口径（语义层） ([#1705](https://github.com/MYTech-Co-LTD/platform-core/pull/1705), [49e0840](https://github.com/MYTech-Co-LTD/platform-core/commit/49e08405864d38fc943fb4135e25a4a73e2ffc5d))
- 【修复】ops: console 工作区中间产物回收（cache clear + 1d 残留 + 体积探针） ([#1707](https://github.com/MYTech-Co-LTD/platform-core/pull/1707), [33c2da5](https://github.com/MYTech-Co-LTD/platform-core/commit/33c2da5776f8d5eb17b668b3f648a5d746d82a1f))
- 【新增】data: audit 档支持窗口子档（增量 mart 的对账只验 7 天窗口） ([#1699](https://github.com/MYTech-Co-LTD/platform-core/pull/1699), [115234e](https://github.com/MYTech-Co-LTD/platform-core/commit/115234ec5d23b9720d4a39ab917061d0b738e210))
- 【修复】data: audit 档加分段选择器（单命令 90 分钟硬上限，56 条跑不完） ([#1698](https://github.com/MYTech-Co-LTD/platform-core/pull/1698), [be10a08](https://github.com/MYTech-Co-LTD/platform-core/commit/be10a089db664018de0ddc131bc58ca39d9b8837))
- 【修复】ops: OO 探活桥补上 per-check 冷却（12h 同因只推一次） ([#1695](https://github.com/MYTech-Co-LTD/platform-core/pull/1695), [5eef4a4](https://github.com/MYTech-Co-LTD/platform-core/commit/5eef4a4ab3d921c942ee3c3e316457deb95ad302))
- 【修复】data: config_drift 闸加 HAVING count(*) > 0（聚合无 GROUP BY 恒出一行） ([#1693](https://github.com/MYTech-Co-LTD/platform-core/pull/1693), [119b4f4](https://github.com/MYTech-Co-LTD/platform-core/commit/119b4f472b78fc072e80d916531c3ce024246899))
- 【修复】ops: OO 机侧脚本加版本握手（桥改完不生效的静默漂移） ([#1689](https://github.com/MYTech-Co-LTD/platform-core/pull/1689), [12ffe4d](https://github.com/MYTech-Co-LTD/platform-core/commit/12ffe4db1e1d9829a375863e0186ff6386e4119e))
- 【修复】ops: OO 告警桥跳过「未展开占位符」资产（stale 刷屏） ([#1686](https://github.com/MYTech-Co-LTD/platform-core/pull/1686), [b3b4451](https://github.com/MYTech-Co-LTD/platform-core/commit/b3b4451121a4fbc968b36ceb861e976cba32c544))
- 【修复】data: tables 档排除 singular tests（build 的间接选择会拖进全史 audit） ([#1684](https://github.com/MYTech-Co-LTD/platform-core/pull/1684), [71788f3](https://github.com/MYTech-Co-LTD/platform-core/commit/71788f380f462c5c15cb7b0ff138ea8090388a66))
- 【新增】data: materialize 新增 tables 档——table 物化模型夜间重建 ([#1683](https://github.com/MYTech-Co-LTD/platform-core/pull/1683), [a70d580](https://github.com/MYTech-Co-LTD/platform-core/commit/a70d58088a3ddb13a2ce0ef7951fdb1d3d9570cf))
- 【修复】data: 战区变更不再让 fct_hq_outbound 重复；小时档重建门店维 ([#1681](https://github.com/MYTech-Co-LTD/platform-core/pull/1681), [1616a8d](https://github.com/MYTech-Co-LTD/platform-core/commit/1616a8d5fb4b0b46e00947ec3b85cb200df35c14))
- 【修复】data: 宽页回填变体退避 2s→5s（源网关高并发随机抖） ([#1677](https://github.com/MYTech-Co-LTD/platform-core/pull/1677), [ece6f82](https://github.com/MYTech-Co-LTD/platform-core/commit/ece6f82b5c8f102df1db0063189ca2dfbf879413))
- 【新增】data: 库存快照宽页回填变体（3120 360 页） ([#1673](https://github.com/MYTech-Co-LTD/platform-core/pull/1673), [19b5a2d](https://github.com/MYTech-Co-LTD/platform-core/commit/19b5a2dbf6733e0694a8fae49da9965641311d76))
- 【修复】data: loss 金额审计 glob 改 bizday=**/*.parquet（P0 改 chunk= 后恒空） ([#1670](https://github.com/MYTech-Co-LTD/platform-core/pull/1670), [7b661b7](https://github.com/MYTech-Co-LTD/platform-core/commit/7b661b7d7150abcc8513c04105e56282964fce48))
- 【修复】data: dim.item 逐页投影再 merge（页间嵌套类型翻转致 union 炸） ([#1667](https://github.com/MYTech-Co-LTD/platform-core/pull/1667), [5f15782](https://github.com/MYTech-Co-LTD/platform-core/commit/5f157823c7c6946b10a8d4f1a052e61a19813163))
- 【新增】data: B 类 inventory.snapshot(64188) 转 manifest static_pages ([#1665](https://github.com/MYTech-Co-LTD/platform-core/pull/1665), [5033bff](https://github.com/MYTech-Co-LTD/platform-core/commit/5033bffb62a85b2300d4657bc8ac95b4ad23782f))
- 【修复】data: dim.item 源 schema 的 item_department/category/brand 改 string（非 JSON 值致 merge 失败） ([#1663](https://github.com/MYTech-Co-LTD/platform-core/pull/1663), [0135039](https://github.com/MYTech-Co-LTD/platform-core/commit/01350394313d5e59c1e51803d81de5852f188ba4))
- 【新增】data: B 类 inventory.snapshot(3120) 转 manifest static_pages + emptyGuard ([#1661](https://github.com/MYTech-Co-LTD/platform-core/pull/1661), [929a9e9](https://github.com/MYTech-Co-LTD/platform-core/commit/929a9e9ab03cca9eea9ee2dede54ffb389e507a7))
- 【新增】data: B 类 dim.item 转 manifest static_pages（149+哨兵→阈值 29800） ([#1659](https://github.com/MYTech-Co-LTD/platform-core/pull/1659), [32abb87](https://github.com/MYTech-Co-LTD/platform-core/commit/32abb87c9e88ffa0600277a3b8726c4d5317850c))
- 【新增】data: B 类 dim.branch 转 manifest static_pages（无代码，哨兵改阈值） ([#1657](https://github.com/MYTech-Co-LTD/platform-core/pull/1657), [7e8e6da](https://github.com/MYTech-Co-LTD/platform-core/commit/7e8e6da578fe062e014f32072a175ab29f134c11))
- 【新增】data: Wave 3——purchase.analysis 转 manifest none（单次请求，无代码） ([#1655](https://github.com/MYTech-Co-LTD/platform-core/pull/1655), [fc259a9](https://github.com/MYTech-Co-LTD/platform-core/commit/fc259a95a70ff6b450a859d8c920d08cec96d646))
- 【新增】data: Wave 2——offset 分页 3 条转 manifest static_pages ([#1653](https://github.com/MYTech-Co-LTD/platform-core/pull/1653), [91f82f0](https://github.com/MYTech-Co-LTD/platform-core/commit/91f82f0d4144fe7c80873682615393bdef3ba01e))
- 【新增】data: P0 物化闭窗读（tick/hourly 只读已闭窗，消 ETag） ([#1651](https://github.com/MYTech-Co-LTD/platform-core/pull/1651), [831bf32](https://github.com/MYTech-Co-LTD/platform-core/commit/831bf324564a76e99d61e46e0e8cbf79188356c0))
- 【新增】data: P0 排班分配器（按实测耗时错峰，同账套不重叠） ([#1649](https://github.com/MYTech-Co-LTD/platform-core/pull/1649), [e9b48f7](https://github.com/MYTech-Co-LTD/platform-core/commit/e9b48f72eb4e2629e1931670aae969153b040bb5))
- 【新增】data: P0——4 条高频源转 manifest static_pages（并行全量采） ([#1647](https://github.com/MYTech-Co-LTD/platform-core/pull/1647), [6315a63](https://github.com/MYTech-Co-LTD/platform-core/commit/6315a639564740609aae0b6d6f23155909e7d083))
- 【修复】data: 增量管线补齐 src.rest retry（3×2000） ([#1641](https://github.com/MYTech-Co-LTD/platform-core/pull/1641), [5110535](https://github.com/MYTech-Co-LTD/platform-core/commit/5110535493474a7d39d0a8f4d43539fb70c5662d))
- 【修复】data: 回填台账区分「真跑」与「窗口已关空转」——ok=15 曾是假绿 (#1638) ([#1637](https://github.com/MYTech-Co-LTD/platform-core/pull/1637), [bc3006b](https://github.com/MYTech-Co-LTD/platform-core/commit/bc3006bbac41b732d0624349ade40ce06c519373))
- 【新增】data: request.order 64188 增量切流（与 3120 同形） ([#1635](https://github.com/MYTech-Co-LTD/platform-core/pull/1635), [53bb0e5](https://github.com/MYTech-Co-LTD/platform-core/commit/53bb0e5723a4869d7d1e7f61a832df9cae13c8b9))
- 【修复】data: 夜间回填加 flock 单实例互斥（昨夜两趟并发烧配额）(#1633) ([#1636](https://github.com/MYTech-Co-LTD/platform-core/pull/1636), [0e30ae5](https://github.com/MYTech-Co-LTD/platform-core/commit/0e30ae595c0f7bff4adcf0ebf5a41e1f6c0d8aad))
- 【新增】data: manifest 支持 incremental（探针+水位+foreach 空页） ([#1632](https://github.com/MYTech-Co-LTD/platform-core/pull/1632), [75071a7](https://github.com/MYTech-Co-LTD/platform-core/commit/75071a77b7013c2e888b40b5dcc2b9a582dee7ea))
- 【修复】data: 回填队列支持 allow-empty（春节零单日卡死）+ 窗口收到 08:00 给 09:00 采集让路 (#1628) ([#1627](https://github.com/MYTech-Co-LTD/platform-core/pull/1627), [4b1f126](https://github.com/MYTech-Co-LTD/platform-core/commit/4b1f1269fa70ccf83489d266872e379311cd67cf))
- 【新增】data: 采集排班小时化——19+16 条报表类 L0 改每小时、3 分钟一槽错峰 (#1624) ([#1625](https://github.com/MYTech-Co-LTD/platform-core/pull/1625), [0bbaa3d](https://github.com/MYTech-Co-LTD/platform-core/commit/0bbaa3d05a0e9ae369d58f52753d3be576f6b202))
- 【修复】data: hourly 档补水位落账 + 首轮调度失败取证 (#1622) ([#1623](https://github.com/MYTech-Co-LTD/platform-core/pull/1623), [e93f720](https://github.com/MYTech-Co-LTD/platform-core/commit/e93f7209227f94e05e7aec8bd8783bf23ce3e5eb))
- 【新增】data: 核心对账窗口化——月段字符类宏 + materialize hourly 档 (#1619) ([#1618](https://github.com/MYTech-Co-LTD/platform-core/pull/1618), [f730bdf](https://github.com/MYTech-Co-LTD/platform-core/commit/f730bdf28e2212602085104f7a4f46f1a9be7083))
- 【修复】data: audit 分档改用 tag:audit（wildcard 不匹配任何节点）(#1616) ([#1617](https://github.com/MYTech-Co-LTD/platform-core/pull/1617), [3f8fbeb](https://github.com/MYTech-Co-LTD/platform-core/commit/3f8fbebb0bab1fadd049d07f66d8801de274b2cd))
- 【新增】data: audit 分档——全史对账降为每日 job，每轮 build 只留 schema+assert (#1614) ([#1615](https://github.com/MYTech-Co-LTD/platform-core/pull/1615), [87d1667](https://github.com/MYTech-Co-LTD/platform-core/commit/87d16676ba9e98c00759dacc39a970accce6953d))
- 【新增】data: fct_hq_outbound 增量重试——非空代理键 + 首次 full-refresh (#1612) ([#1613](https://github.com/MYTech-Co-LTD/platform-core/pull/1613), [9538e0a](https://github.com/MYTech-Co-LTD/platform-core/commit/9538e0ae3921a5e81dad5d1e25f6d6fe89fd1862))
- 【修复】data: 回退 fct_hq_outbound 增量（client_fid NULL 致 delete+insert 重复）(#1610) ([#1611](https://github.com/MYTech-Co-LTD/platform-core/pull/1611), [735d5db](https://github.com/MYTech-Co-LTD/platform-core/commit/735d5dba7c6ccda950f8821ac756c923a2f768de))
- 【新增】data: fct_hq_outbound 改增量，branch_day_activity 暂缓（窗口语义）(#1607) ([#1608](https://github.com/MYTech-Co-LTD/platform-core/pull/1608), [10f6520](https://github.com/MYTech-Co-LTD/platform-core/commit/10f6520aa4bc5390de3e23d5232d38071e77859b))
- 【修复】data: fct_purchase_concentration 月度 lookback 对齐月首，修复 9 月少算 (#1604) ([#1605](https://github.com/MYTech-Co-LTD/platform-core/pull/1605), [a5eb3be](https://github.com/MYTech-Co-LTD/platform-core/commit/a5eb3be59364d4a18ff8cf0083b0e2877630771a))
- 【新增】data: outbound_region / purchase_concentration 改增量（W2-P2 批次 3）(#1602) ([#1603](https://github.com/MYTech-Co-LTD/platform-core/pull/1603), [042c0a6](https://github.com/MYTech-Co-LTD/platform-core/commit/042c0a6d5f2009db27ae11957fffc4074cf9517e))
- 【新增】data: W7 Task4——订单事件表（降级版：类型+时间+关联单号） ([#1601](https://github.com/MYTech-Co-LTD/platform-core/pull/1601), [fdfe6ed](https://github.com/MYTech-Co-LTD/platform-core/commit/fdfe6edce16b0edebeb9c63fe4dfd26a4558c275))
- 【新增】data: fct_request_fulfillment 改增量，消除 OOM 峰 (#1598) ([#1600](https://github.com/MYTech-Co-LTD/platform-core/pull/1600), [8e6f991](https://github.com/MYTech-Co-LTD/platform-core/commit/8e6f9916836516eb3f81845e3e4209c0bebbf908))
- 【修复】data: 覆盖已验基线时写审计三列（不再绕过 refreshBaseline） ([#1596](https://github.com/MYTech-Co-LTD/platform-core/pull/1596), [2525722](https://github.com/MYTech-Co-LTD/platform-core/commit/2525722912f268212619cc9d3d73926c8d45d9a2))
- 【新增】data: 补齐 owner 规则 + 支持 pipelines 显式绑定 ([#1590](https://github.com/MYTech-Co-LTD/platform-core/pull/1590), [a55ed88](https://github.com/MYTech-Co-LTD/platform-core/commit/a55ed8827a69b8d2e6bc06e59fb734066b7ce205))
- 【修复】data: scorecard 的 owner/SLA 匹配、资产归属与模板路径过滤 ([#1587](https://github.com/MYTech-Co-LTD/platform-core/pull/1587), [9d88242](https://github.com/MYTech-Co-LTD/platform-core/commit/9d88242d83e99e119dff5224cbc5204c21d64aff))
- 【新增】data: W7 Task3——多 org 挖掘/评估集卫生/判定分级/verdict 可见性 ([#1589](https://github.com/MYTech-Co-LTD/platform-core/pull/1589), [30c71d7](https://github.com/MYTech-Co-LTD/platform-core/commit/30c71d7cb595a9c2afd7f1b839053901648ec6f9))
- 【新增】data: static_pages 截断哨兵（truncationGuard） ([#1579](https://github.com/MYTech-Co-LTD/platform-core/pull/1579), [65c7f2b](https://github.com/MYTech-Co-LTD/platform-core/commit/65c7f2b6d55d9f369b2c5220315a0992b0328e5f))
- 【新增】data: static_pages 生成物真机验收（P1 试点） ([#1577](https://github.com/MYTech-Co-LTD/platform-core/pull/1577), [acd3be5](https://github.com/MYTech-Co-LTD/platform-core/commit/acd3be5891c041cc34b64717d3a6ea193d355bff))
- 【修复】ops: materialize 空跑不再打 MATERIALIZE_OK（判 noop） ([#1575](https://github.com/MYTech-Co-LTD/platform-core/pull/1575), [1cf0b83](https://github.com/MYTech-Co-LTD/platform-core/commit/1cf0b83014c903a15c5b8e91064bdfdfcb4de106))
- 【修复】data: 订正 job 通知结论——直发企微不进 deliveries feed ([#1573](https://github.com/MYTech-Co-LTD/platform-core/pull/1573), [dbb6eae](https://github.com/MYTech-Co-LTD/platform-core/commit/dbb6eae1b10e16d129b815754bb8e47aa10109ef))
- 【新增】data: 源清单支持 static_pages 分页与多账套 ([#1572](https://github.com/MYTech-Co-LTD/platform-core/pull/1572), [da1c665](https://github.com/MYTech-Co-LTD/platform-core/commit/da1c66514c864f10bf6ad6c357cafd88a866e4bf))
- 【新增】data: scorecard 自动诊断——每日产出处置计划 ([#1570](https://github.com/MYTech-Co-LTD/platform-core/pull/1570), [8b0e4bf](https://github.com/MYTech-Co-LTD/platform-core/commit/8b0e4bfb4df97a8e575848e2fc7e232e6ac5f7ac))
- 【新增】data: scorecard 历史落盘 + 基线汇总 + 告警改走 OO 流 ([#1564](https://github.com/MYTech-Co-LTD/platform-core/pull/1564), [e613a57](https://github.com/MYTech-Co-LTD/platform-core/commit/e613a57ba5280d3d5b0e36dc85b2c5d42b0ff3a6))
- 【修复】data: staging 投影映射 timestamp_tz→timestamptz，3 张 view 不再每轮红 (#1566) ([#1567](https://github.com/MYTech-Co-LTD/platform-core/pull/1567), [f03457a](https://github.com/MYTech-Co-LTD/platform-core/commit/f03457ae1659a0d691becc5ec4b91c0525e7bfe9))
- 【新增】data: W7 Task2 收尾——explore join 接线 + 复合键去重 ([#1565](https://github.com/MYTech-Co-LTD/platform-core/pull/1565), [3b33f32](https://github.com/MYTech-Co-LTD/platform-core/commit/3b33f3277cd7dc2ee3c278c3c5de4984967c781b))
- 【新增】data: 每日 pipeline scorecard P2（长期监控） ([#1561](https://github.com/MYTech-Co-LTD/platform-core/pull/1561), [5e55009](https://github.com/MYTech-Co-LTD/platform-core/commit/5e55009108158cadcff7cfa896c641ec637ca23e))
- 【新增】data: W7 Task2 join 选择器（from 侧 + 闸门过滤） ([#1559](https://github.com/MYTech-Co-LTD/platform-core/pull/1559), [080f1e0](https://github.com/MYTech-Co-LTD/platform-core/commit/080f1e078910f7c5151587e0590ccb573d53ac12))
- 【新增】data: 源清单 CI 门禁 P1（manifest ↔ 生成物） ([#1557](https://github.com/MYTech-Co-LTD/platform-core/pull/1557), [827cfee](https://github.com/MYTech-Co-LTD/platform-core/commit/827cfee515054d91ffe2dd8ab4b81d5560006391))
- 【新增】data: 源清单生成器 P0（manifest → 管线/片段） ([#1555](https://github.com/MYTech-Co-LTD/platform-core/pull/1555), [5015ada](https://github.com/MYTech-Co-LTD/platform-core/commit/5015ada0d7150b65d8aec9357ee8129d817d9d82))
- 【新增】data: W7 Task2 explore 上下文装载关系声明 ([#1551](https://github.com/MYTech-Co-LTD/platform-core/pull/1551), [cc76a5c](https://github.com/MYTech-Co-LTD/platform-core/commit/cc76a5cf1f46cfcb18c7edce6eabb641f3730370))
- 【新增】data: W7 Task2——关系解析与 join 编译 ([#1550](https://github.com/MYTech-Co-LTD/platform-core/pull/1550), [875e8d9](https://github.com/MYTech-Co-LTD/platform-core/commit/875e8d96267e61fafaa8bf9301b344c6d15e89cd))
- 【新增】data: W7 Task2——语义关系声明表 + relations.yml（带证据） ([#1549](https://github.com/MYTech-Co-LTD/platform-core/pull/1549), [160bb24](https://github.com/MYTech-Co-LTD/platform-core/commit/160bb24ff2bbeed2da5852beaaaa1f63c69bae6e))
- 【新增】data: W7 Task2 前置——dim_item_latest 商品当前档案 + 唯一性断言 ([#1544](https://github.com/MYTech-Co-LTD/platform-core/pull/1544), [a7bba0c](https://github.com/MYTech-Co-LTD/platform-core/commit/a7bba0c92a346d735e734dce50bc09fcc8ce6a33))
- 【新增】data: 5 张日粒度 fct 改增量（W2-P2 批次 2）(#1545) ([#1546](https://github.com/MYTech-Co-LTD/platform-core/pull/1546), [e9e9ad2](https://github.com/MYTech-Co-LTD/platform-core/commit/e9e9ad2701f4b3269660b44aa20e853e4fda400f))
- 【新增】data: 门店/客户费用改增量（W2-P2 批次 1）(#1541) ([#1542](https://github.com/MYTech-Co-LTD/platform-core/pull/1542), [8e22192](https://github.com/MYTech-Co-LTD/platform-core/commit/8e2219269d76ce224f857568464e2d474e560eca))
- 【新增】data: fct_inventory_snapshot / fct_retail_quantity 改增量（W2-P1）(#1538) ([#1540](https://github.com/MYTech-Co-LTD/platform-core/pull/1540), [299e951](https://github.com/MYTech-Co-LTD/platform-core/commit/299e951a5ecb0e5075513b7d77225c9da593ad85))
- 【新增】data: W7 Task1——商品粒度事实 fct_retail_item_sale + 键缺口登记 ([#1534](https://github.com/MYTech-Co-LTD/platform-core/pull/1534), [ba618d3](https://github.com/MYTech-Co-LTD/platform-core/commit/ba618d39b5fe5a21933133cba4b4b49acd00d94a))
- 【修复】data: tick 档排除 tests/lemeng 的 singular 重活，只保留模型+schema tests (#1528) ([#1529](https://github.com/MYTech-Co-LTD/platform-core/pull/1529), [8e09764](https://github.com/MYTech-Co-LTD/platform-core/commit/8e09764d8fe714607c569bc159324d3dd04432cb))
- 【修复】data: tick 增量下界改用编译期字面量，触发 DuckDB 分区裁剪 (#1526) ([#1527](https://github.com/MYTech-Co-LTD/platform-core/pull/1527), [ae7dcf7](https://github.com/MYTech-Co-LTD/platform-core/commit/ae7dcf709a1c4936054ec1c0afccaabe785c5810))
- 【修复】data: tick 增量 filter 下推到基面 CTE (#1524) ([#1525](https://github.com/MYTech-Co-LTD/platform-core/pull/1525), [627f932](https://github.com/MYTech-Co-LTD/platform-core/commit/627f93220dcce02d7ff6a440c371ff078fd68114))
- 【修复】data: 全量档排除 tick 拥有的模型，避免并发写同一张表 (#1522) ([#1523](https://github.com/MYTech-Co-LTD/platform-core/pull/1523), [4066731](https://github.com/MYTech-Co-LTD/platform-core/commit/406673158c3f79afd57389b6c6f8c70c5402bcfe))
- 【新增】data: fct_retail_sale 改增量 + 零售 tick 10 分钟档（W1）(#1520) ([#1521](https://github.com/MYTech-Co-LTD/platform-core/pull/1521), [f587239](https://github.com/MYTech-Co-LTD/platform-core/commit/f587239c2c8dd002092caca5167ec92f70d1e493))
- 【新增】monitor: pg_duckdb 崩溃探活断言 ⑮（signal 11/recovery）(#1517) ([#1518](https://github.com/MYTech-Co-LTD/platform-core/pull/1518), [40f180b](https://github.com/MYTech-Co-LTD/platform-core/commit/40f180b4011cdf8fd22597abed45210d9d53f6b3))
- 【修复】data: pg_duckdb 钉 duckdb.threads=1，规避 postgres scan 线程 race (#1515) ([#1516](https://github.com/MYTech-Co-LTD/platform-core/pull/1516), [65e7bda](https://github.com/MYTech-Co-LTD/platform-core/commit/65e7bdae8176fa1c9fbf389641a9fa2057757b60))
- 【新增】data: W6 会话关联——query_audit.session_id，可辩护答案时长开算 ([#1508](https://github.com/MYTech-Co-LTD/platform-core/pull/1508), [6b91b79](https://github.com/MYTech-Co-LTD/platform-core/commit/6b91b794b2efab23d052e7a7f4ea29fc9509c18e))
- 【新增】data: W6 评估集 v2——已封板 2026-10 整月 + 候选池 ([#1501](https://github.com/MYTech-Co-LTD/platform-core/pull/1501), [65ff6ff](https://github.com/MYTech-Co-LTD/platform-core/commit/65ff6ff8972dfa4f40188b96f7397a9d8cdf7ee5))
- 【修复】data: 卡券汇总去掉「全空即拒写」闸——稀疏件 0 行是合法状态 ([#1500](https://github.com/MYTech-Co-LTD/platform-core/pull/1500), [8bbef40](https://github.com/MYTech-Co-LTD/platform-core/commit/8bbef4076e06d3c24791e32c209a228bae33970f))
- 【修复】data: 评估集入库闸——未封板区间拒写 ([#1498](https://github.com/MYTech-Co-LTD/platform-core/pull/1498), [1056f7c](https://github.com/MYTech-Co-LTD/platform-core/commit/1056f7cc5859f83fedc7e49a5c588f1731d92b6f))
- 【修复】data: 营业收款子管线声明 src.rest schema，0 行日不再绑不上列 (#1495) ([#1496](https://github.com/MYTech-Co-LTD/platform-core/pull/1496), [7facf03](https://github.com/MYTech-Co-LTD/platform-core/commit/7facf032eecef7969b5b84f882e83a084ce6cfc9))
- 【新增】data: 回归基线刷新机制——迁移 038 留痕 + refreshBaseline + CLI ([#1494](https://github.com/MYTech-Co-LTD/platform-core/pull/1494), [25c7616](https://github.com/MYTech-Co-LTD/platform-core/commit/25c7616b40a6fda07245ef73bba203ca6f2d6ac0))
- 【修复】data: 营业收款 list 字段按 JSON 落湖 + coupon 子管线去掉派生表 (#1491) ([#1492](https://github.com/MYTech-Co-LTD/platform-core/pull/1492), [5fd21c8](https://github.com/MYTech-Co-LTD/platform-core/commit/5fd21c87dabfb6628a55153e21ee9a5d888f7f4e))
- 【修复】data: 营业收款占位行漏了类型映射，CAST(NULL AS TXT) 炸在真机 (#1488) ([#1489](https://github.com/MYTech-Co-LTD/platform-core/pull/1489), [5eec04e](https://github.com/MYTech-Co-LTD/platform-core/commit/5eec04ecaa1aba0e3667f4e530399ce5d4dd316d))
- 【新增】data: 接源营业收款三件套（门店汇总/收款构成/卡券汇总）(#1485) ([#1486](https://github.com/MYTech-Co-LTD/platform-core/pull/1486), [d67e2c0](https://github.com/MYTech-Co-LTD/platform-core/commit/d67e2c0f982ed9ac8f60ce224ce2659a9f839623))
- 【新增】data: W6 Task4 入库器 + 33 条评估集提议（dry-run 已验，未写库） ([#1483](https://github.com/MYTech-Co-LTD/platform-core/pull/1483), [5ff2313](https://github.com/MYTech-Co-LTD/platform-core/commit/5ff23136ebf977a6691bd64d6e92ac25b613fcaa))
- 【新增】data: 夜间回填提速——让路窗口收窄到 03:00-05:30 + 错日不中断整段 ([#1478](https://github.com/MYTech-Co-LTD/platform-core/pull/1478), [7fe65f1](https://github.com/MYTech-Co-LTD/platform-core/commit/7fe65f1b1c613ef8e0969789295c640d79be41bf))
- 【修复】data: explore_query 列清单改问仓库库（平台库恒空 ⇒ 全部表不可见） ([#1480](https://github.com/MYTech-Co-LTD/platform-core/pull/1480), [8ffa8ae](https://github.com/MYTech-Co-LTD/platform-core/commit/8ffa8aeda62155ab04ea471fdd2b1a97d50d3fbf))
- 【新增】data: W6 分析层——explore_query + 三配方 + 证据包 + 价值指标 ([#1476](https://github.com/MYTech-Co-LTD/platform-core/pull/1476), [39d200b](https://github.com/MYTech-Co-LTD/platform-core/commit/39d200b567bea76534aa1b0faecbdf7d46c90ea8))
- 【修复】data: 报损/要货接口改版——body + 响应字段双改，修复自 11-02 起的静默 0 行 ([#1475](https://github.com/MYTech-Co-LTD/platform-core/pull/1475), [607faa8](https://github.com/MYTech-Co-LTD/platform-core/commit/607faa83e98830a322cf18c17dd4a005ee17b94b))
- 【修复】data: 零行巡检第三轮——按月 glob，缺天不再毒化整条查询 ([#1473](https://github.com/MYTech-Co-LTD/platform-core/pull/1473), [52cb91e](https://github.com/MYTech-Co-LTD/platform-core/commit/52cb91e1a4be42892f735a41f4e3cea026119831))
- 【修复】data: 零行巡检——「无分区」按发布滞后处理，告警判据收紧到「有分区但全 0 行」 ([#1469](https://github.com/MYTech-Co-LTD/platform-core/pull/1469), [57ef98c](https://github.com/MYTech-Co-LTD/platform-core/commit/57ef98c95a3a5f92987506567a970a6f4af7747b))


## [0.278.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.278.0...v0.278.1) - 2026-11-06
- 【修复】data: 零行巡检去掉假绿——duckdb.query 放进 FROM + 查询失败 fail-loud ([#1467](https://github.com/MYTech-Co-LTD/platform-core/pull/1467), [8bf5f66](https://github.com/MYTech-Co-LTD/platform-core/commit/8bf5f66127068a65fc4c2b875e72bdefa7a20c1b))


## [0.278.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.277.1...v0.278.0) - 2026-11-06
- 【新增】data: 日更件「静默 0 行」巡检 + 正典案例 43 ([#1465](https://github.com/MYTech-Co-LTD/platform-core/pull/1465), [2892fa5](https://github.com/MYTech-Co-LTD/platform-core/commit/2892fa503c26c70963794e66c5dd8a679a2ff305))


## [0.277.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.277.0...v0.277.1) - 2026-11-06
- 【修复】data: 调拨响应字段改名——in_order_fid/out_order_fid（补契约 + 80 个页节点 schema） ([#1461](https://github.com/MYTech-Co-LTD/platform-core/pull/1461), [44c254e](https://github.com/MYTech-Co-LTD/platform-core/commit/44c254e20bc6ee8c49a30fe4e679f26d52f9f458))


## [0.277.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.276.1...v0.277.0) - 2026-11-06
- 【新增】data: W5 治理可回溯——体系地图（健康五数/回溯链/移动端/孤儿表与候选质量） ([#1460](https://github.com/MYTech-Co-LTD/platform-core/pull/1460), [654480d](https://github.com/MYTech-Co-LTD/platform-core/commit/654480d63a7f090c73a52cd3408169d9a6af5ad8))


## [0.276.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.276.0...v0.276.1) - 2026-11-06
- 【修复】data: 调拨接口改版——body 由 start_date/end_date 改为 date_start/date_end + date_type ([#1459](https://github.com/MYTech-Co-LTD/platform-core/pull/1459), [328d36f](https://github.com/MYTech-Co-LTD/platform-core/commit/328d36f69c41e4f629bbe7f5c93e18a35d7962dc))


## [0.276.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.275.0...v0.276.0) - 2026-11-06
- 【新增】data: 夜间回填窗口（CST 00:05-09:00）+ 驱动收窗/让路/跳过已有 ([#1457](https://github.com/MYTech-Co-LTD/platform-core/pull/1457), [e4f4a37](https://github.com/MYTech-Co-LTD/platform-core/commit/e4f4a3756c313fa698d30bf1c30f86c1c6e162f0))


## [0.275.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.274.0...v0.275.0) - 2026-11-06
- 【新增】data: 接源 64188 调拨（transfer.in/out）+ 登记三条探针结论 ([#1454](https://github.com/MYTech-Co-LTD/platform-core/pull/1454), [d777263](https://github.com/MYTech-Co-LTD/platform-core/commit/d777263d127debc8382042badf8c1da4d2e1e3d6))


## [0.274.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.273.1...v0.274.0) - 2026-11-06
- 【新增】data: W4 语义完备——实体权威源 + 维度层级 + 业务不变量 + 接新源前置闸 ([#1448](https://github.com/MYTech-Co-LTD/platform-core/pull/1448), [2d1ea87](https://github.com/MYTech-Co-LTD/platform-core/commit/2d1ea879c18b38fa01820bec9171a3a079c54716))


## [0.273.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.273.0...v0.273.1) - 2026-11-06
- 【修复】data: 库存流水分段 l0 的 shape 改回内联形态（自造列不能 cast 输入） ([#1441](https://github.com/MYTech-Co-LTD/platform-core/pull/1441), [34b5155](https://github.com/MYTech-Co-LTD/platform-core/commit/34b515575038f8b23daf97a4f48eef7427486607))


## [0.273.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.272.7...v0.273.0) - 2026-11-06
- 【新增】data: 库存流水日常采集拆成 4 条按页段的 l0（静态并发替代原生分页） ([#1437](https://github.com/MYTech-Co-LTD/platform-core/pull/1437), [09a2b44](https://github.com/MYTech-Co-LTD/platform-core/commit/09a2b4444600025c58a5a1398d02729742c64480))


## [0.272.7](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.272.6...v0.272.7) - 2026-11-06
- 【修复】data: 只改 synonyms 走键级编辑——携带键与注释逐字保留（#1434） ([#1435](https://github.com/MYTech-Co-LTD/platform-core/pull/1435), [fedf0ec](https://github.com/MYTech-Co-LTD/platform-core/commit/fedf0ec726cdda55c2b70f3be4ce9001d9a2b623))


## [0.272.6](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.272.5...v0.272.6) - 2026-11-06
- 【修复】data: movement.l0 去掉调度不传的 BIZDAY 闸 + retail.windows 时间戳减整数（附回填经验沉淀） ([#1432](https://github.com/MYTech-Co-LTD/platform-core/pull/1432), [c7a5492](https://github.com/MYTech-Co-LTD/platform-core/commit/c7a54921f4a6682ffeda69d79a73a645bf153771))
- 【修复】data: 修改模式改为「definition 或 synonyms 至少一个变」——支持 alias_gap 提案（#1427） ([#1433](https://github.com/MYTech-Co-LTD/platform-core/pull/1433), [abb46ec](https://github.com/MYTech-Co-LTD/platform-core/commit/abb46ec2dafe78f7707bfa490705daa4dceb3b76))


## [0.272.5](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.272.4...v0.272.5) - 2026-11-05
- 【修复】dbt: 净销售额补别名 net_sales/retail:net_sales（需求台账 alias_gap 首次闭环） ([#1428](https://github.com/MYTech-Co-LTD/platform-core/pull/1428), [56b40c4](https://github.com/MYTech-Co-LTD/platform-core/commit/56b40c4845a08d41cf054f76b20fca0463dacba0))


## [0.272.5](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.272.4...v0.272.5) - 2026-11-05
- 【修复】dbt: 净销售额补别名 net_sales/retail:net_sales（需求台账 alias_gap 首次闭环） ([#1428](https://github.com/MYTech-Co-LTD/platform-core/pull/1428), [56b40c4](https://github.com/MYTech-Co-LTD/platform-core/commit/56b40c4845a08d41cf054f76b20fca0463dacba0))


## [0.272.4](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.272.3...v0.272.4) - 2026-11-05
- 【修复】data: 私有测度支持 bizday 日期过滤（编译产出 date_range 参数 + 回填迁移）（#1417） ([#1424](https://github.com/MYTech-Co-LTD/platform-core/pull/1424), [67bd5f9](https://github.com/MYTech-Co-LTD/platform-core/commit/67bd5f900c78487277a287e46681fcd8a4d8cf18))


## [0.272.3](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.272.2...v0.272.3) - 2026-11-05
- 【修复】data: 需求挖掘改读活的 askdata_trace（askdata_conv 自 10-16 停更）（#1404） ([#1422](https://github.com/MYTech-Co-LTD/platform-core/pull/1422), [4403503](https://github.com/MYTech-Co-LTD/platform-core/commit/4403503aaea5d4adbffdbb6b398b587f81d9dbef))


## [0.272.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.272.1...v0.272.2) - 2026-11-05
- 【修复】askdata: 采集水位改用 (created_at,seq) 复合游标，修复新会话被永久跳过（#1419） ([#1421](https://github.com/MYTech-Co-LTD/platform-core/pull/1421), [65101c4](https://github.com/MYTech-Co-LTD/platform-core/commit/65101c48258a59aeda3031a44fe4eb0099d1c218))


## [0.272.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.272.0...v0.272.1) - 2026-11-05
- 【修复】askdata: 草稿徽标收紧为首行强制，W2 台账补真机证据（#1409） ([#1418](https://github.com/MYTech-Co-LTD/platform-core/pull/1418), [df39b71](https://github.com/MYTech-Co-LTD/platform-core/commit/df39b71cc8023020a0a7328a73a8547bc59e1b85))


## [0.272.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.271.1...v0.272.0) - 2026-11-05
- 【新增】data: 查询回包带 caliber/basis，bot 回答强制标注草稿口径（#1409） ([#1415](https://github.com/MYTech-Co-LTD/platform-core/pull/1415), [802b7ec](https://github.com/MYTech-Co-LTD/platform-core/commit/802b7ec8f2fc7317997f9afee27f00acb653d9c6))


## [0.271.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.271.0...v0.271.1) - 2026-11-05
- 【修复】data: apply 支持基线未变的文件更新（piece.baseSha256 三态，红线不变）（#1411） ([#1412](https://github.com/MYTech-Co-LTD/platform-core/pull/1412), [fc972a1](https://github.com/MYTech-Co-LTD/platform-core/commit/fc972a12c055e0e6a723520343afa53c85efc137))


## [0.271.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.270.0...v0.271.0) - 2026-11-05
- 【新增】data: Phase 2 需求挖掘——四类机判需求台账 + manage 面两工具（#1404） ([#1407](https://github.com/MYTech-Co-LTD/platform-core/pull/1407), [178c42d](https://github.com/MYTech-Co-LTD/platform-core/commit/178c42d05eb8a2b7d2224bae8b100ec785673641))


## [0.270.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.269.0...v0.270.0) - 2026-11-05
- 【新增】data: W3 L1 提案自动化——候选升级 → l1_metrics.yml 草案 → draft PR ([#1402](https://github.com/MYTech-Co-LTD/platform-core/pull/1402), [e602700](https://github.com/MYTech-Co-LTD/platform-core/commit/e6027001453c39d9d48081673544bc1a0371095a))


## [0.269.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.268.6...v0.269.0) - 2026-11-04
- 【新增】data: W2 三档闭环——私有测度档 + duckle profiler + 候选池 ([#1398](https://github.com/MYTech-Co-LTD/platform-core/pull/1398), [ab5221f](https://github.com/MYTech-Co-LTD/platform-core/commit/ab5221fc842426475e717127f52af52c73bbc8cc))


## [0.268.6](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.268.5...v0.268.6) - 2026-11-04
- 【修复】askdata: 强信号须通过「像指标问题」过滤（降级 weak） ([#1393](https://github.com/MYTech-Co-LTD/platform-core/pull/1393), [425f125](https://github.com/MYTech-Co-LTD/platform-core/commit/425f12581fb96dfd2a413ebec624013d19fddbee))


## [0.268.5](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.268.4...v0.268.5) - 2026-11-04
- 【修复】data: 门店费用页节点重试 3×2s → 10×15s（21 页并发触发 PAT 频率闸） ([#1391](https://github.com/MYTech-Co-LTD/platform-core/pull/1391), [348dbd4](https://github.com/MYTech-Co-LTD/platform-core/commit/348dbd492668a2650fd699e2b6a0d79ebf0da7d2))


## [0.268.4](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.268.3...v0.268.4) - 2026-11-04
- 【修复】data: OO 事件字段名按小写解析（真机统一小写化键） ([#1388](https://github.com/MYTech-Co-LTD/platform-core/pull/1388), [aa6b635](https://github.com/MYTech-Co-LTD/platform-core/commit/aa6b635dde874c2ffbd39abe3ac2f53eee4a8d06))


## [0.268.3](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.268.2...v0.268.3) - 2026-11-04
- 【修复】data: 门店费用容量 900→4,000 条/日（page_size 200 + 数据页 9→20） ([#1386](https://github.com/MYTech-Co-LTD/platform-core/pull/1386), [2bcb9cb](https://github.com/MYTech-Co-LTD/platform-core/commit/2bcb9cb7af4230c8b1f6bdb360ab1fbf4311b905))


## [0.268.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.268.1...v0.268.2) - 2026-11-04
- 【修复】data: verify-ingest 首跑改有界回看窗口（OO 拒绝 start_time=0） ([#1384](https://github.com/MYTech-Co-LTD/platform-core/pull/1384), [1508e91](https://github.com/MYTech-Co-LTD/platform-core/commit/1508e91d89d1893e0da4f3117b7ceb81e6e795ab))


## [0.268.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.268.0...v0.268.1) - 2026-11-04
- 【修复】data: OO 摄入改用组织级 _search（真机 stream 级恒 404） ([#1381](https://github.com/MYTech-Co-LTD/platform-core/pull/1381), [d661c24](https://github.com/MYTech-Co-LTD/platform-core/commit/d661c2446be3307316dc00a34313b86e66f7b1a5))


## [0.268.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.267.0...v0.268.0) - 2026-11-04
- 【新增】data: W1 可信度地基——已验证问答 + 回归 job（结构+容差） ([#1379](https://github.com/MYTech-Co-LTD/platform-core/pull/1379), [0a4dfa1](https://github.com/MYTech-Co-LTD/platform-core/commit/0a4dfa1a4fd466b201dbd3017db75f34af20828c))


## [0.267.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.266.1...v0.267.0) - 2026-11-04
- 【新增】data: W0 指标实体与同义词声明（落库 + 问数消费） ([#1376](https://github.com/MYTech-Co-LTD/platform-core/pull/1376), [d572ea2](https://github.com/MYTech-Co-LTD/platform-core/commit/d572ea29c9557ad592c4680ca1b38a6f3d682240))


## [0.266.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.266.0...v0.266.1) - 2026-11-04
- 【修复】data-mobile: 报表管理与报表中心拆开——管理 tab 只列「我创建的」（#1373） ([#1374](https://github.com/MYTech-Co-LTD/platform-core/pull/1374), [c6540eb](https://github.com/MYTech-Co-LTD/platform-core/commit/c6540eb633a6ff14eee1fd5f2f45568717283765))


## [0.266.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.265.0...v0.266.0) - 2026-11-04
- 【新增】data: 接源库存进出明细（inventory.movement）——原生分页单节点 ([#1354](https://github.com/MYTech-Co-LTD/platform-core/pull/1354), [ecfd0e6](https://github.com/MYTech-Co-LTD/platform-core/commit/ecfd0e6729e80ae9d2f928af644fde06bd2ecf0c))


## [0.265.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.264.0...v0.265.0) - 2026-11-04
- 【新增】data-mobile: 报表中心三 tab 修正——中心(看)/报表管理/指标管理按权限显隐（#1371） ([#1372](https://github.com/MYTech-Co-LTD/platform-core/pull/1372), [090b804](https://github.com/MYTech-Co-LTD/platform-core/commit/090b804f28cf84f7a3957558a616a7e6a1ef715a))


## [0.264.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.263.0...v0.264.0) - 2026-11-04
- 【新增】data-mobile: 报表中心——三 tab（报表/指标/问数）+ 权限自适应（#1369） ([#1370](https://github.com/MYTech-Co-LTD/platform-core/pull/1370), [e9f64a5](https://github.com/MYTech-Co-LTD/platform-core/commit/e9f64a5a3e036a06155649aebf619c15b01beabf))


## [0.263.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.262.1...v0.263.0) - 2026-11-04
- 【新增】data-mobile: 未发布报表可在移动端预览（#1367） ([#1368](https://github.com/MYTech-Co-LTD/platform-core/pull/1368), [702c85a](https://github.com/MYTech-Co-LTD/platform-core/commit/702c85a1b78656646ccd9f1a318a6133186c2244))


## [0.262.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.262.0...v0.262.1) - 2026-11-04
- 【修复】data: branch 扇出四源统一装 #1314 占位行 + 父级全空栅（修复空块 Binder Error） ([#1366](https://github.com/MYTech-Co-LTD/platform-core/pull/1366), [0499c04](https://github.com/MYTech-Co-LTD/platform-core/commit/0499c04bb6ba0a9dd6f6b25d1c4f23029cd2db78))


## [0.262.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.261.0...v0.262.0) - 2026-11-04
- 【新增】data-mobile: 报表在 App 内打开（全屏阅读层 + 返回），不再跳出 App ([#1364](https://github.com/MYTech-Co-LTD/platform-core/pull/1364), [7d23ca6](https://github.com/MYTech-Co-LTD/platform-core/commit/7d23ca6845e913dd4f6b8b8fbafb9f3869929dd5))


## [0.261.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.260.0...v0.261.0) - 2026-11-04
- 【新增】data-mobile: 移动端改业务面（报表进 App），console 手机端转场到手机工作台 ([#1361](https://github.com/MYTech-Co-LTD/platform-core/pull/1361), [bbb9dd4](https://github.com/MYTech-Co-LTD/platform-core/commit/bbb9dd417a49675c283330bdbd6783949f29569e))


## [0.260.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.259.2...v0.260.0) - 2026-11-03
- 【新增】web: 移动端控制台壳——底部标签栏 + 一屏布局（#1359） ([#1360](https://github.com/MYTech-Co-LTD/platform-core/pull/1360), [142f97e](https://github.com/MYTech-Co-LTD/platform-core/commit/142f97eab5ab32ca9db26fa499054a6b87255f87))


## [0.259.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.259.1...v0.259.2) - 2026-11-03
- 【修复】data: 移动端交互重做——整卡可点 + 底部 ActionSheet + 44px 触控（#1357） ([#1358](https://github.com/MYTech-Co-LTD/platform-core/pull/1358), [b277845](https://github.com/MYTech-Co-LTD/platform-core/commit/b277845d26a31f8f3c931870abd19940cea52a90))


## [0.259.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.259.0...v0.259.1) - 2026-11-03
- 【修复】data: console 报表/指标页在手机上改成卡片列表（#1355） ([#1356](https://github.com/MYTech-Co-LTD/platform-core/pull/1356), [76cbae3](https://github.com/MYTech-Co-LTD/platform-core/commit/76cbae32efc2532893ec9b40ddac5d2364dd8b44))


## [0.259.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.258.0...v0.259.0) - 2026-11-03
- 【新增】data: 接源 AMAREPORT 销售员提成汇总（salercommission） ([#1348](https://github.com/MYTech-Co-LTD/platform-core/pull/1348), [676b31c](https://github.com/MYTech-Co-LTD/platform-core/commit/676b31c91ce1723f7e67e3feea5b116df5ec9888))


## [0.258.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.257.0...v0.258.0) - 2026-11-03
- 【新增】web: 移动端业务工作台 /m 打磨（#1351） ([#1352](https://github.com/MYTech-Co-LTD/platform-core/pull/1352), [5d8a082](https://github.com/MYTech-Co-LTD/platform-core/commit/5d8a082d5652ea82bacff55be50d81aeee0c2758))


## [0.257.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.256.0...v0.257.0) - 2026-11-03
- 【新增】data-mobile: 移动指标页移动端优先优化（#1349） ([#1350](https://github.com/MYTech-Co-LTD/platform-core/pull/1350), [a48341f](https://github.com/MYTech-Co-LTD/platform-core/commit/a48341f6a9df5c02212b0463d704f569f4156120))


## [0.256.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.255.0...v0.256.0) - 2026-11-03
- 【新增】data: 接源 AMAREPORT 时段分析（customeranalysis）——日×门店×时段切片 ([#1344](https://github.com/MYTech-Co-LTD/platform-core/pull/1344), [ee166aa](https://github.com/MYTech-Co-LTD/platform-core/commit/ee166aa000af838ef91790c2b79eecfa5b6c4359))


## [0.255.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.254.0...v0.255.0) - 2026-11-03
- 【新增】data: 指标列表 UX 优化（搜索/来源筛选/空态/单行表格/文本动作）（#1341） ([#1342](https://github.com/MYTech-Co-LTD/platform-core/pull/1342), [96e4d81](https://github.com/MYTech-Co-LTD/platform-core/commit/96e4d816f4ebfdbea315938694ec641d5de69019))


## [0.254.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.253.0...v0.254.0) - 2026-11-03
- 【新增】data: 报表列表 UX 优化（搜索/筛选/空态/视觉降噪/窄屏滚动）（#1339） ([#1340](https://github.com/MYTech-Co-LTD/platform-core/pull/1340), [d3a9677](https://github.com/MYTech-Co-LTD/platform-core/commit/d3a967778dbebb7a7e55ce25baf163b893fba8a4))


## [0.253.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.252.1...v0.253.0) - 2026-11-03
- 【新增】data: 接源 AMAREPORT 商品销售/毛利分析（itemsales / itemprofitanalysis） ([#1338](https://github.com/MYTech-Co-LTD/platform-core/pull/1338), [d1eb8a3](https://github.com/MYTech-Co-LTD/platform-core/commit/d1eb8a3ab8950bdc1f2857882e3005e35b5649a8))


## [0.252.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.252.0...v0.252.1) - 2026-11-03
- 【修复】data: 所有者转移 / ACL 点名校验受让人真实可用（#1335） ([#1336](https://github.com/MYTech-Co-LTD/platform-core/pull/1336), [ddf794e](https://github.com/MYTech-Co-LTD/platform-core/commit/ddf794ea0ced8debf04af7357cb28a87e9145ec4))


## [0.252.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.251.0...v0.252.0) - 2026-11-03
- 【新增】data: 管理面标注「无活跃所有者」的资产（#1333） ([#1334](https://github.com/MYTech-Co-LTD/platform-core/pull/1334), [48aa8df](https://github.com/MYTech-Co-LTD/platform-core/commit/48aa8dfaa3f3e60d3132dcdc6ec56508f7aced78))


## [0.251.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.250.0...v0.251.0) - 2026-11-03
- 【新增】data: 创建报表独立成码 data:create（#1330） ([#1331](https://github.com/MYTech-Co-LTD/platform-core/pull/1331), [c6eddea](https://github.com/MYTech-Co-LTD/platform-core/commit/c6eddea9a223061a1caf4ec6fd23bbdf6660acb0))


## [0.250.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.249.0...v0.250.0) - 2026-11-03
- 【新增】data: console 按服务端 canEdit 显示资产操作（#1327） ([#1328](https://github.com/MYTech-Co-LTD/platform-core/pull/1328), [bcce129](https://github.com/MYTech-Co-LTD/platform-core/commit/bcce129aa0dc27e8cd3d728b5552b0e51ea36a19))


## [0.249.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.248.15...v0.249.0) - 2026-11-03
- 【新增】data: owner 对自己报表的最高权限（#1325） ([#1326](https://github.com/MYTech-Co-LTD/platform-core/pull/1326), [905e75a](https://github.com/MYTech-Co-LTD/platform-core/commit/905e75a00b46f6de2b0c414329fb309715a705b2))


## [0.248.15](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.248.14...v0.248.15) - 2026-11-03
- 【修复】data: 报表内容读取路径补齐资产 ACL（published-spec / narrative） ([#1322](https://github.com/MYTech-Co-LTD/platform-core/pull/1322), [1f2ac01](https://github.com/MYTech-Co-LTD/platform-core/commit/1f2ac0138ea8b645fd1b52cc8e82d11fe3a38a85))


## [0.248.14](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.248.13...v0.248.14) - 2026-11-03
- 【修复】data: 零售日批重采窗扩到 T-1..T-3 治晚到退货（#814 restatement window） ([#1319](https://github.com/MYTech-Co-LTD/platform-core/pull/1319), [002da5f](https://github.com/MYTech-Co-LTD/platform-core/commit/002da5f751c2e9659b2197327c1a1440cded2b73))


## [0.248.13](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.248.12...v0.248.13) - 2026-11-03
- 【修复】data: 会员汇总 shape 全列改行内 JSON 取值，源端缺维度得 NULL 而非整天失败 ([#1317](https://github.com/MYTech-Co-LTD/platform-core/pull/1317), [36f748f](https://github.com/MYTech-Co-LTD/platform-core/commit/36f748fa51036273e706c8cb9cc52a5e48fc8e29))


## [0.248.12](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.248.11...v0.248.12) - 2026-11-03
- 【修复】data: config_drift 漂移行接线告警面——断言⑭ + 对齐表行（#809） ([#1316](https://github.com/MYTech-Co-LTD/platform-core/pull/1316), [1a05138](https://github.com/MYTech-Co-LTD/platform-core/commit/1a051384bd173b2661dc7f67176e8fbdb33d063a))


## [0.248.11](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.248.10...v0.248.11) - 2026-11-03
- 【修复】data: 门店指标判空从分块级提到父级，部分块空不再整天拒写湖 (#1314) ([#1315](https://github.com/MYTech-Co-LTD/platform-core/pull/1315), [f4027a7](https://github.com/MYTech-Co-LTD/platform-core/commit/f4027a705e55527baddf7e380ef28813b7342562))


## [0.248.10](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.248.9...v0.248.10) - 2026-11-03
- 【修复】askdata: 撞墙判据三处失真 + 判据侧水位（#963） ([#1312](https://github.com/MYTech-Co-LTD/platform-core/pull/1312), [909ccb0](https://github.com/MYTech-Co-LTD/platform-core/commit/909ccb072a053a5f7351a11d7ac700518aaf7f92))


## [0.248.9](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.248.8...v0.248.9) - 2026-11-03
- 【修复】openclaw: 身份兜底改按会话键隔离——跨会话绝不用他人 userid 取数（#964） ([#1311](https://github.com/MYTech-Co-LTD/platform-core/pull/1311), [b1949f1](https://github.com/MYTech-Co-LTD/platform-core/commit/b1949f17c584f31c8036271a585700da8571f3b4))


## [0.248.8](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.248.7...v0.248.8) - 2026-11-02
- 【修复】askdata: 轨迹导出读 event_zstd + 解不出的事件钉住水位（#969） ([#1310](https://github.com/MYTech-Co-LTD/platform-core/pull/1310), [daea465](https://github.com/MYTech-Co-LTD/platform-core/commit/daea465bfaf23cf2aea7c6e7d7c380260444b00a))


## [0.248.7](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.248.6...v0.248.7) - 2026-11-02
- 【修复】aftersales: 临时库 FORCE-drop 的 57P01 不再以 unhandled error 打死整轮（#1308） ([#1309](https://github.com/MYTech-Co-LTD/platform-core/pull/1309), [a918a04](https://github.com/MYTech-Co-LTD/platform-core/commit/a918a041d8a5dd77fa40b9ed512768645b465433))


## [0.248.6](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.248.5...v0.248.6) - 2026-11-02
- 【修复】data: 自绘图横轴——x 轴升序（#399 A）与日期按上海时区格式化（#400） ([#1307](https://github.com/MYTech-Co-LTD/platform-core/pull/1307), [7c9ec3f](https://github.com/MYTech-Co-LTD/platform-core/commit/7c9ec3f5130478161a552a8e5269f453505afbce))


## [0.248.5](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.248.4...v0.248.5) - 2026-11-02
- 【修复】guard: 两个守卫逃检面收口——软链 compose 可见 + 带引号 double 类型名（#165/#170） ([#1306](https://github.com/MYTech-Co-LTD/platform-core/pull/1306), [be2cbc5](https://github.com/MYTech-Co-LTD/platform-core/commit/be2cbc5aa8badcb7602971c4f66ae2f878e214ab))


## [0.248.4](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.248.3...v0.248.4) - 2026-11-02
- 【修复】ci: release 走 workflow_run 终态门禁——ci 绿才发版，与 CI 不再赛跑（#1052） ([#1303](https://github.com/MYTech-Co-LTD/platform-core/pull/1303), [5e90bad](https://github.com/MYTech-Co-LTD/platform-core/commit/5e90badb2d891cf096b39e6f593f64949bcf6294))


## [0.248.3](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.248.2...v0.248.3) - 2026-11-02
- 【修复】data: fct_branch_day_activity 的 CTE 改名 asof_rows（#1304） ([#1305](https://github.com/MYTech-Co-LTD/platform-core/pull/1305), [08dea0f](https://github.com/MYTech-Co-LTD/platform-core/commit/08dea0fc86966a01c1838953b7dfee27d90a6b2f))


## [0.248.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.248.1...v0.248.2) - 2026-11-02
- 【修复】data: 会员审计 NULL 键 join 失效（#1301） ([#1302](https://github.com/MYTech-Co-LTD/platform-core/pull/1302), [ed19f6f](https://github.com/MYTech-Co-LTD/platform-core/commit/ed19f6fcd9df81294f00b2937d0809a1627bd9ed))


## [0.248.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.248.0...v0.248.1) - 2026-11-02
- 【修复】server: runMigrations 目录缺失口径——onMissingDir=error 档（#203 裁决） ([#1300](https://github.com/MYTech-Co-LTD/platform-core/pull/1300), [22f565f](https://github.com/MYTech-Co-LTD/platform-core/commit/22f565f5b0eda1f625807f9a840254412345deb6))


## [0.248.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.247.0...v0.248.0) - 2026-11-02
- 【新增】data: 移动端表达式指标编辑器——两操作数算式条（spec §10.4 遗留项） ([#1299](https://github.com/MYTech-Co-LTD/platform-core/pull/1299), [c05b5b9](https://github.com/MYTech-Co-LTD/platform-core/commit/c05b5b9740fc7e95d1c7c91ed5c6aaf49f7a2c15))


## [0.247.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.246.0...v0.247.0) - 2026-11-02
- 【新增】data: L1 单位赋值——机械可推导子集 46 条 + 契约闸放行 unit 键（spec §10.4.3） ([#1297](https://github.com/MYTech-Co-LTD/platform-core/pull/1297), [b9637e6](https://github.com/MYTech-Co-LTD/platform-core/commit/b9637e65f5f7038b769f57179b8bee6aff01dc62))


## [0.246.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.245.2...v0.246.0) - 2026-11-02
- 【新增】data: 下线候选的操作入口——usage 响应带 self + 候选卡按 creator 门给删除（spec §10.4.3） ([#1295](https://github.com/MYTech-Co-LTD/platform-core/pull/1295), [78f0f7f](https://github.com/MYTech-Co-LTD/platform-core/commit/78f0f7f1a3a51b161b22cf2379c0a465e20b97d2))
- 【修复】data: 换货形状审计负值判据加分位容差（#1290） ([#1291](https://github.com/MYTech-Co-LTD/platform-core/pull/1291), [7394547](https://github.com/MYTech-Co-LTD/platform-core/commit/739454761e44d653d68d20bf481eedfef6d4ab21))


## [0.245.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.245.1...v0.245.2) - 2026-11-02
- 【修复】data: 调拨单自然键纳入 use_unit（#1287） ([#1288](https://github.com/MYTech-Co-LTD/platform-core/pull/1288), [e96bc62](https://github.com/MYTech-Co-LTD/platform-core/commit/e96bc62db6053056064a19043612e0e1f6f03de6))


## [0.245.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.245.0...v0.245.1) - 2026-11-02
- 【修复】data: 战区结构不变量收窄——根节点战区不算映射缺失（#1199） ([#1285](https://github.com/MYTech-Co-LTD/platform-core/pull/1285), [ac4719e](https://github.com/MYTech-Co-LTD/platform-core/commit/ac4719ecbf9b0f46a9a70b19a149d7f770ca8040))


## [0.245.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.244.0...v0.245.0) - 2026-11-02
- 【新增】data: L2 元数据移动端消费面——卡片展示 + creator 编辑弹窗（spec §10.4.3） ([#1293](https://github.com/MYTech-Co-LTD/platform-core/pull/1293), [ab6d7ac](https://github.com/MYTech-Co-LTD/platform-core/commit/ab6d7acdb307c3e098803709e23ba66e4e4f830f))


## [0.244.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.243.0...v0.244.0) - 2026-11-02
- 【新增】data: P1 收尾——L1 unit 声明面机制 + 移动端 certified 管理入口（self.scopes） ([#1289](https://github.com/MYTech-Co-LTD/platform-core/pull/1289), [2787034](https://github.com/MYTech-Co-LTD/platform-core/commit/27870349fc43101d48d44adbd917a34a4d5d4b66))


## [0.243.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.242.0...v0.243.0) - 2026-11-02
- 【新增】data: P1 指标元数据——业务描述/单位/口径说明三字段（spec §10.4.3） ([#1284](https://github.com/MYTech-Co-LTD/platform-core/pull/1284), [8cd3110](https://github.com/MYTech-Co-LTD/platform-core/commit/8cd311024ab65eacf1dccc9a33f6d227b2431f68))


## [0.242.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.241.1...v0.242.0) - 2026-11-02
- 【新增】data: P1 使用统计读面——query_audit 按 metricId 聚合 + L2 下线候选清单（spec §10.4.3） ([#1282](https://github.com/MYTech-Co-LTD/platform-core/pull/1282), [0f7eede](https://github.com/MYTech-Co-LTD/platform-core/commit/0f7eede69532c87fefd802c89d998253dc49104a))


## [0.241.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.241.0...v0.241.1) - 2026-11-02
- 【修复】data: 零售 staging 视图的结构测试滤掉今天，避 tick 重写 ETag 竞态 (#1279) ([#1280](https://github.com/MYTech-Co-LTD/platform-core/pull/1280), [6f6d7f3](https://github.com/MYTech-Co-LTD/platform-core/commit/6f6d7f3e8cddbde0fae5085e494df5a58a0875b1))


## [0.241.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.240.0...v0.241.0) - 2026-11-02
- 【新增】data: 移动端指标页——L1 只读卡 + L2 creator 草稿管理 + 新鲜度/certified 徽标（spec §10.2/§10.4.2） ([#1278](https://github.com/MYTech-Co-LTD/platform-core/pull/1278), [83cccd9](https://github.com/MYTech-Co-LTD/platform-core/commit/83cccd9ccaa275431c4e9268344157e5675d2d66))


## [0.240.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.239.0...v0.240.0) - 2026-11-02
- 【新增】data: 指标治理收口——确认生效编译+通知、certified 分级、creator 闸（D6/D7） ([#1277](https://github.com/MYTech-Co-LTD/platform-core/pull/1277), [272a4b7](https://github.com/MYTech-Co-LTD/platform-core/commit/272a4b7221de6b4ab35f672a7ac2b86db556b9fc))


## [0.239.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.238.1...v0.239.0) - 2026-11-02
- 【新增】data: 指标治理第一步——L2 草稿声明面 + certified/created_by（spec §10.4） ([#1271](https://github.com/MYTech-Co-LTD/platform-core/pull/1271), [3519ad8](https://github.com/MYTech-Co-LTD/platform-core/commit/3519ad815f06eca74ce49372c39a36d315878dc0))


## [0.238.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.238.0...v0.238.1) - 2026-11-02
- 【优化】data: 明细 staging 物化表翻直读湖视图，维度快照保留物化 (#1275) ([#1276](https://github.com/MYTech-Co-LTD/platform-core/pull/1276), [e091878](https://github.com/MYTech-Co-LTD/platform-core/commit/e0918783d87ee19010aa94105622dc2633c661b2))


## [0.238.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.237.0...v0.238.0) - 2026-11-02
- 【新增】data: 管理清单回带 owner + 控制台「所有者」列（P4 收尾） ([#1268](https://github.com/MYTech-Co-LTD/platform-core/pull/1268), [1326b0a](https://github.com/MYTech-Co-LTD/platform-core/commit/1326b0a2b2271d40b32c2ebbb086ebe0a614ba03))


## [0.237.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.236.3...v0.237.0) - 2026-11-02
- 【新增】platform: manifest 声明业务面承载端 surfaces（机检「不做双实现」） ([#1266](https://github.com/MYTech-Co-LTD/platform-core/pull/1266), [5c7da63](https://github.com/MYTech-Co-LTD/platform-core/commit/5c7da63436345d773e4b956ccd1e284519678c19))


## [0.236.3](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.236.2...v0.236.3) - 2026-11-01
- 【修复】data: branch_indicator 契约闸去单指标假设 (#1264) ([#1265](https://github.com/MYTech-Co-LTD/platform-core/pull/1265), [6fab42b](https://github.com/MYTech-Co-LTD/platform-core/commit/6fab42b7d0c3e7220fe0bef1886914a425689655))


## [0.236.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.236.1...v0.236.2) - 2026-11-01
- 【修复】data: 回填变体同步自证闸修复 (#1262) ([#1263](https://github.com/MYTech-Co-LTD/platform-core/pull/1263), [cfbea6b](https://github.com/MYTech-Co-LTD/platform-core/commit/cfbea6b47b697a8cbb97b7c31b045c512a180686))


## [0.236.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.236.0...v0.236.1) - 2026-11-01
- 【修复】data: 经营指标自证闸按门店数比较，修多指标假红 (#1259) ([#1261](https://github.com/MYTech-Co-LTD/platform-core/pull/1261), [c893a83](https://github.com/MYTech-Co-LTD/platform-core/commit/c893a83be8f30811a4bb77ada6d75597e8119c3b))


## [0.236.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.235.1...v0.236.0) - 2026-11-01
- 【新增】data: 门店经营指标扩到 10 个 (#1257) ([#1258](https://github.com/MYTech-Co-LTD/platform-core/pull/1258), [c16bec3](https://github.com/MYTech-Co-LTD/platform-core/commit/c16bec32f2dd6c332a7c9242d06fa300e43be948))


## [0.235.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.235.0...v0.235.1) - 2026-11-01
- 【修复】aftersales: 平台会话下打开员工登记页 403 卡死（身份互斥） ([#1255](https://github.com/MYTech-Co-LTD/platform-core/pull/1255), [b7fd5d3](https://github.com/MYTech-Co-LTD/platform-core/commit/b7fd5d3be4eb6019b97fb76117858aa2b86542c6))


## [0.235.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.234.0...v0.235.0) - 2026-11-01
- 【新增】data: 所有者转移 PUT /reports/:id/owner（P4） ([#1253](https://github.com/MYTech-Co-LTD/platform-core/pull/1253), [05005f1](https://github.com/MYTech-Co-LTD/platform-core/commit/05005f102ad302a5d19f69b5a66e0bcfb5f79b33))


## [0.234.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.233.0...v0.234.0) - 2026-11-01
- 【新增】web: 移动端业务入口页 /m（按权限列应用卡片） ([#1251](https://github.com/MYTech-Co-LTD/platform-core/pull/1251), [da6fad5](https://github.com/MYTech-Co-LTD/platform-core/commit/da6fad54e646fe51fea219dd5fe0fb39ffc21d35))


## [0.233.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.232.0...v0.233.0) - 2026-11-01
- 【新增】platform: 按人过滤的业务应用入口 /me/apps（P2 第一步） ([#1249](https://github.com/MYTech-Co-LTD/platform-core/pull/1249), [ca579bc](https://github.com/MYTech-Co-LTD/platform-core/commit/ca579bc4d986f81da0b31c7af8d46d9d761f4fbb))


## [0.232.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.231.0...v0.232.0) - 2026-11-01
- 【新增】data: 报表控制台「共享」入口（资产级授权可用面） ([#1247](https://github.com/MYTech-Co-LTD/platform-core/pull/1247), [1cfaf6f](https://github.com/MYTech-Co-LTD/platform-core/commit/1cfaf6f9dcaac9849f38e3b9821f8860d9179d00))


## [0.231.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.230.0...v0.231.0) - 2026-11-01
- 【新增】data: 资产级授权 P1——ACL + 默认私有 + canView/canEdit 单一实现 ([#1244](https://github.com/MYTech-Co-LTD/platform-core/pull/1244), [fd771c3](https://github.com/MYTech-Co-LTD/platform-core/commit/fd771c3d21b843927f5a9cd34ae2c2557e5cbc74))


## [0.230.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.229.3...v0.230.0) - 2026-11-01
- 【新增】openclaw: wecom-app 企微自建应用插件——17 工具+白名单+SKILL (#1238) ([#1240](https://github.com/MYTech-Co-LTD/platform-core/pull/1240), [a50e107](https://github.com/MYTech-Co-LTD/platform-core/commit/a50e10701cfa085bfdea02918f4b7f0e2e185da0))


## [0.229.3](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.229.2...v0.229.3) - 2026-11-01
- 【修复】platform: 权限码供给不再在启动致命路径——Casdoor admin 被锁不再全实例崩 ([#579](https://github.com/MYTech-Co-LTD/platform-core/pull/579), [83bc3e8](https://github.com/MYTech-Co-LTD/platform-core/commit/83bc3e84e12c832129c4bd0a69bae8e0276559bf))


## [0.229.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.229.1...v0.229.2) - 2026-11-01
- 【修复】notify: 探针绕过 token 缓存——凭据改坏后一轮即红，不再等 TTL ([#1235](https://github.com/MYTech-Co-LTD/platform-core/pull/1235), [791a52d](https://github.com/MYTech-Co-LTD/platform-core/commit/791a52d14ae0d2bdb1c925c8626683e917096943))


## [0.229.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.229.0...v0.229.1) - 2026-10-31
- 【修复】notify: 直连通道的凭据列不再显示桥的 env 键名 ([#1233](https://github.com/MYTech-Co-LTD/platform-core/pull/1233), [02f2775](https://github.com/MYTech-Co-LTD/platform-core/commit/02f2775604557a219c11c22fe531f9181d2388be))


## [0.229.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.228.0...v0.229.0) - 2026-10-31
- 【新增】notify: 收件人可达性可观测——抽样 + 聚合 + 控制台清单 ([#1231](https://github.com/MYTech-Co-LTD/platform-core/pull/1231), [0362487](https://github.com/MYTech-Co-LTD/platform-core/commit/03624871a929ea298e5860c86ffb48e551c1caf7))


## [0.228.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.227.0...v0.228.0) - 2026-10-31
- 【新增】platform: 组织同步允许用独立的企微应用（WECOM_SYNC_SECRET__<ORG>） ([#1229](https://github.com/MYTech-Co-LTD/platform-core/pull/1229), [fcda760](https://github.com/MYTech-Co-LTD/platform-core/commit/fcda760aabb70476f23659e339651cbc19310f12))


## [0.227.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.226.0...v0.227.0) - 2026-10-31
- 【新增】platform: 收件人身份映射 Phase 1——source/external_id + 解析优先级 ([#1227](https://github.com/MYTech-Co-LTD/platform-core/pull/1227), [356bea1](https://github.com/MYTech-Co-LTD/platform-core/commit/356bea1cb528724c97ee96241ec61f32f0ef3061))


## [0.226.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.225.1...v0.226.0) - 2026-10-31
- 【新增】platform: 集成判据退役——registry 删掉的条目自动置 enabled=false ([#1223](https://github.com/MYTech-Co-LTD/platform-core/pull/1223), [6d5a9cf](https://github.com/MYTech-Co-LTD/platform-core/commit/6d5a9cfe7179e296177a5dc9be4c06533ae17005))


## [0.225.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.225.0...v0.225.1) - 2026-10-31
- 【修复】notify: 凭据导入脚本读错租户列（org ≠ casdoor_org） ([#1222](https://github.com/MYTech-Co-LTD/platform-core/pull/1222), [729e73b](https://github.com/MYTech-Co-LTD/platform-core/commit/729e73b8c33f2780fc85fbfb6e697e1726b7010d))


## [0.225.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.224.2...v0.225.0) - 2026-10-31
- 【新增】notify: 企微直连 P1——凭据加密落库 + token 缓存 + 活性判据 ([#1219](https://github.com/MYTech-Co-LTD/platform-core/pull/1219), [ba177ac](https://github.com/MYTech-Co-LTD/platform-core/commit/ba177ac71d1852cc01f10f2c91fd66b5457ed854))


## [0.224.2](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.224.1...v0.224.2) - 2026-10-31
- 【优化】notify: 出站发送收敛成 provider 表（只留多渠道架构空间）(#1217) ([#1218](https://github.com/MYTech-Co-LTD/platform-core/pull/1218), [495a24d](https://github.com/MYTech-Co-LTD/platform-core/commit/495a24d3bf415397bf954aa05dfb64f85f1f0be2))


## [0.224.1](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.224.0...v0.224.1) - 2026-10-31
- 【修复】platform: 补 Phase 2 元级看门狗 + 协议文档「接入必带判据」 (#1213) ([#1214](https://github.com/MYTech-Co-LTD/platform-core/pull/1214), [8d8b2b6](https://github.com/MYTech-Co-LTD/platform-core/commit/8d8b2b61dbd39b582b02116c6a506140a5e162b5))


## [0.224.0](https://github.com/MYTech-Co-LTD/platform-core/compare/v0.223.1...v0.224.0) - 2026-10-31
- 【新增】platform: 集成健康 Phase 3——registry 硬门禁（声明即判据） (#1211) ([#1212](https://github.com/MYTech-Co-LTD/platform-core/pull/1212), [62ff61a](https://github.com/MYTech-Co-LTD/platform-core/commit/62ff61ac552613b7c9838cb6f085a31a44994774))


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
