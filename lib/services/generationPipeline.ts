/**
 * Generation Pipeline — programmatic scaffold → content → assemble → validate.
 *
 * Replaces the generation-mode architect agent. The sequence is always the same —
 * no LLM decides "what to do next" when there's only one possible next step.
 * The only LLM calls are inside generateScaffold (Sonnet) and generateAppContent (Opus).
 */
import { z } from 'zod'
import { MODEL_GENERATION, MODEL_APP_CONTENT } from '../models'
import { GenerationContext } from './generationContext'
import { scaffoldPrompt } from '../prompts/scaffoldPrompt'
import { appContentPrompt } from '../prompts/appContentPrompt'
import { loadKnowledge, resolveConditionalKnowledge } from './commcare/knowledge/loadKnowledge'
import {
  scaffoldSchema,
  assembleBlueprint,
  type Scaffold, type AppBlueprint, type BlueprintForm,
} from '../schemas/blueprint'
import {
  appContentSchema,
  processContentOutput,
  processSingleFormOutput,
  buildQuestionTree,
  type AppContentOutput, type ModuleContentOutput,
} from '../schemas/appContentSchema'
import { validateAndFix } from './architectAgent'

// ── Types ────────────────────────────────────────────────────────────

export interface PipelineResult {
  success: boolean
  blueprint: AppBlueprint
  hqJson?: Record<string, any>
}

// ── Progress tracking for streaming ──────────────────────────────────

interface ContentProgressState {
  emittedModuleColumns: Set<number>
  emittedFormQuestionCounts: Map<string, number>
  phaseSwitchedToForms: boolean
}

/**
 * Walk partial structured output and emit data events as modules and forms
 * become complete in the stream.
 */
function emitContentProgress(
  ctx: GenerationContext,
  partial: Partial<AppContentOutput>,
  scaffold: Scaffold,
  state: ContentProgressState,
) {
  if (!partial.modules) return
  const caseTypes = scaffold.case_types ?? []

  for (const modOutput of partial.modules as Partial<ModuleContentOutput>[]) {
    if (modOutput?.moduleIndex == null) continue
    const mIdx = modOutput.moduleIndex

    // Emit data-module-done when columns first appear
    if (
      modOutput.case_list_columns !== undefined &&
      !state.emittedModuleColumns.has(mIdx)
    ) {
      state.emittedModuleColumns.add(mIdx)
      ctx.emit('data-module-done', {
        moduleIndex: mIdx,
        caseListColumns: modOutput.case_list_columns ?? null,
      })
    }

    // Emit form progress as questions accumulate
    if (!modOutput.forms) continue
    for (const formOutput of modOutput.forms as any[]) {
      if (!formOutput?.questions?.length) continue
      const fIdx = formOutput.formIndex ?? 0
      const key = `${mIdx}-${fIdx}`
      const prevCount = state.emittedFormQuestionCounts.get(key) ?? 0
      const currCount = formOutput.questions.length

      if (currCount > prevCount) {
        // Switch to forms phase on first question
        if (!state.phaseSwitchedToForms) {
          state.phaseSwitchedToForms = true
          ctx.emit('data-phase', { phase: 'forms' })
        }

        state.emittedFormQuestionCounts.set(key, currCount)

        // Convert flat questions to nested for the client
        const ct = caseTypes.find(c => c.name === scaffold.modules[mIdx]?.case_type) ?? null
        const nestedQuestions = buildQuestionTree(formOutput.questions)
        const scaffoldForm = scaffold.modules[mIdx]?.forms[fIdx]

        ctx.emit('data-form-done', {
          moduleIndex: mIdx,
          formIndex: fIdx,
          form: {
            name: scaffoldForm?.name ?? `Form ${fIdx}`,
            type: scaffoldForm?.type ?? 'survey',
            questions: nestedQuestions,
            ...(formOutput.close_case && { close_case: formOutput.close_case }),
            ...(formOutput.child_cases && { child_cases: formOutput.child_cases }),
          },
        })
      }
    }
  }
}

// ── Pipeline ─────────────────────────────────────────────────────────

