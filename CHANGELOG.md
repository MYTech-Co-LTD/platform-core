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
