import { NextResponse } from 'next/server'

interface AnthropicModel {
  id: string
  display_name: string
  created_at: string
}

export async function POST(req: Request) {
  try {
    const { apiKey } = await req.json() as { apiKey?: string }
    if (!apiKey) {
      return NextResponse.json({ models: [], error: 'No API key provided' })
    }

    const res = await fetch('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    })

    if (!res.ok) {
      const text = await res.text()
      return NextResponse.json({ models: [], error: `Anthropic API error: ${res.status} ${text}` })
    }

    const body = await res.json() as { data: AnthropicModel[] }
    const models = (body.data ?? [])
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .map(({ id, display_name, created_at }) => ({ id, display_name, created_at }))

    return NextResponse.json({ models })
  } catch (err) {
    return NextResponse.json({ models: [], error: err instanceof Error ? err.message : String(err) })
  }
}
