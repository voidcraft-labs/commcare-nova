import { NextRequest } from 'next/server'
import * as sessions from '@/lib/services/session'

export async function POST(req: NextRequest) {
  const { sessionId, data } = await req.json()

  if (!sessionId) {
    return Response.json({ error: 'sessionId is required' }, { status: 400 })
  }

  const resolved = sessions.respond(sessionId, data)
  if (!resolved) {
    return Response.json({ error: 'No pending request for this session' }, { status: 404 })
  }

  return Response.json({ ok: true })
}
