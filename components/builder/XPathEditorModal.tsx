'use client'
import { useState, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'motion/react'
import CodeMirror from '@uiw/react-codemirror'
import { EditorView, keymap } from '@codemirror/view'
import { foldGutter, foldKeymap, indentOnInput, bracketMatching, indentUnit } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { xpath } from '@/lib/codemirror/xpath-language'
import { novaXPathTheme } from '@/lib/codemirror/xpath-theme'
import { formatXPath, prettyPrintXPath } from '@/lib/codemirror/xpath-format'

const modalEditorTheme = EditorView.theme({
  '&': {
    fontSize: '13px',
    fontFamily: 'var(--font-nova-mono)',
    background: 'var(--nova-surface)',
    borderRadius: '8px',
    border: '1px solid rgba(139, 92, 246, 0.15)',
    maxHeight: '50vh',
  },
  '&.cm-focused': { outline: '1px solid rgba(139, 92, 246, 0.4)' },
  '.cm-scroller': { overflow: 'auto', padding: '4px 0' },
  '.cm-content': { padding: '4px 8px', fontFamily: 'var(--font-nova-mono)' },
  '.cm-line': { padding: '1px 0' },
  '.cm-line:nth-child(even)': { backgroundColor: 'rgba(139, 92, 246, 0.03)' },
  '.cm-activeLine': { backgroundColor: 'rgba(139, 92, 246, 0.06)' },
  '.cm-gutters': {
    background: 'var(--nova-deep)',
    borderRight: '1px solid rgba(139, 92, 246, 0.1)',
    color: 'var(--nova-text-muted)',
  },
  '.cm-foldPlaceholder': {
    backgroundColor: 'rgba(139, 92, 246, 0.1)',
    border: '1px solid rgba(139, 92, 246, 0.2)',
    color: 'var(--nova-text-muted)',
    borderRadius: '3px',
    padding: '0 4px',
  },
  '.cm-foldGutter': { width: '16px' },
  '.cm-foldGutter .cm-gutterElement': {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
})

const modalExtensions = [
  indentUnit.of('    '),
  xpath(),
  foldGutter({
    markerDOM(open) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('viewBox', '0 0 24 24')
      svg.setAttribute('width', '12')
      svg.setAttribute('height', '12')
      svg.style.cssText = 'cursor: pointer; color: var(--nova-text-muted);'
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('fill', 'none')
      path.setAttribute('stroke', 'currentColor')
      path.setAttribute('stroke-linecap', 'round')
      path.setAttribute('stroke-linejoin', 'round')
      path.setAttribute('stroke-width', '2')
      path.setAttribute('d', open ? 'm19 9l-7 7l-7-7' : 'm9 5l7 7l-7 7')
      svg.appendChild(path)
      svg.addEventListener('mouseenter', () => { svg.style.color = 'var(--nova-violet-bright, #a78bfa)' })
      svg.addEventListener('mouseleave', () => { svg.style.color = 'var(--nova-text-muted)' })
      return svg
    },
  }),
  keymap.of(foldKeymap),
  indentOnInput(),
  bracketMatching(),
  EditorView.lineWrapping,
  modalEditorTheme,
]

interface XPathEditorModalProps {
  value: string
  label: string
  onSave: (value: string) => void
  onClose: () => void
}

export function XPathEditorModal({ value, label, onSave, onClose }: XPathEditorModalProps) {
  const [draft, setDraft] = useState(() => prettyPrintXPath(value))

  const handleUpdate = useCallback(() => {
    const normalized = formatXPath(draft)
    if (normalized !== formatXPath(value)) {
      onSave(normalized)
    }
    onClose()
  }, [draft, value, onSave, onClose])

  const handleUpdateRef = useRef(handleUpdate)
  handleUpdateRef.current = handleUpdate
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  const modalRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current()
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        handleUpdateRef.current()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  return createPortal(
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm"
        onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
      >
        <motion.div
          ref={modalRef}
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={{ duration: 0.15 }}
          className="w-[600px] max-h-[80vh] bg-nova-deep rounded-xl border border-nova-border shadow-2xl flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="px-5 py-3 border-b border-nova-border flex items-center justify-between shrink-0">
            <h3 className="text-sm font-medium text-nova-text-secondary">{label}</h3>
            <button
              onClick={onClose}
              className="text-nova-text-muted hover:text-nova-text text-xs transition-colors"
            >
              Esc
            </button>
          </div>

          {/* Editor */}
          <div className="p-4 flex-1 overflow-hidden">
            <CodeMirror
              value={draft}
              onChange={setDraft}
              theme={novaXPathTheme}
              extensions={modalExtensions}
              autoFocus
              onCreateEditor={(view) => {
                const end = view.state.doc.length
                view.dispatch({ selection: { anchor: end } })
              }}
              basicSetup={{
                lineNumbers: true,
                highlightActiveLine: true,
                highlightActiveLineGutter: true,
                foldGutter: false,
                autocompletion: false,
                searchKeymap: false,
              }}
            />
          </div>

          {/* Footer */}
          <div className="px-5 py-3 border-t border-nova-border flex items-center justify-between shrink-0">
            <span className="text-[10px] text-nova-text-muted tracking-wide">
              {typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'} + {typeof navigator !== 'undefined' && /Win/.test(navigator.platform) ? 'ENTER' : 'RETURN'} TO SAVE
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={onClose}
                className="px-3 py-1.5 text-sm text-nova-text-muted hover:text-nova-text transition-colors rounded"
              >
                Cancel
              </button>
              <button
                onClick={handleUpdate}
                className="px-3 py-1.5 text-sm bg-nova-violet/20 text-nova-violet-bright hover:bg-nova-violet/30 border border-nova-violet/30 rounded transition-colors"
              >
                Update
              </button>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body
  )
}
