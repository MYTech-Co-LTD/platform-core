// test-util/tenant.ts — 与真机形状对齐的 TenantRow 替身。
//
// **为什么放 `src/` 而不是 `*.test.ts` 里**（issue #68）：`apps/server/tsconfig.json` 是
// `include: ["src"]` + `exclude: ["src/**/*.test.ts"]`——只排测试文件，**本文件照样被 typecheck**。
// 于是下面那句 `: TenantRow` 注解**从注释变成了门禁**：`tenant.ts` 里 `TenantRow` 加列而这里
// 没跟上，CI 的 `pnpm typecheck` 就会红。
//
// 此前这个字面量躺在 `routes/admin.test.ts` 里，**注解本来就写对了**（`: TenantRow`），
// 但因为文件被 exclude，**注解再对也没人扫**——`wechat_oa_app_id/secret` 两列加进来后
// 它一直缺键，几轮评审都没发现（同一族纪律见 AGENTS.md #11）。
import type { TenantRow } from '../tenant'

/** 租户行替身：字段与 `TenantRow` **逐字段对齐**。 */
export const baseTenant: TenantRow = {
  id: 1, slug: 'my', casdoor_org: 'myorg', product_name: 'P', logo: null,
  primary_color: '#1677ff', background: '', login_methods: ['password'],
  wecom_corp_id: null, wecom_agent_id: null, wecom_secret: null, wecom_provider: null,
  wecom_auto_signup: false,
  // 售后 spec §1.3（005 迁移加的列）。**这两行是这个 fixture 存在的理由**：
  // 它们缺了整整几轮评审没人发现，正是因为旧位置（admin.test.ts）不被 typecheck。
  wechat_oa_app_id: null, wechat_oa_secret: null,
  created_at: new Date(),
}
