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
import { GenerationContext } from './generationContext'
import { MutableBlueprint, type NewQuestion } from './mutableBlueprint'
import { type BlueprintChildCase } from '../schemas/blueprint'
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
  knowledge: string
  /** Real module/form indices for streaming progress back to the client. */
  moduleIndex?: number
  formIndex?: number
}

export function createFormBuilderAgent(
  ctx: GenerationContext,
  mb: MutableBlueprint,
  opts: FormBuilderOptions,
) {
  const emitQuestion = () => {
    if (opts.moduleIndex != null && opts.formIndex != null) {
      ctx.emit('data-question-added', { moduleIndex: opts.moduleIndex, formIndex: opts.formIndex, form: mb.getForm(0, 0)! })
    }
  }

  const agent = new ToolLoopAgent({
    model: ctx.model(MODEL_GENERATION),
    instructions: formBuilderPrompt(opts.knowledge),
    stopWhen: stepCountIs(40),
    onStepFinish: ({ usage, text, toolCalls, toolResults }) => {
      if (usage) {
        ctx.logger.logEvent({
          type: 'orchestration',
          agent: 'Form Builder',
          label: 'Form builder step',
          model: MODEL_GENERATION,
          input_tokens: usage.inputTokens ?? 0,
          output_tokens: usage.outputTokens ?? 0,
          output: { text, toolResults },
          tool_calls: toolCalls?.map((tc: any) => ({ name: tc.toolName, args: tc.args })),
        })
      }
    },
    tools: {
      addQuestion: tool({
        description: 'Add a question to the form. For groups/repeats, add the group first, then add children using parentId. Questions are appended at the end unless afterQuestionId is specified.',
        inputSchema: z.object({
          id: z.string().describe('Unique question id in snake_case'),
          type: z.enum(QUESTION_TYPES),
          label: z.string().optional().describe('Question label (omit for hidden)'),
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
          case_property: z.string().optional(),
          is_case_name: z.boolean().optional(),
          afterQuestionId: z.string().optional().describe('Insert after this question ID. Omit to append at end.'),
          parentId: z.string().optional().describe('ID of a group/repeat to nest inside'),
        }),
        execute: async ({ afterQuestionId, parentId, ...question }) => {
          try {
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
