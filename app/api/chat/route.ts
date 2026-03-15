import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  createAgentUIStream,
  ToolLoopAgent,
  tool,
  type UIMessage,
} from 'ai'
import { z } from 'zod'
import { buildProductManagerPrompt } from '@/lib/prompts/productManagerPrompt'
import { DEFAULT_PIPELINE_CONFIG } from '@/lib/models'
import type { PipelineConfig } from '@/lib/types/settings'
import { GenerationContext, thinkingProviderOptions, withPromptCaching } from '@/lib/services/generationContext'
import { RunLogger } from '@/lib/services/runLogger'
import { createEditArchitectAgent } from '@/lib/services/architectAgent'
import { runGenerationPipeline } from '@/lib/services/generationPipeline'
import { MutableBlueprint } from '@/lib/services/mutableBlueprint'
import { summarizeBlueprint, type AppBlueprint } from '@/lib/schemas/blueprint'

export const maxDuration = 300

// ── Schemas ────────────────────────────────────────────────────────────

const askQuestionsSchema = z.object({
  header: z.string().describe('Short header for this group of questions'),
  questions: z.array(
    z.object({
      question: z.string(),
      options: z.array(
        z.object({
          label: z.string(),
          description: z.string().optional(),
        })
      ),
    })
  ),
})

const generateAppSchema = z.object({
  appName: z.string().describe('Short app name (2-5 words)'),
  appSpecification: z.string().describe(
    'Plain English description of the app: business workflows, data to collect, user roles, and requirements. ' +
    'Do NOT include technical details like property names, case types, or form structures.'
  ),
})

const editAppSchema = z.object({
  editInstructions: z.string().describe(
    'Plain English description of what to change. Reference specific modules, forms, or questions by name.'
  ),
})

// ── Helpers ─────────────────────────────────────────────────────────────

/** Summarize what the pipeline generated so the PM knows what was built. */
function summarizePipelineResult(appName: string, blueprint: AppBlueprint): string {
  const lines = [`Generated "${appName}": ${blueprint.modules.length} modules, ${blueprint.case_types?.length ?? 0} case types.`]

  for (const ct of blueprint.case_types ?? []) {
    lines.push(`  Case type "${ct.name}": ${ct.properties.length} properties, name field: ${ct.case_name_property}`)
  }

  for (let mIdx = 0; mIdx < blueprint.modules.length; mIdx++) {
    const mod = blueprint.modules[mIdx]
    const colCount = mod.case_list_columns?.length ?? 0
    lines.push(`  Module ${mIdx} "${mod.name}" (${mod.case_type ?? 'survey'}): ${colCount} columns, ${mod.forms.length} forms`)

    for (const form of mod.forms) {
      const qCount = form.questions?.length ?? 0
      lines.push(`    Form "${form.name}" (${form.type}): ${qCount} questions`)
    }
  }

  return lines.join('\n')
}

/** Build the edit task prompt for the edit-mode architect. */
function buildEditTaskPrompt(editInstructions: string, blueprintSummary: string): string {
  return `Edit the existing CommCare app.

## Current App Structure
${blueprintSummary}

## Edit Instructions
${editInstructions}

Search the blueprint to find the relevant elements, make the required changes, then validate.`
}

/** Summarize the edited blueprint so the PM knows what changed. */
function summarizeEditResult(blueprint: AppBlueprint): string {
  const lines = [`Edited "${blueprint.app_name}": ${blueprint.modules.length} modules.`]
  for (let mIdx = 0; mIdx < blueprint.modules.length; mIdx++) {
    const mod = blueprint.modules[mIdx]
    const colCount = mod.case_list_columns?.length ?? 0
    lines.push(`  Module ${mIdx} "${mod.name}" (${mod.case_type ?? 'survey'}): ${colCount} columns, ${mod.forms.length} forms`)
    for (let fIdx = 0; fIdx < mod.forms.length; fIdx++) {
      const form = mod.forms[fIdx]
      const qCount = form.questions?.length ?? 0
      lines.push(`    Form "${form.name}" (${form.type}): ${qCount} questions`)
    }
  }
  return lines.join('\n')
}

