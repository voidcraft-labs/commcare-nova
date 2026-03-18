import { NextRequest, NextResponse } from 'next/server'
import { expandBlueprint } from '@/lib/services/hqJsonExpander'
import { appBlueprintSchema } from '@/lib/schemas/blueprint'
import { ApiError, handleApiError } from '@/lib/apiError'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { blueprint } = body

    if (!blueprint) {
      throw new ApiError('blueprint is required', 400)
    }

    const parsed = appBlueprintSchema.safeParse(blueprint)
    if (!parsed.success) {
      throw new ApiError(
        'Invalid blueprint',
        400,
        parsed.error.issues.map((e: { path: PropertyKey[]; message: string }) => `${e.path.join('.')}: ${e.message}`),
      )
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
    return handleApiError(err instanceof Error ? err : new Error('JSON export failed'))
  }
}
