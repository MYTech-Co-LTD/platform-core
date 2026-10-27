/**
 * 租户管理员授权面的权限宇宙（2026-10-27）。
 *
 * `platformOnly` 码只由平台运营在 Casdoor 后台授予；租户管理员的权限页与授权端点都不该看到它。
 * 过滤点收在这里，app.ts 与测试共用同一份实现。
 */
export interface PermissionSpec {
  code: string
  name: string
  platformOnly?: boolean
}

export function tenantGrantable(
  perms: readonly PermissionSpec[],
): Array<{ code: string; name: string }> {
  return perms.filter((p) => !p.platformOnly).map(({ code, name }) => ({ code, name }))
}

export function platformOnlyCodes(perms: readonly PermissionSpec[]): Set<string> {
  return new Set(perms.filter((p) => p.platformOnly).map((p) => p.code))
}
