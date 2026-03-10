/**
 * Supervisor Agent — orchestrates the full blueprint generation pipeline.
 *
 * A ToolLoopAgent (tier 1 solutions architect) that:
 *   1. Designs the app scaffold (data model + structure)
 *   2. Delegates module content generation to subagents
 *   3. Delegates form content generation to subagents
 *   4. Reviews subagent output and can request revisions
 *   5. Finalizes the blueprint (assembly + validation + fix)
 */
import { ToolLoopAgent, generateText, Output, tool, hasToolCall, stepCountIs } from 'ai'
import type { UIMessageStreamWriter } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { z } from 'zod'
import { MODEL_GENERATION, MODEL_FIXER } from '../models'
import { SUPERVISOR_PROMPT } from '../prompts/supervisorPrompt'
import { MODULE_PROMPT } from '../prompts/modulePrompt'
import { FORM_PROMPT } from '../prompts/formPrompt'
import { FORM_FIXER_PROMPT } from '../prompts/formFixerPrompt'
import {
  scaffoldSchema, moduleContentSchema, formContentSchema,
  assembleBlueprint, deriveCaseConfig, unflattenQuestions, flattenQuestions, closeCaseToFlat,
  type Scaffold, type ModuleContent, type FormContent, type AppBlueprint, type BlueprintForm,
} from '../schemas/blueprint'
import { expandBlueprint, validateBlueprint } from './hqJsonExpander'

// ── BlueprintAccumulator ──────────────────────────────────────────────

export class BlueprintAccumulator {
  scaffold: Scaffold | null = null
  moduleContents: ModuleContent[] = []
  formContents: FormContent[][] = []

  setScaffold(s: Scaffold) {
    this.scaffold = s
    this.moduleContents = new Array(s.modules.length).fill({ case_list_columns: null })
    this.formContents = s.modules.map(m => new Array(m.forms.length))
  }

  setModuleContent(moduleIndex: number, mc: ModuleContent) {
    this.moduleContents[moduleIndex] = mc
  }

  setFormContent(moduleIndex: number, formIndex: number, fc: FormContent) {
    this.formContents[moduleIndex][formIndex] = fc
  }
}

// ── Helper: reassemble a FormContent into a BlueprintForm ─────────────

function reassembleForm(
  name: string,
  type: 'registration' | 'followup' | 'survey',
  fc: FormContent,
): BlueprintForm {
  const { case_name_field, case_properties, case_preload } = deriveCaseConfig(fc.questions, type)

  const closeCase = fc.close_case == null ? undefined : {
    ...(fc.close_case.question != null && { question: fc.close_case.question }),
    ...(fc.close_case.answer != null && { answer: fc.close_case.answer }),
  }

  const childCases = fc.child_cases?.map(c => ({
    case_type: c.case_type,
    case_name_field: c.case_name_field,
    ...(c.case_properties != null && { case_properties: c.case_properties }),
    ...(c.relationship != null && { relationship: c.relationship }),
    ...(c.repeat_context != null && { repeat_context: c.repeat_context }),
  }))

  return {
    name,
    type,
    ...(case_name_field != null && { case_name_field }),
    ...(case_properties != null && { case_properties }),
    ...(case_preload != null && { case_preload }),
    ...(closeCase !== undefined && { close_case: closeCase }),
    ...(childCases !== undefined && { child_cases: childCases }),
    questions: unflattenQuestions(fc.questions),
  }
}

// ── Helper: build prompts for subagents ───────────────────────────────

function buildModulePrompt(scaffold: Scaffold, moduleIndex: number, feedback?: string): string {
  const sm = scaffold.modules[moduleIndex]
  const ctInfo = scaffold.case_types?.find(ct => ct.name === sm.case_type)
  const props = ctInfo?.properties ?? []
  const propsDesc = props.length > 0
    ? `\n\nCase type "${sm.case_type}" has these properties:\n${props.map(p => `- ${p.name}: ${p.label}`).join('\n')}\n\nCase name property: ${ctInfo!.case_name_property}`
    : ''

  let prompt = `App: "${scaffold.app_name}" — ${scaffold.description}

Module: "${sm.name}"
Case type: ${sm.case_type ?? 'none (survey-only)'}
Purpose: ${sm.purpose}
Forms: ${sm.forms.map(f => `"${f.name}" (${f.type})`).join(', ')}${propsDesc}

Design the case list columns for this module.`

  if (feedback) {
    prompt += `\n\n## Revision Feedback\n${feedback}`
  }

  return prompt
}

