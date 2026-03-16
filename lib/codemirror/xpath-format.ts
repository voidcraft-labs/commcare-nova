import type { NodeType, SyntaxNode } from '@lezer/common'
import { parser } from './xpath-parser'

// --------------- Types ---------------

export enum Layout { Space, NewLine, Tab }

export type FormatNode = {
  type: NodeType | Layout
  text?: string
  children?: FormatNode[]
}

// --------------- Phase 1: Format ---------------

/** Parent node types where adjacent children get spaces around operators. */
const SPACED_PARENTS = new Set([
  'AddExpr', 'SubtractExpr', 'MultiplyExpr', 'UnionExpr',
  'EqualsExpr', 'NotEqualsExpr',
  'LessThanExpr', 'LessEqualExpr', 'GreaterThanExpr', 'GreaterEqualExpr',
  'AndExpr', 'OrExpr', 'DivideExpr', 'ModulusExpr',
])

/** Should a Space be inserted between prev and curr inside this parent? */
function needsSpace(parent: SyntaxNode, prev: SyntaxNode, curr: SyntaxNode): boolean {
  const parentName = parent.name

  // Binary expressions: space around the operator (middle child)
  if (SPACED_PARENTS.has(parentName)) {
    const isOperator = (n: SyntaxNode) =>
      n.name === 'Keyword' || // and, or, div, mod
      n.name === '+' || n.name === '-' || n.name === '*' || n.name === '|' ||
      n.name === '>' || n.name === '>=' || n.name === '<' || n.name === '<=' ||
      n.name === '=' || n.name === '!='

    // Space before operator, space after operator
    if (isOperator(curr) || isOperator(prev)) return true
    return false
  }

  // Argument list: space after comma
  if (parentName === 'ArgumentList' && prev.name === ',') return true

  // Everything else (paths, filters, axes, attrs, function calls): no space
  return false
}

/** Walk the Lezer tree and produce a FormatNode tree with Layout tokens inserted. */
function format(node: SyntaxNode, source: string): FormatNode {
  // Leaf: source token
  if (!node.firstChild) {
    return { type: node.type, text: source.slice(node.from, node.to) }
  }

  // Composite: format children, insert Layout.Space where needed
  const result: FormatNode[] = []
  let child: SyntaxNode | null = node.firstChild

  while (child) {
    // Check if we need a space before this child
    if (result.length > 0) {
      const last = result[result.length - 1]
      const prev = child.prevSibling
      if (prev && last.type !== Layout.Space && needsSpace(node, prev, child)) {
        result.push({ type: Layout.Space })
      }
    }

    result.push(format(child, source))
    child = child.nextSibling
  }

  return { type: node.type, children: result }
}

// --------------- Phase 2: Render ---------------

const LAYOUT_TEXT: Record<Layout, string> = {
  [Layout.Space]: ' ',
  [Layout.NewLine]: '\n',
  [Layout.Tab]: '\t',
}

function render(node: FormatNode): string {
  // Layout token
  if (typeof node.type === 'number') return LAYOUT_TEXT[node.type]

  // Leaf source token
  if (node.text !== undefined) return node.text

  // Composite: render children
  return node.children!.map(render).join('')
}

// --------------- Public API ---------------

export function formatXPath(expr: string): string {
  const trimmed = expr.trim()
  if (!trimmed) return expr

  const tree = parser.parse(trimmed)

  // Parse errors: return unchanged
  let hasError = false
  tree.iterate({ enter(n) { if (n.name === '⚠') hasError = true } })
  if (hasError) return expr

  return render(format(tree.topNode, trimmed))
}
