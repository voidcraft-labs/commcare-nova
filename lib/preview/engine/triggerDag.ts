import type { Question } from '@/lib/schemas/blueprint'
import { extractPathRefs } from '../xpath/dependencies'
import { parseOutputTags } from './outputTag'

export type ExpressionType = 'relevant' | 'calculate' | 'required' | 'validation' | 'output'

interface DagNode {
  path: string
  expressions: { type: ExpressionType; expr: string }[]
}

/**
 * Directed acyclic graph mapping question paths to dependent expressions.
 * When a value at path X changes, the DAG tells us which other paths
 * need their expressions re-evaluated.
 */
export class TriggerDag {
  /** Map from path → the DagNode for that question */
  private nodes = new Map<string, DagNode>()
  /** Map from dependency path → set of paths that depend on it */
  private dependedOnBy = new Map<string, Set<string>>()
  /** Topologically sorted evaluation order */
  private sortedPaths: string[] = []

  /** Build the DAG from a question tree. */
  build(questions: Question[], prefix = '/data'): void {
    this.nodes.clear()
    this.dependedOnBy.clear()
    this.collectExpressions(questions, prefix)
    this.detectAndBreakCycles()
    this.sortedPaths = this.topologicalSort()
  }

  /** Rebuild the DAG (e.g., after repeat add/remove). */
  rebuild(questions: Question[], prefix = '/data'): void {
    this.build(questions, prefix)
  }

  /**
   * Get all paths affected by a change at `changedPath`, in evaluation order.
   * Uses BFS through dependedOnBy edges, then returns them in topological order.
   */
  getAffected(changedPath: string): string[] {
    const visited = new Set<string>()
    const queue = [changedPath]

    while (queue.length > 0) {
      const current = queue.shift()!
      const dependents = this.dependedOnBy.get(current)
      if (!dependents) continue
      for (const dep of dependents) {
        if (!visited.has(dep)) {
          visited.add(dep)
          queue.push(dep)
        }
      }
    }

    // Return in topological order
    return this.sortedPaths.filter(p => visited.has(p))
  }

  /** Get all expressions registered for a path. */
  getExpressions(path: string): { type: ExpressionType; expr: string }[] {
    return this.nodes.get(path)?.expressions ?? []
  }

  /** Get all paths that have expressions (for initial evaluation). */
  getAllPaths(): string[] {
    return this.sortedPaths
  }

  private collectExpressions(questions: Question[], prefix: string): void {
    for (const q of questions) {
      const path = `${prefix}/${q.id}`

      if (q.type === 'group') {
        // Groups can have relevant
        this.registerExpressions(path, q)
        if (q.children) this.collectExpressions(q.children, path)
      } else if (q.type === 'repeat') {
        this.registerExpressions(path, q)
        // For repeats, register children under [0] template
        if (q.children) this.collectExpressions(q.children, `${path}[0]`)
      } else {
        this.registerExpressions(path, q)
      }
    }
  }

  private registerExpressions(path: string, q: Question): void {
    const expressions: { type: ExpressionType; expr: string }[] = []

    if (q.relevant) expressions.push({ type: 'relevant', expr: q.relevant })
    if (q.calculate) expressions.push({ type: 'calculate', expr: q.calculate })
    if (q.required && q.required !== 'true()' && q.required !== 'false()') {
      expressions.push({ type: 'required', expr: q.required })
    }
    if (q.validation) expressions.push({ type: 'validation', expr: q.validation })

    // Collect all XPath expressions that create dependency edges
    const allDepExprs = expressions.map(e => e.expr)

    // Scan label and hint for <output value="..."/> tags
    const outputTags = parseOutputTags(q.label ?? '').concat(parseOutputTags(q.hint ?? ''))
    if (outputTags.length > 0) {
      expressions.push({ type: 'output', expr: '' })
      for (const tag of outputTags) allDepExprs.push(tag.expr)
    }

    if (expressions.length === 0) return

    this.nodes.set(path, { path, expressions })

    // Register dependency edges
    for (const depExpr of allDepExprs) {
      const refs = extractPathRefs(depExpr)
      for (const ref of refs) {
        if (ref === path) continue // Self-reference doesn't create a dependency
        let deps = this.dependedOnBy.get(ref)
        if (!deps) {
          deps = new Set()
          this.dependedOnBy.set(ref, deps)
        }
        deps.add(path)
      }
    }
  }