function buildFormPrompt(scaffold: Scaffold, moduleIndex: number, formIndex: number, feedback?: string): string {
  const sm = scaffold.modules[moduleIndex]
  const sf = sm.forms[formIndex]
  const ctInfo = scaffold.case_types?.find(ct => ct.name === sm.case_type)
  const props = ctInfo?.properties ?? []
  const propsDesc = props.length > 0
    ? `\n\nCase type "${sm.case_type}" has these properties:\n${props.map(p => `- ${p.name}: ${p.label}`).join('\n')}\n\nCase name property: ${ctInfo!.case_name_property}`
    : ''

  let prompt = `App: "${scaffold.app_name}" — ${scaffold.description}

Module: "${sm.name}" (${sm.purpose})
Case type: ${sm.case_type ?? 'none'}${propsDesc}

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

// ── Helper: validate + fix loop ───────────────────────────────────────

async function validateAndFix(
  apiKey: string,
  blueprint: AppBlueprint,
  writer: UIMessageStreamWriter,
): Promise<{ success: boolean; blueprint: AppBlueprint; hqJson?: Record<string, any> }> {
  const anthropic = createAnthropic({ apiKey })
  const recentErrorSignatures: string[] = []
  const MAX_STUCK_REPEATS = 3
  let attempt = 0

  writer.write({ type: 'data-phase', data: { phase: 'validating' } })

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

    writer.write({ type: 'data-phase', data: { phase: 'fixing' } })
    writer.write({ type: 'data-fix-attempt', data: { attempt, errorCount: errors.length } })

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
      const currentContent = {
        close_case: closeCaseToFlat(form.close_case),
        child_cases: form.child_cases?.map(c => ({
          case_type: c.case_type,
          case_name_field: c.case_name_field,
          case_properties: c.case_properties ?? null,
          relationship: c.relationship ?? null,
          repeat_context: c.repeat_context ?? null,
        })) ?? null,
        questions: flattenQuestions(form.questions),
      }

      const fixMessage = `## Validation Errors\n${formErrs.join('\n')}\n\n## Current Form Content\n${JSON.stringify(currentContent, null, 2)}`

      try {
        const result = await generateText({
          model: anthropic(MODEL_FIXER),
          output: Output.object({ schema: formContentSchema }),
          prompt: fixMessage,
          system: FORM_FIXER_PROMPT,
          maxOutputTokens: 32768,
        })

        if (result.output) {
          const fixedForm = reassembleForm(form.name, form.type, result.output)
          blueprint.modules[mIdx].forms[fIdx] = fixedForm
          writer.write({ type: 'data-form-fixed', data: { moduleIndex: mIdx, formIndex: fIdx, form: fixedForm } })
        }
      } catch {
        // Fix failed, continue to next attempt
      }
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

// ── Create Supervisor Agent ───────────────────────────────────────────

export function createSupervisorAgent(
  apiKey: string,
  accumulator: BlueprintAccumulator,
  writer: UIMessageStreamWriter,
) {
  const anthropic = createAnthropic({ apiKey })

  const agent = new ToolLoopAgent({
    model: anthropic(MODEL_GENERATION),
    instructions: SUPERVISOR_PROMPT,
    stopWhen: [hasToolCall('finalize'), stepCountIs(50)],
    tools: {
      submitScaffold: tool({
        description: 'Submit the designed app scaffold with modules, forms, and case types.',
        inputSchema: scaffoldSchema,
        execute: async (scaffold) => {
          console.log(`[supervisor] Scaffold submitted: ${scaffold.modules.length} modules, ${scaffold.case_types?.length ?? 0} case types`)
          accumulator.setScaffold(scaffold)
          writer.write({ type: 'data-phase', data: { phase: 'modules' } })
          return `Scaffold accepted. ${scaffold.modules.length} modules, ${scaffold.case_types?.length ?? 0} case types. Now generate content for each module and form.`
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
          if (!sm) return `Error: Module index ${moduleIndex} out of range.`

          // Survey-only modules don't need columns
          if (!sm.case_type) {
            const mc = { case_list_columns: null }
            accumulator.setModuleContent(moduleIndex, mc)
            writer.write({ type: 'data-module-done', data: { moduleIndex, caseListColumns: null } })
            return `Module ${moduleIndex} "${sm.name}": survey-only, no columns needed.`
          }

          console.log(`[supervisor] Generating module ${moduleIndex} "${sm.name}"...`)

          try {
            const result = await generateText({
              model: anthropic(MODEL_GENERATION),
              output: Output.object({ schema: moduleContentSchema }),
              system: MODULE_PROMPT,
              prompt: buildModulePrompt(scaffold, moduleIndex, feedback),
              maxOutputTokens: 4096,
            })

            const mc = result.output ?? { case_list_columns: null }
            accumulator.setModuleContent(moduleIndex, mc)
            writer.write({ type: 'data-module-done', data: { moduleIndex, caseListColumns: mc.case_list_columns ?? null } })

            const cols = mc.case_list_columns
            return `Module ${moduleIndex} "${sm.name}": ${cols ? `${cols.length} columns — ${cols.map(c => c.header).join(', ')}` : 'no columns'}.`
          } catch (err) {
            const mc = { case_list_columns: null }
            accumulator.setModuleContent(moduleIndex, mc)
            writer.write({ type: 'data-module-done', data: { moduleIndex, caseListColumns: null } })
            return `Module ${moduleIndex} "${sm.name}": generation failed (${err instanceof Error ? err.message : String(err)}), using empty columns.`
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
          if (!sm) return `Error: Module index ${moduleIndex} out of range.`
          const sf = sm.forms[formIndex]
          if (!sf) return `Error: Form index ${formIndex} out of range in module ${moduleIndex}.`

          // Skip if already generated (unless feedback = revision request)
          if (!feedback && accumulator.formContents[moduleIndex]?.[formIndex]) {
            return `Form [${moduleIndex}][${formIndex}] "${sf.name}" already generated. Pass feedback to revise.`
          }

          writer.write({ type: 'data-phase', data: { phase: 'forms' } })

          console.log(`[supervisor] Generating form [${moduleIndex}][${formIndex}] "${sf.name}" (${sf.type})...`)

          try {
            const result = await generateText({
              model: anthropic(MODEL_GENERATION),
              output: Output.object({ schema: formContentSchema }),
              system: FORM_PROMPT,
              prompt: buildFormPrompt(scaffold, moduleIndex, formIndex, feedback),
              maxOutputTokens: 32768,
            })

            console.log(`[supervisor] Form [${moduleIndex}][${formIndex}] complete: output=${!!result.output}, usage=${result.usage?.totalTokens}`)

            const fc = result.output
            if (!fc) return `Form "${sf.name}": generation returned no output. This is unexpected — try again.`

            accumulator.setFormContent(moduleIndex, formIndex, fc)
            const assembledForm = reassembleForm(sf.name, sf.type as 'registration' | 'followup' | 'survey', fc)
            writer.write({ type: 'data-form-done', data: { moduleIndex, formIndex, form: assembledForm } })

            const questionCount = fc.questions.length
            const caseProps = fc.questions.filter(q => q.case_property).map(q => q.case_property)
            const hasCaseName = fc.questions.some(q => q.is_case_name)
            return `Form [${moduleIndex}][${formIndex}] "${sf.name}" (${sf.type}): ${questionCount} questions, ${caseProps.length} mapped to case properties${hasCaseName ? ', has case name' : ''}. Properties: ${caseProps.join(', ') || 'none'}.`
          } catch (err) {
            console.error(`[supervisor] Form [${moduleIndex}][${formIndex}] error:`, err)
            return `Form "${sf.name}": generation failed — ${err instanceof Error ? err.message : String(err)}. Do NOT retry — call finalize to proceed with what we have.`
          }
        },
      }),

      finalize: tool({
        description: 'Finalize the blueprint after all module and form content is generated. Assembles, validates, and fixes the blueprint.',
        inputSchema: z.object({}),
        execute: async () => {
          console.log(`[supervisor] Finalizing blueprint...`)
          const scaffold = accumulator.scaffold!
          const blueprint = assembleBlueprint(scaffold, accumulator.moduleContents, accumulator.formContents)
          const result = await validateAndFix(apiKey, blueprint, writer)
          writer.write({
            type: 'data-done',
            data: {
              blueprint: result.blueprint,
              hqJson: result.hqJson ?? {},
              success: result.success,
            },
          })
          return result.success ? 'Blueprint finalized successfully.' : 'Blueprint finalized with some validation issues.'
        },
      }),
    },
  })

  return agent
}
