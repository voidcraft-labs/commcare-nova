/**
 * TipTap-based label input with inline reference chip support.
 *
 * Replaces EditableText for the label field, adding the ability to insert
 * #form/, #case/, #user/ references that render as styled inline chips.
 * Preserves the same focus/blur/commit/cancel UX as EditableText:
 *   - Blur → save
 *   - Enter → save (single-line mode)
 *   - Cmd/Ctrl+Enter → save (multiline mode)
 *   - Escape → cancel (revert to original value)
 *   - Emerald checkmark animation on save
 *
 * The underlying document model stores commcareRef nodes. Serialization
 * to/from the canonical string format (#type/path) happens on save/load.
 */

'use client'
import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Mention from '@tiptap/extension-mention'
import { Icon } from '@iconify/react'
import ciCheck from '@iconify-icons/ci/check'
import { CommcareRef } from '@/lib/tiptap/commcareRefNode'
import { createRefSuggestion } from '@/lib/tiptap/refSuggestion'
import { ReferenceProvider } from '@/lib/references/provider'
import { useReferenceProvider } from '@/lib/references/ReferenceContext'
import { parseLabelSegments } from '@/lib/references/renderLabel'
import type { JSONContent } from '@tiptap/core'

interface RefLabelInputProps {
  label: string
  value: string
  onSave: (value: string) => void
  /** Called on every content change (not just commit). Lets the canvas show chips in real-time. */
  onChange?: (value: string) => void
  onEmpty?: () => void
  multiline?: boolean
  autoFocus?: boolean
  selectAll?: boolean
  /** Content rendered right-aligned in the label row (e.g. a toggle). */
  labelRight?: React.ReactNode
}

// ── Serialization ───────────────────────────────────────────────────────

const IS_MAC = /Mac|iPhone|iPad/
const IS_WIN = /Win/

/**
 * Parse a label string into TipTap JSON content.
 * <output value="#type/path"/> tags become commcareRef nodes;
 * everything else becomes text nodes. Delegates to parseLabelSegments
 * for the regex splitting (single source of truth for the output tag pattern).
 */
function parseValueToContent(value: string, provider: ReferenceProvider | null): JSONContent {
  if (!value) {
    return { type: 'doc', content: [{ type: 'paragraph' }] }
  }

  const segments = parseLabelSegments(value)
  const inlineContent: JSONContent[] = []

  for (const seg of segments) {
    if (seg.kind === 'text') {
      inlineContent.push({ type: 'text', text: seg.text })
      continue
    }
    const parsed = ReferenceProvider.parse(seg.value)
    if (!parsed) {
      inlineContent.push({ type: 'text', text: seg.value })
      continue
    }
    const resolved = provider?.resolve(seg.value)
    inlineContent.push({
      type: 'commcareRef',
      attrs: {
        refType: parsed.type,
        path: parsed.path,
        label: resolved?.label ?? parsed.path,
      },
    })
  }

  return {
    type: 'doc',
    content: [{
      type: 'paragraph',
      content: inlineContent.length > 0 ? inlineContent : undefined,
    }],
  }
}

/**
 * Serialize TipTap document content to a label string.
 * commcareRef nodes become <output value="#type/path"/> tags (CommCare standard),
 * text nodes become their text content.
 */
function serializeContent(doc: JSONContent): string {
  let result = ''
  const paragraphs = doc.content ?? []
  for (let pi = 0; pi < paragraphs.length; pi++) {
    const paragraph = paragraphs[pi]
    for (const node of paragraph.content ?? []) {
      if (node.type === 'text') {
        result += node.text ?? ''
      } else if (node.type === 'commcareRef') {
        result += `<output value="#${node.attrs?.refType}/${node.attrs?.path}"/>`
      }
    }
    if (pi < paragraphs.length - 1) {
      result += '\n'
    }
  }
  return result
}

// ── Component ───────────────────────────────────────────────────────────

