import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runChecks } from './checks'

// Task 8（B4/B5）CLI 层：scripts/check-manifests 的核心逻辑是 runChecks，
// 这里用临时 fixtures 目录直接测（文件存在性/全局唯一性/bindings 白名单都是仓库级检查，schema 管不到）。

// 注意 YAML 里 >= 开头的值必须加引号（> 在值首是块标量指示符）。
const validYaml = [
  'id: demo',
  'name: 演示模块',
  'version: 0.1.0',
  "platform: '>=0.1.0'",
  'permissions:',
  '  - code: demo:view',
  '    name: 查看',
  'frontend:',
  '  console:',
  '    - path: /demo',
  '      title: 演示',
  '      scope: demo:view',
  '      entry: console/index.js',
  'migrations:',
  '  dir: migrations',
  'bindings:',
  '  postgres: required',
].join('\n')

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'check-manifests-'))
  try {
    await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** 在 root 下相对路径写文本（自动建父目录）；path 以 / 结尾则视为建目录。 */
async function write(root: string, relPath: string, content = ''): Promise<void> {
  const abs = join(root, relPath)
  await mkdir(join(abs, '..'), { recursive: true })
  if (relPath.endsWith('/')) await mkdir(abs, { recursive: true })
  else await writeFile(abs, content, 'utf8')
}

describe('runChecks（check-manifests CLI 核心）', () => {
  it('无 modules 目录 → 0 错误（无模块即通过，exit 0 语义）', async () => {
    await withRoot(async root => {
      expect((await runChecks(root)).errors).toEqual([])
    })
  })

  it('modules/ 存在但子目录无 manifest.yaml（如只有 README）→ 跳过不报错', async () => {
    await withRoot(async root => {
      await write(root, 'modules/demo/README.md', '# demo')
      expect((await runChecks(root)).errors).toEqual([])
    })
  })

  it('合法 manifest（modules/ + scaffolds/customer/*/modules/ 双入口）→ 0 错误', async () => {
    await withRoot(async root => {
      await write(root, 'modules/demo/manifest.yaml', validYaml)
      await write(root, 'modules/demo/console/index.js')
      await write(root, 'modules/demo/migrations/')
      await write(
        root,
        'scaffolds/customer/acme/modules/report/manifest.yaml',
        validYaml.replaceAll('demo', 'report'),
      )
      await write(root, 'scaffolds/customer/acme/modules/report/console/index.js')
      await write(root, 'scaffolds/customer/acme/modules/report/migrations/')
      expect((await runChecks(root)).errors).toEqual([])
    })
  })

  it('schema 失败（id: Bad）→ 报相对路径与字段错误', async () => {
    await withRoot(async root => {
      await write(root, 'modules/demo/manifest.yaml', validYaml.replace('id: demo', 'id: Bad'))
      await write(root, 'modules/demo/console/index.js')
      await write(root, 'modules/demo/migrations/')
      const { errors } = await runChecks(root)
      expect(errors.length).toBeGreaterThan(0)
      expect(errors[0]).toContain('modules/demo/manifest.yaml')
      expect(errors[0]).toContain('id')
    })
  })

  it('YAML 语法错误 → 报解析失败', async () => {
    await withRoot(async root => {
      await write(root, 'modules/demo/manifest.yaml', 'permissions: [unclosed')
      const { errors } = await runChecks(root)
      expect(errors.length).toBe(1)
      expect(errors[0]).toContain('modules/demo/manifest.yaml')
    })
  })

  it('id 跨 modules/ 与 scaffolds/customer/ 重复 → 唯一性错误（B4）', async () => {
    await withRoot(async root => {
      await write(root, 'modules/demo/manifest.yaml', validYaml)
      await write(root, 'modules/demo/console/index.js')
      await write(root, 'modules/demo/migrations/')
      await write(root, 'scaffolds/customer/acme/modules/demo/manifest.yaml', validYaml)
      await write(root, 'scaffolds/customer/acme/modules/demo/console/index.js')
      await write(root, 'scaffolds/customer/acme/modules/demo/migrations/')
      const { errors } = await runChecks(root)
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain('"demo"')
      expect(errors[0]).toContain('scaffolds/customer/acme/modules/demo/manifest.yaml')
      expect(errors[0]).toContain('modules/demo/manifest.yaml')
    })
  })

  it('console.entry 指向的文件不存在 → 错误（相对 manifest 所在目录）', async () => {
    await withRoot(async root => {
      await write(root, 'modules/demo/manifest.yaml', validYaml)
      await write(root, 'modules/demo/migrations/')
      const { errors } = await runChecks(root)
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain('console/index.js')
    })
  })

  it('migrations.dir 目录不存在 → 错误', async () => {
    await withRoot(async root => {
      await write(root, 'modules/demo/manifest.yaml', validYaml)
      await write(root, 'modules/demo/console/index.js')
      const { errors } = await runChecks(root)
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain('migrations')
    })
  })

  it('bindings 键越界（非 postgres/novu/cube）→ 错误', async () => {
    await withRoot(async root => {
      await write(root, 'modules/demo/manifest.yaml', validYaml + '\n  redis: required')
      await write(root, 'modules/demo/console/index.js')
      await write(root, 'modules/demo/migrations/')
      const { errors } = await runChecks(root)
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain('redis')
    })
  })

  it('多错误并存时逐条列出（schema 失败的 manifest 不再跑后续仓库级检查）', async () => {
    await withRoot(async root => {
      await write(root, 'modules/a/manifest.yaml', validYaml) // a 缺 console/migrations 实体 → 2 错
      await write(root, 'modules/b/manifest.yaml', validYaml.replaceAll('demo', 'b')) // b 全缺 → 2 错
      const { errors } = await runChecks(root)
      expect(errors).toHaveLength(4)
    })
  })
})
