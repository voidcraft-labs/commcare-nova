/**
 * React NodeView for the commcareRef TipTap node.
 *
 * Renders the shared ReferenceChip component inside a NodeViewWrapper,
 * keeping chip appearance consistent between CodeMirror and TipTap surfaces.
 * Uses the ReferenceProvider from context to resolve the full reference
 * (including the question type icon for #form/ refs).
 */

import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react'
import { ReferenceChip } from '@/lib/references/ReferenceChip'
import { useReferenceProvider } from '@/lib/references/ReferenceContext'
import type { Reference, ReferenceType } from '@/lib/references/types'

export function CommcareRefView({ node }: NodeViewProps) {
  const provider = useReferenceProvider()
  const raw = `#${node.attrs.refType}/${node.attrs.path}`

  /* Only render a chip when the provider can actually resolve the ref.
   * Unresolvable refs (typos, partial edits, stale paths) render as plain
   * text so users don't get a false sense of validity. Without a provider
   * (e.g. during initial load), fall back to a bare chip so content isn't
   * invisible while the context mounts. */
  const resolved = provider?.resolve(raw)

  if (provider && !resolved) {
    return (
      <NodeViewWrapper as="span" className="inline">
        <span className="text-nova-text-muted">{raw}</span>
      </NodeViewWrapper>
    )
  }

  const ref: Reference = resolved ?? {
    type: node.attrs.refType as ReferenceType,
    path: node.attrs.path,
    label: node.attrs.label || node.attrs.path,
    raw,
  }

  return (
    <NodeViewWrapper as="span" className="inline">
      <ReferenceChip reference={ref} />
    </NodeViewWrapper>
  )
}
