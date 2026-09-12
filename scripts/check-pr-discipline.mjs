#!/usr/bin/env node
/**
 * check-pr-discipline.mjs — issue/PR 强制纪律守卫(公司标准, CI 执行)
 * 标准依据: team-harness docs/standards/dev-discipline.md
 *
 * 策略:
 *  - pull_request: title type ∈ {feat, fix} 时 body 必须含 Closes/Fixes/Resolves #N, 且 #N 是真实 open 的 issue(非 PR);
 *                  skip-issue 标签豁免(紧急热修,事后补)
 *  - push(通常 main): 可见类型(feat/fix/perf/refactor)提交必须带 (#N) PR 引用; chore(release) bot 豁免。
 *                    (配合 release.mjs 拒发版: 直推代码永远进不了 Release)
 *  - 默认追加 §5.2 #3/#4: 最新 commit 若带 X-Orca-Worktree(即为 Orca 提交), 则须 X-Orca-Agent/X-Agent-Session 齐全,
 *    X-Issue(若有)须与 Closes #N 一致; 另校验分支名编号与 Closes #N 一致
 *
 * 环境变量: GH_TOKEN(必填), REPO(owner/repo, 缺省从 git remote 解析),
 *           EVENT(pull_request|push), PR(编号), BEFORE(push 前 sha),
 *           HEAD_REF(PR 源分支名), HEAD_SHA(PR 头 sha)
 * 逃生口:   ALLOW_CLOSED=1(关 issue open 检查), SKIP_ORCA_TRAILERS=1(关 trailer 检查)
 * 子命令:   --self-test(跑纯函数夹具, 退出码 0/1)
 */
import { execSync } from 'node:child_process';
const env = process.env;

function resolveRepo() {
  if (env.REPO || env.GITHUB_REPOSITORY) return env.REPO || env.GITHUB_REPOSITORY;
  const url = execSync('git remote get-url origin', { encoding: 'utf8' }).trim();
  const m = url.match(/github\.com[/:]([^/]+)\/([^.\s]+)/);
  if (!m) throw new Error('无法从 git remote 解析 owner/repo, 请设 REPO 环境变量');
  return `${m[1]}/${m[2]}`;
}
const REPO = resolveRepo();
/**
 * 调 GitHub REST API 并把响应解析成 JSON。
 * @param {string} path 形如 `repos/{owner}/{repo}/pulls/{n}`
 * @returns {any} 响应体（结构随端点而异，故不细化）
 */
const GH = (path) => JSON.parse(execSync(
  `curl -sf -H "Authorization: Bearer ${env.GH_TOKEN}" -H "Accept: application/vnd.github+json" "https://api.github.com/${path}"`,
  { encoding: 'utf8' }));

const VISIBLE = ['feat', 'fix', 'perf', 'refactor'];
const NEEDS_ISSUE = ['feat', 'fix'];

/**
 * 校验 provenance trailer：Worktree 在场（确属 Orca 提交）时才要求 Agent/Session 齐全；
 * 若提交带 X-Issue，须与 PR body 的 Closes #N 一致。
 * @param {string} prNum PR 编号（仅用于日志与语义可读性）
 * @param {string} closesNum PR body 里声明的 issue 编号
 * @returns {void}
 */
function checkOrcaTrailers(prNum, closesNum) {
  const msg = execSync(`git log -1 --format=%B`, { encoding: 'utf8' });
  const gating = checkTrailerGating(msg);
  if (gating) { console.error(`❌ Orca 提交但 ${gating}：hook 装了一半。重装 hook 后重提交，或设 SKIP_ORCA_TRAILERS=1 豁免。`); process.exit(1); }
  const xi = msg.match(/^X-Issue:\s*(\d+)/m)?.[1];
  if (xi && closesNum && xi !== closesNum) { console.error(`❌ X-Issue(${xi}) 与 Closes #${closesNum} 不一致`); process.exit(1); }
  console.log(`✓ orca trailer 校验通过${xi ? `(X-Issue=${xi})` : ''}`);
}

