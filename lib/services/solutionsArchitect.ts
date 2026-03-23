/**
 * Solutions Architect — single ToolLoopAgent for conversation, generation, and editing.
 *
 * The SA converses with users, incrementally generates apps through focused tool
 * calls, and edits them — all within one conversation context and prompt-caching window.
 */
import { ToolLoopAgent, tool, stepCountIs } from 'ai'
import { forwardAnthropicContainerIdFromLastStep } from '@ai-sdk/anthropic'
import { z } from 'zod'
import { GenerationContext, logWarnings } from './generationContext'
import { buildSolutionsArchitectPrompt } from '../prompts/solutionsArchitectPrompt'
import {
  type AppBlueprint, type BlueprintForm, type Question,
  QUESTION_TYPES,
  caseTypesOutputSchema, scaffoldModulesSchema, moduleContentSchema,
} from '../schemas/blueprint'
import {
  type FlatQuestion,
  stripEmpty, applyDefaults, buildQuestionTree, flattenToFlat,
} from '../schemas/contentProcessing'
import { MutableBlueprint, type NewQuestion } from './mutableBlueprint'
import { validateAndFix } from './validationLoop'
export { validateAndFix } from './validationLoop'

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
    if (q.is_case_property) props.push(q.id)
    if (q.children) props.push(...collectCaseProperties(q.children))
  }
  return props
}

interface QuestionSummary {
  id: string
  type: string
  is_case_property?: true
  children?: QuestionSummary[]
}

/** Compact question tree summary so the SA can see IDs, types, and nesting at a glance. */
function summarizeQuestions(questions: Question[]): QuestionSummary[] {
  return questions.map(q => {
    const entry: QuestionSummary = { id: q.id, type: q.type }
    if (q.is_case_property) entry.is_case_property = true
    if (q.children?.length) entry.children = summarizeQuestions(q.children)
    return entry
  })
}

// ── askQuestions schema ──────────────────────────────────────────────

