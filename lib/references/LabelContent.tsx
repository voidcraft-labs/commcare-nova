/**
 * React component for rendering label text with inline reference chips.
 *
 * Uses markdown-to-jsx with a custom `renderRule` to intercept text nodes and
 * replace ref patterns (#form/x, <output value="#form/x"/>) with ReferenceChip
 * components directly — no string templating, no intermediate HTML. Markdown
 * handles all formatting natively; we only touch text nodes that contain refs.
 */

'use client'
import Markdown, { RuleType, type MarkdownToJSX } from 'markdown-to-jsx'
import { Fragment, type ReactNode } from 'react'
import { ReferenceChip } from './ReferenceChip'
import { useReferenceProvider } from './ReferenceContext'
import { resolveRefFromExpr, parseLabelSegments, LABEL_REF_RE } from './renderLabel'
import type { ReferenceProvider } from './provider'

interface LabelContentProps {
  /** Raw label text (may contain <output> tags, bare hashtags, and markdown). */
  label: string
  /** Engine-resolved label (output tags replaced with values). Undefined if no output tags. */
  resolvedLabel?: string
  /** Whether we're in design/edit mode. */
  isEditMode: boolean
}

/**
 * Split a text node on ref patterns and render chips inline. Uses
 * parseLabelSegments (canonical regex split) so the pattern logic lives
 * in one place.
 */
function textWithChips(text: string, provider: ReferenceProvider | null): ReactNode {
  return parseLabelSegments(text).map((seg, i) => {
    if (seg.kind === 'text') return seg.text
    const ref = resolveRefFromExpr(seg.value, provider)
    return ref ? <ReferenceChip key={i} reference={ref} /> : seg.value
  })
}

/**
 * Build markdown-to-jsx options with a renderRule that intercepts text nodes
 * containing ref patterns and replaces them with ReferenceChip components.
 * Provider comes from context, so no prop threading needed.
 */
function useMarkdownOptions(): MarkdownToJSX.Options {
  const provider = useReferenceProvider()
  return {
    renderRule(next, node, _renderChildren, state) {
      if (node.type === RuleType.text && LABEL_REF_RE.test(node.text)) {
        return <Fragment key={state.key}>{textWithChips(node.text, provider)}</Fragment>
      }
      return next()
    },
    slugify: () => '',
  }
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
