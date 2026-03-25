/**
 * Deep blueprint validation — comprehensive XPath and structural checks.
 *
 * Operates directly on AppBlueprint objects. Validates every XPath expression
 * in every question via a Lezer tree walk (syntax + semantics), detects
 * dependency cycles, and checks case property references.
 *
 * Returns error strings compatible with the existing fix loop.
 */

import type { AppBlueprint, Question } from '@/lib/schemas/blueprint'
// collectCaseProperties derives from questions (reactive schema) rather than case_types
import { validateXPath } from './xpathValidator'
import { TriggerDag } from '@/lib/preview/engine/triggerDag'

const XPATH_FIELDS = ['relevant', 'validation', 'calculate', 'default_value', 'required'] as const

/** Collect all valid /data/... paths from a question tree. */
export function collectValidPaths(questions: Question[], prefix = '/data'): Set<string> {
  const paths = new Set<string>()
  for (const q of questions) {
    const path = `${prefix}/${q.id}`
    paths.add(path)
    if ((q.type === 'group' || q.type === 'repeat') && q.children) {
      for (const p of collectValidPaths(q.children, path)) {
        paths.add(p)
      }
    }
  }
  return paths
}

/** Collect case property names by scanning questions with case_property_on matching the module's case type. */
export function collectCaseProperties(blueprint: AppBlueprint, moduleCaseType: string | undefined): Set<string> | undefined {
  if (!moduleCaseType) return undefined
  const props = new Set<string>()
  for (const mod of blueprint.modules) {
    if (mod.case_type !== moduleCaseType) continue
    for (const form of mod.forms) {
      collectFromQuestions(form.questions || [], moduleCaseType, props)
    }
  }
  return props.size > 0 ? props : undefined
}

function collectFromQuestions(questions: Question[], moduleCaseType: string, props: Set<string>): void {
  for (const q of questions) {
    if (q.case_property_on === moduleCaseType) props.add(q.id)
    if (q.children) collectFromQuestions(q.children, moduleCaseType, props)
  }
}

/**
 * Deep validation of a blueprint's XPath expressions, cycles, and references.
 * Returns error strings in the same format as validateBlueprint() for fix loop compatibility.
 */
export function validateBlueprintDeep(blueprint: AppBlueprint): string[] {
  const errors: string[] = []

  for (const mod of blueprint.modules) {
    const caseProps = collectCaseProperties(blueprint, mod.case_type ?? undefined)

    for (const form of mod.forms) {
      const questions = form.questions || []
      if (questions.length === 0) continue

      const validPaths = collectValidPaths(questions)

      // Validate XPath in every question
      validateQuestionsXPath(questions, validPaths, caseProps, form.name, mod.name, errors)

      // Cycle detection via TriggerDag
      const dag = new TriggerDag()
      const cycles = dag.reportCycles(questions)
      for (const cycle of cycles) {
        const cyclePath = cycle.join(' → ')
        errors.push(`"${form.name}" in "${mod.name}" has a circular dependency: ${cyclePath}`)
      }
    }
  }

  return errors
}

/** Recursively validate XPath expressions in all questions. */
function validateQuestionsXPath(
  questions: Question[],
  validPaths: Set<string>,
  caseProperties: Set<string> | undefined,
  formName: string,
  moduleName: string,
  errors: string[],
): void {
  for (const q of questions) {
    for (const field of XPATH_FIELDS) {
      const expr = q[field]
      if (typeof expr !== 'string' || !expr) continue

      const xpathErrors = validateXPath(expr, validPaths, caseProperties)
      for (const err of xpathErrors) {
        errors.push(`Question "${q.id}" in "${formName}": ${field} expression error — ${err.message}`)
      }
    }

    if ((q.type === 'group' || q.type === 'repeat') && q.children) {
      validateQuestionsXPath(q.children, validPaths, caseProperties, formName, moduleName, errors)
    }
  }
}
