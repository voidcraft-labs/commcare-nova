import { NextRequest } from 'next/server'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { createChatToolServer } from '@/lib/services/chatTools'
import { SYSTEM_PROMPT } from '@/lib/prompts/system'
import * as sessions from '@/lib/services/session'

export const runtime = 'nodejs'
export const maxDuration = 300

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { apiKey, message, sessionId, isResume } = body

  if (!apiKey || !message || !sessionId) {
    return Response.json(
      { error: 'apiKey, message, and sessionId are required' },
      { status: 400 }
    )
  }

  const encoder = new TextEncoder()
  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()
  let closed = false

  function sendEvent(event: Record<string, unknown>) {
    if (closed) return
    writer.write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
  }

  const waitForClient = (event: Record<string, unknown>): Promise<unknown> => {
    sendEvent(event)
    return new Promise((resolve) => {
      sessions.setPending(sessionId, resolve)
    })
  }

  const chatServer = createChatToolServer(waitForClient)

  ;(async () => {
    try {
      const queryOptions: Record<string, unknown> = {
        env: { ...process.env, ANTHROPIC_API_KEY: apiKey },
        systemPrompt: SYSTEM_PROMPT,
        model: 'claude-sonnet-4-5-20250929',
        mcpServers: { commcare: chatServer },
        allowedTools: ['mcp__commcare__generate_app'],
        includePartialMessages: true,
        maxTurns: 10,
        canUseTool: async (
          toolName: string,
          input: Record<string, unknown>,
        ) => {
          if (toolName === 'AskUserQuestion') {
            const response = await waitForClient({
              type: 'questions',
              data: input,
            }) as Record<string, unknown>
            return {
              behavior: 'allow',
              updatedInput: { ...input, answers: response.answers, freeText: response.freeText },
            }
          }
          return { behavior: 'deny', message: 'Tool not available' }
        },
      }

      if (isResume) {
        queryOptions.resume = sessionId
      } else {
        queryOptions.sessionId = sessionId
      }

      for await (const msg of query({
        prompt: message,
        options: queryOptions as any,
      })) {
        const msgType = (msg as any).type

        if (msgType === 'stream_event') {
          const event = (msg as any).event
          if (
            event?.type === 'content_block_delta' &&
            event?.delta?.type === 'text_delta'
          ) {
            sendEvent({ type: 'text_delta', content: event.delta.text })
          } else if (
            event?.type === 'content_block_start' &&
            event?.content_block?.type === 'tool_use'
          ) {
            // Tool call starting — tell client to show thinking indicator
            sendEvent({ type: 'processing' })
          }
        } else if (msgType === 'result') {
          if ((msg as any).subtype === 'error') {
            sendEvent({
              type: 'error',
              message: (msg as any).error || 'Agent error',
            })
          }
        }
      }
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : 'Chat failed'
      sendEvent({ type: 'error', message: errMessage })
    } finally {
      sendEvent({ type: 'done' })
      closed = true
      sessions.removePending(sessionId)
      writer.close()
    }
  })()

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}
