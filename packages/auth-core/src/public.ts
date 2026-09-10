export { normalizeScopes } from './normalize-scopes'
export { CasdoorClient } from './casdoor-client'
export type { CasdoorClientOptions, CasdoorUser, CasdoorPermission } from './casdoor-client'
// MockCasdoor 故意不进 public 导出：它只属于 src/test-util/，测试与冒烟脚本从包内路径引入
