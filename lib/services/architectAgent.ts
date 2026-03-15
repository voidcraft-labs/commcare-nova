/**
 * Solutions Architect — edit mode agent + shared validation.
 *
 * Generation mode uses a programmatic pipeline (generationPipeline.ts).
 * Edit mode uses a ToolLoopAgent with search/get/edit/validate tools.
 */
import { ToolLoopAgent, tool, stepCountIs } from 'ai'
import { z } from 'zod'
import { GenerationContext, logWarnings, withPromptCaching } from './generationContext'
import { EDIT_ARCHITECT_PROMPT } from '../prompts/editArchitectPrompt'
import { loadKnowledge } from './commcare/knowledge/loadKnowledge'
import { generateSingleFormContent } from './generationPipeline'
import {
  type AppBlueprint, type BlueprintForm, type Question,
} from '../schemas/blueprint'
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

  ctx.emit('data-phase', { phase: 'validating' })

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


// ── Edit-mode Solutions Architect Agent ────────────────────────────────

const QUESTION_TYPES = [
  'text', 'int', 'date', 'select1', 'select', 'geopoint', 'image',
  'barcode', 'decimal', 'label', 'phone', 'time', 'datetime',
  'audio', 'video', 'signature', 'hidden', 'secret', 'group', 'repeat',
] as const

const selectOptionSchema = z.object({
  value: z.string().describe('Option value (stored in data)'),
  label: z.string().describe('Option label (shown to user)'),
})

export function createEditArchitectAgent(
  ctx: GenerationContext,
  mutableBp: MutableBlueprint,
) {
  const editModel = ctx.pipelineConfig.editArchitect.model
  const agent = new ToolLoopAgent({
    model: ctx.model(editModel),
    instructions: EDIT_ARCHITECT_PROMPT,
    stopWhen: stepCountIs(50),
    ...withPromptCaching,
    onStepFinish: ({ usage, text, reasoningText, toolCalls, toolResults, warnings }) => {
      logWarnings('Edit Architect', warnings)
      if (usage) {
        ctx.logger.logEvent({
          type: 'orchestration',
          agent: 'Edit Architect',
          label: 'Edit step',
          model: editModel,
          input_tokens: usage.inputTokens ?? 0,
          output_tokens: usage.outputTokens ?? 0,
          cache_read_tokens: usage.inputTokenDetails?.cacheReadTokens ?? undefined,
          cache_write_tokens: usage.inputTokenDetails?.cacheWriteTokens ?? undefined,
          output: { text, ...(reasoningText && { reasoningText }), toolResults },
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
