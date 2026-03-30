'use client'
import CodeMirror from '@uiw/react-codemirror'
import { EditorView } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { xpath } from '@/lib/codemirror/xpath-language'
import { novaXPathTheme, novaChipTheme } from '@/lib/codemirror/xpath-theme'
import { prettyPrintXPath } from '@/lib/codemirror/xpath-format'
import { xpathChips } from '@/lib/codemirror/xpath-chips'
import { useReferenceProvider } from '@/lib/references/ReferenceContext'
import { useMemo } from 'react'

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
}

/**
 * Inline read-only CodeMirror display for XPath expressions.
 *
 * Automatically renders hashtag references as styled chips when a
 * ReferenceProvider is available via context (from ReferenceProviderWrapper
 * in BuilderLayout). No prop wiring needed — any XPathField rendered within
 * the builder gets chip support for free.
 */
export function XPathField({ value, onClick }: XPathFieldProps) {
  const formatted = useMemo(() => prettyPrintXPath(value), [value])
  const provider = useReferenceProvider()

  const extensions = useMemo(() => {
    if (!provider) return baseReadOnlyExtensions
    return [...baseReadOnlyExtensions, xpathChips(provider), novaChipTheme]
  }, [provider])

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
