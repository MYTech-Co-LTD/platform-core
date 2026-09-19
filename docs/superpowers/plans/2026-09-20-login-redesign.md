# 登录页改版（参考 Casdoor 浅色分栏）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `/login` 从「纯色背景 + 居中白卡」改成「浅色分栏（左品牌区 + 右表单）」，移动端折叠单列，品牌字段继续生效，行为零变化。

**Architecture:** 纯前端两文件——`Login.tsx` 只重写 render（全部逻辑不动），新增项目首个 CSS module `Login.module.css` 承载布局/纹理/断点。`branding.background` 语义从「整页背景」收窄为「左栏底色」（有值且 ≠`'default'` 才消费）。spec：`docs/superpowers/specs/2026-09-20-login-redesign-design.md`。

**Tech Stack:** React 19 + antd v6 + Vite CSS Modules（`vite/client` 类型已配）+ vitest 3（happy-dom）。

## Global Constraints

- 分支：`feat/web-login-redesign`（已建，spec 已提交）。提交格式 `type(scope): subject`；feat 关联 issue 走 PR body `Closes #N`，squash 合并。
- **逻辑零改动**：`nextTarget()` 防开放重定向、`queryError()`、branding 拉取与兜底、Tabs 白名单兜底、企微 postMessage origin 校验、错误码文案——逐字保留。
- 固定文案逐字：大标语 `安全、可信赖的` / `多租户管理平台`；副标语 `模块化控制台 · 租户隔离 · 订阅管理`；右栏标题 `欢迎登录`、副题 `登录 {productName} 管理控制台`。
- 移动断点：`@media (max-width: 767px)`；桌面左栏 `flex: 0 0 55%`，右栏表单区 `max-width: 360px`。
- 不改 `api.ts` 类型、服务端路由、`ConfigProvider` primaryColor 机制。
- 既有 16 个用例（①–⑤c）必须零改动跑绿；只新增 1 个用例 ⑥。

---

### Task 1: 分栏布局实现 + background 消费测试

**Files:**
- Modify: `apps/web/src/pages/Login.test.tsx`（追加用例 ⑥）
- Create: `apps/web/src/pages/Login.module.css`
- Modify: `apps/web/src/pages/Login.tsx`（重写 render，逻辑不动）

**Interfaces:**
- Consumes: `lib/api.ts` 的 `Branding`（形状不变）、antd v6 组件、`@ant-design/icons` 的 `UserOutlined`/`LockOutlined`。
- Produces: `data-testid="brand-panel"` 元素（用例 ⑥ 的锚点）；`Login.module.css` 类名 `page/brand/brandHeader/brandLogo/brandName/brandBody/headline/tagline/accentLine/dots/brandFooter/formCol/formInner/loading`（Task 2 验收按此走查）。

- [ ] **Step 1: 写失败测试（用例 ⑥）**

在 `Login.test.tsx` 的 `describe('LoginPage（运行时品牌）', ...)` 内、用例 ⑤c 之后追加（编号顺延；fixture 复用 `BRANDING_DUAL` + `jsonResponse`，模式与现有用例一致）：

```tsx
  it('⑥ 品牌栏底色：background 非 default 时作为左栏底色消费', async () => {
    mockApi({
      '/api/platform/branding': () => jsonResponse({ ...BRANDING_DUAL, background: '#123456' }),
    })

    render(<LoginPage />)

    expect(await screen.findByTestId('brand-panel')).toHaveStyle({ background: '#123456' })
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @platform/web test -- src/pages/Login.test.tsx`
Expected: FAIL——用例 ⑥ `Unable to find element with [data-testid="brand-panel"]`（其余 16 个仍绿）。

- [ ] **Step 3: 新增 `apps/web/src/pages/Login.module.css`（完整内容）**

