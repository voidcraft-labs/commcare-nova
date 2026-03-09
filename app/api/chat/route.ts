import { NextRequest } from 'next/server'
import { sendStructured } from '@/lib/services/claude'
import { ChatResponseSchema } from '@/lib/schemas/chat'
import { SYSTEM_PROMPT } from '@/lib/prompts/system'

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { apiKey, messages } = body

  if (!apiKey || !messages) {
    return Response.json({ error: 'apiKey and messages are required' }, { status: 400 })
  }

  try {
    const result = await sendStructured(apiKey, SYSTEM_PROMPT, messages, ChatResponseSchema)
    return Response.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Chat failed'
    return Response.json({ error: message }, { status: 500 })
  }
}
