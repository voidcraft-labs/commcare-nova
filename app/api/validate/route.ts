import { NextRequest, NextResponse } from 'next/server'
import { validateBlueprint } from '@/lib/services/hqJsonExpander'
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
        valid: false,
        errors: parsed.error.issues.map((e: { path: PropertyKey[]; message: string }) => `${e.path.join('.')}: ${e.message}`)
      })
    }

    const errors = validateBlueprint(parsed.data)
    return NextResponse.json({ valid: errors.length === 0, errors })
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }
}
