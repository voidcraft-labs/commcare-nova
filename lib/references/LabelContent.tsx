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
import { Children, createElement, Fragment, type ReactNode } from 'react'
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

/* ---------------------------------------------------------------------------
 * Table key workaround — markdown-to-jsx renders thead/tbody as a keyless
 * array inside <table>, triggering React's "unique key prop" console warning.
 *
 * JSX `{children}` always passes an array as a single arg to createElement,
 * which triggers the key check even when Children.toArray has already assigned
 * keys. Spreading the keyed array as positional args bypasses the array
 * wrapper entirely, suppressing the warning.
 *
 * Upstream fix: https://github.com/quantizor/markdown-to-jsx/pull/859
 * TODO: Remove TABLE_KEY_OVERRIDES and keyedEl once PR #859 is merged and
 * markdown-to-jsx is bumped past 9.7.13.
 * ------------------------------------------------------------------------ */

interface KeyedElProps extends React.PropsWithChildren {
  [key: string]: unknown
}

function keyedEl(tag: string, { children, ...rest }: KeyedElProps) {
  return createElement(tag, rest, ...Children.toArray(children))
}

const TABLE_KEY_OVERRIDES: MarkdownToJSX.Overrides = {
  table: { component: (p: KeyedElProps) => keyedEl('table', p) },
  thead: { component: (p: KeyedElProps) => keyedEl('thead', p) },
  tbody: { component: (p: KeyedElProps) => keyedEl('tbody', p) },
}

function useMarkdownOptions(): MarkdownToJSX.Options {
  const provider = useReferenceProvider()
  return {
    overrides: TABLE_KEY_OVERRIDES,
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
