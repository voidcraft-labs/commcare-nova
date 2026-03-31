/**
 * WYSIWYG inline text editor for text cursor mode.
 *
 * Replaces static LabelContent in-place when the user clicks a text surface
 * in text mode. Full CommCare markdown rendering — headings, bold, italic,
 * strikethrough, links, images, lists, code (inline + block), blockquotes,
 * horizontal rules, and GFM tables — via tiptap-markdown. Uses the TipTap
 * composable API (`<Tiptap>` provider + `<Tiptap.Content>`).
 *
 * Two toolbar variants:
 *
 * **Labels** — Always-visible floating toolbar anchored above the editor via
 * React portal + manual positioning. Full CommCare markdown feature set via
 * official TipTap UI components: MarkButton (bold, italic, strike, code),
 * HeadingDropdownMenu, ListDropdownMenu, LinkButton, ImageButton,
 * BlockquoteButton, CodeBlockButton, HorizontalRuleButton, and TableButton
 * (dropdown with visual grid picker for selecting dimensions). Portal-mounted
 * to body so overflow-hidden ancestors can't clip it.
 *
 * **Hints/help** — BubbleMenu with default shouldShow (text selection only).
 * Bold and italic MarkButton only.
 *
 * Save: blur or Escape. Cancel: no separate cancel — every blur saves.
 * Tab/Shift+Tab: save current, activate next/previous TextEditable in DOM order.
 */

'use client'
import { useCallback, useMemo, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Tiptap, useEditor } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import { Extension, type Editor } from '@tiptap/core'
import { Toolbar, ToolbarGroup, ToolbarSeparator } from '@/components/tiptap-ui-primitive/toolbar'
import { MarkButton } from '@/components/tiptap-ui/mark-button'
import { HeadingDropdownMenu } from '@/components/tiptap-ui/heading-dropdown-menu'
import { ListDropdownMenu } from '@/components/tiptap-ui/list-dropdown-menu'
import { BlockquoteButton } from '@/components/tiptap-ui/blockquote-button'
import { CodeBlockButton } from '@/components/tiptap-ui/code-block-button'
import { LinkButton } from '@/components/tiptap-ui/link-button'
import { ImageButton } from '@/components/tiptap-ui/image-button'
import { HorizontalRuleButton } from '@/components/tiptap-ui/horizontal-rule-button'
import { TableButton } from '@/components/tiptap-ui/table-button'
import { createInlineEditorExtensions, getMarkdownContent } from '@/lib/tiptap/markdownExtensions'
import { useReferenceProvider } from '@/lib/references/ReferenceContext'

type FieldType = 'label' | 'hint' | 'help'

interface InlineTextEditorProps {
  /** Current markdown value for this field. */
  value: string
  /** Called with the new markdown value when the editor saves (blur/Escape). */
  onSave: (value: string) => void
  /** Which text surface this editor replaces — drives styling to match. */
  fieldType: FieldType
  /** Whether to auto-focus the editor on mount. */
  autoFocus?: boolean
}

/** Style classes per field type so the editor matches the static LabelContent it replaces. */
const FIELD_STYLES: Record<FieldType, string> = {
  label: 'text-sm font-medium text-nova-text',
  hint: 'text-xs text-nova-text-muted',
  help: 'text-xs text-nova-text-muted',
}

// ── Label toolbar (full StarterKit formatting via TipTap UI) ─────────

/**
 * Full formatting toolbar for label fields. Always visible, portal-mounted
 * to document.body and positioned above the editor anchor via manual rect
 * tracking. React portal preserves the `<Tiptap>` context so all TipTap UI
 * components (MarkButton, HeadingDropdownMenu, etc.) access the editor
 * through `useCurrentEditor()` as intended.
 *
 * Uses `onMouseDown` with `preventDefault` on the toolbar wrapper to prevent
 * clicks on toolbar buttons from stealing focus from the ProseMirror editor
 * (which would trigger the blur → save flow). The TipTap UI components use
 * `onClick` internally, which still fires after the prevented `mouseDown`.
 */
function LabelToolbar({ anchorRef }: { anchorRef: React.RefObject<HTMLDivElement | null> }) {
  const portalRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const anchor = anchorRef.current
    const portal = portalRef.current
    if (!anchor || !portal) return

    /** Reposition the toolbar via direct DOM mutation — no React re-render.
     * Fires on every scroll (capture) and resize, so it must be cheap. */
    const update = () => {
      const rect = anchor.getBoundingClientRect()
      portal.style.position = 'fixed'
      portal.style.left = `${rect.left}px`
      portal.style.top = `${rect.top}px`
      portal.style.transform = 'translateY(-100%) translateY(-6px)'
      portal.style.visibility = 'visible'
    }

    update()

    /* Capture-phase scroll listener catches scrolling on any ancestor. */
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [anchorRef])

  return createPortal(
    <div
      ref={portalRef}
      style={{ visibility: 'hidden', zIndex: 'var(--z-popover-top)' }}
      data-no-drag
      data-inline-toolbar
      onMouseDown={(e) => e.preventDefault()}
    >
      <Toolbar variant="floating">
        <ToolbarGroup>
          <MarkButton type="bold" />
          <MarkButton type="italic" />
          <MarkButton type="strike" />
          <MarkButton type="code" />
        </ToolbarGroup>
        <ToolbarSeparator />
        <ToolbarGroup>
          <HeadingDropdownMenu levels={[1, 2, 3]} modal={false} />
          <ListDropdownMenu types={['bulletList', 'orderedList']} modal={false} />
        </ToolbarGroup>
        <ToolbarSeparator />
        <ToolbarGroup>
          <LinkButton />
          <ImageButton />
        </ToolbarGroup>
        <ToolbarSeparator />
        <ToolbarGroup>
          <BlockquoteButton />
          <CodeBlockButton />
          <HorizontalRuleButton />
          <TableButton />
        </ToolbarGroup>
      </Toolbar>
    </div>,
    document.body
  )
}

