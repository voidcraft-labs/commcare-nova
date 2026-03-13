import { generateText, Output } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { z } from 'zod'

const apiKey = process.env.ANTHROPIC_API_KEY
if (!apiKey) { console.error('Set ANTHROPIC_API_KEY'); process.exit(1) }

const anthropic = createAnthropic({ apiKey })

// Combined scaffold + content schema — no nullable, no optional

const QUESTION_TYPES = [
  'text', 'int', 'date', 'select1', 'select', 'geopoint', 'image',
  'barcode', 'decimal', 'trigger', 'phone', 'time', 'datetime',
  'audio', 'video', 'signature', 'hidden', 'secret', 'group', 'repeat',
] as const

const CASE_PROPERTY_DATA_TYPES = [
  'text', 'int', 'decimal', 'date', 'time', 'datetime',
  'select1', 'select', 'phone', 'geopoint',
] as const

const schema = z.object({
  app_name: z.string().describe('Name of the CommCare application'),
  description: z.string().describe('Brief description of the app purpose'),
  case_types: z.array(z.object({
    name: z.string().describe('Case type name in snake_case'),
    case_name_property: z.string().describe('Property name used as case name'),
    properties: z.array(z.object({
      name: z.string().describe('Property name in snake_case, must not be reserved'),
      label: z.string().describe('Human-readable label, used as default question label'),
      data_type: z.enum(CASE_PROPERTY_DATA_TYPES).describe('Data type, determines default question type'),
      hint: z.string().describe('Hint text, empty if none'),
      help: z.string().describe('Extended help text, empty if none'),
      required: z.string().describe('"true()" if required, empty if not'),
      constraint: z.string().describe('XPath constraint, empty if none'),
      constraint_msg: z.string().describe('Constraint error message, empty if none'),
      options: z.array(z.object({ value: z.string(), label: z.string() })).describe('For select types, empty array otherwise'),
    })),
  })).describe('Empty array if all modules are survey-only'),
  modules: z.array(z.object({
    moduleIndex: z.number().describe('0-based module index'),
    name: z.string().describe('Display name for the module'),
    case_type: z.string().describe('Case type name, empty string for survey-only'),
    purpose: z.string().describe('Brief description of module purpose'),
    case_list_columns: z.array(z.object({
      field: z.string().describe('Case property name or "case_name"'),
      header: z.string().describe('Column header text'),
    })).describe('Empty array for survey-only modules'),
    case_detail_columns: z.array(z.object({
      field: z.string(),
      header: z.string(),
    })).describe('Empty array to mirror case_list_columns'),
    forms: z.array(z.object({
      formIndex: z.number().describe('0-based form index'),
      name: z.string().describe('Display name for the form'),
      type: z.enum(['registration', 'followup', 'survey']),
      purpose: z.string().describe('What this form collects and why'),
      questions: z.array(z.object({
        id: z.string().describe('Unique snake_case identifier'),
        type: z.enum(QUESTION_TYPES).describe('Question type'),
        parentId: z.string().describe('Parent group/repeat id, empty for top-level'),
        sortOrder: z.number().describe('Order within parent (0-based)'),
        label: z.string().describe('Question label, empty for hidden'),
        hint: z.string().describe('Hint text, empty if none'),
        help: z.string().describe('Help text, empty if none'),
        required: z.string().describe('"true()" or XPath, empty if not required'),
        readonly: z.boolean().describe('True for display-only preloaded values'),
        constraint: z.string().describe('XPath constraint, empty if none'),
        constraint_msg: z.string().describe('Constraint error message, empty if none'),
        relevant: z.string().describe('XPath visibility condition, empty if always shown'),
        calculate: z.string().describe('XPath computed value, empty if none'),
        default_value: z.string().describe('XPath initial value, empty if none'),
        case_property: z.string().describe('Case property name, empty if none'),
        is_case_name: z.boolean().describe('True if this provides the case name'),
        options: z.array(z.object({ value: z.string(), label: z.string() })).describe('For select types, empty array otherwise'),
      })),
      close_case: z.object({
        question: z.string().describe('Question id, empty if no close or unconditional'),
        answer: z.string().describe('Trigger value, empty if no close or unconditional'),
      }),
      child_cases: z.array(z.object({
        case_type: z.string(),
        case_name_field: z.string(),
        case_properties: z.array(z.object({ case_property: z.string(), question_id: z.string() })),
        relationship: z.enum(['child', 'extension']),
        repeat_context: z.string().describe('Repeat group id, empty if not in repeat'),
      })).describe('Empty array if no child cases'),
    })),
  })),
})

const size = JSON.stringify(z.toJSONSchema(schema)).length
console.log(`Combined schema: ${size} chars. Testing...`)

const controller = new AbortController()
const timer = setTimeout(() => { console.log('TIMEOUT'); controller.abort(); process.exit(1) }, 90000)

generateText({
  model: anthropic('claude-haiku-4-5-20251001'),
  output: Output.object({ schema }),
  system: 'Produce minimal valid output.',
  prompt: '1 module "Patients" with case type "patient" (properties: full_name text, age int), 1 registration form with 2 questions.',
  maxOutputTokens: 1024,
  abortSignal: controller.signal,
}).then(r => {
  clearTimeout(timer)
  console.log(`PASS (${r.usage.inputTokens}/${r.usage.outputTokens} tokens)`)
}).catch(e => {
  clearTimeout(timer)
  console.log('FAIL:', (e.responseBody ?? e.message ?? '').slice(0, 300))
  process.exit(1)
})
