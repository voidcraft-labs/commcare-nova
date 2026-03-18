import { NextResponse } from 'next/server'
import { modelsRequestSchema } from '@/lib/schemas/apiSchemas'
import { ApiError, handleApiError } from '@/lib/apiError'

interface AnthropicModel {
  id: string
  display_name: string
  created_at: string
}

/** Extract broad model family: "claude-opus-4-6-20250514" → "claude-opus", "claude-haiku-4-5-20251001" → "claude-haiku" */
function getModelFamily(id: string): string {
  const match = id.match(/^(claude-[a-z]+)/)
  return match?.[1] ?? id
}

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const parsed = modelsRequestSchema.safeParse(body)
    if (!parsed.success) {
      throw new ApiError('No API key provided', 400)
    }
    const { apiKey } = parsed.data

    const res = await fetch('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    })

    if (!res.ok) {
      const text = await res.text()
      // Map Anthropic status to an appropriate gateway error code
      const status = res.status === 401 ? 401 : 502
      throw new ApiError(`Anthropic API error: ${res.status} ${text}`, status)
    }

    const responseBody = await res.json() as { data: AnthropicModel[] }
    const allModels = (responseBody.data ?? [])
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

    // Keep only the latest version per model family
    const seen = new Set<string>()
    const models = allModels
      .filter(m => {
        const family = getModelFamily(m.id)
        if (seen.has(family)) return false
        seen.add(family)
        return true
      })
      .map(({ id, display_name, created_at }) => ({ id, display_name, created_at }))

    return NextResponse.json({ models })
  } catch (err) {
    return handleApiError(err instanceof Error ? err : new Error(String(err)))
  }
}
