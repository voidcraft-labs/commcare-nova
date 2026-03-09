/**
 * Orchestrates the three-tiered app generation pipeline:
 *
 *   Tier 1: Scaffold — plan app structure + data model (Sonnet, structured output)
 *   Tier 2: Module content — case list columns per module (Sonnet, structured output)
 *   Tier 3: Form content — questions + case config per form (Sonnet, structured output)
 *   Assembly — combine tiers into a full AppBlueprint
 *   Validate — check semantic rules; if errors, re-generate failing forms (Haiku)
 *   Expand — convert to HQ JSON
 */
import { sendOneShotStructured } from './claude'
import { SCAFFOLD_PROMPT } from '../prompts/scaffoldPrompt'
import { MODULE_PROMPT } from '../prompts/modulePrompt'
import { FORM_PROMPT } from '../prompts/formPrompt'
import { FORM_FIXER_PROMPT } from '../prompts/formFixerPrompt'
import {
  scaffoldSchema, moduleContentSchema, formContentSchema,
  assembleBlueprint, unflattenQuestions, flattenQuestions, closeCaseToFlat,
  type Scaffold, type ModuleContent, type FormContent, type AppBlueprint, type BlueprintForm, type BlueprintQuestion,
} from '../schemas/blueprint'
import { expandBlueprint, validateBlueprint } from './hqJsonExpander'

export interface GenerationResult {
  success: boolean
  blueprint?: AppBlueprint
  hqJson?: Record<string, any>
  errors?: string[]
}

export async function generateApp(
  apiKey: string,
  conversationContext: string,
  appName: string,
): Promise<GenerationResult> {
  const resolvedAppName = appName || inferAppName(conversationContext)

  try {
    return await doGenerate(apiKey, conversationContext, resolvedAppName)
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    return { success: false, errors: [errMsg] }
  }
}

async function doGenerate(
  apiKey: string,
  conversationContext: string,
  resolvedAppName: string,
): Promise<GenerationResult> {

  // ── Tier 1: Scaffold ──────────────────────────────────────────────

  const scaffoldMessage = `Here is the full conversation with the user about the app they want:\n\n${conversationContext}\n\nBased on this conversation, plan the app structure. App name: "${resolvedAppName}".`

  let scaffold: Scaffold
  try {
    scaffold = await sendOneShotStructured(
      apiKey, SCAFFOLD_PROMPT, scaffoldMessage, scaffoldSchema,
      () => {},
      { maxTokens: 16384 }
    )
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    return { success: false, errors: [`Scaffold failed: ${errMsg}`] }
  }

  scaffold.app_name = resolvedAppName

  // Build case type property lookup
  const caseTypeProps = new Map<string, Array<{ name: string; label: string }>>()
  if (scaffold.case_types) {
    for (const ct of scaffold.case_types) {
      caseTypeProps.set(ct.name, ct.properties)
    }
  }

  // ── Tier 2 + 3: Modules and Forms (depth-first) ──────────────────

  const moduleContents: ModuleContent[] = []
  const formContents: FormContent[][] = []

  for (let mIdx = 0; mIdx < scaffold.modules.length; mIdx++) {
    const sm = scaffold.modules[mIdx]

    // Get case type properties for this module
    const props = sm.case_type ? (caseTypeProps.get(sm.case_type) ?? []) : []
    const propsDesc = props.length > 0
      ? `\n\nCase type "${sm.case_type}" has these properties:\n${props.map(p => `- ${p.name}: ${p.label}`).join('\n')}`
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
      mc = await sendOneShotStructured(
        apiKey, MODULE_PROMPT, moduleMessage, moduleContentSchema,
        () => {},
        { maxTokens: 4096 }
      )
    } catch {
      mc = { case_list_columns: null }
    }

    moduleContents.push(mc)

    // Tier 3: Form content (depth-first within this module)
    const moduleForms: FormContent[] = []
    let registrationCaseProps: Record<string, string> | null = null

    for (let fIdx = 0; fIdx < sm.forms.length; fIdx++) {
      const sf = sm.forms[fIdx]

      let formMessage = `App: "${scaffold.app_name}" — ${scaffold.description}

Module: "${sm.name}" (${sm.purpose})
Case type: ${sm.case_type ?? 'none'}${propsDesc}

Module's case list columns: ${mc.case_list_columns ? JSON.stringify(mc.case_list_columns) : 'none'}

Form: "${sf.name}"
Type: ${sf.type}
Purpose: ${sf.purpose}

Sibling forms in this module: ${sm.forms.map(f => `"${f.name}" (${f.type})`).join(', ')}`

      if (sf.type === 'followup' && registrationCaseProps) {
        formMessage += `\n\nThe registration form's case_properties mapping (property -> question_id): ${JSON.stringify(registrationCaseProps)}\nUse case_preload to pre-fill questions with these case properties where appropriate.`
      }

      formMessage += '\n\nDesign the questions and case configuration for this form.'

      let fc: FormContent
      try {
        fc = await sendOneShotStructured(
          apiKey, FORM_PROMPT, formMessage, formContentSchema,
          () => {},
          { maxTokens: 32768 }
        )
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        return { success: false, errors: [`Form "${sf.name}" failed: ${errMsg}`] }
      }

      if (sf.type === 'registration' && fc.case_properties) {
        registrationCaseProps = fc.case_properties
      }

      moduleForms.push(fc)
    }

    formContents.push(moduleForms)
  }

  // ── Assembly ──────────────────────────────────────────────────────

  const blueprint = assembleBlueprint(scaffold, moduleContents, formContents)

  // ── Validate + Fix Loop ──────────────────────────────────────────

  return await validateAndFix(apiKey, blueprint)
}

async function validateAndFix(
  apiKey: string,
  blueprint: AppBlueprint,
): Promise<GenerationResult> {
  const recentErrorSignatures: string[] = []
  const MAX_STUCK_REPEATS = 3
  let attempt = 0

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
        return { success: false, blueprint, hqJson, errors }
      } catch {
        return { success: false, blueprint, errors }
      }
    }

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
        case_name_field: form.case_name_field ?? null,
        case_properties: form.case_properties ?? null,
        case_preload: form.case_preload ?? null,
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
        const fixed = await sendOneShotStructured(
          apiKey, FORM_FIXER_PROMPT, fixMessage, formContentSchema,
          () => {},
          { model: 'claude-haiku-4-5-20251001', maxTokens: 32768 }
        )

        blueprint.modules[mIdx].forms[fIdx] = reassembleForm(form.name, form.type, fixed)
      } catch {
        // Fix failed, continue to next attempt
      }
    }
  }
}

/** Reassemble a FormContent back into a BlueprintForm */
function reassembleForm(name: string, type: 'registration' | 'followup' | 'survey', fc: FormContent): BlueprintForm {
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
    ...(fc.case_name_field != null && { case_name_field: fc.case_name_field }),
    ...(fc.case_properties != null && { case_properties: fc.case_properties }),
    ...(fc.case_preload != null && { case_preload: fc.case_preload }),
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
