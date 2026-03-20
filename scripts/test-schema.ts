import { generateText, Output } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { z } from 'zod'

const apiKey = process.env.ANTHROPIC_API_KEY
if (!apiKey) { console.error('Set ANTHROPIC_API_KEY'); process.exit(1) }

const anthropic = createAnthropic({ apiKey })
const model = process.argv[2] === 'opus' ? 'claude-opus-4-6' : 'claude-haiku-4-5-20251001'

const QUESTION_TYPES = [
  'text', 'int', 'date', 'single_select', 'multi_select', 'geopoint', 'image',
  'barcode', 'decimal', 'label', 'phone', 'time', 'datetime',
  'audio', 'video', 'signature', 'hidden', 'secret', 'group', 'repeat',
] as const

const singleFormSchema = z.object({
  questions: z.array(z.object({
    id: z.string(),
    type: z.enum(QUESTION_TYPES),
    parentId: z.string(),
    label: z.string(),
    required: z.string(),
    case_property: z.string(),
    is_case_name: z.boolean(),
    hint: z.string().optional(),
    help: z.string().optional(),
    constraint: z.string().optional(),
    constraint_msg: z.string().optional(),
    relevant: z.string().optional(),
    calculate: z.string().optional(),
    default_value: z.string().optional(),
    options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  })),
  close_case: z.object({ question: z.string(), answer: z.string() }),
  child_cases: z.array(z.object({
    case_type: z.string(),
    case_name_field: z.string(),
    case_properties: z.array(z.object({ case_property: z.string(), question_id: z.string() })),
    relationship: z.enum(['child', 'extension']),
    repeat_context: z.string(),
  })),
})

const size = JSON.stringify(z.toJSONSchema(singleFormSchema)).length
console.log(`singleFormSchema (with type enum): ${size} chars`)
console.log(`Testing with ${model}...`)

const controller = new AbortController()
const timer = setTimeout(() => { console.log('TIMEOUT (180s)'); controller.abort(); process.exit(1) }, 180000)

generateText({
  model: anthropic(model),
  output: Output.object({ schema: singleFormSchema }),
  system: 'Produce minimal valid output.',
  prompt: 'A registration form with 2 questions: patient_name (text) and age (int).',
  maxOutputTokens: 1024,
  abortSignal: controller.signal,
}).then(r => {
  clearTimeout(timer)
  console.log(`PASS (${r.usage.inputTokens}/${r.usage.outputTokens} tokens)`)
}).catch(e => {
  clearTimeout(timer)
  console.log('FAIL:', (e.responseBody ?? e.message ?? '').slice(0, 500))
  process.exit(1)
})
