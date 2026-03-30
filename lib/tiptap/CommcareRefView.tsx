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
import type { ReferenceType } from '@/lib/references/types'

export function CommcareRefView({ node }: NodeViewProps) {
  const provider = useReferenceProvider()
  const raw = `#${node.attrs.refType}/${node.attrs.path}`

  /* Resolve from provider to get the question type icon. Fall back to a
     bare reference if the provider isn't available or the ref is stale. */
  const ref = provider?.resolve(raw) ?? {
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
