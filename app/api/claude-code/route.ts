import { execSync } from 'child_process'
import { streamClaudeCode } from '@/lib/services/claudeCodeStream'

export const maxDuration = 300

function isClaudeAvailable(): boolean {
  try {
    execSync('which claude', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export async function POST(req: Request) {
  if (!isClaudeAvailable()) {
    return new Response(JSON.stringify({ error: 'Claude Code CLI not found' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  if (typeof body !== 'object' || body === null) {
    return new Response(JSON.stringify({ error: 'Invalid request body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const { prompt, sessionId } = body as Record<string, unknown>

  if (typeof prompt !== 'string' || prompt.trim() === '') {
    return new Response(JSON.stringify({ error: 'prompt must be a non-empty string' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const abortController = new AbortController()
  req.signal.addEventListener('abort', () => abortController.abort())

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()

      const sendEvent = (type: string, data: unknown) => {
        const chunk = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
        controller.enqueue(encoder.encode(chunk))
      }

      try {
        const opts = {
          sessionId: typeof sessionId === 'string' ? sessionId : undefined,
          signal: abortController.signal,
        }

        for await (const event of streamClaudeCode(prompt, opts)) {
          if (
            event.type === 'init' ||
            event.type === 'text' ||
            event.type === 'tool_use' ||
            event.type === 'result' ||
            event.type === 'error'
          ) {
            sendEvent(event.type, event)
          }
        }
      } catch (err) {
        if (!abortController.signal.aborted) {
          const message = err instanceof Error ? err.message : 'Unknown error'
          sendEvent('error', { type: 'error', message })
        }
      } finally {
        controller.close()
      }
    },
    cancel() {
      abortController.abort()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}
