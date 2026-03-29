/**
 * Deep XPath validation — Lezer-based syntax, semantics, and reference checking.
 *
 * Operates directly on AppBlueprint objects. Validates every XPath expression
 * in every question via a Lezer tree walk (syntax + semantics), detects
 * dependency cycles, and checks case property references.
 *
 * Called by runner.ts which wraps the string output into structured ValidationError objects.
 */

import type { AppBlueprint, Question } from '@/lib/schemas/blueprint'
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

/** Deep validation of a blueprint's XPath expressions, cycles, and references. */
export function validateBlueprintDeep(blueprint: AppBlueprint): string[] {
  const errors: string[] = []

  for (const mod of blueprint.modules) {
    const caseProps = collectCaseProperties(blueprint, mod.case_type ?? undefined)

    for (const form of mod.forms) {
      const questions = form.questions || []
      if (questions.length === 0) continue

      const validPaths = collectValidPaths(questions)

      // Add Connect data paths so question XPaths can reference them (only when app-level connect_type is set)
      if (blueprint.connect_type && form.connect) {
        if (form.connect.learn_module) validPaths.add(`/data/${form.connect.learn_module.id || 'connect_learn'}`)
        if (form.connect.assessment) validPaths.add(`/data/${form.connect.assessment.id || 'connect_assessment'}/assessment/user_score`)
        if (form.connect.deliver_unit) {
          const duId = form.connect.deliver_unit.id || 'connect_deliver'
          validPaths.add(`/data/${duId}/deliver/entity_id`)
          validPaths.add(`/data/${duId}/deliver/entity_name`)
        }
      }

      // Validate XPath in every question
      validateQuestionsXPath(questions, validPaths, caseProps, form.name, mod.name, errors)

      // Validate Connect XPath expressions (only when app-level connect_type is set)
      if (blueprint.connect_type && form.connect) {
        const connectXPaths: Array<[string, string]> = []
        if (form.connect.assessment?.user_score) connectXPaths.push(['Connect assessment user_score', form.connect.assessment.user_score])
        if (form.connect.deliver_unit?.entity_id) connectXPaths.push(['Connect deliver entity_id', form.connect.deliver_unit.entity_id])
        if (form.connect.deliver_unit?.entity_name) connectXPaths.push(['Connect deliver entity_name', form.connect.deliver_unit.entity_name])
        for (const [label, expr] of connectXPaths) {
          const xpathErrors = validateXPath(expr, validPaths, caseProps)
          for (const err of xpathErrors) {
            errors.push(`"${form.name}" in "${mod.name}" ${label}: ${err.message}`)
          }
        }
      }

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
