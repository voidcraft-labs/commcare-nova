import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  createAgentUIStream,
  type UIMessage,
} from 'ai'
import { DEFAULT_PIPELINE_CONFIG } from '@/lib/models'
import type { PipelineConfig } from '@/lib/types/settings'
import { GenerationContext } from '@/lib/services/generationContext'
import { RunLogger } from '@/lib/services/runLogger'
import { createSolutionsArchitect } from '@/lib/services/solutionsArchitect'
import { MutableBlueprint } from '@/lib/services/mutableBlueprint'
import { chatRequestSchema } from '@/lib/schemas/apiSchemas'

export const maxDuration = 300

// ── Route Handler ──────────────────────────────────────────────────────

export async function POST(req: Request) {
  const body = await req.json()

  // Messages come from the AI SDK's useChat — typed but not schema-validated
  const messages: UIMessage[] = body.messages
  if (!Array.isArray(messages)) {
    return new Response(JSON.stringify({ error: 'Missing messages array' }), { status: 400 })
  }

  // Validate our fields (apiKey, blueprint, pipelineConfig, etc.)
  const parsed = chatRequestSchema.safeParse(body)
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: 'Invalid request body' }), { status: 400 })
  }
  const { apiKey, blueprint, runId, pipelineConfig: rawPipelineConfig } = parsed.data
  const pipelineConfig: PipelineConfig = { ...DEFAULT_PIPELINE_CONFIG, ...rawPipelineConfig }

  const logger = new RunLogger(runId)
  logger.setAgent('Solutions Architect')
  logger.logConversation(messages)

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      // Send runId to client so it can send it back on subsequent requests
      writer.write({ type: 'data-run-id', data: { runId: logger.runId }, transient: true })
      const ctx = new GenerationContext(apiKey, writer, logger, pipelineConfig)

      // Create MutableBlueprint — either from existing blueprint (edit/continuation) or empty (new build)
      const mutableBp = new MutableBlueprint(
        blueprint ?? { app_name: '', modules: [], case_types: null }
      )

      const sa = createSolutionsArchitect(ctx, mutableBp)

      const agentStream = await createAgentUIStream({
        agent: sa,
        uiMessages: messages,
      })
      writer.merge(agentStream)
    },
    onFinish() {
      logger.finalize()
    },
    onError: (error) => {
      console.error('[chat] stream error:', error)
      return error instanceof Error ? error.message : String(error)
    },
  })

  return createUIMessageStreamResponse({ stream })
}
