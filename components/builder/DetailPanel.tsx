'use client'
import { Icon } from '@iconify/react'
import ciCloseMd from '@iconify-icons/ci/close-md'
import type { Builder } from '@/lib/services/builder'
import { ModuleDetail } from '@/components/builder/detail/ModuleDetail'
import { FormDetail } from '@/components/builder/detail/FormDetail'
import { QuestionDetail } from '@/components/builder/detail/QuestionDetail'

interface DetailPanelProps {
  builder: Builder
  onClose: () => void
}

export function DetailPanel({ builder, onClose }: DetailPanelProps) {
  const selected = builder.selected!
  const mb = builder.mb!

  const mod = mb.getModule(selected.moduleIndex)
  if (!mod) return null

  const form = selected.formIndex !== undefined
    ? mb.getForm(selected.moduleIndex, selected.formIndex)
    : null

  const question = selected.questionPath && selected.formIndex !== undefined
    ? mb.getQuestion(selected.moduleIndex, selected.formIndex, selected.questionPath) ?? undefined
    : undefined

  // Mutation helpers — mutate in-place and notify
  const { notifyBlueprintChanged } = builder

  return (
    <div className="w-80 border border-nova-border-bright border-r-0 bg-nova-deep flex flex-col shrink-0 h-full rounded-l-xl m-2 mr-0 shadow-[0_2px_12px_rgba(0,0,0,0.4)]">
      {/* Header */}
      <div className="px-4 py-3 border-b border-nova-border flex items-center justify-between">
        <h3 className="text-sm font-medium text-nova-text-secondary">
          {selected.type === 'module' ? 'Module' : selected.type === 'form' ? 'Form' : 'Question'}
        </h3>
        <div className="flex items-center gap-0.5">
          <button
            onClick={onClose}
            className="text-nova-text-muted hover:text-nova-text transition-colors p-1 cursor-pointer"
          >
            <Icon icon={ciCloseMd} width="14" height="14" />
          </button>
        </div>
      </div>

      {/* Question detail manages its own scrollable area, delete bar, and XPath modal */}
      {selected.type === 'question' && question ? (
        <QuestionDetail
          question={question}
          selected={selected}
          mb={mb}
          builder={builder}
          notifyBlueprintChanged={notifyBlueprintChanged}
        />
      ) : (
        <div className="p-4 space-y-4 overflow-y-auto flex-1 min-h-0">
          {/* Module details */}
          {selected.type === 'module' && (
            <ModuleDetail
              mod={mod}
              moduleIndex={selected.moduleIndex}
              mb={mb}
              notifyBlueprintChanged={notifyBlueprintChanged}
            />
          )}

          {/* Form details */}
          {selected.type === 'form' && form && (
            <FormDetail
              form={form}
              moduleIndex={selected.moduleIndex}
              formIndex={selected.formIndex!}
              mb={mb}
              notifyBlueprintChanged={notifyBlueprintChanged}
            />
          )}
        </div>
      )}

    </div>
  )
}
