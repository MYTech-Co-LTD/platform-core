// scripts/lib/release-commits.mjs — 发布门的提交解析纯函数（release.mjs 用）。
//
// 为什么单独抽出来：`release.mjs` 是顶层同步脚本，逻辑混在 I/O 里就测不了；而「PR 引用的
// 识别口径」正是发布门最容易漂移的地方——它一旦放宽或收紧，症状要么是「直推也能发版」，
// 要么是「历史提交把发布永久堵死」，两者都很难在 CI 之外被发现。
//
// 口径（2026-11-14 订正）：提交主题末尾的 PR 引用**允许半角与全角括号**。
// 历史上有一批 2026-10 的提交写的是 `（#1508）`（全角），旧实现只认 `(#1508)`，
// 于是它们被当成「直推」——发布门自 v0.278.1 起恒红，而主干一直正常部署（门只挡发版）。
// 全角与半角在这里**不是两个语义**：都是「这条变更来自 PR #N」。

/**
 * 末尾 PR 引用（半角或全角括号）。
 * @param {string} subject 提交主题
 * @returns {string|null} PR 编号，没有则 null
 */
export function prRefOf(subject) {
  const m = String(subject ?? '').match(/[(（]#(\d+)[)）]\s*$/)
  return m ? m[1] : null
}

/**
 * 去掉末尾的 PR 引用（半角/全角），用于 CHANGELOG 的描述文本。
 * @param {string} subject 可能带 PR 引用的文本
 * @returns {string} 去掉引用后的文本
 */
export function stripPrRef(subject) {
  return String(subject ?? '').replace(/\s*[(（]#\d+[)）]\s*$/, '')
}

/**
 * 这条提交是否需要向 GitHub API 求证 PR 关联。
 *
 * 只有「可见类型（feat/fix/perf/refactor）」且**主题里没有** PR 引用时才需要——文本里有引用
 * 是快路径（省掉 N 次 API 调用）；没有引用则必须问 API，因为文本判据可伪造，而
 * `commits/{sha}/pulls` 不能（与 ci.yml 的 main-guard 同一判据）。
 * @param {{ subject: string, visible: boolean }} c
 * @returns {boolean}
 */
export function needsPrLookup(c) {
  return Boolean(c.visible) && prRefOf(c.subject) === null
}
