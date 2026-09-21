// routes/chat.ts — POST /chat：通道 A。SSE：activity 事件（工具调用过程）+ final 事件（答案）+ error 事件。
// LLM 编排在**平台后端**（spec §2 已拍板）：key 在服务端 env 不落浏览器；审计集中；权限单点强制。
import { z } from 'zod'
import type { ModuleHono, RouteCtx } from './context'
import { requesterOf } from './context'
import { llmFromEnv, LlmError, openAiCompatModel } from '../domain/llm'
import { runAgentLoop } from '../domain/agent-loop'

const ChatBody = z.object({ question: z.string().min(1).max(2000) })

export function registerChat(r: ModuleHono, ctx: RouteCtx): void {
  r.post('/chat', async (c) => {
    const cfg = llmFromEnv()
    // 没配 LLM ⇒ 可解释的 503（不是 500）：部署没开通道 A 是配置状态，不是故障
    if (!cfg) return c.json({ error: 'LLM_UNCONFIGURED' }, 503)
    const parsed = ChatBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)

    const requester = requesterOf(c)
    // M3 守卫（空 orgId / 缺身份）⇒ fail-closed 拒在编排之前（口径同 POST /keys；
    // runAgentLoop 的签名收非空 Requester——这里不拦，typecheck 都过不了）
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)

    const deps = { pool: ctx.pool, org: c.get('tenant').casdoor_org, execute: ctx.execute }
    const model = openAiCompatModel(cfg)
    const encoder = new TextEncoder()

    const stream = new ReadableStream({
      async start(controller) {
        const send = (ev: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`))
        try {
          for await (const ev of runAgentLoop(deps, requester, model, parsed.data.question)) send(ev)
        } catch (err) {
          // 流已经开了头 ⇒ 状态码发不出去了，失败只能用事件表达。
          // detail **只**取 LlmError 的自身文案（形如 LLM_HTTP_502），别把 unknown error 的 message
          // 透出去——fetch 的异常 message 里可能带 URL，其它异常可能带响应体回显。
          send({
            type: 'error', reason: 'AGENT_FAILED',
            detail: err instanceof LlmError ? err.message : undefined,
          })
        } finally {
          controller.close()
        }
      },
    })

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        // edge/nginx 默认会缓冲响应 ⇒ SSE 被攒成一坨、前端一个字都收不到。显式关掉。
        'x-accel-buffering': 'no',
      },
    })
  })
}
