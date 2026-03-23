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

      // Apply programmatic fixes
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

    const unquotedMatch = err.match(/Question "(\w+)".*unquoted string "([^"]+)" in (\w+)/)
    if (unquotedMatch) {
      const q = findQuestionById(form.questions, unquotedMatch[1])
      if (q) {
        type XPathField = 'validation' | 'relevant' | 'calculate' | 'default_value' | 'required'
        const field = unquotedMatch[3] as XPathField
        q[field] = `'${unquotedMatch[2]}'`
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

    // Auto-fix unknown functions with case mismatch (e.g. Today() → today())
    const unknownFuncMatch = err.match(/Unknown function "(\w[\w-]*)[\w-]*\(\)" — did you mean "(\w[\w-]*)[\w-]*\(\)"/)
    if (unknownFuncMatch) {
      const wrong = unknownFuncMatch[1]
      const correct = unknownFuncMatch[2]
      const qIdMatch = err.match(/Question "(\w+)"/)
      if (qIdMatch) {
        const q = findQuestionById(form.questions, qIdMatch[1])
        if (q) fixFunctionCase(q, wrong, correct)
      }
      continue
    }

    // Auto-fix round(x, 2) → round(x) — common LLM mistake
    const arityMatch = err.match(/(\w[\w-]*)\(\) accepts at most (\d+) argument/)
    if (arityMatch && arityMatch[1] === 'round') {
      const qIdMatch = err.match(/Question "(\w+)"/)
      if (qIdMatch) {
        const q = findQuestionById(form.questions, qIdMatch[1])
        if (q) fixRoundArity(q)
      }
      continue
    }
  }
}

/** Fix function name case in all XPath fields (e.g. Today → today). */
function fixFunctionCase(q: Question, wrong: string, correct: string): void {
  type XPathField = 'validation' | 'relevant' | 'calculate' | 'default_value' | 'required'
  const fields: XPathField[] = ['validation', 'relevant', 'calculate', 'default_value', 'required']
  for (const field of fields) {
    const val = q[field]
    if (typeof val === 'string' && val.includes(wrong + '(')) {
      q[field] = val.replaceAll(wrong + '(', correct + '(')
    }
  }
}

/** Fix round(x, n) → round(x) by stripping the second argument. */
function fixRoundArity(q: Question): void {
  type XPathField = 'validation' | 'relevant' | 'calculate' | 'default_value' | 'required'
  const fields: XPathField[] = ['validation', 'relevant', 'calculate', 'default_value', 'required']
  for (const field of fields) {
    const val = q[field]
    if (typeof val === 'string') {
      // Match round(expr, expr) and keep only the first argument
      q[field] = val.replace(/round\(([^,)]+),\s*[^)]+\)/g, 'round($1)')
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
