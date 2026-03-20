import { flattenQuestionPaths } from '@/lib/services/questionNavigation'
import type { QuestionPath } from '@/lib/services/questionPath'
import type { Shortcut } from '@/lib/services/keyboardManager'
import type { Builder } from '@/lib/services/builder'
import { BuilderPhase } from '@/lib/services/builder'

/**
 * Builds the keyboard shortcuts array for the builder layout.
 *
 * Returns an empty array when not in Done phase.
 * When active, includes: Escape (deselect/exit test), Tab/Shift+Tab (navigate questions),
 * Delete/Backspace (delete question), Cmd+D (duplicate), ArrowUp/ArrowDown (reorder),
 * Cmd+Z/Cmd+Shift+Z (undo/redo).
 *
 * The returned array is NOT memoized — it matches the original inline pattern where
 * useKeyboardShortcuts re-registers based on its own deps array.
 */
export function useBuilderShortcuts(
  builder: Builder,
  viewMode: 'tree' | 'design' | 'preview',
  handleViewModeChange: (mode: 'tree' | 'design' | 'preview') => void,
  handleDelete: () => void,
  onUndo: () => void,
  onRedo: () => void,
): Shortcut[] {
  // ── Keyboard shortcuts ──────────────────────────────────────────────
  const isDone = builder.phase === BuilderPhase.Done

  if (!isDone) return []

  return [
    // Escape — deselect / exit test mode
    {
      key: 'Escape',
      handler: () => {
        if (viewMode === 'preview') { handleViewModeChange('design'); return }
        if (builder.selected) { builder.select(); return }
      },
    },
    // Tab / Shift+Tab — navigate questions
    {
      key: 'Tab',
      handler: () => {
        if (!builder.selected || !builder.blueprint) return
        const sel = builder.selected
        if (sel.formIndex === undefined) return
        const form = builder.blueprint.modules[sel.moduleIndex]?.forms[sel.formIndex]
        if (!form) return
        const ids = flattenQuestionPaths(form.questions)
        const curIdx = ids.indexOf(sel.questionPath as QuestionPath)
        const nextIdx = (curIdx + 1) % ids.length
        builder.select({ type: 'question', moduleIndex: sel.moduleIndex, formIndex: sel.formIndex, questionPath: ids[nextIdx] })
      },
    },
    {
      key: 'Tab',
      shift: true,
      handler: () => {
        if (!builder.selected || !builder.blueprint) return
        const sel = builder.selected
        if (sel.formIndex === undefined) return
        const form = builder.blueprint.modules[sel.moduleIndex]?.forms[sel.formIndex]
        if (!form) return
        const ids = flattenQuestionPaths(form.questions)
        const curIdx = ids.indexOf(sel.questionPath as QuestionPath)
        const prevIdx = curIdx <= 0 ? ids.length - 1 : curIdx - 1
        builder.select({ type: 'question', moduleIndex: sel.moduleIndex, formIndex: sel.formIndex, questionPath: ids[prevIdx] })
      },
    },
    // Delete / Backspace — delete selected question
    {
      key: 'Delete',
      handler: () => {
        if (builder.selected?.type === 'question') handleDelete()
      },
    },
    {
      key: 'Backspace',
      handler: () => {
        if (builder.selected?.type === 'question') handleDelete()
      },
    },
    // Cmd+D — duplicate
    {
      key: 'd',
      meta: true,
      handler: () => {
        const sel = builder.selected
        if (!sel || sel.type !== 'question' || sel.formIndex === undefined || !sel.questionPath) return
        const mb = builder.mb
        if (!mb) return
        const newPath = mb.duplicateQuestion(sel.moduleIndex, sel.formIndex, sel.questionPath)
        builder.notifyBlueprintChanged()
        builder.select({ type: 'question', moduleIndex: sel.moduleIndex, formIndex: sel.formIndex, questionPath: newPath })
      },
    },
    // ArrowUp/ArrowDown — reorder
    {
      key: 'ArrowUp',
      handler: () => {
        const sel = builder.selected
        if (!sel || sel.type !== 'question' || sel.formIndex === undefined || !sel.questionPath) return
        const mb = builder.mb
        if (!mb) return
        const form = mb.getForm(sel.moduleIndex, sel.formIndex)
        if (!form) return
        const ids = flattenQuestionPaths(form.questions)
        const curIdx = ids.indexOf(sel.questionPath as QuestionPath)
        if (curIdx <= 0) return
        mb.moveQuestion(sel.moduleIndex, sel.formIndex, sel.questionPath, { beforePath: ids[curIdx - 1] })
        builder.notifyBlueprintChanged()
      },
    },
    {
      key: 'ArrowDown',
      handler: () => {
        const sel = builder.selected
        if (!sel || sel.type !== 'question' || sel.formIndex === undefined || !sel.questionPath) return
        const mb = builder.mb
        if (!mb) return
        const form = mb.getForm(sel.moduleIndex, sel.formIndex)
        if (!form) return
        const ids = flattenQuestionPaths(form.questions)
        const curIdx = ids.indexOf(sel.questionPath as QuestionPath)
        if (curIdx < 0 || curIdx >= ids.length - 1) return
        mb.moveQuestion(sel.moduleIndex, sel.formIndex, sel.questionPath, { afterPath: ids[curIdx + 1] })
        builder.notifyBlueprintChanged()
      },
    },
    // Cmd+Z / Cmd+Shift+Z — undo/redo
    {
      key: 'z',
      meta: true,
      global: true,
      handler: onUndo,
    },
    {
      key: 'z',
      meta: true,
      shift: true,
      global: true,
      handler: onRedo,
    },
  ]
}
