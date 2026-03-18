'use client'
import { useState, useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'motion/react'
import CodeMirror from '@uiw/react-codemirror'
import { EditorView, keymap } from '@codemirror/view'
import { foldGutter, foldKeymap, indentOnInput, bracketMatching } from '@codemirror/language'
import { xpath } from '@/lib/codemirror/xpath-language'
import { novaXPathTheme } from '@/lib/codemirror/xpath-theme'
import { formatXPath } from '@/lib/codemirror/xpath-format'

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
  '.cm-foldGutter': { width: '12px' },
})

const modalExtensions = [
  xpath(),
  foldGutter(),
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
  const [draft, setDraft] = useState(() => formatXPath(value))

  const handleUpdate = useCallback(() => {
    const trimmed = draft.trim()
    if (trimmed !== value) {
      onSave(trimmed)
    }
    onClose()
  }, [draft, value, onSave, onClose])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        handleUpdate()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose, handleUpdate])

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