```css
/* Login.module.css —— 登录页分栏布局（spec: docs/superpowers/specs/2026-09-20-login-redesign-design.md）
 * 左栏品牌区：浅渐变 + 细网格纹理（纯 CSS，无图片资产）；右栏白底表单。
 * <768px 折叠单列：品牌区缩为顶部横幅，副标语/装饰线/圆点/版权隐藏。 */

.page {
  min-height: 100vh;
  display: flex;
}

/* ---- 左栏：品牌区 ---- */
.brand {
  flex: 0 0 55%;
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  box-sizing: border-box;
  padding: 48px 56px;
  overflow: hidden;
  /* 默认浅渐变底；branding.background 有值且非 'default' 时被内联 style 覆盖为平色 */
  background: linear-gradient(180deg, #f7f9fc 0%, #eef2f8 100%);
  border-right: 1px solid #e5eaf2;
}

/* 细网格纹理：两条 1px 渐变线 32px 平铺（独立伪元素，不被内联底色覆盖） */
.brand::before {
  content: '';
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(rgba(27, 42, 65, 0.04) 1px, transparent 1px),
    linear-gradient(90deg, rgba(27, 42, 65, 0.04) 1px, transparent 1px);
  background-size: 32px 32px;
  pointer-events: none;
}

.brandHeader {
  display: flex;
  align-items: center;
  gap: 12px;
}

.brandLogo {
  height: 36px;
  display: block;
}

.brandName {
  font-size: 18px;
  font-weight: 600;
  color: #1b2a41;
}

.brandBody {
  margin: auto 0;
  max-width: 480px;
}

.headline {
  margin: 0 0 16px;
  font-size: 40px;
  line-height: 1.3;
  font-weight: 700;
  letter-spacing: 0.5px;
  color: #1b2a41;
}

.tagline {
  margin: 0 0 32px;
  font-size: 16px;
  color: #66758c;
}

.accentLine {
  width: 48px;
  height: 4px;
  border-radius: 2px;
}

.dots {
  display: flex;
  gap: 8px;
  margin-top: 16px;
}

.dots span {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.brandFooter {
  font-size: 13px;
  color: #9aa7b8;
}

/* ---- 右栏：表单区 ---- */
.formCol {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  padding: 48px 24px;
  background: #fff;
}

.formInner {
  width: 100%;
  max-width: 360px;
}

/* ---- 加载态（branding 未就绪时的整页 Spin） ---- */
.loading {
  min-height: 100vh;
  display: grid;
  place-items: center;
  background: #f7f9fc;
}

/* ---- 移动端折叠 ---- */
@media (max-width: 767px) {
  .page {
    flex-direction: column;
  }

  .brand {
    flex: none;
    padding: 24px;
    border-right: 0;
    border-bottom: 1px solid #e5eaf2;
  }

  .brandBody {
    margin: 8px 0 4px;
  }

  .headline {
    margin-bottom: 8px;
    font-size: 24px;
  }

  .headline br {
    display: none;
  }

  .tagline,
  .accentLine,
  .dots,
  .brandFooter {
    display: none;
  }

  .formCol {
    padding: 32px 20px;
  }
}
```

- [ ] **Step 4: 重写 `Login.tsx`（完整新内容）**

整文件替换为下述内容——头部注释更新视觉契约口径；`METHOD_LABELS`/`nextTarget`/`queryError` 与两个子组件的行为逻辑逐字保留，仅 render 与输入框皮肤变化：

