// channel-address.ts — Casdoor 用户 → 渠道地址（正典 §4.3）。
// 这是与旧实现的关键差异：旧代码把 Casdoor id 直接当企微 userid（会 81013）；
// 这里显式查 identity_link，映射不到就返回 null（调用方记 failed，不假装成功）。
import type { Pool } from 'pg'
import type { ChannelAddressResolver } from '@platform/sdk'

export function createChannelAddressResolver(deps: { pool: Pool }): ChannelAddressResolver {
  return {
    async resolve({ org, provider, casdoorName }) {
      if (provider === 'in_app') return casdoorName
      if (provider !== 'wecom_chat') return null

      const { rows } = await deps.pool.query<{ external_id: string }>(
        `select external_id from platform.identity_link
          where org = $1 and provider = 'wecom' and casdoor_name = $2 and status = 'active'
          order by id desc limit 1`,
        [org, casdoorName],
      )
      return rows[0]?.external_id ?? null
    },
  }
}
