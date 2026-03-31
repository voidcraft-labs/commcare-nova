/**
 * TipTap extension configuration for WYSIWYG markdown editing.
 *
 * Used by InlineTextEditor (text cursor mode) to enable full markdown
 * rendering — bold, italic, headings, lists, etc. — with round-trip
 * serialization via tiptap-markdown. CommcareRef nodes serialize as
 * `<output value="#type/path"/>` tags and parse back losslessly.
 *
 * Contrast with RefLabelInput which uses StarterKit with everything
 * disabled except paragraphs — that editor is text-only with chips.
 * This editor is a full WYSIWYG surface.
 */

import StarterKit from '@tiptap/starter-kit'
import Mention from '@tiptap/extension-mention'
import { Markdown } from 'tiptap-markdown'
import { CommcareRef } from './commcareRefNode'
import { createRefSuggestion } from './refSuggestion'
import type { ReferenceProvider } from '@/lib/references/provider'
import type { Extensions } from '@tiptap/core'

/**
 * Create the full WYSIWYG extension set for inline text editing.
 *
 * StarterKit is fully enabled (headings, bold, italic, lists, blockquote,
 * code, hr). The Markdown extension handles bidirectional conversion.
 * CommcareRef provides `<output>` tag round-tripping. Mention wires
 * the `#` trigger to ReferenceProvider for chip autocomplete.
 *
 * @param provider - ReferenceProvider for hashtag autocomplete (null disables autocomplete)
 */
export function createInlineEditorExtensions(provider: ReferenceProvider | null): Extensions {
  const suggestion = provider ? createRefSuggestion(provider) : undefined

  return [
    StarterKit.configure({
      /* Headings limited to 1-3 — deeper levels aren't useful in form labels. */
      heading: { levels: [1, 2, 3] },
    }),
    Markdown.configure({
      html: true,
      breaks: true,
      transformPastedText: true,
      transformCopiedText: true,
    }),
    CommcareRef,
    ...(suggestion ? [
      Mention.configure({
        HTMLAttributes: { class: 'commcare-ref-mention' },
        suggestion,
        renderLabel: () => '',
      }),
    ] : []),
  ]
}

/**
 * Extract markdown content from a TipTap editor using tiptap-markdown's
 * serializer. Falls back to empty string if the storage isn't available.
 *
 * Accepts `Editor` from `@tiptap/core`. The `storage` field is typed as
 * `Record<string, any>` by TipTap, so the `markdown.getMarkdown()` access
 * is dynamically typed — tiptap-markdown adds it at runtime.
 */
export function getMarkdownContent(editor: { storage: Record<string, any> }): string {
  return editor.storage.markdown?.getMarkdown() ?? ''
}
