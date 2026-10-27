// org-env.ts — org → per-org env 变量名（唯一实现）。
// 规则：非 [A-Za-z0-9] 一律替换成 '_'，再整体大写；**不折叠**连续下划线
// （a--b ≠ a-b，避免两个不同 org 撞同一个键）。非 ASCII 同样逐字符变 '_'。
export function orgEnvKeyFor(prefix: string, org: string): string {
  return `${prefix}__${org.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`
}
