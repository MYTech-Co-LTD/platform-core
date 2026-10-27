// org-env.test.ts — org → env 变量名（唯一实现）
import { it, expect } from 'vitest'
import { orgEnvKeyFor } from './org-env'

it('大写下划线化，不折叠连续下划线', () => {
  expect(orgEnvKeyFor('WECOM_BRIDGE_URL', 'mytech')).toBe('WECOM_BRIDGE_URL__MYTECH')
  expect(orgEnvKeyFor('X', 'a-b')).toBe('X__A_B')
  expect(orgEnvKeyFor('X', 'a--b')).toBe('X__A__B')
  expect(orgEnvKeyFor('X', 'a.b_c')).toBe('X__A_B_C')
})
