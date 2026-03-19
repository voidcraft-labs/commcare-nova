import { readFile, unlink } from 'fs/promises'
import { join } from 'path'

const BLUEPRINT_PATH = join(process.cwd(), '.nova', 'blueprint.json')

export async function GET() {
  try {
    const raw = await readFile(BLUEPRINT_PATH, 'utf-8')
    const blueprint = JSON.parse(raw)

    // Clean up after reading
    await unlink(BLUEPRINT_PATH).catch(() => {})

    return Response.json({ blueprint })
  } catch {
    return Response.json({ blueprint: null }, { status: 404 })
  }
}
