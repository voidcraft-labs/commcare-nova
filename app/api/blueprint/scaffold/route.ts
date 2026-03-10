import { NextRequest } from 'next/server'
import { scaffoldBlueprint } from '@/lib/services/appGenerator'
import type { ScaffoldStreamEvent } from '@/lib/types'

export async function POST(req: NextRequest) {
  const { apiKey, appName, appSpecification } = await req.json()

  if (!apiKey || !appSpecification) {
    return Response.json({ error: 'apiKey and appSpecification are required' }, { status: 400 })
  }

  const encoder = new TextEncoder()
  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()

  const emit = (event: ScaffoldStreamEvent) => {
    writer.write(encoder.encode(JSON.stringify(event) + '\n'))
  }

  // Run generation in the background — don't await before returning the response
  ;(async () => {
    try {
      await scaffoldBlueprint(apiKey, appSpecification, appName || 'CommCare App', emit)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await writer.write(encoder.encode(JSON.stringify({ type: 'error', message }) + '\n'))
    }
    await writer.close()
  })()

  return new Response(readable, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  })
}
