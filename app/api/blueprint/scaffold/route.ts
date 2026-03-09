import { NextRequest } from 'next/server'
import { scaffoldBlueprint } from '@/lib/services/appGenerator'

export async function POST(req: NextRequest) {
  const { apiKey, appName, appSpecification } = await req.json()

  if (!apiKey || !appSpecification) {
    return Response.json({ error: 'apiKey and appSpecification are required' }, { status: 400 })
  }

  const result = await scaffoldBlueprint(apiKey, appSpecification, appName || 'CommCare App')
  return Response.json(result)  // { success, scaffold?, errors?, usage? }
}
