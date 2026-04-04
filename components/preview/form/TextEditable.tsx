/**
 * Wrapper that makes a text surface (LabelContent) click-activatable in
 * text cursor mode.
 *
 * In text mode: wraps children with a subtle hover indicator and cursor-text.
 * On click, swaps the static children for an InlineTextEditor. On save,
 * swaps back to static rendering.
 *
 * In other modes: renders children as-is (zero overhead).
 *
 * The `data-text-editable` attribute enables Tab navigation discovery —
 * InlineTextEditor's Tab handler queries all [data-text-editable] elements
 * in DOM order to find the next/previous field.
 */

'use client'
import { useState, useCallback, useRef, type ReactNode } from 'react'
import { useEditContext } from '@/hooks/useEditContext'
import { InlineTextEditor } from './InlineTextEditor'

type FieldType = 'label' | 'hint'

interface TextEditableProps {
  /** Raw markdown value for this field. */
  value: string
  /** Called when the editor saves a new value. Undefined = read-only (no text mode editing). */
  onSave: ((value: string) => void) | undefined
  /** Which text surface — drives InlineTextEditor styling. */
  fieldType: FieldType
  /** Static rendering of this field (LabelContent). Shown when not editing. */
  children: ReactNode
}

export function TextEditable({ value, onSave, fieldType, children }: TextEditableProps) {
  const ctx = useEditContext()
  const [editing, setEditing] = useState(false)
  /** Viewport coordinates of the activation click — passed to the editor
   *  so it can place the cursor at the correct text position via posAtCoords. */
  const clickPosRef = useRef<{ x: number; y: number } | null>(null)

  const handleSave = useCallback((newValue: string) => {
    clickPosRef.current = null
    setEditing(false)
    if (newValue !== value) {
      onSave?.(newValue)
    }
  }, [value, onSave])

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    clickPosRef.current = { x: e.clientX, y: e.clientY }
    setEditing(true)
  }, [])

  /** Keyboard activation — Enter or Space activates the inline editor
   *  without a click position (cursor lands at end of text). */
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      e.stopPropagation()
      clickPosRef.current = null
      setEditing(true)
    }
  }, [])

  /* Not in text mode or no save handler — render children as-is.
   * Still wrap in a div with matching padding so content doesn't shift
   * when switching cursor modes (flipbook parity). */
  if (ctx?.cursorMode !== 'text' || !onSave) {
    return <div className="px-[5px] py-[5px]">{children}</div>
  }

  /* Active editing — swap in the WYSIWYG editor. */
  if (editing) {
    return (
      <div className="rounded px-[5px] py-[5px] ring-2 ring-nova-violet-bright/80" data-text-editable data-no-drag>
        <InlineTextEditor
          value={value}
          onSave={handleSave}
          fieldType={fieldType}
          autoFocus
          clickPosition={clickPosRef.current}
        />
      </div>
    )
  }

  /* Text mode idle — semantic <button> with hover indicator. Enter/Space
   * activates inline editing for keyboard users, click for mouse users. */
  return (
    <button
      type="button"
      data-text-editable
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className="w-full text-left bg-transparent border-none p-0 font-[inherit] cursor-text rounded px-[5px] py-[5px] transition-colors hover:ring-1 hover:ring-nova-violet/30 hover:ring-offset-1 hover:ring-offset-transparent"
    >
      {children}
    </button>
  )
}
