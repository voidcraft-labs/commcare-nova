/**
 * React component for rendering label text with inline reference chips.
 *
 * In design mode, <output value="#type/path"/> tags render as real ReferenceChip
 * components (not HTML string templates). Text segments still go through the
 * markdown renderer for bold/italic/etc. In preview mode, the engine-resolved
 * label (with values substituted) is rendered as plain markdown.
 *
 * This avoids duplicating chip styles as HTML string templates — the same
 * ReferenceChip component is used by both TipTap NodeView and label display.
 */

'use client'
import { renderPreviewMarkdown } from '@/lib/markdown'
import { ReferenceChip } from './ReferenceChip'
import { useReferenceProvider } from './ReferenceContext'
import { parseLabelSegments, resolveRefFromExpr, OUTPUT_TAG_RE } from './renderLabel'

interface LabelContentProps {
  /** Raw label text (may contain <output> tags and markdown). */
  label: string
  /** Engine-resolved label (output tags replaced with values). Undefined if no output tags. */
  resolvedLabel?: string
  /** Whether we're in design/edit mode. */
  isEditMode: boolean
}

export function LabelContent({ label, resolvedLabel, isEditMode }: LabelContentProps) {
  const provider = useReferenceProvider()

  /* Preview mode: use engine-resolved values. */
  if (!isEditMode && resolvedLabel !== undefined) {
    return <span className="preview-markdown" dangerouslySetInnerHTML={{ __html: renderPreviewMarkdown(resolvedLabel) }} />
  }

  /* No output tags: render as markdown. */
  if (!OUTPUT_TAG_RE.test(label)) {
    return <span className="preview-markdown" dangerouslySetInnerHTML={{ __html: renderPreviewMarkdown(label) }} />
  }

  /* Design mode with output tags: render as mixed React nodes. */
  const segments = parseLabelSegments(label)

  return (
    <span className="preview-markdown">
      {segments.map((seg, i) => {
        if (seg.kind === 'text') {
          return <span key={i} dangerouslySetInnerHTML={{ __html: renderPreviewMarkdown(seg.text) }} />
        }
        const ref = resolveRefFromExpr(seg.value, provider)
        if (!ref) return <span key={i}>{seg.value}</span>
        return <ReferenceChip key={i} reference={ref} />
      })}
    </span>
  )
}
