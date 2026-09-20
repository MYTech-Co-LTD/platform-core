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

/**
 * 深色底判断（走查修正）：hex 色（#rgb/#rrggbb）按 BT.601 加权亮度 < 0.5 视为深底，
 * 品牌栏切浅色文字；非 hex 值（色名/渐变等）保守按浅底处理。
 */
function isDarkColor(css: string): boolean {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(css.trim())
  if (!m) return false
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1]
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  return 0.299 * r + 0.587 * g + 0.114 * b < 0.5
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

  // background 语义收窄（改版 spec）：有值且非 'default' 才作为左栏底色；默认走 CSS 渐变；
  // 深色底时加 brandDark 类切浅色文字（可读性兜底，走查修正）
  const customBg =
    branding.background && branding.background !== 'default' ? branding.background : undefined
  const brandBg = customBg ? { background: customBg } : undefined
  const brandDark = customBg !== undefined && isDarkColor(customBg)

  return (
    <ConfigProvider theme={{ token: { colorPrimary: branding.primaryColor } }}>
      {ready ? (
        <div className={s.page}>
          <aside
            className={brandDark ? `${s.brand} ${s.brandDark}` : s.brand}
            style={brandBg}
            data-testid="brand-panel"
          >
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
                  <span key={opacity} style={{ background: branding.primaryColor, opacity }} />
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
