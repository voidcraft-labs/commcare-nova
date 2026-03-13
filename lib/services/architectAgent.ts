/**
 * Solutions Architect Agent — orchestrates blueprint generation and editing.
 *
 * Two agent constructors:
 *   - createArchitectAgent: Generation mode — scaffold → modules → forms → assemble → validate
 *   - createEditArchitectAgent: Edit mode — search → get → edit → validate (operates on MutableBlueprint)
 */
import { ToolLoopAgent, tool, hasToolCall, stepCountIs } from 'ai'
import { z } from 'zod'
import { MODEL_GENERATION } from '../models'
import { GenerationContext, withPromptCaching } from './generationContext'
import { ARCHITECT_PROMPT } from '../prompts/architectPrompt'
import { EDIT_ARCHITECT_PROMPT } from '../prompts/editArchitectPrompt'
import { scaffoldPrompt } from '../prompts/scaffoldPrompt'
import { modulePrompt } from '../prompts/modulePrompt'
import { loadKnowledge, resolveConditionalKnowledge } from './commcare/knowledge/loadKnowledge'
import { createFormBuilderAgent } from './formBuilderAgent'
import {
  scaffoldSchema, moduleContentSchema,
  assembleBlueprint,
  type Scaffold, type ModuleContent, type AppBlueprint, type BlueprintForm, type Question, type CaseType,
} from '../schemas/blueprint'
import { expandBlueprint, validateBlueprint } from './hqJsonExpander'
import { MutableBlueprint, type NewQuestion } from './mutableBlueprint'

// ── BlueprintAccumulator ──────────────────────────────────────────────

export class BlueprintAccumulator {
  scaffold: Scaffold | null = null
  specification: string = ''
  moduleContents: ModuleContent[] = []
  formContents: BlueprintForm[][] = []
  assembled: AppBlueprint | null = null

  setScaffold(s: Scaffold) {
    this.scaffold = s
    this.moduleContents = new Array(s.modules.length).fill({ case_list_columns: null, case_detail_columns: null })
    this.formContents = s.modules.map(m => new Array(m.forms.length))
  }

  setModuleContent(moduleIndex: number, mc: ModuleContent) {
    this.moduleContents[moduleIndex] = mc
  }

  setFormContent(moduleIndex: number, formIndex: number, form: BlueprintForm) {
    this.formContents[moduleIndex][formIndex] = form
  }
}

// ── Helper: count questions recursively ───────────────────────────────

function countQuestionsRecursive(questions: Question[]): number {
  let count = 0
  for (const q of questions) {
    count++
    if (q.children) count += countQuestionsRecursive(q.children)
  }
  return count
}

function collectCaseProperties(questions: Question[]): string[] {
  const props: string[] = []
  for (const q of questions) {
    if (q.case_property) props.push(q.case_property)
    if (q.children) props.push(...collectCaseProperties(q.children))
  }
  return props
}

function hasCaseNameQuestion(questions: Question[]): boolean {
  for (const q of questions) {
    if (q.is_case_name) return true
    if (q.children && hasCaseNameQuestion(q.children)) return true
  }
  return false
}

// ── Helper: build prompts for sub-calls ──────────────────────────────

function buildModulePrompt(scaffold: Scaffold, moduleIndex: number, feedback?: string): string {
  const sm = scaffold.modules[moduleIndex]

  let prompt = `App: "${scaffold.app_name}" — ${scaffold.description}

Module: "${sm.name}"
Case type: ${sm.case_type ?? 'none (survey-only)'}
Purpose: ${sm.purpose}
Forms: ${sm.forms.map(f => `"${f.name}" (${f.type})`).join(', ')}

Design the case list columns for this module.`

  if (feedback) {
    prompt += `\n\n## Revision Feedback\n${feedback}`
  }

  return prompt
}

function buildFormPrompt(scaffold: Scaffold, moduleIndex: number, formIndex: number, feedback?: string): string {
  const sm = scaffold.modules[moduleIndex]
  const sf = sm.forms[formIndex]

  let prompt = `App: "${scaffold.app_name}" — ${scaffold.description}

Module: "${sm.name}" (${sm.purpose})

Form: "${sf.name}"
Type: ${sf.type}
Purpose: ${sf.purpose}

Sibling forms in this module: ${sm.forms.map(f => `"${f.name}" (${f.type})`).join(', ')}

Design the questions for this form.`

  if (feedback) {
    prompt += `\n\n## Revision Feedback\n${feedback}`
  }

  return prompt
}

// ── Validate + fix loop ──────────────────────────────────────────────

