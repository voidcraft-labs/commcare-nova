import { NextRequest, NextResponse } from 'next/server'
import { startGeneration } from '@/lib/generation-manager'

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { apiKey, conversation, appName } = body

  if (!apiKey || !conversation) {
    return NextResponse.json({ error: 'apiKey and conversation are required' }, { status: 400 })
  }

  const buildId = await startGeneration(apiKey, conversation, appName || 'CommCare App')

  return NextResponse.json({ buildId })
}