  /**
   * Report all cycles without modifying the graph.
   * Returns an array of cycle paths (e.g. ['/data/a', '/data/b', '/data/a']).
   * Must be called after collectExpressions() and before detectAndBreakCycles().
   */
  reportCycles(questions: Question[], prefix = '/data'): string[][] {
    // Build a fresh graph for cycle detection without mutating the instance
    const nodes = new Map<string, DagNode>()
    const dependedOnBy = new Map<string, Set<string>>()

    // Temporarily swap in fresh maps, collect, then swap back
    const savedNodes = this.nodes
    const savedDeps = this.dependedOnBy
    this.nodes = nodes
    this.dependedOnBy = dependedOnBy
    this.collectExpressions(questions, prefix)
    this.nodes = savedNodes
    this.dependedOnBy = savedDeps

    const WHITE = 0, GRAY = 1, BLACK = 2
    const color = new Map<string, number>()
    const parent = new Map<string, string>()
    const cycles: string[][] = []

    for (const path of nodes.keys()) {
      color.set(path, WHITE)
    }

    const dfs = (u: string): void => {
      color.set(u, GRAY)
      const dependents = dependedOnBy.get(u)
      if (dependents) {
        for (const v of dependents) {
          const c = color.get(v) ?? WHITE
          if (c === GRAY) {
            // Back edge — reconstruct cycle
            const cycle = [v, u]
            let cur = u
            while (cur !== v) {
              cur = parent.get(cur)!
              if (cur === undefined) break
              cycle.push(cur)
            }
            cycle.reverse()
            cycles.push(cycle)
          } else if (c === WHITE) {
            parent.set(v, u)
            dfs(v)
          }
        }
      }
      color.set(u, BLACK)
    }

    for (const path of nodes.keys()) {
      if ((color.get(path) ?? WHITE) === WHITE) {
        dfs(path)
      }
    }

    return cycles
  }

  /** DFS cycle detection. If a cycle is found, break it by removing the back-edge. */
  private detectAndBreakCycles(): void {
    const WHITE = 0, GRAY = 1, BLACK = 2
    const color = new Map<string, number>()

    for (const path of this.nodes.keys()) {
      color.set(path, WHITE)
    }

    const dfs = (u: string): void => {
      color.set(u, GRAY)
      const dependents = this.dependedOnBy.get(u)
      if (dependents) {
        for (const v of dependents) {
          const c = color.get(v) ?? WHITE
          if (c === GRAY) {
            // Back edge found — break it
            console.warn(`[Preview] Cycle detected: ${u} → ${v}. Breaking edge.`)
            dependents.delete(v)
          } else if (c === WHITE) {
            dfs(v)
          }
        }
      }
      color.set(u, BLACK)
    }

    for (const path of this.nodes.keys()) {
      if ((color.get(path) ?? WHITE) === WHITE) {
        dfs(path)
      }
    }
  }

  /** Kahn's algorithm for topological sort. */
  private topologicalSort(): string[] {
    // Build in-degree counts for nodes that have expressions
    const inDegree = new Map<string, number>()
    for (const path of this.nodes.keys()) {
      if (!inDegree.has(path)) inDegree.set(path, 0)
    }

    for (const [, dependents] of this.dependedOnBy) {
      for (const dep of dependents) {
        if (this.nodes.has(dep)) {
          inDegree.set(dep, (inDegree.get(dep) ?? 0) + 1)
        }
      }
    }

    const queue: string[] = []
    for (const [path, deg] of inDegree) {
      if (deg === 0) queue.push(path)
    }

    const sorted: string[] = []
    while (queue.length > 0) {
      const current = queue.shift()!
      sorted.push(current)

      const dependents = this.dependedOnBy.get(current)
      if (dependents) {
        for (const dep of dependents) {
          if (!this.nodes.has(dep)) continue
          const newDeg = (inDegree.get(dep) ?? 1) - 1
          inDegree.set(dep, newDeg)
          if (newDeg === 0) queue.push(dep)
        }
      }
    }

    // Add any remaining nodes that weren't reachable (islands)
    for (const path of this.nodes.keys()) {
      if (!sorted.includes(path)) sorted.push(path)
    }

    return sorted
  }
}
