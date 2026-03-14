import { generateText, Output } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { z } from 'zod'
import { appContentSchema } from '../lib/schemas/appContentSchema'

const apiKey = process.env.ANTHROPIC_API_KEY
if (!apiKey) { console.error('Set ANTHROPIC_API_KEY'); process.exit(1) }

const anthropic = createAnthropic({ apiKey })

const model = process.argv[2] === 'opus' ? 'claude-opus-4-6' : 'claude-haiku-4-5-20251001'

const size = JSON.stringify(z.toJSONSchema(appContentSchema)).length
console.log(`Production appContentSchema: ${size} chars. Testing with ${model}...`)

const controller = new AbortController()
const timer = setTimeout(() => { console.log('TIMEOUT'); controller.abort(); process.exit(1) }, 180000)

generateText({
  model: anthropic(model),
  output: Output.object({ schema: appContentSchema }),
  system: 'Produce minimal valid output.',
  prompt: '1 module "Patients" with 1 registration form with 2 questions (patient_name text, age int).',
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
