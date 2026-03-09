import { NextRequest, NextResponse } from 'next/server'
import { v4 as uuidv4 } from 'uuid'
import { expandBlueprint } from '@/lib/services/hqJsonExpander'
import { AutoFixer } from '@/lib/services/autoFixer'
import { CczCompiler } from '@/lib/services/cczCompiler'
import { appBlueprintSchema } from '@/lib/schemas/blueprint'
import { storeCczBuffer } from '@/lib/generation-manager'

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

    // Expand blueprint to HQ JSON
    const hqJson = expandBlueprint(parsed.data)

    // Auto-fix
    const autoFixer = new AutoFixer()
    const attachments = hqJson._attachments || {}
    const files: Record<string, string> = {}
    for (const [key, value] of Object.entries(attachments)) {
      files[key] = value as string
    }
    const { files: fixedFiles } = autoFixer.fix(files)
    for (const [key, value] of Object.entries(fixedFiles)) {
      hqJson._attachments[key] = value
    }

    // Compile to CCZ
    const compiler = new CczCompiler()
    const buffer = await compiler.compile(hqJson, parsed.data.app_name)

    // Store buffer for download
    const compileId = uuidv4()
    storeCczBuffer(compileId, buffer)

    return NextResponse.json({
      success: true,
      compileId,
      downloadUrl: `/api/compile/${compileId}/download`,
      appName: parsed.data.app_name,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Compilation failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