```tsx
// pages/Login.tsx —— /login：浅色分栏登录页（运行时品牌 + 双登录方式）
//
// 品牌契约（Task 12）：挂载即 GET /api/platform/branding，失败回退 DEFAULT_BRANDING——
// 登录页必须永远可渲染；primaryColor 经 ConfigProvider token 注入全页。
// 视觉契约（2026-09-20 改版 spec）：左栏品牌区（浅渐变+网格纹理：logo/产品名/大标语/
//   副标语/品牌色装饰/版权），右栏白底表单；branding.background 有值且 ≠'default' 时作为
//   **左栏底色**（语义自「整页背景」收窄），默认走 CSS 浅渐变；<768px 折叠单列。
// 企微契约（Task 14）：qr 取 iframe 地址；callback 在 iframe 内 postMessage
//   {type:'sso-done'}（父页跳 next||/console）或 {type:'sso-fail',error}（Alert 对应文案）；
//   302 /login?error=<CODE> 是非 iframe 浏览器兜底——挂载时解析 search 显示同一套文案。
import { useEffect, useState } from 'react'
import { LockOutlined, UserOutlined } from '@ant-design/icons'
import { Alert, Button, ConfigProvider, Form, Input, Spin, Tabs, Typography } from 'antd'
import type { TabsProps } from 'antd'
import {
  ApiError,
  DEFAULT_BRANDING,
  errorText,
  getBranding,
  getWecomQr,
  login,
  type Branding,
} from '../lib/api'
import s from './Login.module.css'

/** 已知登录方式 → Tab 标签（服务端可能回传未知值，页面按白名单过滤） */
const METHOD_LABELS: Record<'password' | 'wecom-qr', string> = {
  password: '账号密码登录',
  'wecom-qr': '企业微信扫码',
}

/**
 * 登录成功统一跳转目标：?next= 参数优先，缺省 /console。
 * 防开放重定向（评审 fix-3）：next 仅当是本站绝对路径（以 / 开头且非协议相对 //）才采用，
 * https://evil、//evil、相对路径一律回落 /console。
 */
function nextTarget(): string {
  const next = new URLSearchParams(window.location.search).get('next')
  return next !== null && next.startsWith('/') && !next.startsWith('//') ? next : '/console'
}

/** 挂载时的 ?error=（企微 302 浏览器兜底路）；空串/null 归 null */
function queryError(): string | null {
  const code = new URLSearchParams(window.location.search).get('error')
  return code && code.trim() ? code : null
}

export default function LoginPage() {
  const [branding, setBranding] = useState<Branding>(DEFAULT_BRANDING)
  const [ready, setReady] = useState(false)
  const [errorCode, setErrorCode] = useState<string | null>(queryError())

  // 挂载即取品牌；失败留默认（登录页永远可渲染）。卸载后不再回写 state。
  useEffect(() => {
    let alive = true
    getBranding()
      .then((b) => alive && setBranding(b))
      .catch(() => {
        /* 取不到品牌 → 默认品牌兜底 */
      })
      .finally(() => alive && setReady(true))
    return () => {
      alive = false
    }
  }, [])

  // 文档标题跟随租户产品名
  useEffect(() => {
    document.title = branding.productName
  }, [branding.productName])

  // 白名单过滤已知方法；空集兜底单账密（评审 fix-4：租户配置错也不留零 Tab 白页）
  const known = (Object.keys(METHOD_LABELS) as Array<keyof typeof METHOD_LABELS>).filter((m) =>
    branding.loginMethods.includes(m),
  )
  const methods = known.length > 0 ? known : (['password'] as Array<keyof typeof METHOD_LABELS>)

  const items: TabsProps['items'] = methods.map((m) => ({
    key: m,
    label: METHOD_LABELS[m],
    children:
      m === 'password' ? (
        <PasswordForm onFail={setErrorCode} />
      ) : (
        <WecomQrTab onError={setErrorCode} />
      ),
  }))

  // background 语义收窄（改版 spec）：有值且非 'default' 才作为左栏底色；默认走 CSS 渐变
  const brandBg =
    branding.background && branding.background !== 'default'
      ? { background: branding.background }
      : undefined

  return (
    <ConfigProvider theme={{ token: { colorPrimary: branding.primaryColor } }}>
      {ready ? (
        <div className={s.page}>
          <aside className={s.brand} style={brandBg} data-testid="brand-panel">
            <div className={s.brandHeader}>
              {branding.logo ? (
                <img src={branding.logo} alt={branding.productName} className={s.brandLogo} />
              ) : null}
              <span className={s.brandName}>{branding.productName}</span>
            </div>
            <div className={s.brandBody}>
              <h1 className={s.headline}>
                安全、可信赖的
                <br />
                <span style={{ color: branding.primaryColor }}>多租户管理平台</span>
              </h1>
              <p className={s.tagline}>模块化控制台 · 租户隔离 · 订阅管理</p>
              <div className={s.accentLine} style={{ background: branding.primaryColor }} />
              <div className={s.dots}>
                {[0.9, 0.55, 0.3].map((opacity) => (
                  <span
                    key={opacity}
                    style={{ background: branding.primaryColor, opacity }}
                  />
                ))}
              </div>
            </div>
            <div className={s.brandFooter}>
              © {new Date().getFullYear()} {branding.productName}
            </div>
          </aside>
          <main className={s.formCol}>
            <div className={s.formInner}>
              <Typography.Title level={3} style={{ marginBottom: 4 }}>
                欢迎登录
              </Typography.Title>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 24 }}>
                登录 {branding.productName} 管理控制台
              </Typography.Paragraph>
              {errorCode ? (
                <Alert
                  type="error"
                  showIcon
                  title={errorText(errorCode)}
                  closable
                  onClose={() => setErrorCode(null)}
                  style={{ marginBottom: 16 }}
                />
              ) : null}
              <Tabs items={items} />
            </div>
          </main>
        </div>
      ) : (
        <div className={s.loading}>
          <Spin size="large" />
        </div>
      )}
    </ConfigProvider>
  )
}

/** 账密 Tab：提交 → login()；成功跳 next||/console，失败 Alert 错误文案并留在本页 */
function PasswordForm({ onFail }: { onFail: (code: string) => void }) {
  const [submitting, setSubmitting] = useState(false)

  const onFinish = async (values: { username: string; password: string }) => {
    setSubmitting(true)
    try {
      await login(values.username, values.password)
      window.location.href = nextTarget()
    } catch (e) {
      onFail(e instanceof ApiError ? e.code : 'UNKNOWN')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Form layout="vertical" onFinish={onFinish}>
      <Form.Item name="username" label="用户名" rules={[{ required: true, message: '请输入用户名' }]}>
        <Input autoComplete="username" placeholder="用户名" prefix={<UserOutlined />} size="large" />
      </Form.Item>
      <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
        <Input.Password
          autoComplete="current-password"
          placeholder="密码"
          prefix={<LockOutlined />}
          size="large"
        />
      </Form.Item>
      <Button type="primary" htmlType="submit" block size="large" loading={submitting}>
        登录
      </Button>
    </Form>
  )
}

/**
 * 企微扫码 Tab：挂载取 qr 地址渲染 iframe；同时注册 window message 监听
 * （callback 在 iframe 内 postMessage sso-done/sso-fail——Task 14 契约），卸载移除。
 */
function WecomQrTab({ onError }: { onError: (code: string) => void }) {
  const [qrUrl, setQrUrl] = useState<string | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)

  useEffect(() => {
    let alive = true
    getWecomQr()
      .then((url) => {
        if (alive) setQrUrl(url)
      })
      .catch(() => {
        if (alive) setLoadFailed(true)
      })

    const onMessage = (e: MessageEvent) => {
      // origin 校验（评审 fix-2）：合法消息恒同源——callback 由 publicOrigin 同源服务，
      // 异源页面伪造的 sso-done/sso-fail 一律忽略
      if (e.origin !== window.location.origin) return
      const data = e.data as { type?: unknown; error?: unknown } | null
      if (typeof data !== 'object' || data === null) return
      if (data.type === 'sso-done') {
        window.location.href = nextTarget()
      } else if (data.type === 'sso-fail') {
        onError(typeof data.error === 'string' ? data.error : 'WECOM_UNAVAILABLE')
      }
    }
    window.addEventListener('message', onMessage)
    return () => {
      alive = false
      window.removeEventListener('message', onMessage)
    }
  }, [onError])

  if (loadFailed) {
    return <Alert type="warning" showIcon title="二维码加载失败，请刷新重试" />
  }
  if (qrUrl === null) {
    return (
      <div style={{ padding: 48, textAlign: 'center' }}>
        <Spin />
      </div>
    )
  }
  return (
    <iframe
      src={qrUrl}
      title="企业微信扫码登录"
      style={{ width: '100%', height: 360, border: 0, display: 'block', borderRadius: 8 }}
    />
  )
}
```

