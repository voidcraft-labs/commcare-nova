/**
 * Form Builder Agent — builds a form question-by-question via tool calls.
 *
 * Operates on a MutableBlueprint shell (single module, single form) at indices [0,0].
 * Each question is added one at a time with a flat schema, avoiding the grammar
 * compiler size limits of the nested blueprintFormSchema.
 */
import { ToolLoopAgent, tool, stepCountIs } from 'ai'
import { z } from 'zod'
import { MODEL_GENERATION } from '../models'
import { GenerationContext, withPromptCaching } from './generationContext'
import { MutableBlueprint, type NewQuestion } from './mutableBlueprint'
import { type BlueprintChildCase, type CaseType } from '../schemas/blueprint'
import { formBuilderPrompt } from '../prompts/formBuilderPrompt'

const QUESTION_TYPES = [
  'text', 'int', 'date', 'select1', 'select', 'geopoint', 'image',
  'barcode', 'decimal', 'long', 'trigger', 'phone', 'time', 'datetime',
  'audio', 'video', 'signature', 'hidden', 'secret', 'group', 'repeat',
] as const

const selectOptionSchema = z.object({
  value: z.string().describe('Option value (stored in data)'),
  label: z.string().describe('Option label (shown to user)'),
})

const casePropertyMappingSchema = z.object({
  case_property: z.string().describe('Case property name'),
  question_id: z.string().describe('Question id in the form'),
})

export interface FormBuilderOptions {
  knowledge?: string
  /** Case type definition for data model defaults. */
  caseType?: CaseType | null
  /** Real module/form indices for streaming progress back to the client. */
  moduleIndex?: number
  formIndex?: number
}

export function createFormBuilderAgent(
  ctx: GenerationContext,
  mb: MutableBlueprint,
  opts: FormBuilderOptions,
) {
  const { caseType } = opts

  const emitQuestion = () => {
    if (opts.moduleIndex != null && opts.formIndex != null) {
      ctx.emit('data-question-added', { moduleIndex: opts.moduleIndex, formIndex: opts.formIndex, form: mb.getForm(0, 0)! })
    }
  }

  // Build case_property field as an enum of available property names when case type is known
  const casePropertyField = caseType
    ? z.enum(caseType.properties.map(p => p.name) as [string, ...string[]]).optional()
        .describe('Case property this question maps to. Defaults (label, hint, constraint, etc.) are applied automatically from the data model.')
    : z.string().optional().describe('Case property name this question maps to.')

  const agent = new ToolLoopAgent({
    model: ctx.model(MODEL_GENERATION),
    instructions: formBuilderPrompt(opts.knowledge),
    stopWhen: stepCountIs(40),
    ...withPromptCaching,
    tools: {
      addQuestion: tool({
        description: 'Add a question to the form. For groups/repeats, add the group first, then add children using parentId. Questions are appended at the end unless afterQuestionId is specified.',
        inputSchema: z.object({
          id: z.string().describe('Unique question id in snake_case'),
          type: z.enum(QUESTION_TYPES).describe(
            'Question type.' + (caseType
              ? ' When mapping to a case property, defaults to the property\'s data_type.'
              : ' Pick the most specific type for the data being collected.')
          ),
          label: z.string().optional().describe('Question label (omit for hidden). When mapping to a case property, defaults to the property label.'),
          hint: z.string().optional(),
          help: z.string().optional(),
          required: z.string().optional().describe('"true()" if always required. XPath for conditional. Omit if not required.'),
          readonly: z.boolean().optional(),
          constraint: z.string().optional(),
          constraint_msg: z.string().optional(),
          relevant: z.string().optional(),
          calculate: z.string().optional(),
          default_value: z.string().optional(),
          options: z.array(selectOptionSchema).optional(),
          case_property: casePropertyField,
          is_case_name: z.boolean().optional().describe(
            caseType
              ? 'Auto-derived from case_name_property in the data model. Only set explicitly to override.'
              : 'True if this question provides the case name.'
          ),
          afterQuestionId: z.string().optional().describe('Insert after this question ID. Omit to append at end.'),
          parentId: z.string().optional().describe('ID of a group/repeat to nest inside'),
        }),
        execute: async ({ afterQuestionId, parentId, ...question }) => {
          try {
            // Auto-merge data model defaults from case type
            if (question.case_property && caseType) {
              const prop = caseType.properties.find(p => p.name === question.case_property)
              if (prop) {
                question.type ??= (prop.data_type ?? 'text') as any
                question.label ??= prop.label
                question.hint ??= prop.hint
                question.help ??= prop.help
                question.required ??= prop.required
                question.constraint ??= prop.constraint
                question.constraint_msg ??= prop.constraint_msg
                question.options ??= prop.options
              }
              // Auto-derive is_case_name when mapping to the case name property
              question.is_case_name ??= caseType.case_name_property === question.case_property ? true : undefined
            }
            mb.addQuestion(0, 0, question as NewQuestion, { afterId: afterQuestionId, parentId })
            emitQuestion()
            return { added: question.id, parentId: parentId ?? null }
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) }
          }
        },
      }),

      setCloseCaseCondition: tool({
        description: 'Set close_case config on the form. Empty object {} = always close. {question, answer} = conditional close. Only for followup forms.',
        inputSchema: z.object({
          question: z.string().optional().describe('Question id for conditional close'),
          answer: z.string().optional().describe('Value that triggers case closure'),
        }),
        execute: async (config) => {
          try {
            mb.updateForm(0, 0, { close_case: config })
            return { close_case: config }
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) }
          }
        },
      }),

      addChildCase: tool({
        description: 'Add a child/sub-case that will be created when the form is submitted. Used for creating linked cases (e.g. referrals from a patient form).',
        inputSchema: z.object({
          case_type: z.string().describe('Child case type in snake_case'),
          case_name_field: z.string().describe('Question id whose value becomes the child case name'),
          case_properties: z.array(casePropertyMappingSchema).optional().describe('Child case property-to-question mappings'),
          relationship: z.enum(['child', 'extension']).optional().describe('"child" (default) or "extension"'),
          repeat_context: z.string().optional().describe('Question id of a repeat group — creates one child case per repeat entry'),
        }),
        execute: async (childCase) => {
          try {
            mb.addChildCase(0, 0, childCase as BlueprintChildCase)
            return { added_child_case: childCase.case_type }
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) }
          }
        },
      }),

    },
  })

  return agent
}
