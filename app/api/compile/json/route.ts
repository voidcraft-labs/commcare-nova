import { NextRequest, NextResponse } from 'next/server'
import { expandBlueprint } from '@/lib/services/hqJsonExpander'
import { appBlueprintSchema } from '@/lib/schemas/blueprint'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { blueprint } = body

    if (!blueprint) {
      return NextResponse.json({ error: 'blueprint is required' }, { status: 400 })
    }

    const parsed = appBlueprintSchema.safeParse(blueprint)
    if (!parsed.success) {
      return NextResponse.json({
        error: 'Invalid blueprint',
        details: parsed.error.issues.map((e: { path: PropertyKey[]; message: string }) => `${e.path.join('.')}: ${e.message}`)
      }, { status: 400 })
    }

    const hqJson = expandBlueprint(parsed.data)
    const jsonStr = JSON.stringify(hqJson, null, 2)

    return new NextResponse(jsonStr, {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="${parsed.data.app_name || 'app'}.json"`,
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'JSON export failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
