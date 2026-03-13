/**
 * Form Builder Agent — builds a form question-by-question via per-type tool calls.
 *
 * Operates on a MutableBlueprint shell (single module, single form) at indices [0,0].
 * Each question type has its own tool with only the relevant fields, making schemas
 * self-documenting contracts that guide the LLM without prompt-based type guidance.
 */
import { ToolLoopAgent, tool, stepCountIs } from 'ai'
import { z } from 'zod'
import { MODEL_GENERATION } from '../models'
import { GenerationContext, withPromptCaching } from './generationContext'
import { MutableBlueprint, type NewQuestion } from './mutableBlueprint'
import { type BlueprintChildCase, type CaseType } from '../schemas/blueprint'
import { formBuilderPrompt } from '../prompts/formBuilderPrompt'

// ---------------------------------------------------------------------------
// Shared field definitions
// ---------------------------------------------------------------------------

const selectOptionSchema = z.object({
  value: z.string().describe('Option value (stored in data)'),
  label: z.string().describe('Option label (shown to user)'),
})

const casePropertyMappingSchema = z.object({
  case_property: z.string().describe('Case property name'),
  question_id: z.string().describe('Question id in the form'),
})

// Positioning fields shared by all question tools
const positioningFields = {
  id: z.string().describe('Unique question id in snake_case'),
  afterQuestionId: z.string().optional().describe('Insert after this question ID. Omit to append at end.'),
  parentId: z.string().optional().describe('ID of a group/repeat to nest inside'),
}

// Reusable optional fields
const labelField = (desc?: string) =>
  z.string().optional().describe(desc ?? 'Question label. When mapping to a case property, defaults to the property label.')
const hintField = z.string().optional().describe('Short hint shown below the question.')
const helpField = z.string().optional().describe('Detailed help text shown on demand.')
const requiredField = z.string().optional().describe('"true()" if always required. XPath for conditional. Omit if not required.')
const readonlyField = z.boolean().optional().describe('True for display-only preloaded values.')
const constraintField = z.string().optional().describe('XPath constraint expression (e.g. ". > 0 and . < 150").')
const constraintMsgField = z.string().optional().describe('Error message when constraint fails.')
const relevantField = z.string().optional().describe('XPath expression controlling when this question is shown.')
const calculateField = z.string().optional().describe('XPath expression for computed value. Recomputes as referenced values change.')
const defaultValueField = z.string().optional().describe('XPath expression for one-time initial value (set on form open).')

// ---------------------------------------------------------------------------
// Field set builder
// ---------------------------------------------------------------------------

type FieldCategory = 'data' | 'date' | 'select' | 'geopoint' | 'barcode' | 'media' | 'trigger' | 'hidden' | 'structural'

function buildSchema(
  category: FieldCategory,
  casePropertyField: z.ZodTypeAny | null,
  extra?: Record<string, z.ZodTypeAny>,
) {
  const fields: Record<string, z.ZodTypeAny> = { ...positioningFields }

  // label — on everything except hidden
  if (category !== 'hidden') {
    fields.label = labelField()
  }

  // hint, help — data, date, select, geopoint, barcode
  if (['data', 'date', 'select', 'geopoint', 'barcode'].includes(category)) {
    fields.hint = hintField
    fields.help = helpField
  }

  // required — data, date, select, geopoint, barcode, media
  if (['data', 'date', 'select', 'geopoint', 'barcode', 'media'].includes(category)) {
    fields.required = requiredField
  }

  // readonly — data, date, select, barcode
  if (['data', 'date', 'select', 'barcode'].includes(category)) {
    fields.readonly = readonlyField
  }

  // constraint, constraint_msg — data, date
  if (['data', 'date'].includes(category)) {
    fields.constraint = constraintField
    fields.constraint_msg = constraintMsgField
  }

  // relevant — everything
  fields.relevant = relevantField

  // calculate — data only (optional), hidden (required — handled via extra)
  if (category === 'data') {
    fields.calculate = calculateField
  }

  // default_value — data, date, select
  if (['data', 'date', 'select'].includes(category)) {
    fields.default_value = defaultValueField
  }

  // options — select only (required — handled via extra)

  // case_property, is_case_name — data, date, select, geopoint, barcode, hidden
  if (casePropertyField && ['data', 'date', 'select', 'geopoint', 'barcode', 'hidden'].includes(category)) {
    fields.case_property = casePropertyField
    fields.is_case_name = ['geopoint'].includes(category)
      ? undefined! // geopoint doesn't get is_case_name
      : z.boolean().optional().describe('True if this question provides the case name. Auto-derived from data model when possible.')
    if (!fields.is_case_name) delete fields.is_case_name
  }

  // Merge extra fields (overrides or additions like options, mediaType, calculate for hidden)
  if (extra) Object.assign(fields, extra)

  return z.object(fields)
}

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