注意两处易错点：
1. `findByText('ACME 工单平台')`/`findByText('Platform')` 依赖 productName **恰好一处**精确匹配——它只出现在左栏 `brandName` span；副题/版权是更长文本不会误匹配，不要把 productName 再单独渲染成第三个精确文本节点。
2. 删除 `Card` import（render 不再用）；`Typography` 保留。

- [ ] **Step 5: 跑 Login 全部用例确认绿**

Run: `pnpm --filter @platform/web test -- src/pages/Login.test.tsx`
Expected: PASS，17 个用例（原 16 + 新 ⑥）全绿。若 ①–⑤c 有红：对照「逻辑零改动」清单排查 render 是否误伤（最常见：productName 多处精确匹配、按钮文案改动）。

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/Login.tsx apps/web/src/pages/Login.module.css apps/web/src/pages/Login.test.tsx
git commit -m "feat(web): 登录页改版浅色分栏——品牌栏背景消费与移动端折叠"
```

---

### Task 2: 浏览器视觉验收（CDP 走查）

**Files:**
- 无新增；如走查发现视觉缺陷，就地修 `Login.module.css` / `Login.tsx` render 并重跑 Task 1 的测试。

**Interfaces:**
- Consumes: Task 1 的类名与 `data-testid="brand-panel"`；dev-stack（`scripts/dev-stack.mjs`，MockCasdoor 内建，demo 凭证 `admin1`/`pw`）。
- Produces: 无代码产出（除非修正）；验收记录进 PR body。

- [ ] **Step 1: 构建并起本地栈**

前置：本地 PG 可连（`docker compose -f deploy/docker-compose.yml up -d postgres`）。

```bash
pnpm --filter @platform/web build
pnpm dev:stack   # → http://127.0.0.1:13100（长驻，验收完 Ctrl-C）
```

- [ ] **Step 2: CDP 走查桌面态（默认品牌）**

用 web-access skill 打开 `http://127.0.0.1:13100/login`，截图核对：
- 左右分栏比例 ~55/45，左栏浅渐变 + 网格纹理 + 右侧 1px 分隔线；
- 左上 logo 位（无 logo 时仅产品名）、垂直居中大标语（「多租户管理平台」为品牌色）、副标语、装饰线 + 三个圆点、左下版权；
- 右栏「欢迎登录」+ 副题、输入框带前置图标 40px 高、整宽「登录」按钮。

