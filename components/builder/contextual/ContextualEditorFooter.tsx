'use client'
import { useCallback, useMemo } from 'react'
import { Icon } from '@iconify/react'
import ciArrowUpMd from '@iconify-icons/ci/arrow-up-md'
import ciArrowDownMd from '@iconify-icons/ci/arrow-down-md'
import ciCopy from '@iconify-icons/ci/copy'
import ciTrashFull from '@iconify-icons/ci/trash-full'
import type { IconifyIcon } from '@iconify/react'
import type { Builder, SelectedElement } from '@/lib/services/builder'
import type { MutableBlueprint } from '@/lib/services/mutableBlueprint'
import { flattenQuestionPaths } from '@/lib/services/questionNavigation'
import type { QuestionPath } from '@/lib/services/questionPath'

interface ContextualEditorFooterProps {
  selected: SelectedElement
  mb: MutableBlueprint
  builder: Builder
  notifyBlueprintChanged: () => void
}

export function ContextualEditorFooter({ selected, mb, builder, notifyBlueprintChanged }: ContextualEditorFooterProps) {
  const form = selected.formIndex !== undefined ? mb.getForm(selected.moduleIndex, selected.formIndex) : null
  const paths = useMemo(() => form ? flattenQuestionPaths(form.questions) : [], [form, builder.mutationCount])
  const curIdx = paths.indexOf(selected.questionPath as QuestionPath)
  const isFirst = curIdx <= 0
  const isLast = curIdx < 0 || curIdx >= paths.length - 1

  const handleMoveUp = useCallback(() => {
    if (isFirst || selected.formIndex === undefined || !selected.questionPath) return
    mb.moveQuestion(selected.moduleIndex, selected.formIndex, selected.questionPath, { beforePath: paths[curIdx - 1] })
    notifyBlueprintChanged()
  }, [mb, selected, paths, curIdx, isFirst, notifyBlueprintChanged])

  const handleMoveDown = useCallback(() => {
    if (isLast || selected.formIndex === undefined || !selected.questionPath) return
    mb.moveQuestion(selected.moduleIndex, selected.formIndex, selected.questionPath, { afterPath: paths[curIdx + 1] })
    notifyBlueprintChanged()
  }, [mb, selected, paths, curIdx, isLast, notifyBlueprintChanged])

  const handleDuplicate = useCallback(() => {
    if (selected.formIndex === undefined || !selected.questionPath) return
    const newPath = mb.duplicateQuestion(selected.moduleIndex, selected.formIndex, selected.questionPath)
    notifyBlueprintChanged()
    builder.select({ type: 'question', moduleIndex: selected.moduleIndex, formIndex: selected.formIndex, questionPath: newPath })
  }, [mb, selected, builder, notifyBlueprintChanged])

  const handleDelete = useCallback(() => {
    if (selected.formIndex === undefined || !selected.questionPath) return
    const nextPath = paths[curIdx + 1] ?? paths[curIdx - 1]
    mb.removeQuestion(selected.moduleIndex, selected.formIndex, selected.questionPath)
    notifyBlueprintChanged()
    if (nextPath) {
      builder.select({ type: 'question', moduleIndex: selected.moduleIndex, formIndex: selected.formIndex!, questionPath: nextPath })
    } else {
      builder.select()
    }
  }, [mb, selected, builder, paths, curIdx, notifyBlueprintChanged])

  return (
    <div className="flex items-center justify-between px-2 py-1.5 border-t border-white/[0.06]">
      <div className="flex items-center gap-0.5">
        <FooterButton icon={ciArrowUpMd} title="Move Up" onClick={handleMoveUp} disabled={isFirst} />
        <FooterButton icon={ciArrowDownMd} title="Move Down" onClick={handleMoveDown} disabled={isLast} />
      </div>
      <div className="flex items-center gap-0.5">
        <FooterButton icon={ciCopy} title="Duplicate" onClick={handleDuplicate} />
        <FooterButton icon={ciTrashFull} title="Delete" onClick={handleDelete} destructive />
      </div>
    </div>
  )
}

function FooterButton({ icon, title, onClick, disabled, destructive }: {
  icon: IconifyIcon
  title: string
  onClick: () => void
  disabled?: boolean
  destructive?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`w-7 h-7 flex items-center justify-center rounded-md transition-colors cursor-pointer
        ${disabled
          ? 'text-nova-text-muted/30 cursor-not-allowed'
          : destructive
            ? 'text-nova-text-muted hover:text-nova-rose hover:bg-nova-rose/10'
            : 'text-nova-text-muted hover:text-nova-text hover:bg-white/[0.06]'
        }`}
    >
      <Icon icon={icon} width="16" height="16" />
    </button>
  )
}
