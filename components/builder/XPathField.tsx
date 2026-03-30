'use client'
import CodeMirror from '@uiw/react-codemirror'
import { EditorView } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { xpath } from '@/lib/codemirror/xpath-language'
import { novaXPathTheme, novaChipTheme } from '@/lib/codemirror/xpath-theme'
import { prettyPrintXPath } from '@/lib/codemirror/xpath-format'
import { xpathChips } from '@/lib/codemirror/xpath-chips'
import { ReferenceProvider } from '@/lib/references/provider'
import type { XPathLintContext } from '@/lib/codemirror/xpath-lint'
import { useMemo, useRef } from 'react'

/** Minimal CodeMirror chrome for inline read-only display. */
const inlineStyles = EditorView.theme({
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
  inlineStyles,
]

interface XPathFieldProps {
  value: string
  onClick?: () => void
  /** Context getter for chip label resolution. When provided, hashtag references render as chips. */
  getLintContext?: () => XPathLintContext | undefined
}

export function XPathField({ value, onClick, getLintContext }: XPathFieldProps) {
  const formatted = useMemo(() => prettyPrintXPath(value), [value])

  /* Stable ref so the provider closure always reads the latest getter. */
  const getLintContextRef = useRef(getLintContext)
  getLintContextRef.current = getLintContext

  const extensions = useMemo(() => {
    if (!getLintContext) return baseReadOnlyExtensions
    const provider = new ReferenceProvider(() => getLintContextRef.current?.())
    return [...baseReadOnlyExtensions, xpathChips(provider), novaChipTheme]
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!getLintContext])

  const editor = (
    <CodeMirror
      value={formatted}
      theme={novaXPathTheme}
      extensions={extensions}
      basicSetup={false}
      editable={false}
    />
  )

  if (!onClick) return editor

  return (
    <div
      onClick={onClick}
      className="cursor-pointer rounded-md border border-transparent hover:border-nova-violet/30 transition-colors"
    >
      {editor}
    </div>
  )
}