- [ ] **Step 3: 走查交互与移动端**

- 错误路：输入 `admin1` + 错密码 → 错误 Alert「用户名或密码错误」，页面不跳转；
- 成功路：`admin1`/`pw` → 跳 `/console`（若 console 需要额外 scope 报 403 属预期，登录跳转本身即验收点）；再带 `?next=/console` 验证参数路；
- 企微 Tab：切换后 iframe 出现且 src 为 `login.work.weixin.qq.com`（demo corp，iframe 内部内容不作要求）；
- 移动端：375px 视口（CDP 截图带 `width=375` 的窗口或 Emulation）折叠单列：顶部横幅（logo+产品名+单行标语），无副标语/装饰线/版权。

- [ ] **Step 4: 自定义品牌色/底色消费验证**

本机 PG 直改当前解析租户（走查 Step 2 里 branding 返回的 productName 对应行）：

```bash
docker compose -f deploy/docker-compose.yml exec postgres \
  psql -U platform -d platform -c \
  "UPDATE platform.tenant SET primary_color='#7c3aed', background='#123456' WHERE product_name='<走查到的产品名>';"
```

刷新 `/login` 核对：按钮/标语着色/装饰线变紫、左栏底色变 `#123456`（网格纹理仍在）。验完还原：

```bash
docker compose -f deploy/docker-compose.yml exec postgres \
  psql -U platform -d platform -c \
  "UPDATE platform.tenant SET primary_color='#1890ff', background='default' WHERE product_name='<走查到的产品名>';"
```

