'use client'
import { useState, useCallback, useRef, useMemo, useEffect } from 'react'
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { EditorView, keymap, tooltips } from '@codemirror/view'
import { EditorState, Prec } from '@codemirror/state'
import { completionStatus, closeCompletion } from '@codemirror/autocomplete'
import { indentOnInput, bracketMatching, indentUnit } from '@codemirror/language'
import { xpath } from '@/lib/codemirror/xpath-language'
import { novaXPathTheme, novaAutocompleteTheme, novaChipTheme } from '@/lib/codemirror/xpath-theme'
import { prettyPrintXPath, formatXPath } from '@/lib/codemirror/xpath-format'
import { xpathLinter, type XPathLintContext } from '@/lib/codemirror/xpath-lint'
import { xpathAutocomplete } from '@/lib/codemirror/xpath-autocomplete'
import { xpathChips } from '@/lib/codemirror/xpath-chips'
import { validateXPath } from '@/lib/services/commcare/validate/xpathValidator'
import { collectValidPaths, collectCaseProperties } from '@/lib/services/commcare/validate/index'
import { useReferenceProvider } from '@/lib/references/ReferenceContext'
import { ReferenceProvider } from '@/lib/references/provider'

// ── Read-only theme ────────────────────────────────────────────────────

/** Minimal CodeMirror chrome for the static display state. */
const readOnlyTheme = EditorView.theme({
  '&': {
    fontSize: '12px',
    fontFamily: 'var(--font-nova-mono)',
    background: 'var(--nova-surface)',
    borderRadius: '6px',
    border: '1px solid rgba(139, 92, 246, 0.1)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { overflow: 'visible', padding: '6px 8px' },
  '.cm-content': { padding: 0, caretColor: 'transparent', fontFamily: 'var(--font-nova-mono)' },
  '.cm-line': { padding: 0 },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-selectionBackground': { backgroundColor: 'transparent !important' },
  '.cm-cursor': { display: 'none' },
})

const baseReadOnlyExtensions = [
  xpath(),
  EditorView.editable.of(false),
  EditorState.readOnly.of(true),
  EditorState.tabSize.of(4),
  EditorView.lineWrapping,
  readOnlyTheme,
]

// ── Editing theme ──────────────────────────────────────────────────────

/** Compact CodeMirror chrome for the inline editing state. */
const editingTheme = EditorView.theme({
  '&': {
    fontSize: '12px',
    fontFamily: 'var(--font-nova-mono)',
    background: 'var(--nova-surface)',
    borderRadius: '6px',
    maxHeight: '200px',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { overflow: 'auto', padding: '6px 8px' },
  '.cm-content': { padding: 0, fontFamily: 'var(--font-nova-mono)' },
  '.cm-line': { padding: '1px 0' },
  '.cm-activeLine': { backgroundColor: 'rgba(139, 92, 246, 0.06)' },
})

/** Base extensions shared across all inline editing instances. */
const baseEditingExtensions = [
  indentUnit.of('    '),
  xpath(),
  indentOnInput(),
  bracketMatching(),
  EditorView.lineWrapping,
  editingTheme,
]

// ── Props ──────────────────────────────────────────────────────────────

interface XPathFieldProps {
  /** The XPath expression value. */
  value: string
  /** Callback to save the edited value. Presence enables click-to-edit. */
  onSave?: (value: string) => void
  /** Context getter for linting and autocomplete. Required when onSave is present. */
  getLintContext?: () => XPathLintContext | undefined
  /** Start in editing mode immediately (for newly added fields). */
  autoEdit?: boolean
  /** Called when editing state changes (used by parent to guard dismiss handlers). */
  onEditingChange?: (editing: boolean) => void
}

// ── Component ──────────────────────────────────────────────────────────

/**
 * Inline XPath expression field with dual-mode rendering.
 *
 * **Read-only** (no `onSave`): Static CodeMirror display with syntax
 * highlighting and reference chips. Zero interactivity.
 *
 * **Editable** (`onSave` provided): Click to activate a full CodeMirror
 * editor with autocomplete, linting, bracket matching, and reference chips.
 * Cmd/Ctrl+Enter validates and saves. Escape and blur cancel (revert).
 * Invalid expressions cannot be saved — the editor shakes on rejected
 * save attempts.
 *
 * Hashtag references render as styled chips automatically when a
 * ReferenceProvider is available via context.
 */
export function XPathField({ value, onSave, getLintContext, autoEdit, onEditingChange }: XPathFieldProps) {
  const [editing, setEditing] = useState(autoEdit ?? false)
  const provider = useReferenceProvider()
  /** Viewport coordinates of the activation click for cursor placement. */
  const clickPosRef = useRef<{ x: number; y: number } | null>(null)

  /* Notify parent when editing state changes. */
  useEffect(() => {
    onEditingChange?.(editing)
  }, [editing, onEditingChange])

  // ── Read-only extensions (memoized on provider) ────────────────────

  const readOnlyExtensions = useMemo(() => {
    if (!provider) return baseReadOnlyExtensions
    return [...baseReadOnlyExtensions, xpathChips(provider), novaChipTheme]
  }, [provider])

  // ── Read-only / idle states ────────────────────────────────────────

  if (!editing) {
    const formatted = prettyPrintXPath(value)
    const display = (
      <CodeMirror
        value={formatted}
        theme={novaXPathTheme}
        extensions={readOnlyExtensions}
        basicSetup={false}
        editable={false}
      />
    )

    /* No onSave = pure read-only display. */
    if (!onSave) return display

    /* Editable idle — show static display with hover chrome. */
    return (
      <div
        onClick={(e) => {
          clickPosRef.current = { x: e.clientX, y: e.clientY }
          setEditing(true)
        }}
        className="cursor-pointer rounded-md border border-transparent hover:border-nova-violet/30 transition-colors"
      >
        {display}
      </div>
    )
  }

  // ── Editing state ──────────────────────────────────────────────────

  return (
    <InlineXPathEditor
      value={value}
      onSave={(v) => {
        clickPosRef.current = null
        setEditing(false)
        const normalized = formatXPath(v)
        if (normalized !== formatXPath(value)) {
          onSave!(normalized)
        }
      }}
      onCancel={() => {
        clickPosRef.current = null
        setEditing(false)
      }}
      getLintContext={getLintContext}
      provider={provider}
      clickPosition={clickPosRef.current}
    />
  )
}

// ── Inline editor sub-component ────────────────────────────────────────

interface InlineXPathEditorProps {
  value: string
  onSave: (draft: string) => void
  /** Cancel editing and revert to the original value (no save). */
  onCancel: () => void
  getLintContext?: () => XPathLintContext | undefined
  provider: ReferenceProvider | null
  clickPosition: { x: number; y: number } | null
}

/**
 * Full CodeMirror editor rendered inline, replacing the static XPathField
 * display. Supports autocomplete, linting, reference chips, and bracket
 * matching.
 *
 * **Save gate:** Cmd/Ctrl+Enter and blur both validate the expression
 * before committing. If valid, the value is saved. If the expression has
 * errors, the editor shakes — Cmd/Ctrl+Enter stays open after shaking,
 * blur shakes then cancels (reverts). Invalid XPath can never be persisted.
 *
 * **Cancel:** Escape always cancels (reverts to the original value).
 * Uses stopPropagation to prevent parent useDismissRef from closing
 * the containing popover.
 */
function InlineXPathEditor({ value, onSave, onCancel, getLintContext, provider, clickPosition }: InlineXPathEditorProps) {
  const editorRef = useRef<ReactCodeMirrorRef>(null)
  /** Guards against double-fire: once save or cancel runs, block the other. */
  const doneRef = useRef(false)
  const [shaking, setShaking] = useState(false)

  /* Stable ref so closures always read the latest getLintContext getter. */
  const getLintContextRef = useRef(getLintContext)
  getLintContextRef.current = getLintContext

  /* ReferenceProvider for chip resolution — shares the same getter. */
  const chipProvider = useMemo(
    () => new ReferenceProvider(() => getLintContextRef.current?.()),
    [],
  )

  /**
   * Check whether the current editor content has XPath validation errors.
   * Uses the same `validateXPath` + context as the CodeMirror linter so
   * the result is always consistent with the inline diagnostics.
   */
  const hasErrors = useCallback((): boolean => {
    const draft = editorRef.current?.view?.state.doc.toString() ?? ''
    if (!draft.trim()) return false
    const ctx = getLintContextRef.current?.()
    const validPaths = ctx?.form.questions ? collectValidPaths(ctx.form.questions) : undefined
    const caseProperties = ctx ? collectCaseProperties(ctx.blueprint, ctx.moduleCaseType) : undefined
    return validateXPath(draft, validPaths, caseProperties).length > 0
  }, [])

  /** Trigger the reject shake animation on the editor wrapper. */
  const shake = useCallback(() => {
    setShaking(true)
    setTimeout(() => setShaking(false), 400)
  }, [])

  /**
   * Attempt to save. If the expression has validation errors, reject with
   * a shake animation and refocus the editor instead of committing.
   */
  const save = useCallback(() => {
    if (doneRef.current) return
    if (hasErrors()) {
      shake()
      editorRef.current?.view?.focus()
      return
    }
    doneRef.current = true
    const draft = editorRef.current?.view?.state.doc.toString() ?? ''
    onSave(draft)
  }, [onSave, hasErrors, shake])

  /** Cancel editing — revert to the original value without saving. */
  const cancel = useCallback(() => {
    if (doneRef.current) return
    doneRef.current = true
    onCancel()
  }, [onCancel])

  const saveRef = useRef(save)
  saveRef.current = save
  const cancelRef = useRef(cancel)
  cancelRef.current = cancel
  const hasErrorsRef = useRef(hasErrors)
  hasErrorsRef.current = hasErrors
  const shakeRef = useRef(shake)
  shakeRef.current = shake

  /* Cmd/Ctrl+Enter saves (with validation gate). Highest precedence so
   * basicSetup keymaps can't intercept it. */
  const saveKeymap = useMemo(() => Prec.highest(keymap.of([
    {
      key: 'Mod-Enter',
      run: () => { saveRef.current(); return true },
    },
  ])), [])

  /**
   * DOM-level Escape handler with stopPropagation. Runs before CodeMirror's
   * internal keymap handlers, so we must check for active autocomplete first:
   * if the completion dropdown is showing, close it (first Escape). Second
   * Escape cancels editing and reverts to the original value. stopPropagation
   * on all Escape presses prevents parent useDismissRef from closing the panel.
   */
  const escapeDom = useMemo(() => EditorView.domEventHandlers({
    keydown: (e, view) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        /* If autocomplete is active, dismiss it instead of canceling. */
        if (completionStatus(view.state) !== null) {
          closeCompletion(view)
          return true
        }
        cancelRef.current()
        return true
      }
      return false
    },
  }), [])

  const extensions = useMemo(
    () => [
      ...baseEditingExtensions,
      /* Portal tooltips to body so they aren't clipped by overflow on
       * ancestor panels (ContextualEditor, FormSettingsPanel). */
      tooltips({ parent: document.body }),
      xpathLinter(() => getLintContextRef.current?.()),
      xpathAutocomplete(() => getLintContextRef.current?.()),
      xpathChips(chipProvider),
      novaAutocompleteTheme,
      novaChipTheme,
      saveKeymap,
      escapeDom,
    ],
    [chipProvider, saveKeymap, escapeDom],
  )

  return (
    <div className={`rounded-md border border-nova-violet/50 ${shaking ? 'xpath-shake' : ''}`}>
      <CodeMirror
        ref={editorRef}
        value={prettyPrintXPath(value)}
        theme={novaXPathTheme}
        extensions={extensions}
        autoFocus
        onCreateEditor={(view) => {
          /* Place cursor at click position when available, otherwise at end. */
          if (clickPosition) {
            const pos = view.posAtCoords(clickPosition)
            if (pos != null) {
              view.dispatch({ selection: { anchor: pos } })
              return
            }
          }
          const end = view.state.doc.length
          view.dispatch({ selection: { anchor: end } })
        }}
        onBlur={() => {
          /* Delay to detect transient blur from autocomplete tooltip
           * interactions (portal-mounted to body). Save if valid; shake
           * then cancel if errors — invalid XPath never persists. */
          requestAnimationFrame(() => {
            if (editorRef.current?.view?.hasFocus) return
            if (document.activeElement?.closest('.cm-tooltip')) return
            if (hasErrorsRef.current()) {
              shakeRef.current()
              setTimeout(() => cancelRef.current(), 400)
            } else {
              saveRef.current()
            }
          })
        }}
        basicSetup={{
          lineNumbers: false,
          highlightActiveLine: true,
          highlightActiveLineGutter: false,
          foldGutter: false,
          autocompletion: false,
          searchKeymap: false,
        }}
      />
    </div>
  )
}
