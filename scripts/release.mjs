#!/usr/bin/env node
/**
 * release.mjs — 公司标准发布脚本(配套 check-pr-discipline.mjs)
 * 触发: release.yml 改为 **workflow_run（ci 在 main 上 conclusion=success）**（#1052 终态门禁，
 * 2026-11-02）——不再与 ci 并行赛跑；本脚本假定「已在一个 ci 全绿的主提交上」执行：
 * 解析上个 tag 以来的 conventional commits
 *   → CHANGELOG.md 每条带【新增】/【优化】/【修复】前缀(关联 PR/commit)
 *   → 提交 chore(release) [skip ci](防循环) + 打 tag vN.N.N
 *   → gh release create(Release Notes = 同款行内前缀条目)
 *
 * 分类: feat→【新增】 fix→【修复】 perf|refactor→【优化】(其余 docs/test/chore/ci/build/style 不上榜)
 * 版本: BREAKING CHANGE 或 "!"→major; 有 feat→minor; 其余可见→patch; 无可见→跳过
 * 铁律: 可见类型提交必须带 PR 引用(直推拒发版)。判据(2026-11-14 订正):
 *   ① 主题末尾 `(#N)` 或 `（#N）`(**全角括号同样算**——历史上有一批全角写法被误判成直推,
 *      导致 release 自 v0.278.1 起恒红);
 *   ② 文本里没有引用时, 带 token 的环境会问 GitHub API `commits/{sha}/pulls`(权威判据,
 *      与 ci.yml 的 main-guard 同一口径); 无 token 则退回纯文本判据(不静默放宽)。
 *
 * 用法: node scripts/release.mjs [--dry-run]
 * 环境变量: GH_TOKEN(release create 用; dry-run 不需要), REPO(可选, 缺省从 git remote 解析)
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { needsPrLookup, prRefOf, stripPrRef } from './lib/release-commits.mjs';

const DRY = process.argv.includes('--dry-run');
/** @param {string} cmd shell 命令 @returns {string} stdout（已 trim） */
const sh = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim();

function resolveRepo() {
  if (process.env.REPO || process.env.GITHUB_REPOSITORY) return process.env.REPO || process.env.GITHUB_REPOSITORY;
  const m = sh('git remote get-url origin').match(/github\.com[/:]([^/]+)\/([^.\s]+)/);
  if (!m) throw new Error('无法解析 owner/repo, 请设 REPO');
  return `${m[1]}/${m[2]}`;
}
const REPO = resolveRepo();
/** @param {string} kind 'pull' | 'commit' @param {string} id 编号或 sha @returns {string} 完整 URL */
const URL = (kind, id) => `https://github.com/${REPO}/${kind}/${id}`;

/**
 * 文本里没有 PR 引用时，向 GitHub API 求证该提交的 PR 关联（与 ci.yml 的 main-guard 同一判据）。
 *
 * 为什么需要：主题文本可伪造，`commits/{sha}/pulls` 不能。没有 token 时**退回纯文本判据**
 * （与旧行为一致，宁可严格也不静默放宽）；dry-run 本地通常无 token，走的就是这条。
 * @param {string} sha 提交完整 sha
 * @returns {string|null} 关联 PR 编号，无则 null
 */
const PR_LOOKUP_CACHE = new Map();
/**
 * @param {string} sha 提交完整 sha
 * @returns {string|null}
 */
function prFromApi(sha) {
  if (PR_LOOKUP_CACHE.has(sha)) return PR_LOOKUP_CACHE.get(sha);
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
  let num = null;
  if (token) {
    try {
      const out = sh(`gh api "repos/${REPO}/commits/${sha}/pulls" --jq '.[0].number // empty'`);
      num = out ? String(out).trim() : null;
    } catch {
      num = null; // API 不可用（离线/权限）⇒ 不回退成「放行」，保持严格
    }
  }
  PR_LOOKUP_CACHE.set(sha, num);
  return num;
}

/** conventional type → CHANGELOG 行内前缀。未列出的 type 不上榜。 @type {Record<string, string>} */
const VISIBLE = { feat: '新增', fix: '修复', perf: '优化', refactor: '优化' };

