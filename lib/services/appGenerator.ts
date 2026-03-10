/**
 * Two-phase app generation pipeline:
 *
 *   scaffoldBlueprint() — Tier 1: plan app structure + data model (returns raw Scaffold)
 *   fillBlueprint()     — Tiers 2+3: module content + form content (accepts Scaffold, skips Tier 1)
 *     Tier 2: Case list columns per module (Sonnet, structured output)
 *     Tier 3: Questions + case config per form (Sonnet, structured output)
 *     Assembly — combine scaffold + tier outputs into a full AppBlueprint
 *     Validate — check semantic rules; if errors, re-generate failing forms (Haiku)
 *     Expand — convert to HQ JSON
 */
import { sendOneShotStructured, sendOneShotStructuredStream, type ClaudeUsage } from './claude'
import { MODEL_FIXER } from '../models'
import { SCAFFOLD_PROMPT } from '../prompts/scaffoldPrompt'
import { MODULE_PROMPT } from '../prompts/modulePrompt'
import { FORM_PROMPT } from '../prompts/formPrompt'
import { FORM_FIXER_PROMPT } from '../prompts/formFixerPrompt'
import {
  scaffoldSchema, moduleContentSchema, formContentSchema,
  assembleBlueprint, deriveCaseConfig, unflattenQuestions, flattenQuestions, closeCaseToFlat,
  type Scaffold, type ModuleContent, type FormContent, type AppBlueprint, type BlueprintForm,
} from '../schemas/blueprint'
import { expandBlueprint, validateBlueprint } from './hqJsonExpander'
import type { FillStreamEvent, ScaffoldStreamEvent } from '../types'

export interface GenerationResult {
  success: boolean
  blueprint?: AppBlueprint
  hqJson?: Record<string, any>
  errors?: string[]
  usage?: ClaudeUsage[]
}

/**
 * Tier 1 only: scaffold the app structure + data model.
 * Returns the raw Scaffold (not assembled into an AppBlueprint).
 */
export async function scaffoldBlueprint(
  apiKey: string,
  conversationContext: string,
  appName: string,
  onEvent?: (event: ScaffoldStreamEvent) => void,
): Promise<{ success: boolean; scaffold?: Scaffold; errors?: string[]; usage?: ClaudeUsage[] }> {
  const resolvedAppName = appName || inferAppName(conversationContext)
  const emit = onEvent ?? (() => {})
  const scaffoldMessage = `Here is the specification for the app to build:\n\n${conversationContext}\n\nBased on this specification, plan the app structure. App name: "${resolvedAppName}".`

  // Track what we've already emitted so we only emit new items
  let emittedMeta = false
  let emittedCaseTypes = 0
  let emittedModules = 0

  try {
    const { data: scaffold, usage } = await sendOneShotStructuredStream(
      apiKey, SCAFFOLD_PROMPT, scaffoldMessage, scaffoldSchema,
      (snapshot: unknown) => {
        const s = snapshot as any
        if (!s) return

        // Emit app name + description once available
        if (!emittedMeta && s.app_name && s.description) {
          emittedMeta = true
          emit({ type: 'scaffold_meta', appName: resolvedAppName, description: s.description })
        }

        // Emit case types as they complete
        if (Array.isArray(s.case_types)) {
          while (emittedCaseTypes < s.case_types.length) {
            const ct = s.case_types[emittedCaseTypes]
            if (ct?.name && ct?.case_name_property && Array.isArray(ct?.properties)) {
              emit({ type: 'scaffold_case_type', caseTypeIndex: emittedCaseTypes, caseType: ct })
              emittedCaseTypes++
            } else {
              break
            }
          }
        }

        // Emit modules as soon as they look complete (name + forms with name/type).
        // scaffold_done overwrites with the final validated scaffold, so early emission is safe.
        if (Array.isArray(s.modules)) {
          while (emittedModules < s.modules.length) {
            const mod = s.modules[emittedModules]
            if (
              mod?.name && Array.isArray(mod?.forms) && mod.forms.length > 0 &&
              mod.forms.every((f: any) => f?.name && f?.type)
            ) {
              emit({ type: 'scaffold_module', moduleIndex: emittedModules, module: mod })
              emittedModules++
            } else {
              break
            }
          }
        }
      },
      {
        maxTokens: 16384,
        toolName: 'generate_scaffold',
        toolDescription: 'Generate the application scaffold with all modules, case types, and forms.',
      }
    )
    scaffold.app_name = resolvedAppName

    // Emit any remaining modules that were held back
    for (let i = emittedModules; i < scaffold.modules.length; i++) {
      emit({ type: 'scaffold_module', moduleIndex: i, module: scaffold.modules[i] as any })
    }

    emit({ type: 'scaffold_done', scaffold, usage: [usage] })
    return { success: true, scaffold, usage: [usage] }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    emit({ type: 'error', message: `Scaffold failed: ${errMsg}` })
    return { success: false, errors: [`Scaffold failed: ${errMsg}`] }
  }
}

