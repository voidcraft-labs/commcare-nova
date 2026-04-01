/**
 * Post-processing pass that converts bare hashtag text (#form/path, #case/path,
 * #user/path) in a TipTap document into commcareRef atom nodes.
 *
 * Called after tiptap-markdown parses a markdown string into ProseMirror content.
 * This avoids the need for a custom markdown-it inline rule that constructs HTML
 * strings — instead, we let markdown-it treat hashtags as plain text, then walk
 * the document and promote matching text spans to structured atom nodes.
 *
 * Replacements are applied in reverse document order within a single transaction
 * so earlier positions aren't shifted by later replacements. Marks (bold, italic,
 * etc.) from the original text node are preserved on the new atom node so
 * tiptap-markdown can round-trip them correctly (e.g. `**#form/name**`).
 */

import { HASHTAG_REF_PATTERN } from '@/lib/references/config'
import { ReferenceProvider } from '@/lib/references/provider'
import type { ReferenceType } from '@/lib/references/types'
import type { Editor } from '@tiptap/core'
import type { Mark } from '@tiptap/pm/model'

/** A hashtag match found in the document with its resolved position and parts. */
interface RefMatch {
  from: number
  to: number
  refType: ReferenceType
  path: string
  /** Marks from the source text node — preserved on the replacement atom node. */
  marks: readonly Mark[]
}

/**
 * Walk the editor's document tree, find text nodes containing hashtag reference
 * patterns, and replace each match with a commcareRef atom node. Dispatches a
 * single ProseMirror transaction with all replacements applied in reverse order.
 */
export function hydrateHashtagRefs(editor: Editor): void {
  const nodeType = editor.schema.nodes.commcareRef
  if (!nodeType) return

  const { doc } = editor.state
  const matches: RefMatch[] = []
  const pattern = new RegExp(HASHTAG_REF_PATTERN.source, 'g')

  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(node.text)) !== null) {
      const parsed = ReferenceProvider.parse(match[0])
      if (!parsed) continue
      matches.push({
        from: pos + match.index,
        to: pos + match.index + match[0].length,
        refType: parsed.type,
        path: parsed.path,
        marks: node.marks,
      })
    }
  })

  if (matches.length === 0) return

  /* Apply in reverse document order so each replacement's position is
   * unaffected by subsequent replacements earlier in the document. */
  const { tr } = editor.state
  for (let i = matches.length - 1; i >= 0; i--) {
    const { from, to, refType, path, marks } = matches[i]
    tr.replaceWith(from, to, nodeType.create({ refType, path, label: path }, null, marks))
  }

  editor.view.dispatch(tr)
}
