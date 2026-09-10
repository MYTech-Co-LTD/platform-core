// pages/Login.tsx —— /login：运行时品牌 + 双登录方式（账密 / 企微扫码）
//
// 品牌契约（Task 12）：挂载即 GET /api/platform/branding，失败回退 DEFAULT_BRANDING——
// 登录页必须永远可渲染；primaryColor 经 ConfigProvider token 注入全页。
// 企微契约（Task 14）：qr 取 iframe 地址；callback 在 iframe 内 postMessage
//   {type:'sso-done'}（父页跳 next||/console）或 {type:'sso-fail',error}（Alert 对应文案）；
//   302 /login?error=<CODE> 是非 iframe 浏览器兜底——挂载时解析 search 显示同一套文案。
import { useEffect, useState } from 'react'
import { Alert, Button, Card, ConfigProvider, Form, Input, Spin, Tabs, Typography } from 'antd'
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

/** 已知登录方式 → Tab 标签（服务端可能回传未知值，页面按白名单过滤） */
const METHOD_LABELS: Record<'password' | 'wecom-qr', string> = {
  password: '账号密码登录',
  'wecom-qr': '企业微信扫码',
}

/** 登录成功统一跳转目标：?next= 参数优先，缺省 /console */
function nextTarget(): string {
  return new URLSearchParams(window.location.search).get('next') || '/console'
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

  const methods = (Object.keys(METHOD_LABELS) as Array<keyof typeof METHOD_LABELS>).filter((m) =>
    branding.loginMethods.includes(m),
  )

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

  return (
    <ConfigProvider theme={{ token: { colorPrimary: branding.primaryColor } }}>
      <div
        style={{
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          background: branding.background || '#f5f5f5',
        }}
      >
        {ready ? (
          <Card style={{ width: 380 }}>
            {branding.logo ? (
              <img src={branding.logo} alt={branding.productName} style={{ height: 40 }} />
            ) : null}
            <Typography.Title level={3} style={{ marginTop: 12 }}>
              {branding.productName}
            </Typography.Title>
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
          </Card>
        ) : (
          <Spin size="large" />
        )}
      </div>
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
        <Input autoComplete="username" placeholder="用户名" />
      </Form.Item>
      <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
        <Input.Password autoComplete="current-password" placeholder="密码" />
      </Form.Item>
      <Button type="primary" htmlType="submit" block loading={submitting}>
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