export async function fillBlueprint(
  apiKey: string,
  scaffold: Scaffold,
  onEvent?: (event: FillStreamEvent) => void,
): Promise<GenerationResult> {
  const emit = onEvent ?? (() => {})
  try {
    return await doGenerate(apiKey, scaffold, emit)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    emit({ type: 'error', message: errMsg })
    return { success: false, errors: [errMsg] }
  }
}

async function doGenerate(
  apiKey: string,
  scaffold: Scaffold,
  emit: (event: FillStreamEvent) => void,
): Promise<GenerationResult> {

  const allUsage: ClaudeUsage[] = []

  // Pre-compute total forms for progress tracking
  const totalForms = scaffold.modules.reduce((sum, m) => sum + m.forms.length, 0)
  const totalSteps = scaffold.modules.length + totalForms // modules + forms
  let completedSteps = 0

  // Build case type lookup (properties + case name property)
  const caseTypeLookup = new Map<string, { properties: Array<{ name: string; label: string }>; case_name_property: string }>()
  if (scaffold.case_types) {
    for (const ct of scaffold.case_types) {
      caseTypeLookup.set(ct.name, { properties: ct.properties, case_name_property: ct.case_name_property })
    }
  }

  // ── Tier 2 + 3: Modules and Forms (depth-first) ──────────────────

  const moduleContents: ModuleContent[] = []
  const formContents: FormContent[][] = []

  emit({ type: 'phase', phase: 'modules' })

  for (let mIdx = 0; mIdx < scaffold.modules.length; mIdx++) {
    const sm = scaffold.modules[mIdx]

    // Get case type info for this module
    const ctInfo = sm.case_type ? caseTypeLookup.get(sm.case_type) : undefined
    const props = ctInfo?.properties ?? []
    const propsDesc = props.length > 0
      ? `\n\nCase type "${sm.case_type}" has these properties:\n${props.map(p => `- ${p.name}: ${p.label}`).join('\n')}\n\nCase name property: ${ctInfo!.case_name_property}`
      : ''

    // Tier 2: Module content
    const moduleMessage = `App: "${scaffold.app_name}" — ${scaffold.description}

Module: "${sm.name}"
Case type: ${sm.case_type ?? 'none (survey-only)'}
Purpose: ${sm.purpose}
Forms: ${sm.forms.map(f => `"${f.name}" (${f.type})`).join(', ')}${propsDesc}

Design the case list columns for this module.`

    let mc: ModuleContent
    try {
      const result = await sendOneShotStructured(
        apiKey, MODULE_PROMPT, moduleMessage, moduleContentSchema,
        () => {},
        { maxTokens: 4096 }
      )
      mc = result.data
      allUsage.push(result.usage)
      emit({ type: 'usage', usage: result.usage })
    } catch {
      mc = { case_list_columns: null }
    }

    moduleContents.push(mc)
    completedSteps++

    emit({ type: 'module_done', moduleIndex: mIdx, caseListColumns: mc.case_list_columns ?? null })
    emit({ type: 'progress', message: `Module ${mIdx + 1}/${scaffold.modules.length}: ${sm.name}`, completed: completedSteps, total: totalSteps })

    // Tier 3: Form content (depth-first within this module)
    const moduleForms: FormContent[] = []

    if (mIdx === 0 && sm.forms.length > 0) {
      emit({ type: 'phase', phase: 'forms' })
    }

    for (let fIdx = 0; fIdx < sm.forms.length; fIdx++) {
      // Emit phase transition to forms on first form overall
      if (mIdx > 0 && fIdx === 0 && formContents.every(mf => mf.length === 0)) {
        // Edge case: first module had no forms, emit phase on first form we encounter
      }

      const sf = sm.forms[fIdx]

      let formMessage = `App: "${scaffold.app_name}" — ${scaffold.description}

Module: "${sm.name}" (${sm.purpose})
Case type: ${sm.case_type ?? 'none'}${propsDesc}

Form: "${sf.name}"
Type: ${sf.type}
Purpose: ${sf.purpose}

Sibling forms in this module: ${sm.forms.map(f => `"${f.name}" (${f.type})`).join(', ')}`

      formMessage += '\n\nDesign the questions for this form.'

      let fc: FormContent
      try {
        const result = await sendOneShotStructured(
          apiKey, FORM_PROMPT, formMessage, formContentSchema,
          () => {},
          { maxTokens: 32768 }
        )
        fc = result.data
        allUsage.push(result.usage)
        emit({ type: 'usage', usage: result.usage })
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        emit({ type: 'error', message: `Form "${sf.name}" failed: ${errMsg}` })
        return { success: false, errors: [`Form "${sf.name}" failed: ${errMsg}`] }
      }

      moduleForms.push(fc)
      completedSteps++

      // Emit the assembled form for incremental tree updates
      const assembledForm = reassembleForm(sf.name, sf.type as 'registration' | 'followup' | 'survey', fc)
      emit({ type: 'form_done', moduleIndex: mIdx, formIndex: fIdx, form: assembledForm })
      emit({ type: 'progress', message: `Form ${completedSteps - scaffold.modules.length}/${totalForms}: ${sf.name}`, completed: completedSteps, total: totalSteps })
    }

    formContents.push(moduleForms)
  }

  // ── Assembly ──────────────────────────────────────────────────────

  const blueprint = assembleBlueprint(scaffold, moduleContents, formContents)

  // ── Validate + Fix Loop ──────────────────────────────────────────

  return await validateAndFix(apiKey, blueprint, allUsage, emit)
}