// ---------- 1) 上个 tag 与范围内 commits ----------
const tags = sh("git tag --list 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname").split('\n').filter(Boolean);
const lastTag = tags[0] || null;
const range = lastTag ? `${lastTag}..HEAD` : 'HEAD';
const commits = sh(`git log --no-merges --format=%H%x1f%s%x1f%b%x1e ${range}`)
  .split('\x1e').map(s => s.trim()).filter(Boolean)
  .map(b => { const [hash, subject = '', body = ''] = b.split('\x1f'); return { hash, subject, body }; });

// ---------- 2) 分类与条目 ----------
const entries = [];
const noPrCommits = [];   // 可见类型但无 PR 引用(直推) —— 拒绝发版
let hasBreaking = false;
for (const c of commits) {
  const m = c.subject.match(/^([a-z]+)(\([^)]*\))?(!)?:\s*(.+)$/);
  if (!m) continue;
  const [, type, scopeRaw, bang, rest] = m;
  if (bang === '!' || /BREAKING CHANGE/i.test(c.body)) hasBreaking = true;
  const label = VISIBLE[type];
  if (!label) continue;
  // 先看主题文本（半角/全角都认）；没有就问 API（权威判据，见 prFromApi）。
  const pr = prRefOf(c.subject) ?? (needsPrLookup({ subject: c.subject, visible: true }) ? prFromApi(c.hash) : null);
  if (!pr) noPrCommits.push(c.subject);
  const short = c.hash.slice(0, 7);
  const desc = `${scopeRaw ? scopeRaw.slice(1, -1) + ': ' : ''}${stripPrRef(rest)}`;
  const refs = pr ? ` ([#${pr}](${URL('pull', pr)}), [${short}](${URL('commit', c.hash)}))` : '';
  entries.push(`- 【${label}】${desc}${refs}`);
}

if (entries.length === 0) { console.log('release: 无可见变更(feat/fix/perf/refactor), 跳过'); process.exit(0); }
if (noPrCommits.length) {
  console.error('release: 拒绝发版 —— 以下可见变更未经 PR(#N) 引用(直推):');
  noPrCommits.forEach(s => console.error('   - ' + s));
  console.error('   纪律: 一切可见变更必须走 PR; 直推代码永远进不了 Release。');
  process.exit(1);
}

// ---------- 3) 版本推进 ----------
/** @param {string} t 形如 `v1.2.3` @returns {number[]} [major, minor, patch] */
const parse = (t) => t.replace(/^v/, '').split('.').map(Number);
let [M, m, p] = lastTag ? parse(lastTag) : [0, 1, 0];
if (hasBreaking) { M++; m = 0; p = 0; }
else if (entries.some(e => e.includes('【新增】'))) { m++; p = 0; }
else p++;
const version = `${M}.${m}.${p}`;
const today = new Date().toISOString().slice(0, 10);
const section = `## [${version}](${URL('compare', `${lastTag || 'v0.0.0'}...v${version}`)}) - ${today}\n${entries.join('\n')}\n`;

// ---------- 4) CHANGELOG.md 前插 ----------
const cl = readFileSync('CHANGELOG.md', 'utf8');
const marker = '## [Unreleased]';
const next = cl.includes(marker)
  ? cl.replace(marker, `${marker}\n\n${section}`)
  : `# Changelog\n\n${marker}\n\n${section}\n`;
console.log(`release v${version} (${REPO}):`);
console.log(section);
// dry-run 必须**零写入**：它在本地与 test:guard 里都会被跑（黑盒回归「门在真仓库上能过」），
// 早先写入在 DRY 退出之前 ⇒ 每跑一次就改一次 CHANGELOG，还能被 `git add -A` 顺手提交。
if (DRY) { console.log('(dry-run, 不写 CHANGELOG、不提交不打 tag)'); process.exit(0); }
writeFileSync('CHANGELOG.md', next);

// ---------- 5) 提交 + tag + Release ----------
sh('git config user.name "github-actions[bot]"');
sh('git config user.email "41898282+github-actions[bot]@users.noreply.github.com"');
sh('git add CHANGELOG.md');
sh(`git commit -m "chore(release): v${version} [skip ci]"`);
sh(`git tag v${version}`);
sh('git push origin HEAD:main');
sh(`git push origin v${version}`);

writeFileSync('/tmp/release-notes.md', `# v${version}\n\n${section}`);
sh(`gh release create v${version} --repo ${REPO} --title "v${version}" --notes-file /tmp/release-notes.md`);
console.log(`✓ 已发布 GitHub Release v${version}`);
