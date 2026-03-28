/**
 * Validation runner — single entry point for all blueprint validation.
 *
 * Walks the blueprint tree once, running scope-appropriate rules at each level,
 * then runs deep XPath validation. Returns structured ValidationError[].
 */

import type { AppBlueprint } from '@/lib/schemas/blueprint'
import type { ValidationError } from './errors'
import { validationError } from './errors'
import { APP_RULES } from './rules/app'
import { MODULE_RULES } from './rules/module'
import { runFormRules } from './rules/form'
import { runQuestionRules } from './rules/question'
import { validateBlueprintDeep } from './index'

/**
 * Run all validation rules on a blueprint.
 * Returns structured errors — use errorToString() for human-readable format.
 */
export function runValidation(blueprint: AppBlueprint): ValidationError[] {
  const errors: ValidationError[] = []

  for (const rule of APP_RULES) {
    errors.push(...rule(blueprint))
  }

  for (let mIdx = 0; mIdx < blueprint.modules.length; mIdx++) {
    const mod = blueprint.modules[mIdx]

    for (const rule of MODULE_RULES) {
      errors.push(...rule(mod, mIdx, blueprint))
    }

    for (let fIdx = 0; fIdx < mod.forms.length; fIdx++) {
      const form = mod.forms[fIdx]
      errors.push(...runFormRules(form, fIdx, mod, mIdx, blueprint))
      if (form.questions && form.questions.length > 0) {
        errors.push(...runQuestionRules(form.questions, {
          formName: form.name, moduleName: mod.name,
          formIndex: fIdx, moduleIndex: mIdx,
        }))
      }
    }
  }

  errors.push(...runDeepValidation(blueprint))

  return errors
}

/**
 * Wrap validateBlueprintDeep() output into structured ValidationErrors
 * with human-friendly messages.
 */
function runDeepValidation(blueprint: AppBlueprint): ValidationError[] {
  const deepErrors = validateBlueprintDeep(blueprint)
  const errors: ValidationError[] = []

  for (const errStr of deepErrors) {
    // Format: Question "id" in "formName": field expression error — message
    const questionMatch = errStr.match(/^Question "([^"]+)" in "([^"]+)": (\w+) expression error — (.+)$/)
    if (questionMatch) {
      const [, questionId, formName, field, rawMessage] = questionMatch
      const code = inferXPathErrorCode(rawMessage)
      const message = humanizeXPathError(code, rawMessage, questionId, formName, field)
      errors.push(validationError(code, 'question', message, {
        formName, questionId, field,
        ...findFormLocation(blueprint, formName),
      }))
      continue
    }

    // Format: "formName" in "moduleName" label: message
    const formLabelMatch = errStr.match(/^"([^"]+)" in "([^"]+)" (.+): (.+)$/)
    if (formLabelMatch) {
      const [, formName, moduleName, label, rawMessage] = formLabelMatch
      const code = inferXPathErrorCode(rawMessage)
      const message = humanizeXPathError(code, rawMessage, undefined, formName, undefined, label)
      errors.push(validationError(code, 'form', message, {
        formName, moduleName,
        ...findFormLocation(blueprint, formName),
      }))
      continue
    }

    // Format: "formName" in "moduleName" has a circular dependency: cycle
    const cycleMatch = errStr.match(/^"([^"]+)" in "([^"]+)" has a circular dependency: (.+)$/)
    if (cycleMatch) {
      const [, formName, moduleName, cycle] = cycleMatch
      errors.push(validationError('CYCLE', 'form',
        `"${formName}" in "${moduleName}" has a circular dependency: ${cycle}. These calculated fields reference each other in a loop, so none of them can ever finish computing. Break the cycle by removing one of the references.`,
        { formName, moduleName, ...findFormLocation(blueprint, formName) },
      ))
      continue
    }

    errors.push(validationError('XPATH_SYNTAX', 'app', errStr, {}))
  }

  return errors
}

const FIELD_NAMES: Record<string, string> = {
  relevant: 'display condition',
  validation: 'validation rule',
  calculate: 'calculated value',
  default_value: 'default value',
  required: 'required condition',
}

/** Convert terse XPath error messages into helpful, human-friendly ones. */
function humanizeXPathError(
  code: ValidationError['code'],
  rawMessage: string,
  questionId?: string,
  formName?: string,
  field?: string,
  label?: string,
): string {
  const loc = questionId && formName
    ? `Question "${questionId}" in "${formName}"${field ? ` (${FIELD_NAMES[field] || field})` : ''}`
    : formName
      ? `"${formName}"${label ? ` ${label}` : ''}`
      : 'Expression'

  switch (code) {
    case 'XPATH_SYNTAX':
      return `${loc} has a syntax error: ${rawMessage}. Check for unbalanced parentheses, missing operators, or stray characters.`

    case 'UNKNOWN_FUNCTION': {
      const suggestion = rawMessage.match(/did you mean "([^"]+)"/)?.[1]
      if (suggestion) {
        return `${loc} calls a function that doesn't exist. ${rawMessage}. XPath function names are case-sensitive — use the lowercase version.`
      }
      const funcName = rawMessage.match(/Unknown function "([^"]+)"/)?.[1] || 'unknown'
      return `${loc} calls "${funcName}" which isn't a recognized CommCare function. Check the function name for typos, or consult the CommCare XPath reference for available functions.`
    }

    case 'WRONG_ARITY':
      return `${loc} is calling a function with the wrong number of arguments. ${rawMessage}.`

    case 'INVALID_REF': {
      const path = rawMessage.match(/"([^"]+)"/)?.[1] || ''
      return `${loc} references "${path}" which doesn't exist in this form. Check for typos in the question ID, or make sure the question hasn't been renamed or removed.`
    }

    case 'INVALID_CASE_REF': {
      const prop = rawMessage.match(/"([^"]+)"/)?.[1] || ''
      return `${loc} references case property "${prop}" which doesn't exist on this case type. Check for typos, or make sure a question saves to this property with case_property_on.`
    }

    case 'TYPE_ERROR':
      return `${loc} has a type mismatch: ${rawMessage}. This will likely produce unexpected results at runtime.`

    default:
      return `${loc}: ${rawMessage}`
  }
}

function inferXPathErrorCode(message: string): ValidationError['code'] {
  if (message.includes('Syntax error')) return 'XPATH_SYNTAX'
  if (message.includes('Unknown function')) return 'UNKNOWN_FUNCTION'
  if (message.includes('requires') || message.includes('accepts at most')) return 'WRONG_ARITY'
  if (message.includes('Unknown case property')) return 'INVALID_CASE_REF'
  if (message.includes('unknown question path') || message.includes('References unknown')) return 'INVALID_REF'
  if (message.includes('Type mismatch')) return 'TYPE_ERROR'
  return 'XPATH_SYNTAX'
}

function findFormLocation(blueprint: AppBlueprint, formName: string): { moduleIndex?: number; moduleName?: string; formIndex?: number } {
  for (let mIdx = 0; mIdx < blueprint.modules.length; mIdx++) {
    for (let fIdx = 0; fIdx < blueprint.modules[mIdx].forms.length; fIdx++) {
      if (blueprint.modules[mIdx].forms[fIdx].name === formName) {
        return { moduleIndex: mIdx, moduleName: blueprint.modules[mIdx].name, formIndex: fIdx }
      }
    }
  }
  return {}
}