export async function validateAndFix(
  ctx: GenerationContext,
  blueprint: AppBlueprint,
): Promise<{ success: boolean; blueprint: AppBlueprint; hqJson?: Record<string, any> }> {
  const recentErrorSignatures: string[] = []
  const MAX_STUCK_REPEATS = 3
  let attempt = 0

  ctx.emit('data-phase', { phase: 'validating' })

  while (true) {
    attempt++
    const errors = validateBlueprint(blueprint)

    if (errors.length === 0) {
      const hqJson = expandBlueprint(blueprint)
      return { success: true, blueprint, hqJson }
    }

    // Stuck detection
    const sig = errors.slice().sort().join('|||')
    recentErrorSignatures.push(sig)
    if (recentErrorSignatures.length > MAX_STUCK_REPEATS) recentErrorSignatures.shift()
    if (recentErrorSignatures.length === MAX_STUCK_REPEATS && recentErrorSignatures.every(s => s === sig)) {
      try {
        const hqJson = expandBlueprint(blueprint)
        return { success: false, blueprint, hqJson }
      } catch {
        return { success: false, blueprint }
      }
    }

    ctx.emit('data-phase', { phase: 'fixing' })
    ctx.emit('data-fix-attempt', { attempt, errorCount: errors.length })

    // Fix module-level errors programmatically
    for (const err of errors) {
      const match = err.match(/"([^"]+)" has case forms but no case_type/)
      if (match) {
        const modName = match[1]
        const mod = blueprint.modules.find(m => m.name === modName)
        if (mod && !mod.case_type) {
          mod.case_type = modName.toLowerCase().replace(/\s+/g, '_')
        }
      }
    }

    // Group errors by form and fix per-form
    const formErrors = groupErrorsByForm(errors, blueprint)

    for (const [formName, formErrs] of formErrors) {
      const [mIdx, fIdx] = findFormIndices(blueprint, formName)
      if (mIdx === -1) continue

      const form = blueprint.modules[mIdx].forms[fIdx]

      // "has no questions" — rebuild with form builder agent
      if (formErrs.some(e => e.includes('has no questions'))) {
        try {
          const mod = blueprint.modules[mIdx]
          const ctInfo = blueprint.case_types?.find(ct => ct.name === mod.case_type) ?? null
          const shell: AppBlueprint = {
            app_name: blueprint.app_name,
            case_types: blueprint.case_types,
            modules: [{
              name: mod.name,
              forms: [{ name: form.name, type: form.type, questions: [] }],
              ...(mod.case_type && { case_type: mod.case_type }),
            }],
          }
          const mb = new MutableBlueprint(shell)
          const formAgent = createFormBuilderAgent(ctx, mb, { caseType: ctInfo })
          await ctx.runAgent(formAgent, {
            prompt: `Form "${form.name}" (${form.type}) has no questions. Generate appropriate questions for this form.`,
            label: 'Form builder',
            agentName: 'Form Builder',
          })
          blueprint.modules[mIdx].forms[fIdx] = mb.getForm(0, 0)!
        } catch {
          // Rebuild failed, will be caught on next attempt
        }
        ctx.emit('data-form-fixed', { moduleIndex: mIdx, formIndex: fIdx, form: blueprint.modules[mIdx].forms[fIdx] })
        continue
      }

      // Apply programmatic fixes for all other errors
      applyProgrammaticFixes(form, formErrs)
      ctx.emit('data-form-fixed', { moduleIndex: mIdx, formIndex: fIdx, form })
    }
  }
}

function groupErrorsByForm(errors: string[], blueprint: AppBlueprint): Map<string, string[]> {
  const grouped = new Map<string, string[]>()
  for (const err of errors) {
    const match = err.match(/^"([^"]+)"/)
    if (match) {
      const name = match[1]
      const isForm = blueprint.modules.some(m => m.forms.some(f => f.name === name))
      if (isForm) {
        if (!grouped.has(name)) grouped.set(name, [])
        grouped.get(name)!.push(err)
      }
    }
  }
  return grouped
}

function findFormIndices(blueprint: AppBlueprint, formName: string): [number, number] {
  for (let mIdx = 0; mIdx < blueprint.modules.length; mIdx++) {
    for (let fIdx = 0; fIdx < blueprint.modules[mIdx].forms.length; fIdx++) {
      if (blueprint.modules[mIdx].forms[fIdx].name === formName) {
        return [mIdx, fIdx]
      }
    }
  }
  return [-1, -1]
}

// ── Programmatic form fixes ──────────────────────────────────────────