async function validateAndFix(
  apiKey: string,
  blueprint: AppBlueprint,
  allUsage: ClaudeUsage[],
  emit: (event: FillStreamEvent) => void,
): Promise<GenerationResult> {
  const recentErrorSignatures: string[] = []
  const MAX_STUCK_REPEATS = 3
  let attempt = 0

  emit({ type: 'phase', phase: 'validating' })

  while (true) {
    attempt++

    const errors = validateBlueprint(blueprint)

    if (errors.length === 0) {
      const hqJson = expandBlueprint(blueprint)

      emit({ type: 'done', blueprint, hqJson, usage: allUsage })
      return { success: true, blueprint, hqJson, usage: allUsage }
    }

    // Stuck detection
    const sig = errors.slice().sort().join('|||')
    recentErrorSignatures.push(sig)
    if (recentErrorSignatures.length > MAX_STUCK_REPEATS) recentErrorSignatures.shift()
    if (recentErrorSignatures.length === MAX_STUCK_REPEATS && recentErrorSignatures.every(s => s === sig)) {
      try {
        const hqJson = expandBlueprint(blueprint)
        emit({ type: 'done', blueprint, hqJson, usage: allUsage })
        return { success: false, blueprint, hqJson, errors, usage: allUsage }
      } catch {
        emit({ type: 'error', message: errors.join('; ') })
        return { success: false, blueprint, errors, usage: allUsage }
      }
    }

    emit({ type: 'phase', phase: 'fixing' })
    emit({ type: 'fix_attempt', attempt, errorCount: errors.length })

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
        const result = await sendOneShotStructured(
          apiKey, FORM_FIXER_PROMPT, fixMessage, formContentSchema,
          () => {},
          { model: MODEL_FIXER, maxTokens: 32768 }
        )
        allUsage.push(result.usage)
        emit({ type: 'usage', usage: result.usage })

        const fixedForm = reassembleForm(form.name, form.type, result.data)
        blueprint.modules[mIdx].forms[fIdx] = fixedForm
        emit({ type: 'form_done', moduleIndex: mIdx, formIndex: fIdx, form: fixedForm })
      } catch {
        // Fix failed, continue to next attempt
      }
    }
  }
}

/** Reassemble a FormContent back into a BlueprintForm */
export function reassembleForm(name: string, type: 'registration' | 'followup' | 'survey', fc: FormContent): BlueprintForm {
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

/** Group validation errors by form name */
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

/** Find module and form indices by form name */
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

function inferAppName(context: string): string {
  const firstLine = context.split('\n').find(l => l.startsWith('User:'))
  if (firstLine) {
    let desc = firstLine.replace('User:', '').trim()
    desc = desc.replace(
      /^(I need|I want|Create|Build|Make|Generate|Design|Develop|Help me build|Help me create|Can you build|Can you create|Please create|Please build)\s+(a|an|the|me a|me an)?\s*/i,
      ''
    )
    const words = desc.split(/\s+/).slice(0, 5).join(' ')
    if (words.length > 3) {
      return words.replace(/[^a-zA-Z0-9\s-]/g, '').trim() || 'CommCare App'
    }
  }
  return 'CommCare App'
}