/** Consume a ReadableStream to drive execution to completion. */
async function drainStream(stream: ReadableStream): Promise<void> {
  const reader = stream.getReader()
  while (!(await reader.read()).done) {}
}

// ── Route Handler ──────────────────────────────────────────────────────

export async function POST(req: Request) {
  const { messages, apiKey, blueprint, blueprintSummary, runId, pipelineConfig: rawPipelineConfig } = await req.json() as {
    messages: UIMessage[]
    apiKey: string
    blueprint?: AppBlueprint
    blueprintSummary?: string
    runId?: string
    pipelineConfig?: Partial<PipelineConfig>
  }
  const pipelineConfig: PipelineConfig = { ...DEFAULT_PIPELINE_CONFIG, ...rawPipelineConfig }

  const logger = new RunLogger(runId)
  logger.setAgent('Product Manager')
  logger.logConversation(messages)

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      // Send runId to client so it can send it back on subsequent requests
      writer.write({ type: 'data-run-id', data: { runId: logger.runId }, transient: true })
      const ctx = new GenerationContext(apiKey, writer, logger, pipelineConfig)
      const pmInstructions = buildProductManagerPrompt(blueprintSummary)

      const pmReasoning = ctx.reasoningForStage('pm')
      const productManager = new ToolLoopAgent({
        model: ctx.model(pipelineConfig.pm.model),
        instructions: pmInstructions,
        ...(pmReasoning && { providerOptions: thinkingProviderOptions(pmReasoning.effort) }),
        ...withPromptCaching,
        tools: {
          askQuestions: {
            description: 'Ask the user clarifying questions about their app requirements. Each call can hold up to 5 questions.',
            inputSchema: askQuestionsSchema,
            // No execute → client-side tool, agent stops for user input
          },
          generateApp: tool({
            description: 'Generate the CommCare app from the specification. Call when you have enough information.',
            inputSchema: generateAppSchema,
            execute: async ({ appName, appSpecification }) => {
              logger.setAppName(appName)
              ctx.emit('data-planning', {})
              logger.setAgent('Generation Pipeline')

              const result = await runGenerationPipeline(ctx, appSpecification, appName)

              return summarizePipelineResult(appName, result.blueprint)
            },
          }),
          editApp: tool({
            description: 'Edit the existing CommCare app blueprint. Call when the user requests changes to the generated app.',
            inputSchema: editAppSchema,
            execute: async ({ editInstructions }, { abortSignal }) => {
              if (!blueprint) return 'Error: No blueprint available to edit.'
              logger.setAppName(blueprint.app_name)
              ctx.emit('data-editing', {})
              logger.setAgent('Edit Architect')
              const mutableBp = new MutableBlueprint(blueprint)
              const editArchitect = createEditArchitectAgent(ctx, mutableBp)
              const result = await editArchitect.stream({
                prompt: buildEditTaskPrompt(editInstructions, summarizeBlueprint(blueprint)),
                abortSignal,
              })
              await drainStream(result.toUIMessageStream())
              return summarizeEditResult(mutableBp.getBlueprint())
            },
          }),
        },
      })

      const agentStream = await createAgentUIStream({
        agent: productManager,
        uiMessages: messages,
        onStepFinish: ({ usage, text, reasoningText, toolCalls, toolResults, warnings }) => {
          if (warnings?.length) {
            for (const w of warnings) console.warn('[PM step] warning:', w)
          }
          if (usage) {
            logger.logEvent({
              type: 'orchestration',
              agent: 'Product Manager',
              label: 'PM step',
              model: pipelineConfig.pm.model,
              input_tokens: usage.inputTokens ?? 0,
              output_tokens: usage.outputTokens ?? 0,
              cache_read_tokens: usage.inputTokenDetails?.cacheReadTokens ?? undefined,
              cache_write_tokens: usage.inputTokenDetails?.cacheWriteTokens ?? undefined,
              output: { text, ...(reasoningText && { reasoningText }), toolResults },
              tool_calls: toolCalls?.map((tc: any) => ({ name: tc.toolName, args: tc.input })),
            })
          }
        },
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
