import { generateText, Output } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { z } from 'zod'

const apiKey = process.env.ANTHROPIC_API_KEY
if (!apiKey) { console.error('Set ANTHROPIC_API_KEY'); process.exit(1) }

const anthropic = createAnthropic({ apiKey })

// Full app content schema — describes, enum, all fields, NO nullable/optional
const schema = z.object({
  modules: z.array(z.object({
    moduleIndex: z.number().describe('0-based, matching scaffold order'),
    case_list_columns: z.array(z.object({
      field: z.string().describe('Case property name or "case_name"'),
      header: z.string().describe('Column header text — short and scannable'),
    })).describe('Empty array for survey-only modules'),
    case_detail_columns: z.array(z.object({
      field: z.string().describe('Case property name or "case_name"'),
      header: z.string().describe('Column header text'),
    })).describe('Empty array to mirror case_list_columns'),
    forms: z.array(z.object({
      formIndex: z.number().describe('0-based, matching scaffold order'),
      questions: z.array(z.object({
        id: z.string().describe('Unique snake_case identifier'),
        type: z.enum([
          'text', 'int', 'date', 'select1', 'select', 'geopoint', 'image',
          'barcode', 'decimal', 'trigger', 'phone', 'time', 'datetime',
          'audio', 'video', 'signature', 'hidden', 'secret', 'group', 'repeat',
        ]).describe('Question type'),
        parentId: z.string().describe('Parent group/repeat id, or empty string for top-level'),
        sortOrder: z.number().describe('Order within parent (0-based)'),
        label: z.string().describe('Question label text, empty for hidden'),
        hint: z.string().describe('Short hint below question, empty if none'),
        help: z.string().describe('Extended help text, empty if none'),
        required: z.string().describe('"true()" or XPath condition, empty if not required'),
        readonly: z.boolean().describe('True for display-only preloaded values'),
        constraint: z.string().describe('XPath constraint, empty if none'),
        constraint_msg: z.string().describe('Error message when constraint fails, empty if none'),
        relevant: z.string().describe('XPath visibility condition, empty if always shown'),
        calculate: z.string().describe('XPath computed value, empty if none'),
        default_value: z.string().describe('XPath one-time initial value, empty if none'),
        case_property: z.string().describe('Case property name this maps to, empty if none'),
        is_case_name: z.boolean().describe('True if this provides the case name'),
        options: z.array(z.object({
          value: z.string(),
          label: z.string(),
        })).describe('For select1/select, empty array for other types'),
      })).describe('All questions, using parentId for nesting and sortOrder for ordering'),
      close_case: z.object({
        question: z.string().describe('Question id for conditional close, empty if unconditional or no close'),
        answer: z.string().describe('Value that triggers closure, empty if unconditional or no close'),
      }).describe('Empty strings = no close case. Both empty but present = unconditional. Both set = conditional.'),
      child_cases: z.array(z.object({
        case_type: z.string(),
        case_name_field: z.string().describe('Question id for child case name'),
        case_properties: z.array(z.object({ case_property: z.string(), question_id: z.string() })),
        relationship: z.enum(['child', 'extension']),
        repeat_context: z.string().describe('Repeat group question id, empty if not in repeat'),
      })).describe('Empty array if no child cases'),
    })),
  })),
})

const size = JSON.stringify(z.toJSONSchema(schema)).length
console.log(`Full schema with describes + enum, no nullable/optional: ${size} chars. Testing...`)

const controller = new AbortController()
const timer = setTimeout(() => { console.log('TIMEOUT'); controller.abort(); process.exit(1) }, 90000)

generateText({
  model: anthropic('claude-haiku-4-5-20251001'),
  output: Output.object({ schema }),
  system: 'Produce minimal valid output.',
  prompt: '1 module, 1 registration form, 3 questions, case type patient.',
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
