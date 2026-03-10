import { promises as fs } from 'fs'
import path from 'path'

const CCZ_DIR = path.join(process.cwd(), '.data', 'ccz')

export async function saveCcz(id: string, buffer: Buffer): Promise<void> {
  await fs.mkdir(CCZ_DIR, { recursive: true })
  await fs.writeFile(path.join(CCZ_DIR, `${id}.ccz`), buffer)
}

export async function getCcz(id: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(path.join(CCZ_DIR, `${id}.ccz`))
  } catch {
    return null
  }
}
