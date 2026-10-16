// console/FillForm.tsx — 填报页（issue #718）：head 版本契约 → RJSF 渲染 → 提交。
//
// 渲染链路：head 契约（存储态，零值）→ 注入字典 options 的**渲染副本**（值同源 /options，
// 与服务端提交校验同一数据源）→ @rjsf/antd 渲染（draft-07 原生校验器，与服务端 ajv 同源——
// ADR-0005 §12.1 方言定案）。提交以**服务端五道闸为权威**：客户端预校验失败只做体验提示，
// 服务端拒绝（机检错误码）原样呈现。
// formContext v6 坑（§12.8）以设计绕开：选项走副本注入，不依赖 formContext。
import { useEffect, useMemo, useState } from 'react'
import { Alert, Card, Descriptions, Spin, Typography } from 'antd'
// @rjsf/antd v6 的默认导出即 Form 组件（forwardRef；PoC smoke 的 antdTheme.Form ?? antdTheme
// 两个形态在此归一为本形态）。validator-ajv8 = draft-07 原生，与服务端 ajv 同源（§12.1）。
import AntdForm from '@rjsf/antd'
import validator from '@rjsf/validator-ajv8'
import { apiGet, apiSend, injectDictEnums, loadOptions, schemaDictRefs } from './api'
import type { OptionItem, VersionInfo } from './api'

interface HeadInfo {
  version: number
  body: unknown
}

export default function FillForm({ assetId }: { assetId: string | undefined }) {
  const [head, setHead] = useState<HeadInfo | null>(null)
  const [options, setOptions] = useState<Map<string, OptionItem[]>>(new Map())
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState<{ id: string; version: number } | null>(null)

  useEffect(() => {
    let cancelled = false
    setDone(null)
    setError(null)
    setHead(null)
    setLoading(true)
    if (!assetId) {
      setLoading(false)
      return
    }
    ;(async () => {
      try {
        const detail = await apiGet<{ head: number | null; versions: VersionInfo[] }>(
          `/api/modules/forms/defs/${encodeURIComponent(assetId)}`,
        )
        if (detail.head === null) {
          if (!cancelled) setError('该表单还没有发布版本，暂不能填报')
          return
        }
        const headBody = detail.versions.find((v) => v.version === detail.head)?.body ?? null
        if (headBody === null) {
          if (!cancelled) setError('发布版本契约缺失')
          return
        }
        const refs = schemaDictRefs(headBody)
        const opts = refs.length > 0 ? await loadOptions(refs) : new Map()
        if (!cancelled) {
          setHead({ version: detail.head, body: headBody })
          setOptions(opts)
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [assetId])

  const rendered = useMemo(
    () => (head === null ? null : injectDictEnums(head.body as object, options)),
    [head, options],
  )

  const onSubmit = async ({ formData }: { formData?: unknown }) => {
    if (!assetId) return
    setSubmitting(true)
    setError(null)
    try {
      const result = await apiSend<{ id: string; version: number }>(
        'POST',
        `/api/modules/forms/defs/${encodeURIComponent(assetId)}/submissions`,
        { payload: formData },
      )
      setDone(result)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  if (!assetId) return <Typography.Text type="secondary">从「表单」页选择一个要填报的表单</Typography.Text>
  if (loading) return <Spin />
  if (error !== null && head === null) return <Alert type="warning" showIcon message={error} />

  return (
    <Card title={`填报：${assetId}${head ? `（v${head.version}）` : ''}`} style={{ maxWidth: 720 }}>
      {error !== null && (
        <Alert type="error" showIcon style={{ marginBottom: 16 }} message="提交被拒" description={error} />
      )}
      {done !== null && (
        <Alert
          type="success"
          showIcon
          style={{ marginBottom: 16 }}
          message={`已提交（记录 #${done.id}，按 v${done.version} 契约收执）`}
        />
      )}
      {rendered !== null && (
        <AntdForm
          schema={rendered.schema}
          uiSchema={rendered.uiSchema}
          validator={validator}
          onSubmit={onSubmit}
          disabled={submitting}
        >
          <button type="submit" disabled={submitting}>
            {submitting ? '提交中…' : '提交'}
          </button>
        </AntdForm>
      )}
      <Descriptions size="small" column={1} style={{ marginTop: 16 }}>
        <Descriptions.Item label="口径">服务端按提交钉住的版本契约校验（历史提交按当时版本）</Descriptions.Item>
      </Descriptions>
    </Card>
  )
}
