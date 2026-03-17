/**
 * Solutions Architect — single ToolLoopAgent for conversation, generation, and editing.
 *
 * The SA converses with users, incrementally generates apps through focused tool
 * calls, and edits them — all within one conversation context and prompt-caching window.
 */
import { ToolLoopAgent, tool, stepCountIs } from 'ai'
import { z } from 'zod'
import { GenerationContext, logWarnings, withPromptCaching, thinkingProviderOptions } from './generationContext'
import { buildSolutionsArchitectPrompt } from '../prompts/solutionsArchitectPrompt'
import { SCHEMA_PROMPT } from '../prompts/schemaPrompt'
import { scaffoldPrompt } from '../prompts/scaffoldPrompt'
import {
  type AppBlueprint, type BlueprintForm, type Question,
  caseTypesOutputSchema, scaffoldModulesSchema, moduleContentSchema,
  summarizeBlueprint,
} from '../schemas/blueprint'
import {
  processSingleFormOutput,
  type FlatQuestion,
} from '../schemas/contentProcessing'
import { expandBlueprint, validateBlueprint } from './hqJsonExpander'
import { MutableBlueprint, type NewQuestion } from './mutableBlueprint'

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

// ── Validate + fix loop ──────────────────────────────────────────────

export async function validateAndFix(
  ctx: GenerationContext,
  blueprint: AppBlueprint,
): Promise<{ success: boolean; blueprint: AppBlueprint; hqJson?: Record<string, any> }> {
  const recentErrorSignatures: string[] = []
  const MAX_STUCK_REPEATS = 3
  let attempt = 0

  ctx.emit('data-phase', { phase: 'validate' })

  while (true) {
    attempt++
    const errors = validateBlueprint(blueprint)

    if (errors.length === 0) {
      // TODO: Remove this artificial delay once we integrate CommCare core .jar
      // validation. Currently our validation is purely deterministic/rule-based and
      // completes near-instantly when there are no issues, which feels jarring in
      // the UI. Once we run the full CommCare .jar validator this will take real
      // time and the delay can be removed.
      if (attempt === 1) await new Promise(r => setTimeout(r, 3000))
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

    ctx.emit('data-phase', { phase: 'fix' })
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

      // "has no questions" — regenerate with Opus structured output
      if (formErrs.some(e => e.includes('has no questions'))) {
        try {
          const newForm = await generateSingleFormContent(
            ctx, blueprint, mIdx, fIdx,
            `Form "${form.name}" (${form.type}) has no questions. Generate appropriate questions for this form.`,
          )
          blueprint.modules[mIdx].forms[fIdx] = newForm
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
    if (err.includes('has no case_name_field')) {
      const candidate = findCaseNameCandidate(form.questions)
      if (candidate) candidate.is_case_name = true
      continue
    }

    if (err.includes('multiple questions have is_case_name')) {
      let found = false
      clearDuplicateCaseNames(form.questions, { found })
      continue
    }

    const reservedMatch = err.match(/reserved case property name "(\w+)"/)
    if (reservedMatch) {
      const reserved = reservedMatch[1]
      renameReservedProperty(form.questions, reserved)
      continue
    }

    if (err.includes('media/binary questions cannot be saved as case properties')) {
      const mediaMatch = err.match(/case property "(\w+)" maps to a (\w+) question/)
      if (mediaMatch) {
        const qWithProp = findQuestionByCaseProperty(form.questions, mediaMatch[1])
        if (qWithProp) delete qWithProp.case_property
      }
      continue
    }

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

    if (err.includes('close_case references question') && err.includes("doesn't exist")) {
      delete form.close_case
      continue
    }

    if (err.includes('close_case condition is missing')) {
      delete form.close_case
      continue
    }

    if (err.includes('has close_case but is not a followup form')) {
      delete form.close_case
      continue
    }

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
  for (const q of questions) {
    if (q.case_property && /name/i.test(q.case_property) && q.type === 'text') return q
    if (q.children) {
      const found = findCaseNameCandidate(q.children)
      if (found) return found
    }
  }
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

// ── Single-form generation ───────────────────────────────────────────

// ── Shared constants ─────────────────────────────────────────────────

const QUESTION_TYPES = [
  'text', 'int', 'date', 'select1', 'select', 'geopoint', 'image',
  'barcode', 'decimal', 'label', 'phone', 'time', 'datetime',
  'audio', 'video', 'signature', 'hidden', 'secret', 'group', 'repeat',
] as const

const selectOptionSchema = z.object({
  value: z.string().describe('Option value (stored in data)'),
  label: z.string().describe('Option label (shown to user)'),
})

/**
 * Schema for single-form structured output generation.
 *
 * The Anthropic schema compiler times out with >8 optional fields per array item.
 * Fields that are almost always present use required + empty sentinels instead.
 * Post-processing (stripEmpty + applyDefaults) converts sentinels back to undefined.
 */
const singleFormSchema = z.object({
  questions: z.array(z.object({
    id: z.string(),
    type: z.enum(QUESTION_TYPES),
    parentId: z.string().describe('Parent group/repeat ID. Empty string for top-level.'),
    // Required sentinels (4) — almost always present, low cost as empty values
    label: z.string().describe('Question label. Empty string to use case property default or for hidden questions.'),
    required: z.string().describe('"true()" if always required, XPath for conditional. Empty string if not required.'),
    case_property: z.string().describe('Case property name. Empty string if not mapped.'),
    is_case_name: z.boolean().describe('True if this is the case name field. False if not.'),
    // Optionals (8) — sparse, saves tokens when absent
    hint: z.string().optional(),
    help: z.string().optional(),
    constraint: z.string().optional(),
    constraint_msg: z.string().optional(),
    relevant: z.string().optional(),
    calculate: z.string().optional(),
    default_value: z.string().optional(),
    options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  })),
  close_case: z.object({
    question: z.string().describe('Question ID for conditional close. Empty string if no close.'),
    answer: z.string().describe('Value that triggers closure. Empty string if no close.'),
  }),
  child_cases: z.array(z.object({
    case_type: z.string(),
    case_name_field: z.string(),
    case_properties: z.array(z.object({ case_property: z.string(), question_id: z.string() })),
    relationship: z.enum(['child', 'extension']),
    repeat_context: z.string().describe('Repeat group question ID. Empty string if not in repeat.'),
  })).describe('Empty array if no child cases.'),
})

const FORM_GENERATION_SYSTEM = `You are a senior CommCare form builder. Build the questions for a single form.

Questions use a flat structure: parentId (empty string for top-level, group id for nested). Array order determines display order.

For case wiring: registration forms save to case properties, followup forms preload from case using default_value with #case/property_name.
For display-only context in followups, use label questions with <output value="#case/property_name"/> labels (labels support markdown formatting). Use groups for visual sections. Calculate don't ask for derived values.
Use raw XPath operators (>, <), never HTML-escaped. Reference questions by /data/question_id.

### Design Principles
- Use groups to create visual sections that help the worker understand the form's structure
- Calculate, don't ask: if a value can be derived (age from DOB, BMI from height+weight), use a hidden calculated field
- Coordinate sibling forms: Registration and followup forms for the same case type should use the same question IDs and group structure for shared fields
- Confirm context in followups: start with label questions showing key case details using <output value="#case/property_name"/>
- Use relevant for conditional visibility. Use constraint with constraint_msg for validation
- Default the common case: Use default_value (e.g. today()) when 90%+ of submissions will use the same value
- hidden questions MUST have either calculate or default_value — a hidden question with neither saves blank data`

/**
 * Generate content for a single form using structured output.
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

  const formGenCfg = ctx.pipelineConfig.formGeneration
  const result = await ctx.generate(singleFormSchema, {
    model: formGenCfg.model,
    reasoning: ctx.reasoningForStage('formGeneration'),
    system: FORM_GENERATION_SYSTEM,
    prompt: `App: "${blueprint.app_name}"
Module: "${mod.name}"
Form: "${form.name}" (${form.type})
Sibling forms: ${siblingForms}

${dataModel}

## Instructions
${instructions}

Build the complete questions for this form.`,
    label: `Generate form "${form.name}"`,
    maxOutputTokens: formGenCfg.maxOutputTokens || undefined,
  })

  if (!result) {
    return { name: form.name, type: form.type, questions: [] }
  }

  return processSingleFormOutput(
    { formIndex, questions: result.questions as FlatQuestion[], close_case: result.close_case, child_cases: result.child_cases },
    form.name,
    form.type,
    ct,
  )
}

// ── Module column prompt builder ─────────────────────────────────────

function buildColumnPrompt(blueprint: AppBlueprint, moduleIndex: number, instructions: string): string {
  const mod = blueprint.modules[moduleIndex]
  const caseTypes = blueprint.case_types ?? []
  const ct = caseTypes.find(c => c.name === mod.case_type)

  const dataModel = ct
    ? `Case type: ${ct.name}\nProperties: ${ct.properties.map(p => p.name).join(', ')}`
    : 'Survey-only module (no case type)'

  return `App: "${blueprint.app_name}"
Module: "${mod.name}"
${dataModel}

## Instructions
${instructions}

Design the case list columns and case detail columns for this module.
- Choose columns that help the user quickly identify and differentiate records
- Include case_name as the first column unless there is a reason not to
- 3-5 columns is typical
- Column headers should be short and scannable
- For case_detail_columns, include more fields than the list. Use null to auto-mirror.
- Survey-only modules should have null for both.`
}

// ── askQuestions schema ──────────────────────────────────────────────

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

// ── Solutions Architect Agent ────────────────────────────────────────

export function createSolutionsArchitect(
  ctx: GenerationContext,
  mutableBp: MutableBlueprint,
  blueprintSummary?: string,
) {
  const saCfg = ctx.pipelineConfig.solutionsArchitect
  const saReasoning = ctx.reasoningForStage('solutionsArchitect')

  const agent = new ToolLoopAgent({
    model: ctx.model(saCfg.model),
    instructions: buildSolutionsArchitectPrompt(blueprintSummary),
    ...(saReasoning && { providerOptions: thinkingProviderOptions(saReasoning.effort) }),
    stopWhen: stepCountIs(80),
    ...withPromptCaching,
    onStepFinish: ({ usage, text, reasoningText, toolCalls, warnings }) => {
      logWarnings('Solutions Architect', warnings)
      if (usage) {
        ctx.logger.logStep({
          text: text || undefined,
          reasoning: reasoningText || undefined,
          tool_calls: toolCalls?.map((tc: any) => ({ name: tc.toolName, args: tc.input })),
          usage: {
            model: saCfg.model,
            input_tokens: usage.inputTokens ?? 0,
            output_tokens: usage.outputTokens ?? 0,
            cache_read_tokens: usage.inputTokenDetails?.cacheReadTokens ?? undefined,
            cache_write_tokens: usage.inputTokenDetails?.cacheWriteTokens ?? undefined,
          },
        })
      }
    },
    tools: {

      // ── Conversation ──────────────────────────────────────────────

      askQuestions: {
        description: 'Ask the user clarifying questions about their app requirements. Up to 5 questions per call — call as many times as needed. Most requests need several rounds. Don\'t rush to generate; an app built on assumptions is worse than one that took extra questions to get right.',
        inputSchema: askQuestionsSchema,
        // No execute → client-side tool, agent stops for user input
      },

      // ── Generation ────────────────────────────────────────────────

      generateSchema: tool({
        description: 'Design the data model (case types and properties) for the app. Call this first before generateScaffold. Provide the app name and a thorough description of all entities, their properties, and relationships.',
        inputSchema: z.object({
          appName: z.string().describe('Short app name (2-5 words)'),
          description: z.string().describe(
            'Thorough description of all case types needed: what entities to track, what properties each needs, ' +
            'how they relate to each other, and what the case_name_property should be for each.'
          ),
        }),
        execute: async ({ appName, description }) => {
          ctx.logger.setAppName(appName)
          ctx.emit('data-start-build', {})

          const schemaCfg = ctx.pipelineConfig.schemaGeneration
          const result = await ctx.generate(caseTypesOutputSchema, {
            model: schemaCfg.model,
            reasoning: ctx.reasoningForStage('schemaGeneration'),
            system: SCHEMA_PROMPT,
            prompt: `App: "${appName}"\n\n${description}`,
            label: 'Schema',
            maxOutputTokens: schemaCfg.maxOutputTokens || undefined,
          })

          if (!result) {
            return { error: 'Schema generation returned no output' }
          }

          mutableBp.setCaseTypes(result.case_types)
          // Set app_name on the blueprint
          const bp = mutableBp.getBlueprint()
          bp.app_name = appName
          ctx.emit('data-schema', { caseTypes: result.case_types })

          return {
            appName,
            caseTypes: result.case_types.map(ct => ({
              name: ct.name,
              case_name_property: ct.case_name_property,
              propertyCount: ct.properties.length,
              properties: ct.properties.map(p => p.name),
            })),
          }
        },
      }),

      generateScaffold: tool({
        description: 'Design the module and form structure for the app. Call after generateSchema. Provide a full specification describing every module, its forms, and what each form does.',
        inputSchema: z.object({
          specification: z.string().describe(
            'Full plain English specification: describe every module, its purpose, each form\'s purpose, ' +
            'the intended UX for each form, and how forms relate to each other. Include formDesign specs.'
          ),
        }),
        execute: async ({ specification }) => {
          ctx.emit('data-phase', { phase: 'structure' })

          const caseTypes = mutableBp.getBlueprint().case_types
          const scaffoldCfg = ctx.pipelineConfig.scaffold
          const result = await ctx.streamGenerate(scaffoldModulesSchema, {
            model: scaffoldCfg.model,
            reasoning: ctx.reasoningForStage('scaffold'),
            system: scaffoldPrompt(caseTypes),
            prompt: specification,
            label: 'Scaffold',
            maxOutputTokens: scaffoldCfg.maxOutputTokens || undefined,
            onPartial: (partial) => ctx.emit('data-partial-scaffold', partial),
          })

          if (!result) {
            return { error: 'Scaffold generation returned no output' }
          }

          mutableBp.setScaffold(result)
          ctx.emit('data-scaffold', result)

          return {
            appName: result.app_name,
            modules: result.modules.map((m, i) => ({
              index: i,
              name: m.name,
              case_type: m.case_type,
              formCount: m.forms.length,
              forms: m.forms.map((f, j) => ({ index: j, name: f.name, type: f.type })),
            })),
          }
        },
      }),

      addModule: tool({
        description: 'Generate case list columns for a module. Call after generateScaffold, before addForm. Provide the module index and instructions for what columns to display.',
        inputSchema: z.object({
          moduleIndex: z.number().describe('0-based module index'),
          instructions: z.string().describe('What columns to show in the case list and case detail view'),
        }),
        execute: async ({ moduleIndex, instructions }) => {
          const blueprint = mutableBp.getBlueprint()
          const mod = blueprint.modules[moduleIndex]
          if (!mod) return { error: `Module ${moduleIndex} not found` }

          // Survey-only modules don't need columns
          if (!mod.case_type) {
            ctx.emit('data-module-done', { moduleIndex, caseListColumns: null })
            return { moduleIndex, name: mod.name, columns: null, message: 'Survey-only module, no columns needed' }
          }

          const scaffoldCfg = ctx.pipelineConfig.scaffold
          const result = await ctx.generate(moduleContentSchema, {
            model: scaffoldCfg.model,
            reasoning: ctx.reasoningForStage('scaffold'),
            system: 'You are a CommCare app builder. Design the case list and case detail columns for a module.',
            prompt: buildColumnPrompt(blueprint, moduleIndex, instructions),
            label: `Module ${moduleIndex} columns`,
            maxOutputTokens: scaffoldCfg.maxOutputTokens || undefined,
          })

          if (!result) {
            return { error: 'Column generation returned no output' }
          }

          // Apply to blueprint
          mutableBp.updateModule(moduleIndex, {
            ...(result.case_list_columns && { case_list_columns: result.case_list_columns }),
            ...(result.case_detail_columns && { case_detail_columns: result.case_detail_columns }),
          })

          ctx.emit('data-module-done', {
            moduleIndex,
            caseListColumns: result.case_list_columns,
          })

          return {
            moduleIndex,
            name: mod.name,
            case_list_columns: result.case_list_columns,
            case_detail_columns: result.case_detail_columns,
          }
        },
      }),

      addForm: tool({
        description: 'Generate all questions for a form. Call after addModule for the form\'s module. Provide the module index, form index, and rich instructions describing what the form should contain.',
        inputSchema: z.object({
          moduleIndex: z.number().describe('0-based module index'),
          formIndex: z.number().describe('0-based form index'),
          instructions: z.string().describe(
            'Rich description of what this form should contain: questions, flow, skip logic, ' +
            'calculated fields, how it relates to sibling forms. The generation will handle ' +
            'question IDs, XPath, and group structure.'
          ),
        }),
        execute: async ({ moduleIndex, formIndex, instructions }) => {
          const blueprint = mutableBp.getBlueprint()
          const mod = blueprint.modules[moduleIndex]
          if (!mod) return { error: `Module ${moduleIndex} not found` }
          const form = mod.forms[formIndex]
          if (!form) return { error: `Form ${formIndex} not found in module ${moduleIndex}` }

          ctx.emit('data-phase', { phase: 'forms' })

          const newForm = await generateSingleFormContent(
            ctx, blueprint, moduleIndex, formIndex, instructions,
          )

          mutableBp.replaceForm(moduleIndex, formIndex, newForm)
          ctx.emit('data-form-done', { moduleIndex, formIndex, form: newForm })

          return {
            moduleIndex,
            formIndex,
            name: form.name,
            type: form.type,
            questionCount: countQuestionsRecursive(newForm.questions),
            caseProperties: collectCaseProperties(newForm.questions),
          }
        },
      }),

      // ── Read ────────────────────────────────────────────────────────

      searchBlueprint: tool({
        description: 'Search the blueprint for questions, forms, modules, or case properties matching a query.',
        inputSchema: z.object({
          query: z.string().describe('Search term: case property name, question id, label text, case type, XPath fragment, or module/form name'),
        }),
        execute: async ({ query }) => {
          const results = mutableBp.search(query)
          return { query, results }
        },
      }),

      getModule: tool({
        description: 'Get a module by index. Returns module metadata, case list columns, and a summary of its forms.',
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
        description: 'Get a form by module and form index. Returns the full form including all questions.',
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
        description: 'Get a single question by ID within a form.',
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
            return { moduleIndex, formIndex, questionId, updatedFields: Object.keys(updates) }
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) }
          }
        },
      }),

      addQuestion: tool({
        description: 'Add a new question to an existing form. Use beforeQuestionId or afterQuestionId to control position; omit both to append at end.',
        inputSchema: z.object({
          moduleIndex: z.number().describe('0-based module index'),
          formIndex: z.number().describe('0-based form index'),
          question: z.object({
            id: z.string().describe('Unique question id in snake_case'),
            type: z.enum(QUESTION_TYPES),
            label: z.string().optional().describe('Question label (omit for hidden)'),
            hint: z.string().optional(),
            required: z.string().optional(),
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
          beforeQuestionId: z.string().optional().describe('Insert before this question ID. Takes precedence over afterQuestionId.'),
          parentId: z.string().optional().describe('ID of a group/repeat to nest inside'),
        }),
        execute: async ({ moduleIndex, formIndex, question, afterQuestionId, beforeQuestionId, parentId }) => {
          try {
            mutableBp.addQuestion(moduleIndex, formIndex, question as NewQuestion, { afterId: afterQuestionId, beforeId: beforeQuestionId, parentId })
            const form = mutableBp.getForm(moduleIndex, formIndex)!
            ctx.emit('data-form-updated', { moduleIndex, formIndex, form })
            return { moduleIndex, formIndex, addedQuestionId: question.id, parentId: parentId ?? null, afterQuestionId: afterQuestionId ?? null, beforeQuestionId: beforeQuestionId ?? null }
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) }
          }
        },
      }),

      removeQuestion: tool({
        description: 'Remove a question from a form.',
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
          })).nullable().optional().describe('Columns for case detail view. null to remove.'),
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
            question: z.string().optional(),
            answer: z.string().optional(),
          }).nullable().optional().describe('Set close_case config. null to remove. {} for unconditional.'),
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

      createForm: tool({
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

      createModule: tool({
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
        description: 'Rename a case property across the entire app. Automatically propagates to all questions, columns, and XPath.',
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

      // ── Generation (edit context) ─────────────────────────────────

      regenerateForm: tool({
        description: 'Fully regenerate a form using AI. Use for major restructuring or when adding many questions at once.',
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
            const newForm = await generateSingleFormContent(
              ctx, blueprint, moduleIndex, formIndex, instructions,
            )
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

      // ── Validation ────────────────────────────────────────────────

      validateApp: tool({
        description: 'Validate the app against CommCare platform rules and fix any issues. Call this when you are done building or editing.',
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
