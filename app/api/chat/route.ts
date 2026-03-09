import { NextRequest } from 'next/server'
import { streamMessage } from '@/lib/services/claude'
import { SYSTEM_PROMPT } from '@/lib/prompts/system'

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { apiKey, messages } = body

  if (!apiKey || !messages) {
    return new Response(JSON.stringify({ error: 'apiKey and messages are required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      try {
        await streamMessage(
          apiKey,
          SYSTEM_PROMPT,
          messages,
          (chunk) => {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: chunk })}\n\n`))
          }
        )
        controller.enqueue(encoder.encode(`data: [DONE]\n\n`))
        controller.close()
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Chat failed'
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: message })}\n\n`))
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store',
    },
  })
}