function applyProgrammaticFixes(form: BlueprintForm, errors: string[]): void {
  for (const err of errors) {
    // "is a registration form but has no case_name_field" — find best candidate and set is_case_name
    if (err.includes('has no case_name_field')) {
      const candidate = findCaseNameCandidate(form.questions)
      if (candidate) candidate.is_case_name = true
      continue
    }

    // "multiple questions have is_case_name" — keep first, clear rest
    if (err.includes('multiple questions have is_case_name')) {
      let found = false
      clearDuplicateCaseNames(form.questions, { found })
      continue
    }

    // "uses reserved case property name" — rename it
    const reservedMatch = err.match(/reserved case property name "(\w+)"/)
    if (reservedMatch) {
      const reserved = reservedMatch[1]
      renameReservedProperty(form.questions, reserved)
      continue
    }

    // "media question cannot be saved as case properties" — remove case_property
    if (err.includes('media/binary questions cannot be saved as case properties')) {
      const mediaMatch = err.match(/case property "(\w+)" maps to a (\w+) question/)
      if (mediaMatch) {
        const qWithProp = findQuestionByCaseProperty(form.questions, mediaMatch[1])
        if (qWithProp) delete qWithProp.case_property
      }
      continue
    }

    // "is a select but has no options" — add placeholder options
    const selectMatch = err.match(/Question "(\w+)".*is a select but has no options/)
    if (selectMatch) {
      const q = findQuestionById(form.questions, selectMatch[1])
      if (q) {
        q.options = [
          { value: 'option_1', label: 'Option 1' },
          { value: 'option_2', label: 'Option 2' },
        ]
      }
      continue
    }

    // "close_case references question which doesn't exist" — remove close_case
    if (err.includes('close_case references question') && err.includes("doesn't exist")) {
      delete form.close_case
      continue
    }

    // "close_case condition is missing" — remove close_case
    if (err.includes('close_case condition is missing')) {
      delete form.close_case
      continue
    }

    // "close_case but is not a followup form" — remove close_case
    if (err.includes('has close_case but is not a followup form')) {
      delete form.close_case
      continue
    }

    // child_cases errors — remove broken entries
    if (err.includes('child_cases')) {
      const idxMatch = err.match(/child_cases\[(\d+)\]/)
      if (idxMatch && form.child_cases) {
        const cIdx = parseInt(idxMatch[1])
        form.child_cases.splice(cIdx, 1)
        if (form.child_cases.length === 0) delete form.child_cases
      }
      continue
    }
  }
}

function findCaseNameCandidate(questions: Question[]): Question | null {
  // Prefer a question with case_property that looks like a name
  for (const q of questions) {
    if (q.case_property && /name/i.test(q.case_property) && q.type === 'text') return q
    if (q.children) {
      const found = findCaseNameCandidate(q.children)
      if (found) return found
    }
  }
  // Fallback: first question with a case_property
  for (const q of questions) {
    if (q.case_property) return q
    if (q.children) {
      const found = findCaseNameCandidate(q.children)
      if (found) return found
    }
  }
  return null
}

function clearDuplicateCaseNames(questions: Question[], state: { found: boolean }): void {
  for (const q of questions) {
    if (q.is_case_name) {
      if (state.found) {
        q.is_case_name = false
      } else {
        state.found = true
      }
    }
    if (q.children) clearDuplicateCaseNames(q.children, state)
  }
}

function renameReservedProperty(questions: Question[], reserved: string): void {
  for (const q of questions) {
    if (q.case_property === reserved) {
      q.case_property = `${reserved}_value`
    }
    if (q.children) renameReservedProperty(q.children, reserved)
  }
}

function findQuestionByCaseProperty(questions: Question[], prop: string): Question | null {
  for (const q of questions) {
    if (q.case_property === prop) return q
    if (q.children) {
      const found = findQuestionByCaseProperty(q.children, prop)
      if (found) return found
    }
  }
  return null
}

function findQuestionById(questions: Question[], id: string): Question | null {
  for (const q of questions) {
    if (q.id === id) return q
    if (q.children) {
      const found = findQuestionById(q.children, id)
      if (found) return found
    }
  }
  return null
}


// ── Create Solutions Architect Agent ──────────────────────────────────

