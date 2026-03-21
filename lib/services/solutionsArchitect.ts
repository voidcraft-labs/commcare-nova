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
import { MutableBlueprint, type NewQuestion } from './mutableBlueprint'
import { validateAndFix } from './validationLoop'
import { generateSingleFormContent, buildColumnPrompt, QUESTION_TYPES } from './formGeneration'

// Re-export for consumers that imported from this module
export { validateAndFix } from './validationLoop'
export { generateSingleFormContent } from './formGeneration'

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

interface QuestionSummary {
  id: string
  type: string
  case_property?: string
  children?: QuestionSummary[]
}

/** Compact question tree summary so the SA can see IDs, types, and nesting at a glance. */
function summarizeQuestions(questions: Question[]): QuestionSummary[] {
  return questions.map(q => {
    const entry: QuestionSummary = { id: q.id, type: q.type }
    if (q.case_property) entry.case_property = q.case_property
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
            questions: summarizeQuestions(newForm.questions),
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
            validation: z.string().optional().describe('XPath validation expression'),
            validation_msg: z.string().optional().describe('Error message when validation fails'),
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
            const questionPath = mutableBp.resolveQuestionId(moduleIndex, formIndex, questionId)
            if (!questionPath) return { error: `Question "${questionId}" not found in m${moduleIndex}-f${formIndex}` }
            const question = mutableBp.updateQuestion(moduleIndex, formIndex, questionPath, updates)
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
            validation: z.string().optional(),
            validation_msg: z.string().optional(),
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
              questions: summarizeQuestions(newForm.questions),
            }
          } catch (err) {
            return { error: err instanceof Error ? err.message : String(err) }
          }
        },
      }),

      // ── Validation ────────────────────────────────────────────────

      validateApp: tool({
        description: 'Validate the app against CommCare platform rules and fix any issues. Call this when you are done building or editing. If validation fails with remaining errors, use your mutation tools (removeQuestion, editQuestion, etc.) to fix them, then call validateApp again.',
        inputSchema: z.object({}),
        execute: async () => {
          const blueprint = mutableBp.getBlueprint()
          const result = await validateAndFix(ctx, blueprint)
          if (result.success) {
            ctx.emit('data-done', {
              blueprint: result.blueprint,
              hqJson: result.hqJson ?? {},
              success: true,
            })
            return { success: true }
          }
          // Surface remaining errors so the SA can fix them with its tools
          return { success: false, errors: result.errors ?? [] }
        },
      }),
    },
  })

  return agent
}