// ── Hint/help toolbar (minimal formatting) ───────────────────────────

/**
 * Minimal BubbleMenu for hint/help fields. Default shouldShow — appears
 * on text selection only. Bold and italic only.
 */
function CompactToolbar() {
  return (
    <BubbleMenu>
      <Toolbar variant="floating" data-no-drag>
        <ToolbarGroup>
          <MarkButton type="bold" />
          <MarkButton type="italic" />
        </ToolbarGroup>
      </Toolbar>
    </BubbleMenu>
  )
}

// ── Main editor ──────────────────────────────────────────────────────

export function InlineTextEditor({ value, onSave, fieldType, autoFocus }: InlineTextEditorProps) {
  const provider = useReferenceProvider()
  const savedRef = useRef(false)
  const anchorRef = useRef<HTMLDivElement>(null)

  /** Save the current editor content as markdown. Guards against double-save. */
  const saveAndDeactivate = useCallback((editor: Editor | null) => {
    if (savedRef.current || !editor) return
    savedRef.current = true
    const md = getMarkdownContent(editor)
    onSave(md.trim())
  }, [onSave])

  const saveRef = useRef(saveAndDeactivate)
  saveRef.current = saveAndDeactivate

  /**
   * TipTap keyboard extension for Tab/Shift+Tab navigation between
   * TextEditable instances. On Tab: save current editor, find next
   * [data-text-editable] in DOM order, click it to activate. On Escape:
   * save and deactivate.
   */
  const keyboardExtension = useMemo(() => Extension.create({
    name: 'inlineTextEditorKeyboard',
    addKeyboardShortcuts() {
      return {
        Tab: ({ editor }) => {
          saveRef.current(editor)
          requestAnimationFrame(() => activateAdjacentEditable('next'))
          return true
        },
        'Shift-Tab': ({ editor }) => {
          saveRef.current(editor)
          requestAnimationFrame(() => activateAdjacentEditable('prev'))
          return true
        },
        Escape: ({ editor }) => {
          saveRef.current(editor)
          editor.commands.blur()
          return true
        },
      }
    },
  }), [])

  const extensions = useMemo(() => [
    ...createInlineEditorExtensions(provider),
    keyboardExtension,
  ], [provider, keyboardExtension])

  const editor = useEditor({
    extensions,
    /* Content is set via setContent() below — not here — because TipTap 3's
     * `immediatelyRender: false` creates the editor in an effect, and the
     * Markdown extension's `onBeforeCreate` hook (which intercepts `content`
     * and parses markdown → HTML) can miss the initial content depending on
     * extension initialization order. Using the overridden `setContent` command
     * guarantees the Markdown extension parses the string. */
    content: '',
    immediatelyRender: false,
    editorProps: {
      attributes: {
        /* preview-markdown reuses the same typography CSS that LabelContent's
         * markdown-to-jsx output uses, so the editor is a pixel-perfect match
         * for the static rendering — true flipbook parity. */
        class: `outline-none preview-markdown ${FIELD_STYLES[fieldType]}`,
        'data-1p-ignore': '',
        autocomplete: 'off',
      },
    },
    onBlur: ({ editor: e }) => {
      /* Delay save to let the browser update activeElement. If focus moved to
       * our toolbar portal or its dropdown (both outside the ProseMirror DOM
       * tree), the blur is transient — don't save. Only save when focus has
       * genuinely left the editing context. The toolbar wrapper and the Radix
       * dropdown content are both tagged with [data-inline-toolbar]. */
      requestAnimationFrame(() => {
        if (!document.activeElement?.closest('[data-inline-toolbar]')) {
          saveRef.current(e)
        }
      })
    },
  })

  /* Load markdown content and auto-focus after the editor mounts. Uses the
   * Markdown extension's overridden setContent command which explicitly parses
   * the markdown string through markdown-it before setting editor state. */
  useEffect(() => {
    if (!editor) return
    editor.commands.setContent(value)
    if (autoFocus) editor.commands.focus('end')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor])

  if (!editor) return null

  return (
    <Tiptap editor={editor}>
      <div
        ref={anchorRef}
        className="relative rounded ring-2 ring-nova-violet/50 ring-offset-1 ring-offset-transparent"
        data-no-drag
      >
        {fieldType === 'label' ? <LabelToolbar anchorRef={anchorRef} /> : <CompactToolbar />}
        <Tiptap.Content />
      </div>
    </Tiptap>
  )
}

/**
 * Find and click the next or previous [data-text-editable] element
 * in DOM order to activate its InlineTextEditor.
 */
function activateAdjacentEditable(direction: 'next' | 'prev') {
  const all = Array.from(document.querySelectorAll<HTMLElement>('[data-text-editable]'))
  /* Find the currently active editable — the one whose InlineTextEditor just saved. */
  const active = document.activeElement?.closest('[data-text-editable]') as HTMLElement | null
    ?? all.find(el => el.querySelector('.ProseMirror'))
  if (!active) return

  const idx = all.indexOf(active)
  if (idx === -1) return

  const targetIdx = direction === 'next'
    ? (idx + 1) % all.length
    : (idx - 1 + all.length) % all.length
  all[targetIdx]?.click()
}
