import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  ChatMarkdown,
  PreviewMarkdown,
  PREVIEW_OPTIONS,
  composeRenderRules,
  withChipInjection,
} from '../markdown'
import Markdown, { RuleType, type MarkdownToJSX } from 'markdown-to-jsx'

/** Render a React element to an HTML string for assertion. */
function html(element: React.ReactElement): string {
  return renderToStaticMarkup(element)
}

/* ---------------------------------------------------------------------------
 * Chat security
 * ------------------------------------------------------------------------ */

describe('ChatMarkdown', () => {
  it('strips links, rendering text content only', () => {
    const output = html(<ChatMarkdown>{'[click me](https://evil.com)'}</ChatMarkdown>)
    expect(output).toContain('click me')
    expect(output).not.toContain('<a')
    expect(output).not.toContain('href')
  })

  it('strips images, rendering alt text only', () => {
    const output = html(<ChatMarkdown>{'![photo](https://evil.com/img.png)'}</ChatMarkdown>)
    expect(output).toContain('photo')
    expect(output).not.toContain('<img')
  })

  it('strips raw HTML tags', () => {
    const output = html(<ChatMarkdown>{'<script>alert("xss")</script>safe text'}</ChatMarkdown>)
    expect(output).toContain('safe text')
    expect(output).not.toContain('<script')
  })

  it('renders bold, italic, and code', () => {
    const output = html(<ChatMarkdown>{'**bold** *italic* `code`'}</ChatMarkdown>)
    expect(output).toContain('<strong>bold</strong>')
    expect(output).toContain('<em>italic</em>')
    expect(output).toContain('<code>code</code>')
  })

  it('renders headings', () => {
    const output = html(<ChatMarkdown>{'# Heading 1\n\n## Heading 2'}</ChatMarkdown>)
    expect(output).toContain('<h1')
    expect(output).toContain('Heading 1')
    expect(output).toContain('<h2')
    expect(output).toContain('Heading 2')
  })

  it('renders lists', () => {
    const output = html(<ChatMarkdown>{'- item 1\n- item 2'}</ChatMarkdown>)
    expect(output).toContain('<ul>')
    expect(output).toContain('<li>item 1</li>')
    expect(output).toContain('<li>item 2</li>')
  })

  it('renders tables', () => {
    const output = html(<ChatMarkdown>{'| A | B |\n|---|---|\n| 1 | 2 |'}</ChatMarkdown>)
    expect(output).toContain('<table>')
    expect(output).toContain('<th')
    expect(output).toContain('<td')
  })
})

/* ---------------------------------------------------------------------------
 * Preview rendering
 * ------------------------------------------------------------------------ */

describe('PreviewMarkdown', () => {
  it('renders links with target="_blank" and rel="noopener noreferrer"', () => {
    const output = html(<PreviewMarkdown>{'[docs](https://example.com)'}</PreviewMarkdown>)
    expect(output).toContain('<a')
    expect(output).toContain('href="https://example.com"')
    expect(output).toContain('target="_blank"')
    expect(output).toContain('rel="noopener noreferrer"')
    expect(output).toContain('docs</a>')
  })

  it('renders images', () => {
    const output = html(<PreviewMarkdown>{'![alt text](https://example.com/img.png)'}</PreviewMarkdown>)
    expect(output).toContain('<img')
    expect(output).toContain('src="https://example.com/img.png"')
    expect(output).toContain('alt="alt text"')
  })

  it('renders inline when inline prop is set (no block elements)', () => {
    const output = html(<PreviewMarkdown inline>{'**bold** text'}</PreviewMarkdown>)
    /* forceInline should prevent <p> wrapping — content is inline. */
    expect(output).not.toContain('<p>')
    expect(output).toContain('<strong>bold</strong>')
  })
})

/* ---------------------------------------------------------------------------
 * Breaks behavior (single newlines → <br>)
 * ------------------------------------------------------------------------ */