export function RefLabelInput({
  label: fieldLabel,
  value,
  onSave,
  onChange,
  onEmpty,
  multiline,
  autoFocus,
  selectAll,
  labelRight,
}: RefLabelInputProps) {
  const [focused, setFocused] = useState(false)
  const [saved, setSaved] = useState(false)
  const committedRef = useRef(false)
  const valueRef = useRef(value)
  valueRef.current = value
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const savedTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  /* Clean up pending timers on unmount to prevent stale state updates. */
  useEffect(() => () => {
    clearTimeout(debounceRef.current)
    clearTimeout(savedTimerRef.current)
  }, [])

  const provider = useReferenceProvider()

  const suggestion = useMemo(() => {
    if (!provider) return undefined
    return createRefSuggestion(provider)
  }, [provider])

  /* Only paragraphs + text + commcareRef nodes — no block-level elements. */
  const extensions = useMemo(() => [
    StarterKit.configure({
      /* Disable everything except paragraph — we only want inline text. */
      heading: false,
      blockquote: false,
      bulletList: false,
      orderedList: false,
      codeBlock: false,
      horizontalRule: false,
      listItem: false,
    }),
    CommcareRef,
    ...(suggestion ? [
      Mention.configure({
        HTMLAttributes: { class: 'commcare-ref-mention' },
        suggestion,
        renderLabel: () => '',
      }),
    ] : []),
  ], [suggestion])

  const initialContent = useMemo(
    () => parseValueToContent(value, provider),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const editor = useEditor({
    extensions,
    content: initialContent,
    immediatelyRender: false,
    /* Debounced live update — avoids a full builder notification per keystroke
       while still keeping the canvas in sync for chip insertion. */
    onUpdate: ({ editor: e }) => {
      clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        onChangeRef.current?.(serializeContent(e.getJSON()))
      }, 200)
    },
    editorProps: {
      attributes: {
        class: 'outline-none',
        'data-1p-ignore': '',
        autocomplete: 'off',
      },
    },
  })

  /* Sync editor content when the value prop changes externally (e.g. undo). */
  useEffect(() => {
    if (!editor || focused) return
    const currentSerialized = serializeContent(editor.getJSON())
    if (currentSerialized !== value) {
      const content = parseValueToContent(value, provider)
      editor.commands.setContent(content)
    }
  }, [editor, value, focused, provider])

  /* Auto-focus and selectAll on mount. */
  useEffect(() => {
    if (!editor) return
    if (autoFocus) {
      editor.commands.focus()
      if (selectAll) {
        editor.commands.selectAll()
      } else {
        editor.commands.focus('end')
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor])

  /**
   * Commit the current editor content as the new label value. Sets the
   * committedRef flag to prevent the subsequent blur event from double-saving.
   * Triggers the emerald checkmark animation on successful save.
   */
  const commit = useCallback(() => {
    if (committedRef.current || !editor) return
    committedRef.current = true
    setFocused(false)

    const serialized = serializeContent(editor.getJSON()).trim()
    if (!serialized && onEmpty) {
      onEmpty()
      return
    }
    if (serialized !== valueRef.current) {
      onSave(serialized)
      setSaved(true)
      savedTimerRef.current = setTimeout(() => setSaved(false), 1500)
    }
  }, [editor, onSave, onEmpty])

  /**
   * Cancel editing and revert the editor content to the last saved value.
   * Called on Escape. If the original value was empty and onEmpty is provided,
   * signals removal (matching EditableText's "delete on empty cancel" behavior).
   */
  const cancel = useCallback(() => {
    if (!editor) return
    committedRef.current = true
    setFocused(false)

    const content = parseValueToContent(valueRef.current, provider)
    editor.commands.setContent(content)

    if (!valueRef.current.trim() && onEmpty) {
      onEmpty()
    }
  }, [editor, provider, onEmpty])

  /* Stable refs so the event listener effect doesn't re-register on every
     parent render (commit/cancel get new identities when onSave/onEmpty change). */
  const commitRef = useRef(commit)
  commitRef.current = commit
  const cancelRef = useRef(cancel)
  cancelRef.current = cancel

  /* Register focus/blur + keyboard handlers on the editor. */
  useEffect(() => {
    if (!editor) return

    const handleFocus = () => {
      committedRef.current = false
      setFocused(true)
      if (selectAll) {
        setTimeout(() => editor.commands.selectAll(), 0)
      }
    }

    const handleBlur = () => {
      if (committedRef.current) {
        committedRef.current = false
        return
      }
      commitRef.current()
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Enter') {
        if (multiline) {
          if (event.metaKey || event.ctrlKey) {
            event.preventDefault()
            commitRef.current()
          }
          return
        }
        event.preventDefault()
        commitRef.current()
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        cancelRef.current()
      }
    }

    editor.on('focus', handleFocus)
    editor.on('blur', handleBlur)

    const dom = editor.view.dom
    dom.addEventListener('keydown', handleKeyDown)

    return () => {
      editor.off('focus', handleFocus)
      editor.off('blur', handleBlur)
      dom.removeEventListener('keydown', handleKeyDown)
    }
  }, [editor, multiline, selectAll])

  /* Derive styling classes matching EditableText. */
  const baseCls = 'w-full text-sm rounded px-2 py-1 border outline-none transition-colors'
  const focusedCls = `${baseCls} bg-nova-surface text-nova-text border-nova-violet/60`
  const isEmpty = !value && !focused
  const unfocusedCls = `${baseCls} bg-transparent border-transparent cursor-text ${isEmpty ? 'text-nova-text-muted italic' : 'font-medium'} hover:border-nova-border/40`
  const wrapperCls = focused ? focusedCls : unfocusedCls

  return (
    <div>
      <label className="text-xs text-nova-text-muted uppercase tracking-wider mb-1 flex items-center gap-1.5">
        {fieldLabel}
        {focused && multiline && (
          <span className="ml-auto text-[10px] tracking-normal text-nova-text-secondary font-normal">
            {typeof navigator !== 'undefined' && IS_MAC.test(navigator.platform) ? '⌘' : 'Ctrl'} + {typeof navigator !== 'undefined' && IS_WIN.test(navigator.platform) ? 'ENTER' : 'RETURN'} TO SAVE
          </span>
        )}
        <AnimatePresence>
          {saved && !focused && (
            <motion.span
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              transition={{ duration: 0.2 }}
            >
              <Icon icon={ciCheck} width="12" height="12" className="text-emerald-400" />
            </motion.span>
          )}
        </AnimatePresence>
        {labelRight}
      </label>
      <div className={wrapperCls}>
        <EditorContent editor={editor} />
      </div>
    </div>
  )
}
