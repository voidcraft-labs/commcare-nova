/**
 * Validation and fix loop for CommCare app blueprints.
 *
 * Runs validateBlueprint() in a loop, applying programmatic fixes for common
 * issues and falling back to structured output generation for unfixable errors
 * (e.g. empty forms). Stuck detection prevents infinite loops.
 */
import type { AppBlueprint, BlueprintForm, Question } from '../schemas/blueprint'
import { expandBlueprint, validateBlueprint } from './hqJsonExpander'
import { GenerationContext } from './generationContext'
import { generateSingleFormContent } from './formGeneration'

// ── Validate + fix loop ──────────────────────────────────────────────

export async function validateAndFix(
  ctx: GenerationContext,
  blueprint: AppBlueprint,
): Promise<{ success: boolean; blueprint: AppBlueprint; hqJson?: Record<string, any>; errors?: string[] }> {
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
        return { success: false, blueprint, hqJson, errors }
      } catch {
        return { success: false, blueprint, errors }
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

// ── Error grouping helpers ───────────────────────────────────────────

export function groupErrorsByForm(errors: string[], blueprint: AppBlueprint): Map<string, string[]> {
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

export function applyProgrammaticFixes(form: BlueprintForm, errors: string[]): void {
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

// ── Question search helpers ──────────────────────────────────────────

function findCaseNameCandidate(questions: Question[]): Question | undefined {
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
  return undefined
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

function findQuestionByCaseProperty(questions: Question[], prop: string): Question | undefined {
  for (const q of questions) {
    if (q.case_property === prop) return q
    if (q.children) {
      const found = findQuestionByCaseProperty(q.children, prop)
      if (found) return found
    }
  }
  return undefined
}

function findQuestionById(questions: Question[], id: string): Question | undefined {
  for (const q of questions) {
    if (q.id === id) return q
    if (q.children) {
      const found = findQuestionById(q.children, id)
      if (found) return found
    }
  }
  return undefined
}
