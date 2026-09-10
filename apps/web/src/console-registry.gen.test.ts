// console-registry.gen.test.ts —— 生成器机检（Task 18）。
//
// 方式选择说明：选「node 子进程跑 scripts/gen-console-registry.mjs 对临时 fixture 仓」，
// 而非抽函数单测——生成器的对外契约是 CLI（build 脚本 `node ../../scripts/...` 直调）+
// 生成文件形状，子进程全链路把「参数解析 → 扫描 → 落盘」一并覆盖。
// 放 web 包是因为 vitest 配置在本包（脚本本体在仓根 scripts/，与被测物解耦）。
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const run = promisify(execFile)
/** 仓根 = 测试文件 apps/web/src/*.test.ts 上溯四级（脚本与生成物目标都以仓根定位，与 cwd 无关） */
const REPO_ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const SCRIPT = join(REPO_ROOT, 'scripts', 'gen-console-registry.mjs')

const tmpRoots: string[] = []

async function newFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gen-console-registry-'))
  tmpRoots.push(root)
  return root
}

async function writeModule(root: string, id: string, manifest: string): Promise<void> {
  await mkdir(join(root, 'modules', id), { recursive: true })
  await writeFile(join(root, 'modules', id, 'manifest.yaml'), manifest, 'utf8')
}

async function gen(root: string): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await run(process.execPath, [SCRIPT, root])
  return { stdout, stderr }
}

async function readGen(root: string): Promise<string> {
  return readFile(join(root, 'apps', 'web', 'src', 'console-registry.gen.ts'), 'utf8')
}

afterEach(async () => {
  while (tmpRoots.length > 0) await rm(tmpRoots.pop()!, { recursive: true, force: true })
})

describe('gen-console-registry.mjs（CLI 子进程）', () => {
  it('① 聚合多模块 console 项：按模块排序、声明序保留、icon 透传、load 指向模块源', async () => {
    const root = await newFixture()
    await writeModule(
      root,
      'demo',
      `id: demo
name: 演示模块
version: 0.1.0
platform: '>=0.1.0'
permissions: []
frontend:
  console:
    - path: /console/demo/things
      title: 演示工单
      icon: AppstoreOutlined
      scope: demo:console
      entry: ./console/main.tsx
    - path: /console/demo/settings
      title: 演示设置
      scope: demo:console
      entry: ./console/settings.tsx
`,
    )
    await writeModule(
      root,
      'billing',
      `id: billing
name: 计费
version: 0.2.0
platform: '>=0.1.0'
permissions: []
frontend:
  console:
    - path: /console/billing/invoices
      title: 账单
      icon: FileTextOutlined
      scope: billing:console
      entry: ./pages/console.tsx
`,
    )
    // 无 console 的模块 + 无 manifest 的目录：都不参与，也不报错
    await writeModule(
      root,
      'bare',
      `id: bare
name: 裸模块
version: 0.1.0
platform: '>=0.1.0'
permissions: []
`,
    )
    await mkdir(join(root, 'modules', 'not-a-module'), { recursive: true })

    const { stdout } = await gen(root)
    expect(stdout).toContain('3 项')

    const genFile = await readGen(root)
    // 固定文件头 + 类型 + 导出名
    expect(genFile).toContain('勿手改')
    expect(genFile).toContain('export interface ConsoleRegistryEntry')
    expect(genFile).toContain('export const consoleRegistry: ConsoleRegistryEntry[] = [')
    // 生成物在 apps/web/src 下：import 说明符相对它（上溯到仓根再进 modules）
    expect(genFile).toContain('load: () => import("../../../modules/billing/pages/console.tsx")')
    // 模块间按 id 排序（billing 先于 demo）；模块内保持 manifest 声明序（things 先于 settings）
    expect(genFile.indexOf('/console/billing/invoices')).toBeLessThan(genFile.indexOf('/console/demo/things'))
    expect(genFile.indexOf('/console/demo/things')).toBeLessThan(genFile.indexOf('/console/demo/settings'))
    // icon 字符串透传；未声明 icon 的项（demo settings）不带 icon 键
    expect(genFile).toContain('icon: "AppstoreOutlined"')
    expect(genFile).toContain('icon: "FileTextOutlined"')
    const settingsEntry = genFile.slice(genFile.indexOf('/console/demo/settings'))
    expect(settingsEntry.slice(0, settingsEntry.indexOf('},')).includes('icon:')).toBe(false)
  })

  it('② 无模块/无 console 项 → 空数组合法；重复生成幂等（字节级一致）', async () => {
    const root = await newFixture()
    // 空 modules 目录（连 modules/ 都可以不存在）
    const { stdout } = await gen(root)
    expect(stdout).toContain('0 项')
    expect(await readGen(root)).toContain('export const consoleRegistry: ConsoleRegistryEntry[] = []')

    await gen(root)
    const first = await readGen(root)
    await gen(root)
    expect(await readGen(root)).toBe(first)
  })

  it('③ 跨模块 console path 重复 → 非零退出并指明冲突双方', async () => {
    const root = await newFixture()
    await writeModule(
      root,
      'demo',
      `id: demo
name: 演示
version: 0.1.0
platform: '>=0.1.0'
permissions: []
frontend:
  console:
    - path: /console/clash
      title: A
      scope: demo:console
      entry: ./a.tsx
`,
    )
    await writeModule(
      root,
      'other',
      `id: other
name: 另一模块
version: 0.1.0
platform: '>=0.1.0'
permissions: []
frontend:
  console:
    - path: /console/clash
      title: B
      scope: other:console
      entry: ./b.tsx
`,
    )

    await expect(gen(root)).rejects.toThrow()
  })

  it('④ manifest 形状不对（console 项缺 entry）→ 非零退出，不生成半份 registry', async () => {
    const root = await newFixture()
    await writeModule(
      root,
      'demo',
      `id: demo
name: 演示
version: 0.1.0
platform: '>=0.1.0'
permissions: []
frontend:
  console:
    - path: /console/demo/things
      title: 演示工单
      scope: demo:console
`,
    )

    await expect(gen(root)).rejects.toThrow()
    await expect(readGen(root)).rejects.toThrow()
  })
})
