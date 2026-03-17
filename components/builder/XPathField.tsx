'use client'
import CodeMirror from '@uiw/react-codemirror'
import { EditorView } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { xpath } from '@/lib/codemirror/xpath-language'
import { novaXPathTheme } from '@/lib/codemirror/xpath-theme'
import { prettyPrintXPath } from '@/lib/codemirror/xpath-format'
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

const readOnlyExtensions = [
  xpath(),
  EditorView.editable.of(false),
  EditorState.readOnly.of(true),
  EditorState.tabSize.of(4),
  EditorView.lineWrapping,
  inlineStyles,
]

interface XPathFieldProps {
  value: string
}

export function XPathField({ value }: XPathFieldProps) {
  const formatted = useMemo(() => prettyPrintXPath(value), [value])

  return (
    <CodeMirror
      value={formatted}
      theme={novaXPathTheme}
      extensions={readOnlyExtensions}
      basicSetup={false}
      editable={false}
    />
  )
}
