/**
 * React component for rendering label text with inline reference chips.
 *
 * Uses marked's lexer to parse markdown into a token tree, then walks the tree
 * to produce React elements directly — no intermediate HTML string. Leaf text
 * nodes are split on the ref pattern so hashtag references render as real
 * ReferenceChip React components, correctly nested inside whatever markdown
 * formatting (bold, heading, etc.) wraps them.
 *
 * Rendering paths:
 * 1. Preview mode with resolved values — plain markdown via dangerouslySetInnerHTML.
 * 2. Labels with references — token tree → React elements with inline chips.
 * 3. Plain text (no refs) — plain markdown via dangerouslySetInnerHTML.
 */

'use client'
import type { ReactNode } from 'react'
import type { Token, Tokens } from 'marked'
import { previewLexer, renderPreviewMarkdown } from '@/lib/markdown'
import { ReferenceChip } from './ReferenceChip'
import { useReferenceProvider } from './ReferenceContext'
import { resolveRefFromExpr, parseLabelSegments, OUTPUT_TAG_RE, LABEL_REF_RE } from './renderLabel'
import type { ReferenceProvider } from './provider'

interface LabelContentProps {
  /** Raw label text (may contain <output> tags, bare hashtags, and markdown). */
  label: string
  /** Engine-resolved label (output tags replaced with values). Undefined if no output tags. */
  resolvedLabel?: string
  /** Whether we're in design/edit mode. */
  isEditMode: boolean
}

// ── Token tree → React ────────────────────────────────────────────────

/**
 * Render a leaf text string as an array of React nodes, splitting on ref
 * patterns so hashtag references become ReferenceChip components. Delegates
 * to parseLabelSegments for the regex splitting (single source of truth),
 * then maps segments to React nodes.
 */
function renderLeafText(text: string, provider: ReferenceProvider | null, keyBase: string): ReactNode[] {
  return parseLabelSegments(text).map((seg, i) => {
    if (seg.kind === 'text') return seg.text
    const ref = resolveRefFromExpr(seg.value, provider)
    return ref
      ? <ReferenceChip key={`${keyBase}-${i}`} reference={ref} />
      : seg.value
  })
}

/**
 * Render an array of inline tokens (children of a block token like paragraph
 * or heading) as React nodes. Recurses into formatting tokens (strong, em, del)
 * and splits leaf text on ref patterns.
 */
function renderInline(tokens: Token[], provider: ReferenceProvider | null, keyBase: string): ReactNode[] {
  return tokens.map((token, i) => {
    const key = `${keyBase}-${i}`
    switch (token.type) {
      case 'text': {
        const t = token as Tokens.Text
        /* Text tokens with nested sub-tokens (e.g. inside list items). */
        if (t.tokens) return renderInline(t.tokens, provider, key)
        return renderLeafText(t.text, provider, key)
      }
      case 'strong': {
        const t = token as Tokens.Strong
        return <strong key={key}>{renderInline(t.tokens, provider, key)}</strong>
      }
      case 'em': {
        const t = token as Tokens.Em
        return <em key={key}>{renderInline(t.tokens, provider, key)}</em>
      }
      case 'del': {
        const t = token as Tokens.Del
        return <del key={key}>{renderInline(t.tokens, provider, key)}</del>
      }
      case 'codespan': {
        const t = token as Tokens.Codespan
        return <code key={key}>{t.text}</code>
      }
      case 'br':
        return <br key={key} />
      case 'link': {
        /* Preview renderer allows links. Render children (may contain refs). */
        const t = token as Tokens.Link
        return (
          <a key={key} href={t.href} target="_blank" rel="noopener noreferrer">
            {renderInline(t.tokens, provider, key)}
          </a>
        )
      }
      case 'image': {
        const t = token as Tokens.Image
        return <img key={key} src={t.href} alt={t.text} title={t.title || undefined} />
      }
      case 'html': {
        /* Inline HTML — check for <output> tags containing refs. */
        const t = token as Tokens.HTML
        const outputMatch = OUTPUT_TAG_RE.exec(t.text)
        if (outputMatch) {
          const ref = resolveRefFromExpr(outputMatch[1], provider)
          return ref ? <ReferenceChip key={key} reference={ref} /> : outputMatch[1]
        }
        /* Other inline HTML is stripped (matches the existing allowlist behavior). */
        return null
      }
      case 'escape': {
        const t = token as Tokens.Escape
        return t.text
      }
      default:
        return null
    }
  })
}

/**
 * Render an array of block tokens as React elements. Each block type maps to
 * the same HTML element the existing markdown renderer produces — the allowlist
 * and visual output are identical, just expressed as React instead of HTML strings.
 */
function renderBlocks(tokens: Token[], provider: ReferenceProvider | null): ReactNode[] {
  return tokens.map((token, i) => {
    const key = `b-${i}`
    switch (token.type) {
      case 'heading': {
        const t = token as Tokens.Heading
        const Tag = `h${t.depth}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
        return <Tag key={key}>{renderInline(t.tokens, provider, key)}</Tag>
      }
      case 'paragraph': {
        const t = token as Tokens.Paragraph
        return <p key={key}>{renderInline(t.tokens, provider, key)}</p>
      }
      case 'hr':
        return <hr key={key} />
      case 'list': {
        const t = token as Tokens.List
        const Tag = t.ordered ? 'ol' : 'ul'
        return (
          <Tag key={key}>
            {t.items.map((item, j) => (
              <li key={`${key}-${j}`}>{renderBlocks(item.tokens, provider)}</li>
            ))}
          </Tag>
        )
      }
      case 'code': {
        const t = token as Tokens.Code
        return <pre key={key}><code>{t.text}</code></pre>
      }
      case 'blockquote': {
        const t = token as Tokens.Blockquote
        return <>{renderBlocks(t.tokens, provider)}</>
      }
      case 'table': {
        const t = token as Tokens.Table
        return (
          <table key={key}>
            <thead>
              <tr>
                {t.header.map((cell, j) => (
                  <th key={j} style={cell.align ? { textAlign: cell.align } : undefined}>
                    {renderInline(cell.tokens, provider, `${key}-h-${j}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {t.rows.map((row, j) => (
                <tr key={j}>
                  {row.map((cell, k) => (
                    <td key={k} style={cell.align ? { textAlign: cell.align } : undefined}>
                      {renderInline(cell.tokens, provider, `${key}-${j}-${k}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )
      }
      case 'html':
        /* Block-level HTML is stripped (matches existing allowlist). */
        return null
      case 'space':
        return null
      default:
        return null
    }
  })
}

// ── Component ──────────────────────────────────────────────────────────

export function LabelContent({ label, resolvedLabel, isEditMode }: LabelContentProps) {
  const provider = useReferenceProvider()

  /* Preview mode: use engine-resolved values (no chips, just substituted text). */
  if (!isEditMode && resolvedLabel !== undefined) {
    return <div className="preview-markdown" dangerouslySetInnerHTML={{ __html: renderPreviewMarkdown(resolvedLabel) }} />
  }

  /* Fast path: no references — render as plain markdown (cheaper than token walking). */
  const hasRefs = LABEL_REF_RE.test(label)
  if (!hasRefs) {
    return <div className="preview-markdown" dangerouslySetInnerHTML={{ __html: renderPreviewMarkdown(label) }} />
  }

  /* Walk the markdown token tree and render React elements with inline chips. */
  const tokens = previewLexer(label)
  return <div className="preview-markdown">{renderBlocks(tokens, provider)}</div>
}