export function createArchitectAgent(
  ctx: GenerationContext,
  accumulator: BlueprintAccumulator,
) {

  const agent = new ToolLoopAgent({
    model: ctx.model(MODEL_GENERATION),
    instructions: ARCHITECT_PROMPT,
    stopWhen: stepCountIs(50),
    ...withPromptCaching,
    onStepFinish: ({ usage, text, toolCalls, toolResults }) => {
      if (usage) {
        ctx.logger.logEvent({
          type: 'orchestration',
          agent: 'Solutions Architect',
          label: 'Orchestration step',
          model: MODEL_GENERATION,
          input_tokens: usage.inputTokens ?? 0,
          output_tokens: usage.outputTokens ?? 0,
          cache_read_tokens: usage.inputTokenDetails?.cacheReadTokens ?? undefined,
          cache_write_tokens: usage.inputTokenDetails?.cacheWriteTokens ?? undefined,
          output: { text, toolResults },
          tool_calls: toolCalls?.map((tc: any) => ({ name: tc.toolName, args: tc.input })),
        })
      }
    },
    tools: {
      generateScaffold: tool({
        description: 'Generate the app scaffold (data model + structure) from the specification.',
        inputSchema: z.object({
          specification: z.string().describe('Full app specification including app name, description, and all requirements'),
        }),
        execute: async ({ specification }) => {
          ctx.emit('data-phase', { phase: 'designing' })
          accumulator.specification = specification

          const files = resolveConditionalKnowledge('scaffold', { specification })
          const knowledge = await loadKnowledge(...files)
          const scaffold = await ctx.streamGenerate(scaffoldSchema, {
            system: scaffoldPrompt(knowledge),
            prompt: specification,
            label: 'Scaffold',
            knowledge: files,
            maxOutputTokens: 16384,
            onPartial: (partial) => ctx.emit('data-partial-scaffold', partial),
          })

          if (!scaffold) return { error: 'Scaffold generation returned no output' }

          accumulator.setScaffold(scaffold)
          ctx.emit('data-scaffold', scaffold)
          ctx.emit('data-phase', { phase: 'modules' })

          return {
            moduleCount: scaffold.modules.length,
            caseTypeCount: scaffold.case_types?.length ?? 0,
            modules: scaffold.modules.map(m => ({ name: m.name, case_type: m.case_type, formCount: m.forms.length })),
          }
        },
      }),

      generateModuleContent: tool({
        description: 'Generate case list columns for a module. Pass moduleIndex (0-based). Optionally pass feedback to request revision.',
        inputSchema: z.object({
          moduleIndex: z.number().describe('0-based index of the module in the scaffold'),
          feedback: z.string().optional().describe('Feedback for revision if re-calling'),
        }),
        execute: async ({ moduleIndex, feedback }) => {
          const scaffold = accumulator.scaffold!
          const sm = scaffold.modules[moduleIndex]
          if (!sm) return { error: `Module index ${moduleIndex} out of range` }

          // Survey-only modules don't need columns
          if (!sm.case_type) {
            const mc = { case_list_columns: null, case_detail_columns: null }
            accumulator.setModuleContent(moduleIndex, mc)
            ctx.emit('data-module-done', { moduleIndex, caseListColumns: null })
            return { moduleIndex, name: sm.name, columns: null }
          }

          try {
            const files = resolveConditionalKnowledge('module', {
              specification: accumulator.specification,
              formPurpose: sm.purpose,
            })
            const knowledge = await loadKnowledge(...files)

            // Dynamically constrain the column field to valid property names
            const ctInfo = scaffold.case_types?.find(ct => ct.name === sm.case_type)
            const propertyNames = ctInfo?.properties.map(p => p.name) ?? []
            const columnSchema = z.object({
              field: propertyNames.length > 0
                ? z.enum(['case_name', ...propertyNames] as [string, ...string[]])
                    .describe('Case property name to display')
                : z.string().describe('Case property name to display'),
              header: z.string().describe('Column header text'),
            })
            const dynamicModuleSchema = z.object({
              case_list_columns: z.array(columnSchema).nullable().describe('Columns for the case list. null for survey-only modules.'),
              case_detail_columns: z.array(columnSchema).nullable().describe(
                'Columns shown in the case detail view (when a user taps on a case). null to auto-mirror case_list_columns.'
              ),
            })

            const mc = await ctx.generate(dynamicModuleSchema, {
              system: modulePrompt(knowledge),
              prompt: buildModulePrompt(scaffold, moduleIndex, feedback),
              label: `Module ${moduleIndex} "${sm.name}"`,
              knowledge: files,
              maxOutputTokens: 4096,
            }) ?? { case_list_columns: null, case_detail_columns: null }

            accumulator.setModuleContent(moduleIndex, mc)
            ctx.emit('data-module-done', { moduleIndex, caseListColumns: mc.case_list_columns ?? null })

            return { moduleIndex, name: sm.name, columns: mc.case_list_columns ?? null }
          } catch (err) {
            const mc = { case_list_columns: null, case_detail_columns: null }
            accumulator.setModuleContent(moduleIndex, mc)
            ctx.emit('data-module-done', { moduleIndex, caseListColumns: null })
            return { error: `Module ${moduleIndex} "${sm.name}": generation failed (${err instanceof Error ? err.message : String(err)})`, moduleIndex, name: sm.name, columns: null }
          }
        },
      }),

      generateFormContent: tool({
        description: 'Generate questions and case config for a form. Pass moduleIndex and formIndex (0-based). Optionally pass feedback to request revision.',
        inputSchema: z.object({
          moduleIndex: z.number().describe('0-based index of the module'),
          formIndex: z.number().describe('0-based index of the form within the module'),
          feedback: z.string().optional().describe('Feedback for revision if re-calling'),
        }),
        execute: async ({ moduleIndex, formIndex, feedback }) => {
          const scaffold = accumulator.scaffold!
          const sm = scaffold.modules[moduleIndex]
          if (!sm) return { error: `Module index ${moduleIndex} out of range` }
          const sf = sm.forms[formIndex]
          if (!sf) return { error: `Form index ${formIndex} out of range in module ${moduleIndex}` }

          // Skip if already generated (unless feedback = revision request)
          if (!feedback && accumulator.formContents[moduleIndex]?.[formIndex]) {
            return { moduleIndex, formIndex, name: sf.name, alreadyGenerated: true }
          }

          ctx.emit('data-phase', { phase: 'forms' })

          try {
            const ctInfo = scaffold.case_types?.find(ct => ct.name === sm.case_type) ?? null
            const shell: AppBlueprint = {
              app_name: scaffold.app_name,
              case_types: scaffold.case_types,
              modules: [{
                name: sm.name,
                forms: [{ name: sf.name, type: sf.type, questions: [] }],
                ...(sm.case_type != null && { case_type: sm.case_type }),
              }],
            }
            const mb = new MutableBlueprint(shell)
            const formAgent = createFormBuilderAgent(ctx, mb, { caseType: ctInfo, moduleIndex, formIndex })
            await ctx.runAgent(formAgent, {
              prompt: buildFormPrompt(scaffold, moduleIndex, formIndex, feedback),
              label: 'Form builder',
              agentName: 'Form Builder',
            })

            const form = mb.getForm(0, 0)!
            accumulator.setFormContent(moduleIndex, formIndex, form)
            ctx.emit('data-form-done', { moduleIndex, formIndex, form })

            return {
              moduleIndex,
              formIndex,
              name: sf.name,
              type: sf.type,
              questionCount: countQuestionsRecursive(form.questions),
              caseProperties: collectCaseProperties(form.questions),
              hasCaseName: hasCaseNameQuestion(form.questions),
            }
          } catch (err) {
            return { error: `Form "${sf.name}": generation failed — ${err instanceof Error ? err.message : String(err)}` }
          }
        },
      }),

      assembleBlueprint: tool({
        description: 'Assemble the full blueprint from the generated scaffold, module content, and form content. Call this after all modules and forms have been generated.',
        inputSchema: z.object({}),
        execute: async () => {
          const scaffold = accumulator.scaffold!
          const blueprint = assembleBlueprint(scaffold, accumulator.moduleContents, accumulator.formContents)
          accumulator.assembled = blueprint
          return {
            app_name: blueprint.app_name,
            moduleCount: blueprint.modules.length,
            modules: blueprint.modules.map((m, i) => ({
              moduleIndex: i,
              name: m.name,
              case_type: m.case_type ?? null,
              formCount: m.forms.length,
            })),
          }
        },
      }),

      validateApp: tool({
        description: 'Validate the assembled blueprint against CommCare platform rules and fix any issues. Call this after assembling the blueprint to ensure the app is valid and produce the final output.',
        inputSchema: z.object({}),
        execute: async () => {
          const blueprint: AppBlueprint = accumulator.assembled
            ?? assembleBlueprint(accumulator.scaffold!, accumulator.moduleContents, accumulator.formContents)
          const result = await validateAndFix(ctx, blueprint)
          ctx.emit('data-done', {
            blueprint: result.blueprint,
            hqJson: result.hqJson ?? {},
            success: result.success,
          })
          return { success: result.success }
        },
      }),
    },
  })

  return agent
}

