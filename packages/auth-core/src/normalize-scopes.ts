export function normalizeScopes(claims: { scopes?: string[]; permissions?: Array<{ resources?: string[] }> }): string[] {
  const set = new Set<string>()
  for (const s of claims.scopes ?? []) if (s) set.add(s)
  for (const p of claims.permissions ?? []) for (const r of p.resources ?? []) if (r) set.add(r)
  return [...set].sort()
}
