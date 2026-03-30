'use client'
import { useCallback } from 'react'
import type { Question } from '@/lib/schemas/blueprint'
import type { Builder, SelectedElement } from '@/lib/services/builder'
import type { MutableBlueprint } from '@/lib/services/mutableBlueprint'
import { EditableText } from '@/components/builder/EditableText'
import { CasePropertyPills } from './CasePropertyPills'
import { OptionsEditor } from './OptionsEditor'
import { useSaveQuestion } from '@/hooks/useSaveQuestion'
import { MEDIA_TYPES, getModuleCaseTypes } from './shared'

interface ContextualEditorDataProps {
  question: Question
  selected: SelectedElement
  mb: MutableBlueprint
  builder: Builder
  notifyBlueprintChanged: () => void
}

export function ContextualEditorData({ question, selected, mb, builder, notifyBlueprintChanged }: ContextualEditorDataProps) {
  const saveQuestion = useSaveQuestion(selected, mb, notifyBlueprintChanged)

  const setCasePropertyOn = useCallback((caseType: string | null) => {
    if (selected.formIndex === undefined || !selected.questionPath) return
    mb.updateQuestion(selected.moduleIndex, selected.formIndex, selected.questionPath, {
      case_property_on: caseType,
    })
    notifyBlueprintChanged()
  }, [mb, selected.moduleIndex, selected.formIndex, selected.questionPath, notifyBlueprintChanged])

  const renameQuestion = useCallback((newId: string) => {
    if (selected.formIndex === undefined || !selected.questionPath || !newId) return
    const { newPath } = mb.renameQuestion(selected.moduleIndex, selected.formIndex, selected.questionPath, newId)
    builder.select({ ...selected, questionPath: newPath })
    notifyBlueprintChanged()
  }, [mb, selected, builder, notifyBlueprintChanged])

  return (
    <div className="space-y-3">
      <EditableText
        label="ID"
        value={question.id}
        onSave={(v) => { renameQuestion(v); builder.clearNewQuestion() }}
        mono
        color="text-nova-violet-bright"
        selectAll={builder.isNewQuestion(selected.questionPath!)}
      />
      <CasePropertyPills
        value={question.case_property_on}
        isCaseName={question.id === 'case_name'}
        disabled={MEDIA_TYPES.has(question.type)}
        caseTypes={getModuleCaseTypes(mb, selected.moduleIndex)}
        onChange={setCasePropertyOn}
      />
      {(question.type === 'single_select' || question.type === 'multi_select') && (
        <OptionsEditor
          options={question.options ?? []}
          onSave={(options) => {
            if (selected.formIndex === undefined || !selected.questionPath) return
            mb.updateQuestion(selected.moduleIndex, selected.formIndex, selected.questionPath, {
              options: options.length > 0 ? options : null,
            })
            notifyBlueprintChanged()
          }}
        />
      )}
    </div>
  )
}
