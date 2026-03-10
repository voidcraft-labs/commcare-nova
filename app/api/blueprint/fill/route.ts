import { NextRequest } from 'next/server'
import { fillBlueprint } from '@/lib/services/appGenerator'
import { scaffoldSchema } from '@/lib/schemas/blueprint'
import type { FillStreamEvent } from '@/lib/types'

export async function POST(req: NextRequest) {
  const { apiKey, scaffold: rawScaffold } = await req.json()

  if (!apiKey || !rawScaffold) {
    return Response.json({ error: 'apiKey and scaffold are required' }, { status: 400 })
  }

  const parsed = scaffoldSchema.safeParse(rawScaffold)
  if (!parsed.success) {
    return Response.json({ error: 'Invalid scaffold', details: parsed.error.issues }, { status: 400 })
  }

  const encoder = new TextEncoder()
  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()

  const emit = (event: FillStreamEvent) => {
    writer.write(encoder.encode(JSON.stringify(event) + '\n'))
  }

  // Run generation in the background — don't await before returning the response
  ;(async () => {
    try {
      await fillBlueprint(apiKey, parsed.data, emit)
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
