import { NextRequest } from 'next/server'
import { fillBlueprint } from '@/lib/services/appGenerator'

export async function POST(req: NextRequest) {
  const { apiKey, conversation, appName } = await req.json()

  if (!apiKey || !conversation) {
    return Response.json({ error: 'apiKey and conversation are required' }, { status: 400 })
  }

  const result = await fillBlueprint(apiKey, conversation, appName || 'CommCare App')
  return Response.json(result)
}