describe('breaks behavior', () => {
  it('converts single newlines to <br> in chat markdown', () => {
    const output = html(<ChatMarkdown>{'line 1\nline 2'}</ChatMarkdown>)
    expect(output).toContain('<br/>')
    expect(output).toContain('line 1')
    expect(output).toContain('line 2')
  })

  it('converts single newlines to <br> in preview markdown', () => {
    const output = html(<PreviewMarkdown>{'line 1\nline 2'}</PreviewMarkdown>)
    expect(output).toContain('<br/>')
  })

  it('does not add <br> when there are no newlines', () => {
    const output = html(<ChatMarkdown>{'no newlines here'}</ChatMarkdown>)
    expect(output).not.toContain('<br')
  })
})

/* ---------------------------------------------------------------------------
 * composeRenderRules
 * ------------------------------------------------------------------------ */

describe('composeRenderRules', () => {
  /** Helper: a renderRule that matches text containing a marker and replaces it. */
  function markerRule(marker: string, replacement: string): NonNullable<MarkdownToJSX.Options['renderRule']> {
    return (next, node, _renderChildren, state) => {
      if (node.type === RuleType.text && typeof node.text === 'string' && node.text.includes(marker)) {
        return <span key={state.key}>{node.text.replace(marker, replacement)}</span>
      }
      return next()
    }
  }

  it('returns undefined when no rules are provided', () => {
    expect(composeRenderRules()).toBeUndefined()
  })

  it('returns the single rule when only one is provided', () => {
    const rule = markerRule('x', 'y')
    expect(composeRenderRules(rule)).toBe(rule)
  })

  it('first rule takes priority when both match', () => {
    const composed = composeRenderRules(
      markerRule('hello', 'FIRST'),
      markerRule('hello', 'SECOND'),
    )!
    const output = html(<Markdown options={{ renderRule: composed }}>{'hello world'}</Markdown>)
    expect(output).toContain('FIRST')
    expect(output).not.toContain('SECOND')
  })

  it('falls through to second rule when first does not match', () => {
    const composed = composeRenderRules(
      markerRule('NOMATCH', 'FIRST'),
      markerRule('hello', 'SECOND'),
    )!
    const output = html(<Markdown options={{ renderRule: composed }}>{'hello world'}</Markdown>)
    expect(output).toContain('SECOND')
  })

  it('falls through to default rendering when no rules match', () => {
    const composed = composeRenderRules(
      markerRule('NOMATCH1', 'FIRST'),
      markerRule('NOMATCH2', 'SECOND'),
    )!
    const output = html(<Markdown options={{ renderRule: composed }}>{'hello world'}</Markdown>)
    expect(output).toContain('hello world')
  })

  it('filters out undefined rules', () => {
    const rule = markerRule('hello', 'MATCH')
    const composed = composeRenderRules(undefined, rule, undefined)
    /* Should simplify to the single rule. */
    expect(composed).toBe(rule)
  })
})

/* ---------------------------------------------------------------------------
 * withChipInjection
 * ------------------------------------------------------------------------ */

describe('withChipInjection', () => {
  it('composes a chip rule on top of base options', () => {
    const chipRule: NonNullable<MarkdownToJSX.Options['renderRule']> = (next, node, _rc, state) => {
      if (node.type === RuleType.text && typeof node.text === 'string' && node.text.includes('#chip')) {
        return <span key={state.key} data-testid="chip">CHIP</span>
      }
      return next()
    }

    const options = withChipInjection(PREVIEW_OPTIONS, chipRule)
    const output = html(<Markdown options={options}>{'text with #chip ref'}</Markdown>)
    expect(output).toContain('data-testid="chip"')
    expect(output).toContain('CHIP')
  })

  it('preserves breaks behavior when chip rule does not match', () => {
    const chipRule: NonNullable<MarkdownToJSX.Options['renderRule']> = (next) => next()

    const options = withChipInjection(PREVIEW_OPTIONS, chipRule)
    const output = html(<Markdown options={options}>{'line 1\nline 2'}</Markdown>)
    expect(output).toContain('<br/>')
  })
})
