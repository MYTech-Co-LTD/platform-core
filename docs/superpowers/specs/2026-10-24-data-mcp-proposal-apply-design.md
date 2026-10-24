# 数据面 MCP 提案应用通路（apply_pipeline_proposal）设计

> 2026-10-24 brainstorming 定稿。对应 issue #1003（D-W3-5「应用」这一半）。
> 前置事实源：`modules/data/domain/pipelines/propose.ts`（零写入的三件套草案生成）、
> `deploy/data-plane-deploy-sop.md`、`docs/architecture.md` §2.8（沙箱 seam 的同构先例）。

## 0. 已拍板的两个分叉

1. **入口形态 = 独立 apply 工具 + 草案回传**（否决「同工具加 apply 参数」与「服务端暂存按 id」）：
   WYSIWYG——PR 内容 = 人 review 过的草案，不依赖「重新生成是确定的」这一假设；服务端无状态；
   审计存摘要不存全文。代价：工具清单 7→8，正典 §7 与工具清单测试同步更新。
2. **闸门 = 写总闸 + PAT 存在性**（否决再加专闸）：开 PR 需同时满足
   ① `DATA_MCP_ALLOW_MUTATING=true`（已有总闸；关闸时 `denied / mutating_disabled`，即 #1003 验收第三条）；
   ② `DATA_MCP_GITHUB_TOKEN` 已配，未配 ⇒ `not_executed / proposal_apply_unconfigured`（与沙箱 seam 同构）。

## 1. 工具

- 名字：`apply_pipeline_proposal`；`mutating: true`、`readOnlyHint: false`、scope `data:manage`；挂 `/mcp-manage`。
- **输入 = `propose_pipeline_change` 回包原样回传**：`{title, branch, pieces:[{path, content}], downstream, validation}`。
- **服务端不信任回包内容**：对每个 piece 重跑 `validateContractDraft` / `validatePipelineDraft`
  （按 path 判类型），不过 ⇒ `refused / invalid_draft` + issues，**零网络调用**。
- 现有两条 `propose_*` 本体不动：仍零写入，结构性红线不破。

## 2. 机制（GitHub REST，容器内 fetch，无 git 依赖）

基线：repo 由 `DATA_MCP_GITHUB_REPO` 给（默认 `MYTech-Co-LTD/platform-core`），base = 该仓默认分支。

1. `GET /repos/{repo}/git/ref/heads/{default}` ⇒ 基线 head sha。
2. **冲突预检**（#1003 第 3 条）：逐 piece `GET /repos/{repo}/contents/<path>?ref=<base>`：
   - 404 ⇒ 新文件；
   - 200 且内容与 piece 一致 ⇒ **幂等跳过**（进 `skipped`）；
   - 200 且不同 ⇒ **拒绝**：`refused / proposal_conflict` + 当前内容 sha256 前 16 位，**不建分支不开 PR、不自动合并**。
3. 建分支：`POST /repos/{repo}/git/refs`（from base head）。建议名 `proposal/<slugOf(title)>`
   已存在 ⇒ 追加 `-<6位随机hex>` 重试（命名碰撞 ≠ 他人改动，不是拒绝路径）。
4. 逐 piece `PUT /repos/{repo}/contents/<path>`（branch、content base64、现状 sha 或省略=新文件）
   ⇒ 每文件一个 commit；一条 PR 多 commit，满足「契约+管线+dbt staging 同 PR」纪律的前两件。
5. 开 **draft PR**：`POST /repos/{repo}/pulls`（`draft: true`）。dbt staging 第三件不机械生成 ⇒
   draft + PR body 带 downstream 清单与 validation 结论 = 诚实的半成品，纪律不破。
6. 回包：`ok` + `{prUrl, prNumber, branch, commitCount, skipped[]}`。

## 3. 失败语义（与 `verdictOf` 对齐）

| 情形 | status / reason | isError | 审计 verdict |
|---|---|---|---|
| 总闸没开 | `denied / mutating_disabled`（现状复用） | true | denied |
| PAT 未配 | `not_executed / proposal_apply_unconfigured` | false | ok |
| 回传草案没过重校验 | `refused / invalid_draft` + issues | true | denied |
| 目标文件内容与基线不同 | `refused / proposal_conflict` + 当前内容 sha256 前 16 位 | true | denied |
| GitHub 4xx（鉴权/权限/参数） | `denied / proposal_apply_rejected` + GitHub 原话 | true | denied |
| GitHub 5xx / 网络（**可能部分完成**：分支可能已建） | `unknown / proposal_apply_unknown` + detail + 已建分支名（如有） | true | ok |
| 全部 piece 幂等（无差异） | `ok / nothing_to_apply` + 说明，**不开 PR** | false | ok |
| 成功 | `ok` + `{prUrl, prNumber, branch, commitCount, skipped}` | false | ok |

## 4. 审计

- 沿用 `mcp-pipeline-tools.ts` 的单点 `writeAudit`。apply 过程**两行**：建分支成功后一行
  （`ok / proposal_branch_created`）、PR 开成后一行（`ok / proposal_pr_created`）；
  拒绝 / unknown 各一行。多行同 params 便于对账。
- **args 存摘要不存全文**：审计 params 用 `{title, branch, piecePaths, pieceCount, downstreamCount}`，
  pieces 内容不进审计表（`params` 是整包 JSON 入库，大 payload 会撑爆行）。

## 5. 测试（vitest，fetch 全注入，不连网）

1. 冲突：contents 返回不同内容 ⇒ `refused / proposal_conflict` + 摘要，且**零**建分支/开 PR 调用（调用序列断言）。
2. 幂等：全部 piece 相同 ⇒ `ok / nothing_to_apply`，零写调用、不开 PR。
3. 重校验：回传脏草案（如删 `data.label`）⇒ `refused / invalid_draft`，零网络调用。
4. 分支撞名 ⇒ 建分支 409/422 后带后缀重试成功。
5. GitHub 401 ⇒ `denied / proposal_apply_rejected` + 原话；500 ⇒ `unknown / proposal_apply_unknown` + 已建分支名。
6. 闸门：总闸关 ⇒ `denied / mutating_disabled`；PAT 空 ⇒ `not_executed / proposal_apply_unconfigured`，零网络。
7. 成功路径：调用序列 = ref → contents×N → git/refs → contents PUT×N → pulls；回包字段齐。
8. 现有工具清单测试同步（7→8）。

## 6. 文档与部署

- 正典：`docs/architecture.md` 提案面小节补 apply 通路；spec §7 原文位置补第 8 个工具
  （spec 正文位置实现时定位，找不到就在 SOP 给指针并标待沉淀）。
- SOP：`deploy/data-plane-deploy-sop.md` 增「提案应用通路」段——PAT 在哪、怎么取、怎么 scoped、
  关闸/未配 PAT 的冒烟口径。
- 部署：仅 `server` 服务行加 `DATA_MCP_GITHUB_TOKEN`(isSecret) + `DATA_MCP_GITHUB_REPO`（有默认可不配）。
  **生产默认不配 PAT ⇒ 默认不生效**，满足「不会在没有显式开关的实例上生效」。

## 7. 红线不变式

- `propose.ts` 保持零写入；apply 的一切写动作只经 GitHub API 落在**提案分支 + draft PR**，
  **永不直写** `contracts/`、`deploy/duckle/console/` 等正式目录（结构性成立：容器里根本没有这些目录的写通道）。
- PAT 最小权限（单仓 contents:write + pull_requests:write），只在 server 行 env，不进代码与文档。