export async function runGenerationPipeline(
  ctx: GenerationContext,
  specification: string,
  appName: string,
): Promise<PipelineResult> {

  // ── Step 1: Scaffold (Sonnet, structured output, streamed) ─────────
  ctx.emit('data-phase', { phase: 'designing' })

  const scaffoldFiles = resolveConditionalKnowledge('scaffold', { specification })
  const scaffoldKnowledge = await loadKnowledge(...scaffoldFiles)

  const scaffold = await ctx.streamGenerate(scaffoldSchema, {
    model: MODEL_APP_CONTENT,
    thinking: true,
    system: scaffoldPrompt(scaffoldKnowledge),
    prompt: specification,
    label: 'Scaffold',
    knowledge: scaffoldFiles,
    maxOutputTokens: 16384,
    onPartial: (partial) => ctx.emit('data-partial-scaffold', partial),
  })

  if (!scaffold) {
    ctx.emit('data-error', { message: 'Scaffold generation returned no output' })
    return { success: false, blueprint: { app_name: appName, modules: [], case_types: null } }
  }

  ctx.emit('data-scaffold', scaffold)
  ctx.emit('data-phase', { phase: 'modules' })

  // ── Step 2: App content (Opus, structured output, streamed) ────────

  // Load knowledge: combine module + form conditional sets
  const moduleFiles = resolveConditionalKnowledge('module', { specification })
  const formFiles = resolveConditionalKnowledge('form', { specification })
  const allContentFiles = [...new Set([...moduleFiles, ...formFiles])]
  const [contentKnowledge, examples] = await Promise.all([
    allContentFiles.length > 0 ? loadKnowledge(...allContentFiles) : Promise.resolve(undefined),
    loadKnowledge('form-design-examples'),
  ])

  const contentPrompt = appContentPrompt({
    scaffold,
    knowledge: contentKnowledge,
    examples,
  })

  const progressState: ContentProgressState = {
    emittedModuleColumns: new Set(),
    emittedFormQuestionCounts: new Map(),
    phaseSwitchedToForms: false,
  }

  const content = await ctx.streamGenerate(appContentSchema, {
    model: MODEL_APP_CONTENT,
    thinking: true,
    system: contentPrompt,
    prompt: `Build complete content for all ${scaffold.modules.length} modules in "${scaffold.app_name}".`,
    label: 'App Content',
    knowledge: allContentFiles.length > 0 ? allContentFiles : undefined,
    maxOutputTokens: 32768,
    onPartial: (partial) => emitContentProgress(ctx, partial, scaffold, progressState),
  })

  if (!content) {
    ctx.emit('data-error', { message: 'App content generation returned no output' })
    return { success: false, blueprint: { app_name: appName, modules: [], case_types: null } }
  }

  // ── Step 3: Assemble (pure function) ───────────────────────────────
  const { moduleContents, formContents } = processContentOutput(content, scaffold)
  const blueprint = assembleBlueprint(scaffold, moduleContents, formContents)

  // ── Step 4: Validate + fix (programmatic) ──────────────────────────
  const result = await validateAndFix(ctx, blueprint)

  ctx.emit('data-done', {
    blueprint: result.blueprint,
    hqJson: result.hqJson ?? {},
    success: result.success,
  })

  return result
}

// ── Single-form generation (for edit mode regenerateForm + validate empty form fallback) ──

/** Schema for single-form generation — no nullable, no optional, empty values instead. */
const singleFormSchema = z.object({
  questions: z.array(z.object({
    id: z.string(),
    type: z.string(),
    parentId: z.string(),
    sortOrder: z.number(),
    label: z.string(),
    hint: z.string(),
    help: z.string(),
    required: z.string(),
    readonly: z.boolean(),
    constraint: z.string(),
    constraint_msg: z.string(),
    relevant: z.string(),
    calculate: z.string(),
    default_value: z.string(),
    case_property: z.string(),
    is_case_name: z.boolean(),
    options: z.array(z.object({ value: z.string(), label: z.string() })),
  })),
  close_case: z.object({
    question: z.string(),
    answer: z.string(),
  }),
  child_cases: z.array(z.object({
    case_type: z.string(),
    case_name_field: z.string(),
    case_properties: z.array(z.object({ case_property: z.string(), question_id: z.string() })),
    relationship: z.enum(['child', 'extension']),
    repeat_context: z.string(),
  })),
})

/**
 * Generate content for a single form using Opus structured output.
 * Returns a BlueprintForm with nested questions.
 */
export async function generateSingleFormContent(
  ctx: GenerationContext,
  blueprint: AppBlueprint,
  moduleIndex: number,
  formIndex: number,
  instructions: string,
): Promise<BlueprintForm> {
  const mod = blueprint.modules[moduleIndex]
  const form = mod.forms[formIndex]
  const caseTypes = blueprint.case_types ?? []
  const ct = caseTypes.find(c => c.name === mod.case_type) ?? null

  const dataModel = ct
    ? `Case type: ${ct.name} (case_name_property: ${ct.case_name_property})\nProperties:\n${ct.properties.map(p => {
        const parts = [p.name]
        if (p.data_type) parts.push(`(${p.data_type})`)
        if (p.label) parts.push(`— ${p.label}`)
        return `  - ${parts.join(' ')}`
      }).join('\n')}`
    : 'No case type (survey)'

  const siblingForms = mod.forms.map(f => `"${f.name}" (${f.type})`).join(', ')

  const result = await ctx.generate(singleFormSchema, {
    model: MODEL_APP_CONTENT,
    thinking: true,
    system: `You are a senior CommCare form builder. Build the questions for a single form.

Questions use a flat structure: parentId (null for top-level, group id for nested) and sortOrder (0-based within parent).

For case wiring: registration forms save to case properties, followup forms preload from case using default_value with #case/property_name.
Use readonly: true for display-only preloaded values. Use groups for visual sections. Calculate don't ask for derived values.
Use raw XPath operators (>, <), never HTML-escaped. Reference questions by /data/question_id.`,
    prompt: `App: "${blueprint.app_name}"
Module: "${mod.name}"
Form: "${form.name}" (${form.type})
Sibling forms: ${siblingForms}

${dataModel}

## Instructions
${instructions}

Build the complete questions for this form.`,
    label: `Regenerate form "${form.name}"`,
    maxOutputTokens: 16384,
  })

  if (!result) {
    return { name: form.name, type: form.type, questions: [] }
  }

  return processSingleFormOutput(
    { formIndex, questions: result.questions, close_case: result.close_case, child_cases: result.child_cases },
    form.name,
    form.type,
    ct,
  )
}
