// pages/admin/Storage.tsx — 存储配置（M3c，正典「租户级配置注入」）
//
// 依据：spec §3/§4（管理组的范围收敛）+ Subscriptions.tsx/Users.tsx 的页面范式
// （Card + antd Form/Table + App.useApp().message + loading 态）；**零新增前端依赖**。
//
// 页面要如实呈现**三态**（服务端的兜底语义是 fail-explicit，UI 不能把它揉成一句「未配置」）：
//   · 未配 + 有平台默认  → 附件走平台桶（正常态，不必报警）
//   · 未配 + 平台也没默认 → 附件功能不可用（503）
//   · 部分填写            → 按 fail-explicit **不予使用**（绝不回落平台桶——回落 = 数据位置误述）
//
// 安全纪律（与 lib/api.ts 同源）：**AK/SK 永不回显**。表单里这两项初始为空，
// 留空 = 保持原值（服务端语义），故「不改凭据」不需要用户重贴密钥。
import { useCallback, useEffect, useState } from 'react'
import { Alert, App, Button, Card, Form, Input, Popconfirm, Space, Tag, Typography } from 'antd'
import {
  ApiError,
  clearAdminStorage,
  getAdminStorage,
  saveAdminStorage,
  testAdminStorage,
  type AdminStorage,
  type AdminStorageInput,
} from '../../lib/api'

/** 失败文案：**必须带上 reason**（服务端只回分类 + endpoint host）。
 *  「操作失败」四个字对排障毫无价值——用户拿着它没有任何下一步可做。 */
function failureText(prefix: string, e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'STORAGE_PROBE_FAILED') {
      return `${prefix}：连接失败（${e.reason ?? '未知原因'}${e.detail ? `，${e.detail}` : ''}）`
    }
    return `${prefix}：${e.code}`
  }
  return `${prefix}：操作失败`
}

/** 顶部状态告示（三态 + 已配态）。优先级：partial > 未配（平台默认有无）> 已配。 */
function StatusNotice({ storage }: { storage: AdminStorage }) {
  if (storage.partial) {
    return (
      <Alert
        type="warning"
        showIcon
        message="配置不完整 ⇒ 附件不可用"
        description="库里只有半套配置时平台不会回落到平台默认存储（写错桶比写不进去更难发现）。请补齐后保存。"
      />
    )
  }
  if (!storage.configured) {
    return storage.platformFallback ? (
      <Typography.Text type="secondary">未配置：本租户附件使用平台默认存储。</Typography.Text>
    ) : (
      <Alert
        type="warning"
        showIcon
        message="未配置且平台无默认 ⇒ 附件功能不可用（503）"
        description="请填写本租户自己的对象存储配置。"
      />
    )
  }
  return (
    <Space>
      <Tag color="green">已配置</Tag>
      <Typography.Text type="secondary">本租户附件写入你自己的桶。</Typography.Text>
    </Space>
  )
}

export default function AdminStoragePage() {
  const { message } = App.useApp()
  const [storage, setStorage] = useState<AdminStorage | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [form] = Form.useForm<AdminStorageInput>()

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const s = await getAdminStorage()
      setStorage(s)
      // 回填**不含** AK/SK：凭据服务端不回显（字段都不存在），前端也就无法回填 ⇒ 留空即「保持原值」
      form.setFieldsValue({
        endpoint: s.endpoint, region: s.region, bucket: s.bucket,
        accessKeyId: '', secretAccessKey: '',
      })
    } catch (e) {
      message.error(failureText('加载失败', e))
    } finally {
      setLoading(false)
    }
  }, [form, message])

  useEffect(() => { void reload() }, [reload])

  const values = () => form.getFieldsValue() as AdminStorageInput

  const onSave = async () => {
    setBusy(true)
    try {
      await saveAdminStorage(values())
      // 顺序照 Users.tsx 的实测回归：先刷新表（状态/掩码要跟着变），再做 UI 反馈
      void reload()
      message.success('已保存（保存前已通过连通性探测）')
    } catch (e) {
      message.error(failureText('保存失败', e))
    } finally {
      setBusy(false)
    }
  }

  const onTest = async () => {
    setBusy(true)
    try {
      await testAdminStorage(values())
      message.success('连接正常')
    } catch (e) {
      message.error(failureText('测试连接失败', e))
    } finally {
      setBusy(false)
    }
  }

  const onClear = async () => {
    setBusy(true)
    try {
      await clearAdminStorage()
      void reload()
      message.success('已清除：活回落平台默认存储')
    } catch (e) {
      message.error(failureText('清除失败', e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title="存储配置" loading={loading}>
      {/* antd v6：`direction` 已废弃 ⇒ `orientation`（照控制台其余页面同一口径，别引新弃用告警） */}
      <Space orientation="vertical" size="middle" style={{ display: 'flex' }}>
        {storage && <StatusNotice storage={storage} />}

        <Form<AdminStorageInput> form={form} layout="vertical" disabled={busy} onFinish={onSave}>
          <Form.Item label="Endpoint" name="endpoint" rules={[{ required: true, message: '请填写 Endpoint' }]}>
            <Input placeholder="https://zos.example.com（不写协议默认补 https://）" autoComplete="off" />
          </Form.Item>
          <Form.Item label="Region" name="region" rules={[{ required: true, message: '请填写 Region' }]}>
            <Input placeholder="xinan1" autoComplete="off" />
          </Form.Item>
          <Form.Item label="Bucket" name="bucket" rules={[{ required: true, message: '请填写 Bucket' }]}>
            <Input placeholder="my-bucket" autoComplete="off" />
          </Form.Item>
          <Form.Item label="AccessKeyId" name="accessKeyId">
            <Input
              placeholder={storage?.accessKeyIdMasked || 'AccessKeyId'}
              autoComplete="off"
            />
          </Form.Item>
          <Form.Item label="SecretAccessKey" name="secretAccessKey">
            {/* 密码型输入：本地也不该被肩窥；placeholder 明说「留空 = 不改」，免得用户以为必须重贴 */}
            <Input.Password placeholder="留空表示不修改" autoComplete="new-password" />
          </Form.Item>
        </Form>

        <Space>
          <Button type="primary" loading={busy} onClick={() => form.submit()}>保存</Button>
          <Button loading={busy} onClick={onTest}>测试连接</Button>
          <Popconfirm
            title="清除存储配置？"
            description="清除后本租户附件回落平台默认存储；已写入你自己桶的存量附件不受影响。"
            onConfirm={onClear}
            okText="清除"
            cancelText="取消"
          >
            <Button danger loading={busy}>清除配置</Button>
          </Popconfirm>
        </Space>

        {/* 运维必须看到的三句（每条都对应一个真实的失败形态） */}
        <ul style={{ color: 'rgba(0, 0, 0, 0.45)', margin: 0, paddingInlineStart: 20 }}>
          <li>保存时会做一次连通性探测，探测不通过不会写入（预签名是本地计算，请求路径上发现不了配置坏）。</li>
          <li>未配置 = 使用平台默认存储；配置后<strong>新</strong>附件写入你的桶（存量附件仍按其写入时的桶读取）。</li>
          <li>生效窗口：single 部署下最长 60 秒（租户行有 60s 进程内缓存）。</li>
        </ul>
      </Space>
    </Card>
  )
}
