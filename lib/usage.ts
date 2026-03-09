import { MODEL_PRICING, DEFAULT_PRICING } from './models'

/** Token usage metadata returned from Claude API calls. */
export interface ClaudeUsage {
  model: string
  input_tokens: number
  output_tokens: number
  stop_reason: string | null
  /** The input sent to Claude. */
  input?: { system: string; message: unknown; tools?: unknown }
  /** The parsed output returned by Claude. */
  output?: unknown
}

/** Estimate token count from a value's serialized size (~4 chars/token). */
function estimateTokens(value: unknown): number {
  if (value == null) return 0
  const chars = typeof value === 'string' ? value.length : (JSON.stringify(value) ?? '').length
  return Math.ceil(chars / 4)
}

/** Format an estimated token count label. */
function tkns(value: unknown): string {
  return `~${estimateTokens(value).toLocaleString()} tkns`
}

/** Log Claude API usage to the browser console as an expandable table. */
export function logUsage(label: string, calls: ClaudeUsage[]) {
  const rows = calls.map(c => {
    const pricing = MODEL_PRICING[c.model] ?? DEFAULT_PRICING
    const cost = (c.input_tokens * pricing.input + c.output_tokens * pricing.output) / 1_000_000
    return {
      model: c.model,
      input_tokens: c.input_tokens,
      output_tokens: c.output_tokens,
      stop_reason: c.stop_reason,
      est_cost: `$${cost.toFixed(4)}`,
    }
  })

  const totalInput = calls.reduce((s, c) => s + c.input_tokens, 0)
  const totalOutput = calls.reduce((s, c) => s + c.output_tokens, 0)
  const totalCost = rows.reduce((s, r) => s + parseFloat(r.est_cost.slice(1)), 0)

  console.groupCollapsed(
    `%c⚡ ${label}%c — ${calls.length} call${calls.length !== 1 ? 's' : ''}, ${totalInput.toLocaleString()} in / ${totalOutput.toLocaleString()} out, ~$${totalCost.toFixed(4)}`,
    'color: #a78bfa; font-weight: bold',
    'color: #888'
  )
  console.table(rows)

  for (let i = 0; i < calls.length; i++) {
    const c = calls[i]
    if (c.input || c.output) {
      console.groupCollapsed(`Call ${i + 1}: ${c.model}`)
      if (c.input) {
        console.log(`%cInput (system) %c${tkns(c.input.system)}`, 'color: #67e8f9', 'color: #666', c.input.system)
        console.log(`%cInput (message) %c${tkns(c.input.message)}`, 'color: #67e8f9', 'color: #666', c.input.message)
        if (c.input.tools) {
          console.log(`%cInput (tools) %c${tkns(c.input.tools)}`, 'color: #f59e0b', 'color: #666', c.input.tools)
        }
      }
      if (c.output) {
        console.log(`%cOutput %c${tkns(c.output)}`, 'color: #34d399', 'color: #666', c.output)
      }
      console.groupEnd()
    }
  }

  console.groupEnd()
}
