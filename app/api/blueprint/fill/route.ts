import { NextRequest } from 'next/server'
import { fillBlueprint } from '@/lib/services/appGenerator'
import { scaffoldSchema } from '@/lib/schemas/blueprint'

export async function POST(req: NextRequest) {
  const { apiKey, scaffold: rawScaffold } = await req.json()

  if (!apiKey || !rawScaffold) {
    return Response.json({ error: 'apiKey and scaffold are required' }, { status: 400 })
  }

  const parsed = scaffoldSchema.safeParse(rawScaffold)
  if (!parsed.success) {
    return Response.json({ error: 'Invalid scaffold', details: parsed.error.issues }, { status: 400 })
  }

  const result = await fillBlueprint(apiKey, parsed.data)
  return Response.json(result)
}