const selectOptionSchema = z.object({
  value: z.string().describe('Option value (stored in data)'),
  label: z.string().describe('Option label (shown to user)'),
})

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
) {
  const saCfg = ctx.pipelineConfig.solutionsArchitect
  const saReasoning = ctx.reasoningForStage('solutionsArchitect')

  const agent = new ToolLoopAgent({
    model: ctx.model(saCfg.model),
    instructions: buildSolutionsArchitectPrompt(),
    stopWhen: stepCountIs(80),
    prepareStep: ({ steps }: { steps?: Array<{ providerMetadata?: Record<string, any> }> }) => {
      const anthropic: Record<string, any> = {
        // Automatic prompt caching — Anthropic places the cache breakpoint on the
        // last cacheable block and advances it as the conversation grows. System
        // prompt stays cached across requests; code execution blocks are skipped.
        cacheControl: { type: 'ephemeral' },
      }

      // Reasoning (adaptive thinking)
      if (saReasoning) {
        anthropic.thinking = { type: 'adaptive' as const, effort: saReasoning.effort }
      }

      // Container forwarding (code execution sandbox persistence)
      if (steps?.length) {
        const containerResult = forwardAnthropicContainerIdFromLastStep({ steps })
        const containerOpts = containerResult?.providerOptions?.anthropic
        if (containerOpts) Object.assign(anthropic, containerOpts)
      }

      return { providerOptions: { anthropic } as Record<string, any> }
    },
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
        description: 'Set the data model (case types and properties) for the app. Call this first before generateScaffold. Provide the structured case types directly.',
        inputSchema: z.object({
          appName: z.string().describe('Short app name (2-5 words)'),
          caseTypes: caseTypesOutputSchema.shape.case_types,
        }),
        providerOptions: {
          anthropic: { allowedCallers: ['code_execution_20260120'] },
        },
        onInputStart: () => {
          ctx.emit('data-start-build', {})
        },
        execute: async ({ appName, caseTypes }) => {
          ctx.logger.setAppName(appName)
          mutableBp.setCaseTypes(caseTypes)
          const bp = mutableBp.getBlueprint()
          bp.app_name = appName
          ctx.emit('data-schema', { caseTypes })

          return {
            appName,
            caseTypes: caseTypes.map(ct => ({
              name: ct.name,
              propertyCount: ct.properties.length,
              properties: ct.properties.map(p => p.name),
            })),
          }
        },
      }),

      generateScaffold: tool({
        description: 'Set the module and form structure for the app. Call after generateSchema. Provide the complete scaffold directly.',
        inputSchema: scaffoldModulesSchema,
        providerOptions: {
          anthropic: { allowedCallers: ['code_execution_20260120'] },
        },
        onInputStart: () => {
          ctx.emit('data-phase', { phase: 'structure' })
        },
        execute: async (scaffold) => {
          mutableBp.setScaffold(scaffold)
          ctx.emit('data-scaffold', scaffold)

          return {
            appName: scaffold.app_name,
            modules: scaffold.modules.map((m, i) => ({
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
        description: 'Set case list columns for a module. Call after generateScaffold. Provide the columns directly. Survey-only modules (no case_type) should pass null for both.',
        inputSchema: z.object({
          moduleIndex: z.number().describe('0-based module index'),
          case_list_columns: moduleContentSchema.shape.case_list_columns,
          case_detail_columns: moduleContentSchema.shape.case_detail_columns,
        }),
        providerOptions: {
          anthropic: { allowedCallers: ['code_execution_20260120'] },
        },
        onInputStart: () => {
          ctx.emit('data-phase', { phase: 'modules' })
        },
        execute: async ({ moduleIndex, case_list_columns, case_detail_columns }) => {
          const mod = mutableBp.getModule(moduleIndex)
          if (!mod) return { error: `Module ${moduleIndex} not found` }

          if (!mod.case_type || !case_list_columns) {
            ctx.emit('data-module-done', { moduleIndex, caseListColumns: null })
            return { moduleIndex, name: mod.name, columns: null }
          }

          mutableBp.updateModule(moduleIndex, {
            case_list_columns,
            ...(case_detail_columns && { case_detail_columns }),
          })

          ctx.emit('data-module-done', { moduleIndex, caseListColumns: case_list_columns })

          return {
            moduleIndex,
            name: mod.name,
            case_list_columns,
            case_detail_columns: case_detail_columns ?? null,
          }
        },
      }),

      code_execution: ctx.codeExecutionTool(),

      addQuestions: tool({
        description: 'Add a batch of questions to an existing form. Appends to existing questions (does not replace). Call from code_execution for large forms. Groups added in one batch can be referenced as parentId in later batches.',
        inputSchema: z.object({
          moduleIndex: z.number().describe('0-based module index'),
          formIndex: z.number().describe('0-based form index'),
          questions: z.array(z.object({
            id: z.string(),
            type: z.enum(QUESTION_TYPES),
            parentId: z.string().describe('Parent group/repeat ID. Empty string for top-level.'),
            // Required sentinels (3) — almost always present, low cost as empty values
            label: z.string().describe('Question label. Empty string for hidden questions.'),
            required: z.string().describe('"true()" if always required, XPath for conditional. Empty string if not required.'),
            is_case_property: z.boolean().describe('True if this question saves to case (property name = question id). The case name question must have id "case_name". False if not mapped.'),
            // Optionals (8) — sparse, saves tokens when absent
            hint: z.string().optional(),
            help: z.string().optional(),
            validation: z.string().optional(),
            validation_msg: z.string().optional(),
            relevant: z.string().optional(),
            calculate: z.string().optional(),
            default_value: z.string().optional().describe("XPath for initial value on form load. String values must be quoted: `'text'`, not `text`."),
            options: z.array(selectOptionSchema).optional(),
          })),
        }),
        providerOptions: {
          anthropic: { allowedCallers: ['code_execution_20260120'] },
        },
        execute: async ({ moduleIndex, formIndex, questions }) => {
          const blueprint = mutableBp.getBlueprint()
          const mod = blueprint.modules[moduleIndex]
          if (!mod) return { error: `Module ${moduleIndex} not found` }
          const form = mod.forms[formIndex]
          if (!form) return { error: `Form ${formIndex} not found in module ${moduleIndex}` }

          // Get case type for applyDefaults
          const ct = (blueprint.case_types ?? []).find(c => c.name === mod.case_type) ?? null

          // Process new questions: strip sentinels → apply case property defaults
          const processed = questions.map(q => applyDefaults(stripEmpty(q as unknown as FlatQuestion), ct))

          // Merge with existing: flatten existing tree, append new, rebuild
          const existingFlat = flattenToFlat(form.questions)
          const allFlat = [...existingFlat, ...processed]
          const newTree = buildQuestionTree(allFlat)

          mutableBp.replaceForm(moduleIndex, formIndex, { ...form, questions: newTree })
          ctx.emit('data-phase', { phase: 'forms' })
          ctx.emit('data-form-updated', { moduleIndex, formIndex, form: { ...form, questions: newTree } })

          return {
            addedCount: questions.length,
            totalCount: countQuestionsRecursive(newTree),
            caseProperties: collectCaseProperties(newTree),
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
          const questionPath = mutableBp.resolveQuestionId(moduleIndex, formIndex, questionId)
          if (!questionPath) return { error: `Question "${questionId}" not found in m${moduleIndex}-f${formIndex}` }
          const question = mutableBp.getQuestion(moduleIndex, formIndex, questionPath)
          if (!question) return { error: `Question "${questionId}" not found in m${moduleIndex}-f${formIndex}` }
          return { moduleIndex, formIndex, questionId, path: questionPath as string, question }
        },
      }),

      // ── Question mutations ────────────────────────────────────────

      editQuestion: tool({
        description: 'Update fields on an existing question. Only include fields you want to change. Use null to clear a field. Renaming the id automatically propagates XPath and column references — for case properties, propagates across all forms in the module.',
        inputSchema: z.object({
          moduleIndex: z.number().describe('0-based module index'),
          formIndex: z.number().describe('0-based form index'),
          questionId: z.string().describe('Question id to update'),
          updates: z.object({
            id: z.string().optional().describe('New question id. Automatically propagates XPath refs; for case properties, propagates across all forms and columns.'),
            label: z.string().optional().describe('Question label text'),
            type: z.enum(QUESTION_TYPES).optional(),
            hint: z.string().optional().describe('Hint text'),
            required: z.string().optional().describe('"true()" if always required, or XPath for conditional.'),
            validation: z.string().optional().describe('XPath validation expression'),
            validation_msg: z.string().optional().describe('Error message when validation fails'),
            relevant: z.string().nullable().optional().describe('XPath display condition'),
            calculate: z.string().nullable().optional().describe('XPath computed value'),
            default_value: z.string().nullable().optional().describe('XPath initial value'),
            options: z.array(selectOptionSchema).nullable().optional(),
            is_case_property: z.boolean().optional(),
          }).describe('Fields to update. Only include fields you want to change.'),
        }),
        execute: async ({ moduleIndex, formIndex, questionId, updates }) => {
          try {
            let currentPath = mutableBp.resolveQuestionId(moduleIndex, formIndex, questionId)
            if (!currentPath) return { error: `Question "${questionId}" not found in m${moduleIndex}-f${formIndex}` }

            // Handle ID rename with automatic propagation
            const { id: newId, ...fieldUpdates } = updates
            if (newId && newId !== questionId) {
              const question = mutableBp.getQuestion(moduleIndex, formIndex, currentPath)
              if (question?.is_case_property) {
                // Cross-form rename: all forms in module + columns + #case/ refs
                const mod = mutableBp.getModule(moduleIndex)
                if (mod?.case_type) {
                  mutableBp.renameCaseProperty(mod.case_type, questionId, newId)
                }
              } else {
                // Single-form rename: XPath path refs within this form
                mutableBp.renameQuestion(moduleIndex, formIndex, currentPath, newId)
              }
              // Re-resolve path after rename
              currentPath = mutableBp.resolveQuestionId(moduleIndex, formIndex, newId)!
            }

            // Apply remaining field updates
            if (Object.keys(fieldUpdates).length > 0) {
              mutableBp.updateQuestion(moduleIndex, formIndex, currentPath, fieldUpdates)
            }

            // Emit update for all affected forms
            if (newId && newId !== questionId) {
              ctx.emit('data-blueprint-updated', { blueprint: mutableBp.getBlueprint() })
            } else {
              const form = mutableBp.getForm(moduleIndex, formIndex)!
              ctx.emit('data-form-updated', { moduleIndex, formIndex, form })
            }
            return { moduleIndex, formIndex, questionId: newId ?? questionId, updatedFields: Object.keys(updates) }
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
            validation: z.string().optional(),
            validation_msg: z.string().optional(),
            relevant: z.string().optional(),
            calculate: z.string().optional(),
            default_value: z.string().optional(),
            options: z.array(selectOptionSchema).optional(),
            is_case_property: z.boolean().optional(),
          }),
          afterQuestionId: z.string().optional().describe('Insert after this question ID. Omit to append at end.'),
          beforeQuestionId: z.string().optional().describe('Insert before this question ID. Takes precedence over afterQuestionId.'),
          parentId: z.string().optional().describe('ID of a group/repeat to nest inside'),
        }),
        execute: async ({ moduleIndex, formIndex, question, afterQuestionId, beforeQuestionId, parentId }) => {
          try {
            const afterPath = afterQuestionId ? mutableBp.resolveQuestionId(moduleIndex, formIndex, afterQuestionId) : undefined
            const beforePath = beforeQuestionId ? mutableBp.resolveQuestionId(moduleIndex, formIndex, beforeQuestionId) : undefined
            const parentPath = parentId ? mutableBp.resolveQuestionId(moduleIndex, formIndex, parentId) : undefined
            mutableBp.addQuestion(moduleIndex, formIndex, question as NewQuestion, { afterPath, beforePath, parentPath })
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
            const questionPath = mutableBp.resolveQuestionId(moduleIndex, formIndex, questionId)
            if (!questionPath) return { error: `Question "${questionId}" not found in m${moduleIndex}-f${formIndex}` }
            const beforeCount = countQuestionsRecursive(mutableBp.getForm(moduleIndex, formIndex)!.questions)
            mutableBp.removeQuestion(moduleIndex, formIndex, questionPath)
            const form = mutableBp.getForm(moduleIndex, formIndex)!
            ctx.emit('data-form-updated', { moduleIndex, formIndex, form })
            const afterCount = countQuestionsRecursive(form.questions)
            return { moduleIndex, formIndex, removedQuestionId: questionId, questionCountBefore: beforeCount, questionCountAfter: afterCount }
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
        description: 'Update form metadata: name, close_case, or child_cases config.',
        inputSchema: z.object({
          moduleIndex: z.number().describe('0-based module index'),
          formIndex: z.number().describe('0-based form index'),
          name: z.string().optional().describe('New form name'),
          close_case: z.object({
            question: z.string().optional(),
            answer: z.string().optional(),
          }).nullable().optional().describe('Set close_case config. null to remove. {} for unconditional.'),
          child_cases: z.array(z.object({
            case_type: z.string(),
            case_name_field: z.string(),
            case_properties: z.array(z.object({ case_property: z.string(), question_id: z.string() })),
            relationship: z.enum(['child', 'extension']),
            repeat_context: z.string().describe('Repeat group ID. Empty string if not in repeat.'),
          })).nullable().optional().describe('Child cases config. null to remove.'),
        }),
        execute: async ({ moduleIndex, formIndex, name, close_case, child_cases }) => {
          try {
            mutableBp.updateForm(moduleIndex, formIndex, {
              ...(name !== undefined && { name }),
              ...(close_case !== undefined && { close_case }),
              ...(child_cases !== undefined && { child_cases }),
            })
            const form = mutableBp.getForm(moduleIndex, formIndex)!
            ctx.emit('data-form-updated', { moduleIndex, formIndex, form })
            return { moduleIndex, formIndex, name: form.name, type: form.type, close_case: form.close_case ?? null, child_cases: form.child_cases ?? null }
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) }
          }
        },
      }),

      createForm: tool({
        description: 'Add a new empty form to a module. Use code_execution + addQuestions to populate it.',
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

      // ── Validation ────────────────────────────────────────────────

      validateApp: tool({
        description: 'Validate the app against CommCare platform rules and fix any issues. Call this when you are done building or editing. If validation fails with remaining errors, use your mutation tools (removeQuestion, editQuestion, etc.) to fix them, then call validateApp again.',
        inputSchema: z.object({}),
        onInputStart: () => {
          ctx.emit('data-phase', { phase: 'validate' })
        },
        execute: async () => {
          const blueprint = mutableBp.getBlueprint()
          const result = await validateAndFix(ctx, blueprint)
          if (result.success) {
            ctx.emit('data-done', {
              blueprint: result.blueprint,
              hqJson: result.hqJson ?? {},
              success: true,
            })
            const output = { success: true as const }
            ctx.logger.logToolOutput('validateApp', output)
            return output
          }
          // Surface remaining errors so the SA can fix them with its tools
          const output = { success: false as const, errors: result.errors ?? [] }
          ctx.logger.logToolOutput('validateApp', output)
          return output
        },
      }),
    },
  })

  return agent
}