if (env.EVENT === 'pull_request') {
  const n = env.PR;
  if (!n) { console.log('pr-discipline: 无 PR 编号, 跳过'); process.exit(0); }
  const pr = GH(`repos/${REPO}/pulls/${n}`);
  const type = typeOf(pr.title);
  const labels = /** @type {{ name: string }[]} */ (pr.labels).map((l) => l.name);
  if (labels.includes('skip-issue')) { console.log(`✓ PR #${n} 带 skip-issue 标签, 豁免 issue 关联`); process.exit(0); }
  if (!type || !NEEDS_ISSUE.includes(type)) {
    console.log(`✓ PR #${n} type=${type}(非 feat/fix), 不强制 issue`); process.exit(0);
  }
  const nums = extractIssueNums(pr.body);
  if (nums.length === 0) {
    console.error(`❌ PR #${n} [${type}] 必须关联 issue: body 里写 Closes #N(或打 skip-issue 标签豁免)`);
    process.exit(1);
  }
  for (const num of nums) {
    const it = GH(`repos/${REPO}/issues/${num}`);
    if (it.pull_request) { console.error(`❌ #${num} 是 PR 不是 issue`); process.exit(1); }
    if (env.ALLOW_CLOSED !== '1' && it.state !== 'open') {
      console.error(`❌ issue #${num} 不是 open 状态(${it.state}) —— 引用已关闭的 issue 请新开一条`);
      console.error(`   确属有意(如历史遗留)可设 env ALLOW_CLOSED=1 豁免。`);
      process.exit(1);
    }
    console.log(`✓ 关联 issue #${num}: ${it.title}`);
  }
  if (env.SKIP_ORCA_TRAILERS !== '1') checkOrcaTrailers(n, nums[0]);
  const bn = branchIssueNum(env.HEAD_REF);
  if (bn && bn !== nums[0]) {
    console.error(`❌ 分支名含 issue 编号 ${bn} 但 PR body 写 Fixes #${nums[0]} —— 两者必须一致`);
    process.exit(1);
  }
  console.log('✓ issue 纪律通过');
} else if (env.EVENT === 'push') {
  let before = env.BEFORE || '';
  if (!/^[0-9a-f]{40}$/.test(before)) { console.log('push 守卫: 无有效 before sha(首推/强推), 跳过'); process.exit(0); }
  const log = execSync(`git log --no-merges --format=%H%x1f%s ${before}..HEAD`, { encoding: 'utf8' }).trim();
  if (!log) { console.log('push 守卫: 无新提交'); process.exit(0); }
  const bad = [];
  for (const line of log.split('\n')) {
    const [, subj = ''] = line.split('\x1f');
    const type = typeOf(subj);
    if (!type || !VISIBLE.includes(type)) continue;
    if (/\(#\d+\)\s*$/.test(subj)) continue;          // 经 PR(squash 带 (#N))
    bad.push(subj);
  }
  if (bad.length) {
    console.error('❌ 以下可见变更未经 PR 直推 main(纪律: 一切可见变更必须走 PR):');
    bad.forEach(s => console.error('   - ' + s));
    console.error('   → 直推代码将无法进入任何 Release(release.mjs 拒发); 请改走 PR 或回滚。');
    process.exit(1);
  }
  console.log('✓ push 守卫通过(所有可见变更均经 PR)');
} else {
  console.log(`pr-discipline: 事件 ${env.EVENT || '(未知)'}, 跳过`);
}

/** @param {string} subject commit/PR 标题 @returns {string|null} conventional type，非规范返回 null */
export function typeOf(subject) {
  return subject.match(/^([a-z]+)(\([^)]*\))?(!)?:/)?.[1] || null;
}

/** @param {string|undefined} ref 分支名（env 取值，可能为空） @returns {string|null} 分支名里的 issue 编号，无则 null */
export function branchIssueNum(ref) {
  return (ref || '').match(/(?:^|[^a-z])issues?-([0-9]{1,6})/)?.[1] || null;
}

/**
 * 从 PR body 提取 `Closes/Fixes/Resolves #N` 里的全部编号（大小写不敏感）。
 * @param {string} body PR body
 * @returns {string[]} issue 编号（字符串形式，原样保留前导零）
 */
export function extractIssueNums(body) {
  const m = (body || '').match(/(?:closes|fixes|resolves)\s+#(\d+)/gi) || [];
  return m.map((s) => /** @type {string} */ (s.match(/#(\d+)/)?.[1] ?? ''));
}

/**
 * trailer 门控判据：无 X-Orca-Worktree 即视为非 Orca 提交，不额外要求；
 * 有则须 Agent/Session 齐全（抓「hook 装了一半」）。
 * @param {string} msg 提交信息全文
 * @returns {string|null} 违规描述，合规返回 null
 */
export function checkTrailerGating(msg) {
  if (!/^X-Orca-Worktree:/m.test(msg)) return null;      // 非 Orca 提交，不额外要求
  for (const t of ['X-Orca-Agent', 'X-Agent-Session']) {
    if (!new RegExp(`^${t}:`, 'm').test(msg)) return `缺 trailer ${t}`;
  }
  return null;
}

// ─── 自测：钉住判据（本仓惯例，见 scripts/guard.mjs）─────────────────
function selfTest() {
  const cases = [];
  cases.push(['typeOf 解析 feat', typeOf('feat(scope): x') === 'feat']);
  cases.push(['typeOf 拒绝非规范', typeOf('更新文档') === null]);
  cases.push(['分支名 issue-32- 提取', branchIssueNum('refactor/issue-32-x') === '32']);
  cases.push(['分支名无编号返回 null', branchIssueNum('fix/stale-refs') === null]);
  cases.push(['body 提取 Fixes #N', extractIssueNums('Fixes #16').join() === '16']);
  cases.push(['body 大小写不敏感', extractIssueNums('closes #7').join() === '7']);
  cases.push(['无 trailer 不额外要求', checkTrailerGating('feat: x') === null]);
  cases.push([
    '有 Worktree 缺 Agent 被拦',
    checkTrailerGating('feat: x\n\nX-Orca-Worktree: /a/b') === '缺 trailer X-Orca-Agent',
  ]);
  cases.push([
    'trailer 齐全通过',
    checkTrailerGating('feat: x\n\nX-Orca-Worktree: /a/b\nX-Orca-Agent: claude\nX-Agent-Session: s') === null,
  ]);
  let failed = 0;
  for (const [name, pass] of cases) {
    console.log(`  ${pass ? '✓' : '✗'} ${name}`);
    if (!pass) failed++;
  }
  console.log(`\n自测：${cases.length - failed}/${cases.length} 通过`);
  return failed === 0;
}

if (process.argv.includes('--self-test')) process.exit(selfTest() ? 0 : 1);
