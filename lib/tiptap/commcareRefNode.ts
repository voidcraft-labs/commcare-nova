/**
 * Custom TipTap node extension for CommCare hashtag references.
 *
 * Renders #form/, #case/, #user/ references as inline atom chips within
 * TipTap editors. The node stores three attributes:
 *   - refType: 'form' | 'case' | 'user' — determines color and icon
 *   - path: the property/question path (e.g. "patient_name", "group1/age")
 *   - label: human-readable display text (falls back to path)
 *
 * Round-trips through HTML via <span data-commcare-ref data-ref-type data-path data-label>.
 *
 * Markdown round-trip via tiptap-markdown:
 *   - Serialize: writes `<output value="#type/path"/>` (CommCare standard)
 *   - Parse: a markdown-it inline rule intercepts `<output value="..."/>`
 *     before the HTML parser sees it (avoiding self-closing void element
 *     issues) and emits `<span data-commcare-ref ...>` which the existing
 *     parseHTML rule picks up.
 *
 * Backspace-to-revert: when the cursor is right after a commcareRef node,
 * backspace converts it back to raw text minus the last character, causing
 * the suggestion popup to re-trigger on the partial match.
 */

import { Node, mergeAttributes } from '@tiptap/core'
import { ReactNodeViewRenderer } from '@tiptap/react'
import { CommcareRefView } from './CommcareRefView'
/** Matches <output value="#type/path"/> in markdown text. */
const OUTPUT_TAG_RE = /^<output\s+value="(#(form|case|user)\/([^"]*))"\s*\/>/

/** Minimal typing for markdown-it's StateInline — just the fields we need. */
interface MdStateInline {
  src: string
  pos: number
  push: (type: string, tag: string, nesting: number) => { content: string; attrs: null | [string, string][] }
}

/** Minimal typing for the markdown-it inline ruler we register with. */
interface MdInlineRuler {
  before: (beforeName: string, ruleName: string, fn: (state: MdStateInline, silent: boolean) => boolean) => void
}

/** Minimal typing for the markdown-it instance passed to parse.setup(). */
interface MdInstance {
  inline: { ruler: MdInlineRuler }
}

/**
 * markdown-it inline rule that intercepts `<output value="#type/path"/>` tags
 * and converts them to `<span data-commcare-ref ...>` HTML before they reach
 * the browser's DOMParser. This avoids the self-closing non-void element
 * issue (`<output>` is not a void element in HTML5, so `<output .../>` would
 * swallow subsequent content).
 */
function commcareRefInlineRule(state: MdStateInline, silent: boolean): boolean {
  const tail = state.src.slice(state.pos)
  const match = tail.match(OUTPUT_TAG_RE)
  if (!match) return false
  if (!silent) {
    const token = state.push('html_inline', '', 0)
    const refType = match[2]
    const path = match[3]
    /* Emit the <span> format that CommcareRef.parseHTML recognizes. */
    token.content = `<span data-commcare-ref data-ref-type="${refType}" data-path="${path}" data-label="${path}">${path}</span>`
  }
  state.pos += match[0].length
  return true
}

export const CommcareRef = Node.create({
  name: 'commcareRef',
  group: 'inline',
  inline: true,
  atom: true,

  /**
   * Markdown serialization/parsing for tiptap-markdown round-trips.
   * Serialize: CommcareRef → `<output value="#type/path"/>`.
   * Parse: markdown-it inline rule intercepts `<output>` tags before
   * the HTML parser, converting them to `<span data-commcare-ref>`
   * that the existing parseHTML rule recognizes.
   */
  addStorage() {
    return {
      markdown: {
        serialize(state: { write: (s: string) => void }, node: { attrs: { refType: string; path: string } }) {
          state.write(`<output value="#${node.attrs.refType}/${node.attrs.path}"/>`)
        },
        parse: {
          setup(markdownit: MdInstance) {
            /* Register before html_inline so we intercept <output> tags first. */
            markdownit.inline.ruler.before('html_inline', 'commcare_ref', commcareRefInlineRule)
          },
        },
      },
    }
  },

  /** Node attributes mapping to the Reference type's fields. */
  addAttributes() {
    return {
      /** Reference namespace: 'form' | 'case' | 'user'. */
      refType: { default: 'form' },
      /** Property/question path within the namespace. */
      path: { default: '' },
      /** Human-readable label (used for accessibility, falls back to path). */
      label: { default: '' },
    }
  },

  /**
   * Parse from HTML: reads data attributes from <span data-commcare-ref>.
   * The `el` param is always an HTMLElement here because the tag selector
   * already matched — the cast is safe.
   */
  parseHTML() {
    return [
      {
        tag: 'span[data-commcare-ref]',
        getAttrs: (el) => {
          const dom = el as HTMLElement
          return {
            refType: dom.getAttribute('data-ref-type') ?? 'form',
            path: dom.getAttribute('data-path') ?? '',
            label: dom.getAttribute('data-label') ?? dom.textContent ?? '',
          }
        },
      },
    ]
  },

  /** Serialize to HTML: produces <span data-commcare-ref ...>label</span>. */
  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-commcare-ref': '',
        'data-ref-type': node.attrs.refType,
        'data-path': node.attrs.path,
        'data-label': node.attrs.label,
      }),
      node.attrs.label || node.attrs.path,
    ]
  },

  /** Render via React NodeView for rich chip display with icon and styling. */
  addNodeView() {
    return ReactNodeViewRenderer(CommcareRefView, { as: 'span' })
  },

  addKeyboardShortcuts() {
    return {
      /**
       * Backspace-to-revert: when the cursor is immediately after a
       * commcareRef node, delete the node and insert its raw text minus
       * the last character. This exposes the partial text (e.g.
       * "#form/patient_nam") and re-triggers the suggestion popup.
       */
      Backspace: ({ editor }) => {
        const { state } = editor
        const { $anchor } = state.selection

        if (!state.selection.empty) return false

        const posBefore = $anchor.pos
        if (posBefore <= 0) return false

        const nodeBefore = state.doc.resolve(posBefore).nodeBefore
        if (!nodeBefore || nodeBefore.type.name !== 'commcareRef') return false

        /* Build the canonical form and trim the last character for re-suggestion. */
        const raw = `#${nodeBefore.attrs.refType}/${nodeBefore.attrs.path}`
        const reverted = raw.slice(0, -1)
        const nodeStart = posBefore - nodeBefore.nodeSize

        editor
          .chain()
          .focus()
          .command(({ tr }) => {
            tr.delete(nodeStart, posBefore)
            tr.insertText(reverted, nodeStart)
            return true
          })
          .run()

        return true
      },
    }
  },
})