const XPATH_FIELDS = ['constraint', 'relevant', 'calculate', 'default_value', 'required'] as const

/** Unescape HTML entities that LLMs sometimes emit in XPath strings. */
function unescapeXPath(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
}

// ---------------------------------------------------------------------------
// Shared execute function factory
// ---------------------------------------------------------------------------

function createExecutor(
  questionType: string | null,
  mb: MutableBlueprint,
  caseType: CaseType | null | undefined,
  emitQuestion: () => void,
) {
  return async ({ afterQuestionId, parentId, mediaType, ...fields }: any) => {
    try {
      const question = { ...fields, type: mediaType ?? questionType }

      // Unescape HTML entities in XPath fields (LLMs sometimes emit &gt; instead of >)
      for (const f of XPATH_FIELDS) {
        if (typeof question[f] === 'string') question[f] = unescapeXPath(question[f])
      }

      // Auto-merge data model defaults from case type
      if (question.case_property && caseType) {
        const prop = caseType.properties.find((p: any) => p.name === question.case_property)
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
  }
}

// ---------------------------------------------------------------------------
// Per-type tool factory
// ---------------------------------------------------------------------------

function defineQuestionTool(
  type: string | null,
  description: string,
  category: FieldCategory,
  mb: MutableBlueprint,
  caseType: CaseType | null | undefined,
  casePropertyField: z.ZodTypeAny | null,
  emitQuestion: () => void,
  extra?: Record<string, z.ZodTypeAny>,
) {
  return tool({
    description,
    inputSchema: buildSchema(category, casePropertyField, extra),
    execute: createExecutor(type, mb, caseType, emitQuestion),
  })
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

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

  // Build case_type field as an enum of known case types from the data model
  const allCaseTypes = mb.getBlueprint().case_types?.map(ct => ct.name) ?? []
  const caseTypeField = allCaseTypes.length > 0
    ? z.enum(allCaseTypes as [string, ...string[]]).describe('Child case type — must be defined in the data model.')
    : z.string().describe('Child case type in snake_case')

  // Helper with common args bound
  const dt = (type: string | null, description: string, category: FieldCategory, extra?: Record<string, z.ZodTypeAny>) =>
    defineQuestionTool(type, description, category, mb, caseType, casePropertyField, emitQuestion, extra)

  const agent = new ToolLoopAgent({
    model: ctx.model(MODEL_GENERATION),
    instructions: formBuilderPrompt(opts.knowledge),
    stopWhen: stepCountIs(40),
    ...withPromptCaching,
    tools: {
      // --- Data types ---
      addTextQuestion: dt('text',
        'Add a text question for open-ended responses like names, addresses, descriptions, or notes. Multiline by default. Only use for genuinely free-text fields — prefer more specific types (phone, date, int, select1) when the input has a defined format.',
        'data'),
      addIntQuestion: dt('int',
        'Add a whole number question for counts, ages, quantities, or any integer value. Shows a numeric keypad. Use constraint for range validation (e.g. ". > 0 and . < 150"). Use addDecimalQuestion for measurements with fractional parts.',
        'data'),
      addDecimalQuestion: dt('decimal',
        'Add a decimal number question for measurements, percentages, or values with fractional parts. Shows a numeric keypad. Use addIntQuestion for whole numbers.',
        'data'),
      addPhoneQuestion: dt('phone',
        'Add a phone number or numeric ID question. Shows a numeric keypad but stores as a string, preserving leading zeros. Use instead of text for phone numbers and instead of int for fixed-length IDs.',
        'data'),
      addSecretQuestion: dt('secret',
        'Add a password or PIN question. Input is masked on screen but stored as plaintext. Use for sensitive values like access codes.',
        'data'),

      // --- Temporal types ---
      addDateQuestion: dt('date',
        'Add a date picker for calendar dates like date of birth, visit date, or appointment date. Use addTimeQuestion for time-of-day or addDateTimeQuestion for both.',
        'date'),
      addTimeQuestion: dt('time',
        'Add a time picker for time-of-day values like appointment time or medication schedule. Use addDateQuestion for calendar dates.',
        'date'),
      addDateTimeQuestion: dt('datetime',
        'Add a combined date and time picker for timestamps that need both components, like event start times or incident reports. Android only — not supported on Web Apps.',
        'date'),

      // --- Select types ---
      addSingleSelectQuestion: dt('select1',
        'Add a single-choice question where the user picks exactly one option. Use for yes/no, gender, status, or any fixed set of mutually exclusive choices.',
        'select',
        { options: z.array(selectOptionSchema).describe('Choice options. When mapping to a case property, defaults to the property options.') }),
      addMultiSelectQuestion: dt('select',
        'Add a multi-choice question where the user can select multiple options. Use for symptoms, services provided, or any field where multiple values apply.',
        'select',
        { options: z.array(selectOptionSchema).describe('Choice options. When mapping to a case property, defaults to the property options.') }),

      // --- Specialized types ---
      addGeopointQuestion: dt('geopoint',
        'Add a GPS location capture for geographic coordinates. Records latitude, longitude, altitude, and accuracy. Avoid making GPS required — GPS may be unavailable.',
        'geopoint'),
      addBarcodeQuestion: dt('barcode',
        'Add a barcode/QR code scanner question. Stores the scanned value as text. Commonly maps to case properties like patient ID or supply tracking codes.',
        'barcode'),
      addMediaQuestion: dt(null,
        'Add a media capture question: image (photo), audio (recording), video, or signature (handwritten). Media is stored as binary attachments and cannot map to case properties.',
        'media',
        { mediaType: z.enum(['image', 'audio', 'video', 'signature']).describe('Type of media to capture.') }),
      addTriggerQuestion: dt('trigger',
        'Add a display-only label or acknowledgment screen. Use for informational text, consent statements, or confirmation steps. No data is captured. The label supports <output value="/data/question_id"/> for dynamic references.',
        'trigger'),
      addHiddenQuestion: dt('hidden',
        'Add a hidden computed value not shown to the user. Requires a calculate expression. Use for derived values like BMI, risk scores, age from DOB, or concatenated fields. The expression recomputes as referenced values change.',
        'hidden',
        { calculate: z.string().describe('XPath expression for computed value (required). Recomputes as referenced values change.') }),

      // --- Structural types ---
      addGroupQuestion: dt('group',
        'Add a group container to visually organize related questions. Add child questions using parentId. Groups can be nested at any depth.',
        'structural'),
      addRepeatQuestion: dt('repeat',
        'Add a repeating group for variable-length lists like household members, medications, or visit records. Add child questions using parentId. Creates one entry set per repeat iteration. Can be nested at any depth.',
        'structural'),

      // --- Non-question tools ---
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
        description: 'Add a child/sub-case that will be created when the form is submitted. Used for creating linked cases (e.g. referrals from a patient form). Case type must be one defined in the data model.',
        strict: true,
        inputSchema: z.object({
          case_type: caseTypeField,
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