（seed.ts 只导出函数无 CLI 入口，别拿它当还原手段；UPDATE 是唯一还原路。）

- [ ] **Step 5: 有修正则重跑测试并 commit**

若走查引发修正：

```bash
pnpm --filter @platform/web test -- src/pages/Login.test.tsx   # 必须仍 17 绿
git add -A apps/web/src/pages/
git commit -m "fix(web): 登录页走查修正——<具体点>"
```

无修正则跳过。

---

### Task 3: 全量门禁 + issue + PR

**Files:**
- 无代码改动（流程任务）。

**Interfaces:**
- Consumes: Task 1/2 的提交（分支 `feat/web-login-redesign` 上已有 spec commit + 实现 commit）。
- Produces: GitHub issue + PR（squash 合并后 CI 自动部署）。

- [ ] **Step 1: 全量门禁（与 CI 同款）**

```bash
pnpm test            # 各包 vitest + 仓根守卫单测
pnpm typecheck       # 递归 tsc --noEmit + scripts
pnpm exec tsx scripts/check-manifests.mjs
pnpm exec tsx scripts/lint-architecture.mjs
pnpm exec tsx scripts/check-compose.mjs
pnpm exec tsx scripts/check-env-example.mjs
pnpm exec tsx scripts/check-tenant-isolation.mjs
pnpm --filter @platform/web build   # Task 2 已 build 过，幂等重跑兜底
```

Expected: 全绿。红了先修再继续（不许 continue-on-error）。

- [ ] **Step 2: 建 issue（feat 必须先有 issue）**

```bash
gh issue create --repo MYTech-Co-LTD/platform-core \
  --title "登录页改版：参考 Casdoor 浅色分栏风格" \
  --body "现状 /login 是纯色背景+居中白卡，视觉单薄。目标：浅色分栏（左品牌区+右表单），移动端折叠，品牌字段继续生效，行为零变化。设计：docs/superpowers/specs/2026-09-20-login-redesign-design.md"
```

- [ ] **Step 3: push + 建 PR**

```bash
git push -u origin feat/web-login-redesign
gh pr create --repo MYTech-Co-LTD/platform-core --base main \
  --title "feat(web): 登录页改版——参考 Casdoor 浅色分栏风格" \
  --body "Closes #<Step 2 的 issue 号>

## 改了什么
- /login 重写为浅色分栏：左栏品牌区（logo/产品名/大标语/副标语/品牌色装饰/版权，浅渐变+网格纹理），右栏白底表单（欢迎登录+副题+Tabs）；<768px 折叠单列。
- branding.background 语义收窄为「左栏底色」（有值且 ≠'default' 时消费），接口形状不动；新增用例 ⑥ 守护。
- 行为零变化：登录/企微/错误处理/防开放重定向逐字保留；既有 16 用例零改动跑绿。

## 验收
- [x] 单测 17 绿（pnpm --filter @platform/web test）
- [x] 浏览器走查：默认品牌/自定义色/错误路/成功跳转/企微 Tab/375px 折叠（截图见会话）
- [x] 全量门禁：pnpm test / typecheck / 5 守卫脚本 / web build

spec: docs/superpowers/specs/2026-09-20-login-redesign-design.md
plan: docs/superpowers/plans/2026-09-20-login-redesign.md"
```

- [ ] **Step 4: PR CI 绿后请人合并（squash）**

合并即自动部署（merge main = 门禁全绿自动部署）；部署后按 deploy-verify 规矩线上再打开 `/login` 验一眼新行为在线上可观测。
