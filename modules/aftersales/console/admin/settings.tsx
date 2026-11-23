// console/admin/settings.tsx — 售后设置（管理组子页，2026-11-23）
//
// 为什么在「管理」组而不是售后业务菜单：这是**渠道凭据配置**（公众号 AppID/Secret），
// 属平台管理动作（console-ui-conventions「平台管理 → 管理组」）。manifest 声明 frontend.admin
// ⇒ 宿主三重过滤（registry ∩ 模块启用 ∩ scope）保证：**售后模块不启用时本页自动隐藏**，
// 直达 URL 也被 config 门挡住。
//
// 服务端语义（apps/server/src/routes/admin.ts `/integrations/wechat-oa`）：
//   · secret 永不回显——只回 `secretConfigured` 布尔；留空 = 保持原值（轮换不必重贴）；
//   · 从未配过且本次也留空 ⇒ SECRET_REQUIRED（fail-explicit：半套配置 = 访客登录一定失败）。
// 写操作要 CSRF：现取 /session 的 csrfToken（会话重签会轮换，不缓存）。
import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Card, Form, Input, Space, Spin, Typography, message } from 'antd'
import { platformFetch } from '@platform/sdk/web'

const API = '/api/platform/admin/integrations/wechat-oa'

interface WechatOaState {
  appId: string
  configured: boolean
  partial: boolean
  secretConfigured: boolean
}

/** 写操作：现取 csrfToken 再带 x-csrf-token（与宿主 csrfWrite 同一契约，模块侧不 import 宿主包） */
async function csrfPut<T>(path: string, body: unknown): Promise<T> {
  const sres = await platformFetch('/api/platform/session')
  if (!sres.ok) throw new Error('SESSION_UNAVAILABLE')
  const session = (await sres.json()) as { csrfToken?: string }
  const res = await platformFetch(path, {
    method: 'PUT',
    headers: { 'x-csrf-token': session.csrfToken ?? '', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const e = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(e?.error ?? `HTTP_${res.status}`)
  }
  return (await res.json()) as T
}

export default function AftersalesSettingsPage() {
  // 提示一律走**页面内 Alert**（错误需要有下一步可读，见 ConsolePage 约定）+ 静态 message
  // （成功提示）——不用 App.useApp：本仓既有页面同惯例，且它要求 <App> 上下文（测试/独立
  // 渲染下会变成 `message.error is not a function`，CI 实际抓红过）。
  const [state, setState] = useState<WechatOaState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [form] = Form.useForm<{ appId: string, secret: string }>()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await platformFetch(API)
      if (!res.ok) throw new Error(`HTTP_${res.status}`)
      const data = (await res.json()) as WechatOaState
      setState(data)
      form.setFieldsValue({ appId: data.appId, secret: '' })
    } catch (e) {
      setError(e instanceof Error ? `加载失败：${e.message}` : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [form])

  useEffect(() => { void load() }, [load])

  const save = async () => {
    // 校验失败时 antd 抛 errorFields（不是 Error）——不接住就是未处理的 promise rejection
    // （CI unit 实际抓红过）。错误已展示在表单上，直接返回、不发请求。
    let v: { appId: string, secret: string }
    try {
      v = await form.validateFields()
    } catch {
      return
    }
    setSaving(true)
    setError(null)
    try {
      await csrfPut<{ ok: true }>(API, { appId: v.appId, secret: v.secret || undefined })
      message.success('已保存')
      await load()
    } catch (e) {
      const code = e instanceof Error ? e.message : 'UNKNOWN'
      setError(code === 'SECRET_REQUIRED'
        ? '首次配置必须填写 AppSecret'
        : code === 'APP_ID_REQUIRED' ? 'AppID 不能为空' : `保存失败：${code}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card
      extra={<Button type="primary" loading={saving} onClick={() => void save()}>保存</Button>}
    >
      {loading ? <Spin /> : (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {error !== null && <Alert type="error" showIcon message={error} />}
          {state?.partial && (
            <Alert type="warning" showIcon message="配置不完整 ⇒ 访客登录不可用"
              description="AppID 与 AppSecret 必须成对。请补齐后保存。" />
          )}
          {state !== null && !state.configured && !state.partial && (
            <Alert type="info" showIcon message="未配置：售后移动端访客登录不可用"
              description="填写公众号 AppID / AppSecret 后，访客才能从公众号内打开 /app/aftersales。" />
          )}
          <Form form={form} layout="vertical" style={{ maxWidth: 520 }}>
            <Form.Item name="appId" label="AppID" rules={[{ required: true, message: '请填写公众号 AppID' }]}>
              <Input placeholder="wx1234567890abcdef" autoComplete="off" />
            </Form.Item>
            <Form.Item name="secret" label="AppSecret"
              rules={state?.secretConfigured ? [] : [{ required: true, message: '首次配置必须填写 AppSecret' }]}
              extra={state?.secretConfigured ? '已配置；留空表示不修改' : '首次配置必填'}>
              <Input.Password placeholder={state?.secretConfigured ? '••••••••（留空不修改）' : '公众号后台 → 基本配置 → AppSecret'}
                autoComplete="new-password" />
            </Form.Item>
          </Form>
          <Typography.Text type="secondary">
            还需客户在微信公众号后台配置「网页授权域名」= 本实例域名；此处只存平台侧凭据。
          </Typography.Text>
        </Space>
      )}
    </Card>
  )
}
