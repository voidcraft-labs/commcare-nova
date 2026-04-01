/**
 * React component for rendering label text with inline reference chips.
 *
 * Uses markdown-to-jsx (via shared `previewMarkdownOptions`) with a chip
 * injection renderRule that intercepts text nodes containing `#type/path`
 * hashtag patterns and replaces them with ReferenceChip components directly.
 * Markdown handles all formatting natively; we only touch text nodes that
 * contain refs. The chip rule composes on top of the shared breaksRenderRule
 * via `withChipInjection`.
 */

'use client'
import Markdown, { RuleType, type MarkdownToJSX } from 'markdown-to-jsx'
import { Fragment, useMemo, type ReactNode } from 'react'
import { PREVIEW_OPTIONS, withChipInjection } from '@/lib/markdown'
import { ReferenceChip } from './ReferenceChip'
import { useReferenceProvider } from './ReferenceContext'
import { HASHTAG_REF_PATTERN } from './config'
import { resolveRefFromExpr, parseLabelSegments } from './renderLabel'
import type { ReferenceProvider } from './provider'

interface LabelContentProps {
  /** Raw label text (bare `#type/path` hashtags and markdown). */
  label: string
  /** Engine-resolved label (hashtag refs evaluated to values). Undefined when no refs present. */
  resolvedLabel?: string
  /** Whether we're in design/edit mode. */
  isEditMode: boolean
}

/**
 * Split a text node on ref patterns and render chips inline. Uses
 * parseLabelSegments (canonical regex split) so the pattern logic lives
 * in one place. Exported for use by lightweight rendering surfaces (e.g.
 * structure sidebar) that need chips without full markdown rendering.
 */
export function textWithChips(text: string, provider: ReferenceProvider | null): ReactNode {
  /* Fast path: skip regex work for the ~95% of labels with no refs. */
  if (!text.includes('#')) return text
  return parseLabelSegments(text).map((seg, i) => {
    if (seg.kind === 'text') return seg.text
    const ref = resolveRefFromExpr(seg.value, provider)
    return ref ? <ReferenceChip key={i} reference={ref} /> : seg.value
  })
}

/**
 * Build a renderRule that intercepts text nodes containing ref patterns and
 * replaces them with ReferenceChip components. Composed on top of the shared
 * preview options (which include breaksRenderRule) via withChipInjection.
 */
function chipRenderRule(
  provider: ReferenceProvider | null,
): NonNullable<MarkdownToJSX.Options['renderRule']> {
  return (next, node, _renderChildren, state) => {
    if (node.type === RuleType.text && HASHTAG_REF_PATTERN.test(node.text)) {
      return <Fragment key={state.key}>{textWithChips(node.text, provider)}</Fragment>
    }
    return next()
  }
}

function useMarkdownOptions(): MarkdownToJSX.Options {
  const provider = useReferenceProvider()
  return useMemo(
    () => withChipInjection(PREVIEW_OPTIONS, chipRenderRule(provider)),
    [provider],
  )
}

export function LabelContent({ label, resolvedLabel, isEditMode }: LabelContentProps) {
  const options = useMarkdownOptions()

  /* Preview mode: use engine-resolved values (no chips, just substituted text). */
  if (!isEditMode && resolvedLabel !== undefined) {
    return (
      <div className="preview-markdown">
        <Markdown options={options}>{resolvedLabel}</Markdown>
      </div>
    )
  }

  return (
    <div className="preview-markdown">
      <Markdown options={options}>{label}</Markdown>
    </div>
  )
}
