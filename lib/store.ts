import { promises as fs } from 'fs'
import path from 'path'
import type { Build } from './types'

const DATA_DIR = path.join(process.cwd(), '.data', 'builds')

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true })
}

export async function saveBuild(build: Build): Promise<void> {
  await ensureDir()
  await fs.writeFile(
    path.join(DATA_DIR, `${build.id}.json`),
    JSON.stringify(build, null, 2)
  )
}

export async function getBuild(id: string): Promise<Build | null> {
  try {
    const data = await fs.readFile(path.join(DATA_DIR, `${id}.json`), 'utf-8')
    return JSON.parse(data)
  } catch {
    return null
  }
}

export async function listBuilds(): Promise<Build[]> {
  await ensureDir()
  const files = await fs.readdir(DATA_DIR)
  const builds: Build[] = []
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    try {
      const data = await fs.readFile(path.join(DATA_DIR, file), 'utf-8')
      builds.push(JSON.parse(data))
    } catch {
      // Skip corrupt files
    }
  }
  return builds.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function deleteBuild(id: string): Promise<void> {
  try {
    await fs.unlink(path.join(DATA_DIR, `${id}.json`))
  } catch {
    // Already deleted
  }
}
