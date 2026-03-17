import type { Question } from '@/lib/schemas/blueprint'

/**
 * Flat data store keyed by absolute path.
 * Paths: /data/question_id, /data/group_id/child_id, /data/repeat_id[0]/child_id
 */
export class DataInstance {
  private data = new Map<string, string>()

  /** Initialize from a question tree, creating an entry for each non-structural question. */
  initFromQuestions(questions: Question[], prefix = '/data'): void {
    for (const q of questions) {
      const path = `${prefix}/${q.id}`

      if (q.type === 'group') {
        // Groups don't have values — recurse into children
        if (q.children) this.initFromQuestions(q.children, path)
      } else if (q.type === 'repeat') {
        // Repeats start with one instance [0]
        if (q.children) this.initFromQuestions(q.children, `${path}[0]`)
      } else {
        // Leaf question — empty string initial value
        this.data.set(path, '')
      }
    }
  }

  get(path: string): string | undefined {
    return this.data.get(path)
  }

  set(path: string, value: string): void {
    this.data.set(path, value)
  }

  has(path: string): boolean {
    return this.data.has(path)
  }

  /** Get all paths matching a prefix. */
  getPathsByPrefix(prefix: string): string[] {
    const result: string[] = []
    for (const key of this.data.keys()) {
      if (key.startsWith(prefix)) result.push(key)
    }
    return result
  }

  /** Add a new repeat instance. Returns the new index. */
  addRepeatInstance(repeatPath: string): number {
    const count = this.getRepeatCount(repeatPath)
    const newIndex = count

    // Find the template paths from instance [0]
    const templatePrefix = `${repeatPath}[0]/`
    for (const [key] of this.data) {
      if (key.startsWith(templatePrefix)) {
        const suffix = key.slice(templatePrefix.length)
        this.data.set(`${repeatPath}[${newIndex}]/${suffix}`, '')
      }
    }

    return newIndex
  }

  /** Remove a repeat instance and renumber higher indices. */
  removeRepeatInstance(repeatPath: string, index: number): void {
    const count = this.getRepeatCount(repeatPath)
    if (count <= 1) return // Keep at least one instance

    // Remove paths for this index
    const prefix = `${repeatPath}[${index}]/`
    for (const key of [...this.data.keys()]) {
      if (key.startsWith(prefix)) this.data.delete(key)
    }

    // Renumber higher indices
    for (let i = index + 1; i < count; i++) {
      const oldPrefix = `${repeatPath}[${i}]/`
      const newPrefix = `${repeatPath}[${i - 1}]/`
      for (const key of [...this.data.keys()]) {
        if (key.startsWith(oldPrefix)) {
          const suffix = key.slice(oldPrefix.length)
          const value = this.data.get(key)!
          this.data.delete(key)
          this.data.set(newPrefix + suffix, value)
        }
      }
    }
  }

  /** Count repeat instances by counting distinct [N] indices. */
  getRepeatCount(repeatPath: string): number {
    let maxIndex = -1
    const pattern = `${repeatPath}[`
    for (const key of this.data.keys()) {
      if (key.startsWith(pattern)) {
        const afterBracket = key.slice(pattern.length)
        const closeBracket = afterBracket.indexOf(']')
        if (closeBracket > 0) {
          const idx = parseInt(afterBracket.slice(0, closeBracket), 10)
          if (idx > maxIndex) maxIndex = idx
        }
      }
    }
    return maxIndex + 1
  }

  /** Get all entries (for debugging). */
  entries(): [string, string][] {
    return [...this.data.entries()]
  }
}
