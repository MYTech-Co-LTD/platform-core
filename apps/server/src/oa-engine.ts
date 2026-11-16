// oa-engine.ts — 租户 → OA 引擎（case-engine）映射的读写（issue #2363，OA P0 Task 5）。
//
// 语义（计划 Task 5 / design spec）：
//   · **无行 = 该租户 OA 关闭**（fail-closed）；`enabled=false` 与无行同义，对调用方都返回 null。
//   · `pat_secret_ref` 只存**引用键名**，不存值——真正的 PAT 在部署面的 secret/env 里，
//     由用到它的调用方（引擎 client，P1 Task 10）按该键名取值。本层绝不读、绝不记值。
//   · 平台是唯一登记点：引擎地址不散落在各模块 env 里（多租户下一租户一引擎）。
import type { Pool } from 'pg'

export interface OaEngineConfig {
  org: string
  baseUrl: string
  /** secret 引用键名（不是值）。 */
  patSecretRef: string
  engineVersion: string | null
  enabled: boolean
}

export interface OaEngineStore {
  /** 该租户的引擎配置；无行或 enabled=false ⇒ null（= OA 对该租户关闭）。 */
  get(org: string): Promise<OaEngineConfig | null>
  upsert(c: OaEngineConfig): Promise<void>
}

export function createOaEngineStore(pool: Pool): OaEngineStore {
  return {
    async get(org: string): Promise<OaEngineConfig | null> {
      // enabled 过滤放在 SQL 里：调用方拿到 null 就是「这条路对该租户不存在」，
      // 不需要在每处调用点重复判 enabled（漏判 = 静默给关闭的租户放行）。
      const { rows } = await pool.query(
        `select org, base_url, pat_secret_ref, engine_version, enabled
           from platform.oa_engine where org = $1 and enabled`,
        [org],
      )
      const r = rows[0]
      if (!r) return null
      return {
        org: r.org,
        baseUrl: r.base_url,
        patSecretRef: r.pat_secret_ref,
        engineVersion: r.engine_version,
        enabled: r.enabled,
      }
    },

    async upsert(c: OaEngineConfig): Promise<void> {
      await pool.query(
        `insert into platform.oa_engine (org, base_url, pat_secret_ref, engine_version, enabled, updated_at)
         values ($1,$2,$3,$4,$5,now())
         on conflict (org) do update set base_url = excluded.base_url,
           pat_secret_ref = excluded.pat_secret_ref,
           engine_version = excluded.engine_version,
           enabled = excluded.enabled,
           updated_at = now()`,
        [c.org, c.baseUrl, c.patSecretRef, c.engineVersion, c.enabled],
      )
    },
  }
}
