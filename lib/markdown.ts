import { Marked, type RendererObject, type Tokens } from 'marked'

/**
 * Allowlist-based markdown renderer for chat messages.
 * Only renders safe formatting tokens — everything else passes through as plain text.
 */

const renderer: RendererObject = {
  // Allowed block-level tokens
  heading({ tokens, depth }) {
    const text = this.parser.parseInline(tokens)
    return `<${`h${depth}`}>${text}</${`h${depth}`}>\n`
  },
  paragraph({ tokens }) {
    const text = this.parser.parseInline(tokens)
    return `<p>${text}</p>\n`
  },
  hr() {
    return '<hr />\n'
  },
  list(token) {
    const tag = token.ordered ? 'ol' : 'ul'
    const body = token.items.map(item => this.listitem(item)).join('')
    return `<${tag}>\n${body}</${tag}>\n`
  },
  listitem(item) {
    const text = this.parser.parse(item.tokens)
    return `<li>${text}</li>\n`
  },
  table(token) {
    const headerCells = token.header.map(cell => this.tablecell(cell)).join('')
    const headerRow = `<tr>\n${headerCells}</tr>\n`
    const bodyRows = token.rows.map(row => {
      const cells = row.map(cell => this.tablecell(cell)).join('')
      return `<tr>\n${cells}</tr>\n`
    }).join('')
    return `<table>\n<thead>\n${headerRow}</thead>\n<tbody>\n${bodyRows}</tbody>\n</table>\n`
  },
  tablecell(token) {
    const tag = token.header ? 'th' : 'td'
    const alignAttr = token.align ? ` style="text-align:${token.align}"` : ''
    const text = this.parser.parseInline(token.tokens)
    return `<${tag}${alignAttr}>${text}</${tag}>\n`
  },

  // Allowed inline tokens
  strong({ tokens }) {
    return `<strong>${this.parser.parseInline(tokens)}</strong>`
  },
  em({ tokens }) {
    return `<em>${this.parser.parseInline(tokens)}</em>`
  },
  del({ tokens }) {
    return `<del>${this.parser.parseInline(tokens)}</del>`
  },
  codespan({ text }) {
    return `<code>${text}</code>`
  },
  br() {
    return '<br />'
  },
  text(token: Tokens.Text | Tokens.Escape) {
    if (token.type === 'text' && token.tokens) {
      return this.parser.parseInline(token.tokens)
    }
    return token.text
  },
  space() {
    return ''
  },

  // Blocked — strip syntax, keep text content
  link({ tokens }) {
    return this.parser.parseInline(tokens)
  },
  image({ title, text }) {
    return title || text || ''
  },
  code({ text }) {
    return `<pre><code>${text}</code></pre>\n`
  },
  blockquote({ tokens }) {
    return this.parser.parse(tokens)
  },
  html() {
    return ''
  },
  checkbox() {
    return ''
  },
  def() {
    return ''
  },
}

const marked = new Marked({ renderer, async: false })

export function renderMarkdown(text: string): string {
  return marked.parse(text) as string
}

/**
 * Preview markdown renderer — supports everything chat does, plus links and images.
 */
const previewRenderer: RendererObject = {
  ...renderer,
  link({ href, tokens }) {
    const text = this.parser.parseInline(tokens)
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`
  },
  image({ href, title, text }) {
    const titleAttr = title ? ` title="${title}"` : ''
    const altAttr = text ? ` alt="${text}"` : ''
    return `<img src="${href}"${altAttr}${titleAttr} />`
  },
}

const previewMarked = new Marked({ renderer: previewRenderer, async: false })

export function renderPreviewMarkdown(text: string): string {
  return previewMarked.parse(text) as string
}