// ── Edit-mode Solutions Architect Agent ────────────────────────────────

const QUESTION_TYPES = [
  'text', 'int', 'date', 'select1', 'select', 'geopoint', 'image',
  'barcode', 'decimal', 'long', 'trigger', 'phone', 'time', 'datetime',
  'audio', 'video', 'signature', 'hidden', 'secret', 'group', 'repeat',
] as const

const selectOptionSchema = z.object({
  value: z.string().describe('Option value (stored in data)'),
  label: z.string().describe('Option label (shown to user)'),
})

/** Build a form-generation prompt from the current blueprint context (for regenerateForm). */
function buildRegenerateFormPrompt(blueprint: AppBlueprint, moduleIndex: number, formIndex: number, instructions: string): string {
  const mod = blueprint.modules[moduleIndex]
  const form = mod.forms[formIndex]

  return `App: "${blueprint.app_name}"

Module: "${mod.name}"

Form: "${form.name}"
Type: ${form.type}

Sibling forms in this module: ${mod.forms.map(f => `"${f.name}" (${f.type})`).join(', ')}

## Instructions
${instructions}`
}

export function createEditArchitectAgent(
  ctx: GenerationContext,
  mutableBp: MutableBlueprint,
) {
  const agent = new ToolLoopAgent({
    model: ctx.model(MODEL_GENERATION),
    instructions: EDIT_ARCHITECT_PROMPT,
    stopWhen: stepCountIs(50),
    ...withPromptCaching,
    onStepFinish: ({ usage, text, toolCalls, toolResults }) => {
      if (usage) {
        ctx.logger.logEvent({
          type: 'orchestration',
          agent: 'Edit Architect',
          label: 'Edit step',
          model: MODEL_GENERATION,
          input_tokens: usage.inputTokens ?? 0,
          output_tokens: usage.outputTokens ?? 0,
          cache_read_tokens: usage.inputTokenDetails?.cacheReadTokens ?? undefined,
          cache_write_tokens: usage.inputTokenDetails?.cacheWriteTokens ?? undefined,
          output: { text, toolResults },
          tool_calls: toolCalls?.map((tc: any) => ({ name: tc.toolName, args: tc.input })),
        })
      }
    },
    tools: {

      // ── Search ────────────────────────────────────────────────────

      searchBlueprint: tool({
        description: 'Search the blueprint for questions, forms, modules, or case properties matching a query. Search by property names, question labels, IDs, case types, or any keyword.',
        inputSchema: z.object({
          query: z.string().describe('Search term: case property name, question id, label text, case type, XPath fragment, or module/form name'),
        }),
        execute: async ({ query }) => {
          const results = mutableBp.search(query)
          return { query, results }
        },
      }),

      // ── Get ───────────────────────────────────────────────────────

      getModule: tool({
        description: 'Get a module by index. Returns module metadata, case list columns, and a summary of its forms (without full question trees).',
        inputSchema: z.object({
          moduleIndex: z.number().describe('0-based module index'),
        }),
        execute: async ({ moduleIndex }) => {
          const mod = mutableBp.getModule(moduleIndex)
          if (!mod) return { error: `Module ${moduleIndex} not found` }
          return {
            moduleIndex,
            name: mod.name,
            case_type: mod.case_type ?? null,
            case_list_columns: mod.case_list_columns ?? null,
            forms: mod.forms.map((f, i) => ({
              formIndex: i,
              name: f.name,
              type: f.type,
              questionCount: f.questions?.length ?? 0,
            })),
          }
        },
      }),

      getForm: tool({
        description: 'Get a form by module and form index. Returns the full form including all questions, case config, and metadata.',
        inputSchema: z.object({
          moduleIndex: z.number().describe('0-based module index'),
          formIndex: z.number().describe('0-based form index'),
        }),
        execute: async ({ moduleIndex, formIndex }) => {
          const form = mutableBp.getForm(moduleIndex, formIndex)
          if (!form) return { error: `Form m${moduleIndex}-f${formIndex} not found` }
          return { moduleIndex, formIndex, form }
        },
      }),

      getQuestion: tool({
        description: 'Get a single question by ID within a form. Returns the question and its path within the form.',
        inputSchema: z.object({
          moduleIndex: z.number().describe('0-based module index'),
          formIndex: z.number().describe('0-based form index'),
          questionId: z.string().describe('Question id'),
        }),
        execute: async ({ moduleIndex, formIndex, questionId }) => {
          const result = mutableBp.getQuestion(moduleIndex, formIndex, questionId)
          if (!result) return { error: `Question "${questionId}" not found in m${moduleIndex}-f${formIndex}` }
          return { moduleIndex, formIndex, questionId, path: result.path, question: result.question }
        },
      }),

      // ── Question mutations ────────────────────────────────────────

      editQuestion: tool({
        description: 'Update fields on an existing question. Only include fields you want to change. Use null to clear a field.',
        inputSchema: z.object({
          moduleIndex: z.number().describe('0-based module index'),
          formIndex: z.number().describe('0-based form index'),
          questionId: z.string().describe('Question id to update'),
          updates: z.object({
            label: z.string().optional().describe('Question label text'),
            type: z.enum(QUESTION_TYPES).optional(),
            hint: z.string().optional().describe('Hint text'),
            required: z.string().optional().describe('"true()" if always required, or XPath for conditional.'),
            readonly: z.boolean().optional(),
            constraint: z.string().optional().describe('XPath constraint expression'),
            constraint_msg: z.string().optional().describe('Error message when constraint fails'),
            relevant: z.string().nullable().optional().describe('XPath display condition'),
            calculate: z.string().nullable().optional().describe('XPath computed value'),
            default_value: z.string().nullable().optional().describe('XPath initial value'),
            options: z.array(selectOptionSchema).nullable().optional(),
            case_property: z.string().nullable().optional(),
            is_case_name: z.boolean().optional(),
          }).describe('Fields to update. Only include fields you want to change.'),
        }),
        execute: async ({ moduleIndex, formIndex, questionId, updates }) => {
          try {
            const question = mutableBp.updateQuestion(moduleIndex, formIndex, questionId, updates)
            const form = mutableBp.getForm(moduleIndex, formIndex)!
            ctx.emit('data-form-updated', { moduleIndex, formIndex, form })
            return { moduleIndex, formIndex, questionId, question }
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) }
          }
        },
      }),

      addQuestion: tool({
        description: 'Add a new question to an existing form. Optionally specify afterQuestionId to insert after a specific question, or parentId to nest inside a group/repeat.',
        inputSchema: z.object({
          moduleIndex: z.number().describe('0-based module index'),
          formIndex: z.number().describe('0-based form index'),
          question: z.object({
            id: z.string().describe('Unique question id in snake_case'),
            type: z.enum(QUESTION_TYPES),
            label: z.string().optional().describe('Question label (omit for hidden)'),
            hint: z.string().optional(),
            required: z.string().optional().describe('"true()" if always required. XPath for conditional. Omit if not required.'),
            readonly: z.boolean().optional(),
            constraint: z.string().optional(),
            constraint_msg: z.string().optional(),
            relevant: z.string().optional(),
            calculate: z.string().optional(),
            default_value: z.string().optional(),
            options: z.array(selectOptionSchema).optional(),
            case_property: z.string().optional(),
            is_case_name: z.boolean().optional(),
          }),
          afterQuestionId: z.string().optional().describe('Insert after this question ID. Omit to append at end.'),
          parentId: z.string().optional().describe('ID of a group/repeat to nest inside'),
        }),
        execute: async ({ moduleIndex, formIndex, question, afterQuestionId, parentId }) => {
          try {
            mutableBp.addQuestion(moduleIndex, formIndex, question as NewQuestion, { afterId: afterQuestionId, parentId })
            const form = mutableBp.getForm(moduleIndex, formIndex)!
            ctx.emit('data-form-updated', { moduleIndex, formIndex, form })
            return { moduleIndex, formIndex, addedQuestionId: question.id, parentId: parentId ?? null, afterQuestionId: afterQuestionId ?? null }
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) }
          }
        },
      }),

      removeQuestion: tool({
        description: 'Remove a question from a form. Also cleans up any close_case or child_case references to the removed question.',
        inputSchema: z.object({
          moduleIndex: z.number().describe('0-based module index'),
          formIndex: z.number().describe('0-based form index'),
          questionId: z.string().describe('Question id to remove'),
        }),
        execute: async ({ moduleIndex, formIndex, questionId }) => {
          try {
            mutableBp.removeQuestion(moduleIndex, formIndex, questionId)
            const form = mutableBp.getForm(moduleIndex, formIndex)!
            ctx.emit('data-form-updated', { moduleIndex, formIndex, form })
            return { moduleIndex, formIndex, removedQuestionId: questionId }
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) }
          }
        },
      }),

      // ── Structural mutations ──────────────────────────────────────

      updateModule: tool({
        description: 'Update module metadata: name, case list columns, or case detail columns.',
        inputSchema: z.object({
          moduleIndex: z.number().describe('0-based module index'),
          name: z.string().optional().describe('New module name'),
          case_list_columns: z.array(z.object({
            field: z.string().describe('Case property name'),
            header: z.string().describe('Column header text'),
          })).optional().describe('New case list columns'),
          case_detail_columns: z.array(z.object({
            field: z.string().describe('Case property name'),
            header: z.string().describe('Display label for this detail field'),
          })).nullable().optional().describe('Columns for case detail view (when tapping a case). null to remove explicit detail columns.'),
        }),
        execute: async ({ moduleIndex, name, case_list_columns, case_detail_columns }) => {
          try {
            mutableBp.updateModule(moduleIndex, {
              ...(name !== undefined && { name }),
              ...(case_list_columns !== undefined && { case_list_columns }),
              ...(case_detail_columns !== undefined && { case_detail_columns }),
            })
            ctx.emit('data-blueprint-updated', { blueprint: mutableBp.getBlueprint() })
            const mod = mutableBp.getModule(moduleIndex)!
            return { moduleIndex, name: mod.name, case_list_columns: mod.case_list_columns ?? null, case_detail_columns: mod.case_detail_columns ?? null }
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) }
          }
        },
      }),

      updateForm: tool({
        description: 'Update form metadata: name or close_case config.',
        inputSchema: z.object({
          moduleIndex: z.number().describe('0-based module index'),
          formIndex: z.number().describe('0-based form index'),
          name: z.string().optional().describe('New form name'),
          close_case: z.object({
            question: z.string().optional().describe('Question id for conditional close'),
            answer: z.string().optional().describe('Value that triggers closure'),
          }).nullable().optional().describe('Set close_case config. null to remove. {} for unconditional. {question, answer} for conditional.'),
        }),
        execute: async ({ moduleIndex, formIndex, name, close_case }) => {
          try {
            mutableBp.updateForm(moduleIndex, formIndex, {
              ...(name !== undefined && { name }),
              ...(close_case !== undefined && { close_case }),
            })
            const form = mutableBp.getForm(moduleIndex, formIndex)!
            ctx.emit('data-form-updated', { moduleIndex, formIndex, form })
            return { moduleIndex, formIndex, name: form.name, type: form.type, close_case: form.close_case ?? null }
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) }
          }
        },
      }),

      addForm: tool({
        description: 'Add a new empty form to a module. Use regenerateForm after to populate it with questions.',
        inputSchema: z.object({
          moduleIndex: z.number().describe('0-based module index'),
          name: z.string().describe('Form display name'),
          type: z.enum(['registration', 'followup', 'survey']).describe('Form type'),
        }),
        execute: async ({ moduleIndex, name, type }) => {
          try {
            const form: BlueprintForm = { name, type, questions: [] }
            mutableBp.addForm(moduleIndex, form)
            ctx.emit('data-blueprint-updated', { blueprint: mutableBp.getBlueprint() })
            const mod = mutableBp.getModule(moduleIndex)!
            return { moduleIndex, formIndex: mod.forms.length - 1, name, type }
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) }
          }
        },
      }),

      removeForm: tool({
        description: 'Remove a form from a module.',
        inputSchema: z.object({
          moduleIndex: z.number().describe('0-based module index'),
          formIndex: z.number().describe('0-based form index'),
        }),
        execute: async ({ moduleIndex, formIndex }) => {
          try {
            const form = mutableBp.getForm(moduleIndex, formIndex)
            const name = form?.name ?? null
            mutableBp.removeForm(moduleIndex, formIndex)
            ctx.emit('data-blueprint-updated', { blueprint: mutableBp.getBlueprint() })
            return { moduleIndex, removedFormIndex: formIndex, removedFormName: name }
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) }
          }
        },
      }),

      addModule: tool({
        description: 'Add a new module to the app.',
        inputSchema: z.object({
          name: z.string().describe('Module display name'),
          case_type: z.string().optional().describe('Case type (required if module will have registration/followup forms)'),
          case_list_columns: z.array(z.object({
            field: z.string().describe('Case property name'),
            header: z.string().describe('Column header text'),
          })).optional().describe('Case list columns'),
        }),
        execute: async ({ name, case_type, case_list_columns }) => {
          try {
            mutableBp.addModule({
              name,
              ...(case_type && { case_type }),
              forms: [],
              ...(case_list_columns && { case_list_columns }),
            })
            ctx.emit('data-blueprint-updated', { blueprint: mutableBp.getBlueprint() })
            const bp = mutableBp.getBlueprint()
            return { moduleIndex: bp.modules.length - 1, name, case_type: case_type ?? null }
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) }
          }
        },
      }),

      removeModule: tool({
        description: 'Remove a module from the app.',
        inputSchema: z.object({
          moduleIndex: z.number().describe('0-based module index'),
        }),
        execute: async ({ moduleIndex }) => {
          try {
            const mod = mutableBp.getModule(moduleIndex)
            const name = mod?.name ?? null
            mutableBp.removeModule(moduleIndex)
            ctx.emit('data-blueprint-updated', { blueprint: mutableBp.getBlueprint() })
            return { removedModuleIndex: moduleIndex, removedModuleName: name }
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) }
          }
        },
      }),

      renameCaseProperty: tool({
        description: 'Rename a case property across the entire app. Automatically propagates to all questions, case list columns, and XPath expressions that reference it.',
        inputSchema: z.object({
          caseType: z.string().describe('The case type that owns this property'),
          oldName: z.string().describe('Current property name'),
          newName: z.string().describe('New property name'),
        }),
        execute: async ({ caseType, oldName, newName }) => {
          try {
            const result = mutableBp.renameCaseProperty(caseType, oldName, newName)
            ctx.emit('data-blueprint-updated', { blueprint: mutableBp.getBlueprint() })
            return { caseType, oldName, newName, formsChanged: result.formsChanged, columnsChanged: result.columnsChanged }
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) }
          }
        },
      }),

      // ── Generation ────────────────────────────────────────────────

      regenerateForm: tool({
        description: 'Fully regenerate a form using AI. Use for major restructuring or when adding many questions at once. More efficient than many individual addQuestion calls.',
        inputSchema: z.object({
          moduleIndex: z.number().describe('0-based module index'),
          formIndex: z.number().describe('0-based form index'),
          instructions: z.string().describe('What this form should contain or how to change it'),
        }),
        execute: async ({ moduleIndex, formIndex, instructions }) => {
          const blueprint = mutableBp.getBlueprint()
          const mod = blueprint.modules[moduleIndex]
          if (!mod) return { error: `Module index ${moduleIndex} out of range` }
          const form = mod.forms[formIndex]
          if (!form) return { error: `Form index ${formIndex} out of range in module ${moduleIndex}` }

          try {
            const ctInfo = blueprint.case_types?.find(ct => ct.name === mod.case_type) ?? null
            const shell: AppBlueprint = {
              app_name: blueprint.app_name,
              case_types: blueprint.case_types,
              modules: [{
                name: mod.name,
                forms: [{ name: form.name, type: form.type, questions: [] }],
                ...(mod.case_type && { case_type: mod.case_type }),
              }],
            }
            const mb = new MutableBlueprint(shell)
            const formAgent = createFormBuilderAgent(ctx, mb, { caseType: ctInfo, moduleIndex, formIndex })
            await ctx.runAgent(formAgent, {
              prompt: buildRegenerateFormPrompt(blueprint, moduleIndex, formIndex, instructions),
              label: 'Regenerate form',
              agentName: 'Form Builder',
            })

            const newForm = mb.getForm(0, 0)!
            mutableBp.replaceForm(moduleIndex, formIndex, newForm)
            ctx.emit('data-form-updated', { moduleIndex, formIndex, form: newForm })

            return {
              moduleIndex,
              formIndex,
              name: form.name,
              questionCount: countQuestionsRecursive(newForm.questions),
              caseProperties: collectCaseProperties(newForm.questions),
            }
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) }
          }
        },
      }),

      // ── Knowledge ─────────────────────────────────────────────────

      loadKnowledge: tool({
        description: 'Load CommCare platform knowledge files for reference. Use this before making design decisions that involve case model changes, expression patterns, instance references, or any non-trivial CommCare feature. The knowledge index in your system prompt lists available files and when to consult them.',
        inputSchema: z.object({
          files: z.array(z.string()).describe('Knowledge file names to load (without .md extension). Check the knowledge index for available files.'),
        }),
        execute: async ({ files }) => {
          const content = await loadKnowledge(...files)
          return content
        },
      }),

      // ── Validation ────────────────────────────────────────────────

      validateApp: tool({
        description: 'Validate the edited blueprint against CommCare platform rules and fix any issues. Call this when you are done making edits to ensure the app is valid.',
        inputSchema: z.object({}),
        execute: async () => {
          const blueprint = mutableBp.getBlueprint()
          const result = await validateAndFix(ctx, blueprint)
          ctx.emit('data-done', {
            blueprint: result.blueprint,
            hqJson: result.hqJson ?? {},
            success: result.success,
          })
          return { success: result.success }
        },
      }),
    },
  })

  return agent
}
