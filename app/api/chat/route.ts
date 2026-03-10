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
import { MODEL_PM } from '@/lib/models'
import { GenerationContext } from '@/lib/services/generationContext'
import { createArchitectAgent, createEditArchitectAgent, BlueprintAccumulator } from '@/lib/services/architectAgent'
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

/** Summarize what the architect generated so the PM knows what was built. */
function summarizeGeneration(appName: string, accumulator: BlueprintAccumulator): string {
  const scaffold = accumulator.scaffold
  if (!scaffold) return 'Generation completed but no scaffold was produced.'

  const lines = [`Generated "${appName}": ${scaffold.modules.length} modules, ${scaffold.case_types?.length ?? 0} case types.`]

  for (const ct of scaffold.case_types ?? []) {
    lines.push(`  Case type "${ct.name}": ${ct.properties.length} properties, name field: ${ct.case_name_property}`)
  }

  for (let mIdx = 0; mIdx < scaffold.modules.length; mIdx++) {
    const sm = scaffold.modules[mIdx]
    const mc = accumulator.moduleContents[mIdx]
    const colCount = mc?.case_list_columns?.length ?? 0
    lines.push(`  Module ${mIdx} "${sm.name}" (${sm.case_type ?? 'survey'}): ${colCount} columns, ${sm.forms.length} forms`)

    for (let fIdx = 0; fIdx < sm.forms.length; fIdx++) {
      const sf = sm.forms[fIdx]
      const fc = accumulator.formContents[mIdx]?.[fIdx]
      const qCount = fc?.questions?.length ?? 0
      lines.push(`    Form "${sf.name}" (${sf.type}): ${qCount} questions`)
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
  const { messages, apiKey, blueprint, blueprintSummary } = await req.json() as {
    messages: UIMessage[]
    apiKey: string
    blueprint?: AppBlueprint
    blueprintSummary?: string
  }

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      const ctx = new GenerationContext(apiKey, writer)
      const pmInstructions = buildProductManagerPrompt(blueprintSummary)

      const productManager = new ToolLoopAgent({
        model: ctx.model(MODEL_PM),
        instructions: pmInstructions,
        tools: {
          askQuestions: {
            description: 'Ask the user clarifying questions about their app requirements. Each call can hold up to 5 questions.',
            inputSchema: askQuestionsSchema,
            // No execute → client-side tool, agent stops for user input
          },
          generateApp: tool({
            description: 'Generate the CommCare app from the specification. Call when you have enough information.',
            inputSchema: generateAppSchema,
            execute: async ({ appName, appSpecification }, { abortSignal }) => {
              ctx.emit('data-planning', {})
              const accumulator = new BlueprintAccumulator()
              const architect = createArchitectAgent(ctx, accumulator)
              const result = await architect.stream({
                prompt: `Design and generate a CommCare app called "${appName}".\n\nSpecification:\n${appSpecification}`,
                abortSignal,
              })
              await drainStream(result.toUIMessageStream())
              return summarizeGeneration(appName, accumulator)
            },
          }),
          editApp: tool({
            description: 'Edit the existing CommCare app blueprint. Call when the user requests changes to the generated app.',
            inputSchema: editAppSchema,
            execute: async ({ editInstructions }, { abortSignal }) => {
              if (!blueprint) return 'Error: No blueprint available to edit.'
              ctx.emit('data-editing', {})
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
        onStepFinish: ({ usage, text, toolCalls, toolResults }) => {
          if (usage) {
            ctx.emitUsage('Product Manager', MODEL_PM, usage, { system: pmInstructions, message: messages }, { text, toolCalls, toolResults })
          }
        },
      })
      writer.merge(agentStream)
    },
    onError: (error) => error instanceof Error ? error.message : String(error),
  })

  return createUIMessageStreamResponse({ stream })
}
