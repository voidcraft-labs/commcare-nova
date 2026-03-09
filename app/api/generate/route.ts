import { NextRequest } from 'next/server'
import { generateApp } from '@/lib/services/appGenerator'

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { apiKey, conversation, appName } = body

  if (!apiKey || !conversation) {
    return Response.json({ error: 'apiKey and conversation are required' }, { status: 400 })
  }

  const result = await generateApp(apiKey, conversation, appName || 'CommCare App')

  if (result.success) {
    return Response.json(result)
  } else {
    return Response.json(result, { status: 500 })
  }
}
