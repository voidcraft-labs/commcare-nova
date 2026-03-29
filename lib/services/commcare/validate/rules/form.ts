/**
 * Form-level validation rules.
 * Each rule receives a form, its indices, the parent module, and the full blueprint.
 * Case config is derived once per form and passed to rules that need it.
 */

import type { AppBlueprint, BlueprintForm, BlueprintModule, Question, DerivedCaseConfig } from '@/lib/schemas/blueprint'
import { deriveCaseConfig } from '@/lib/schemas/blueprint'
import { RESERVED_CASE_PROPERTIES, MEDIA_QUESTION_TYPES, CASE_PROPERTY_REGEX, MAX_CASE_PROPERTY_LENGTH } from '../../constants'
import { type ValidationError, validationError } from '../errors'
import { detectUnquotedStringLiteral } from '../../../hqJsonExpander'

// ── Helpers ────────────────────────────────────────────────────────

function collectQuestionIds(questions: Question[]): string[] {
  const ids: string[] = []
  for (const q of questions) {
    ids.push(q.id)
    if ((q.type === 'group' || q.type === 'repeat') && q.children) {
      ids.push(...collectQuestionIds(q.children))
    }
  }
  return ids
}

function findQuestionById(questions: Question[], id: string): Question | undefined {
  for (const q of questions) {
    if (q.id === id) return q
    if ((q.type === 'group' || q.type === 'repeat') && q.children) {
      const found = findQuestionById(q.children, id)
      if (found) return found
    }
  }
  return undefined
}

interface FormContext {
  formIndex: number
  modIndex: number
  formName: string
  moduleName: string
}

// ── Rules ──────────────────────────────────────────────────────────

export function emptyForm(form: BlueprintForm, ctx: FormContext): ValidationError[] {
  if (!form.questions || form.questions.length === 0) {
    return [validationError('EMPTY_FORM', 'form',
      `"${ctx.formName}" in "${ctx.moduleName}" has no questions. CommCare can't build an empty form — add at least one question.`,
      { moduleIndex: ctx.modIndex, moduleName: ctx.moduleName, formIndex: ctx.formIndex, formName: ctx.formName })]
  }
  return []
}

export function noCaseNameField(form: BlueprintForm, ctx: FormContext, caseConfig: DerivedCaseConfig): ValidationError[] {
  if (form.type === 'registration' && !caseConfig.case_name_field) {
    return [validationError('NO_CASE_NAME_FIELD', 'form',
      `"${ctx.formName}" is a registration form but none of its questions has id "case_name". Every new case needs a name — add a text question with id "case_name" and case_property_on set to the module's case type.`,
      { moduleIndex: ctx.modIndex, moduleName: ctx.moduleName, formIndex: ctx.formIndex, formName: ctx.formName })]
  }
  return []
}

export function caseNameFieldMissing(form: BlueprintForm, ctx: FormContext, caseConfig: DerivedCaseConfig): ValidationError[] {
  if (form.type === 'registration' && caseConfig.case_name_field) {
    const ids = collectQuestionIds(form.questions || [])
    if (!ids.includes(caseConfig.case_name_field)) {
      return [validationError('CASE_NAME_FIELD_MISSING', 'form',
        `"${ctx.formName}" expects a question with id "${caseConfig.case_name_field}" for the case name, but no such question exists. Either add this question or rename an existing one.`,
        { formIndex: ctx.formIndex, formName: ctx.formName })]
    }
  }
  return []
}

export function reservedCaseProperty(form: BlueprintForm, ctx: FormContext, caseConfig: DerivedCaseConfig): ValidationError[] {
  if (!caseConfig.case_properties) return []
  const errors: ValidationError[] = []
  for (const { case_property: prop } of caseConfig.case_properties) {
    if (RESERVED_CASE_PROPERTIES.has(prop) && prop !== 'case_name') {
      errors.push(validationError('RESERVED_CASE_PROPERTY', 'form',
        `"${ctx.formName}" saves to case property "${prop}", which is a reserved name in CommCare (used internally for case tracking). Rename the question to something like "${prop}_value" or "case_${prop}" instead.`,
        { formIndex: ctx.formIndex, formName: ctx.formName },
        { reservedName: prop }))
    }
  }
  return errors
}

export function casePropertyMissingQuestion(form: BlueprintForm, ctx: FormContext, caseConfig: DerivedCaseConfig): ValidationError[] {
  if (!caseConfig.case_properties) return []
  const errors: ValidationError[] = []
  const ids = collectQuestionIds(form.questions || [])
  for (const { case_property: prop, question_id: qId } of caseConfig.case_properties) {
    if (!ids.includes(qId)) {
      errors.push(validationError('CASE_PROPERTY_MISSING_QUESTION', 'form',
        `"${ctx.formName}" maps case property "${prop}" to question "${qId}", but that question doesn't exist in this form. Either add the question or remove the case property mapping.`,
        { formIndex: ctx.formIndex, formName: ctx.formName }))
    }
  }
  return errors
}

export function mediaCaseProperty(form: BlueprintForm, ctx: FormContext, caseConfig: DerivedCaseConfig): ValidationError[] {
  if (!caseConfig.case_properties) return []
  const errors: ValidationError[] = []
  for (const { case_property: prop, question_id: qId } of caseConfig.case_properties) {
    const q = findQuestionById(form.questions || [], qId)
    if (q && MEDIA_QUESTION_TYPES.has(q.type)) {
      errors.push(validationError('MEDIA_CASE_PROPERTY', 'form',
        `"${ctx.formName}" tries to save the ${q.type} question "${qId}" as case property "${prop}". Media files (images, audio, video, signatures) can't be stored as case properties — they're handled separately by CommCare's attachment system. Remove the case_property_on from this question.`,
        { formIndex: ctx.formIndex, formName: ctx.formName },
        { property: prop, questionId: qId }))
    }
  }
  return errors
}

export function casePreloadMissingQuestion(form: BlueprintForm, ctx: FormContext, caseConfig: DerivedCaseConfig): ValidationError[] {
  if (!caseConfig.case_preload) return []
  const errors: ValidationError[] = []
  const ids = collectQuestionIds(form.questions || [])
  for (const { question_id: qId, case_property: prop } of caseConfig.case_preload) {
    if (!ids.includes(qId)) {
      errors.push(validationError('CASE_PRELOAD_MISSING_QUESTION', 'form',
        `"${ctx.formName}" tries to preload case property "${prop}" into question "${qId}", but that question doesn't exist. The preload needs a matching question to receive the data.`,
        { formIndex: ctx.formIndex, formName: ctx.formName }))
    }
  }
  return errors
}

export function casePreloadReserved(form: BlueprintForm, ctx: FormContext, caseConfig: DerivedCaseConfig): ValidationError[] {
  if (!caseConfig.case_preload) return []
  const errors: ValidationError[] = []
  for (const { case_property: prop } of caseConfig.case_preload) {
    if (RESERVED_CASE_PROPERTIES.has(prop)) {
      errors.push(validationError('CASE_PRELOAD_RESERVED', 'form',
        `"${ctx.formName}" tries to preload reserved property "${prop}". CommCare reserves this name for internal use. Use a custom property name instead.`,
        { formIndex: ctx.formIndex, formName: ctx.formName }))
    }
  }
  return errors
}

export function duplicateCasePropertyMapping(form: BlueprintForm, ctx: FormContext, caseConfig: DerivedCaseConfig): ValidationError[] {
  if (!caseConfig.case_properties) return []
  const errors: ValidationError[] = []
  const seen = new Map<string, string>()
  for (const { case_property: prop, question_id: qId } of caseConfig.case_properties) {
    const prev = seen.get(prop)
    if (prev && prev !== qId) {
      errors.push(validationError('DUPLICATE_CASE_PROPERTY', 'form',
        `"${ctx.formName}" has two questions ("${prev}" and "${qId}") both saving to case property "${prop}". Each case property can only be updated by one question — rename one of the question IDs so they map to different properties.`,
        { formIndex: ctx.formIndex, formName: ctx.formName },
        { property: prop, questionId1: prev, questionId2: qId }))
    } else {
      seen.set(prop, qId)
    }
  }
  return errors
}

export function registrationNoCaseProperties(form: BlueprintForm, ctx: FormContext, caseConfig: DerivedCaseConfig, mod: BlueprintModule): ValidationError[] {
  if (form.type !== 'registration' || !mod.case_type) return []
  if (!caseConfig.case_properties || caseConfig.case_properties.length === 0) {
    return [validationError('REGISTRATION_NO_CASE_PROPS', 'form',
      `"${ctx.formName}" is a registration form but none of its questions save data to the "${mod.case_type}" case. A registration form should capture information about the new case. Add case_property_on: "${mod.case_type}" to questions whose answers should be saved to the case.`,
      { moduleIndex: ctx.modIndex, moduleName: ctx.moduleName, formIndex: ctx.formIndex, formName: ctx.formName })]
  }
  return []
}

export function closeCaseValidation(form: BlueprintForm, ctx: FormContext): ValidationError[] {
  if (!form.close_case) return []
  const errors: ValidationError[] = []
  const loc = { formIndex: ctx.formIndex, formName: ctx.formName }

  if (form.type !== 'followup') {
    errors.push(validationError('CLOSE_CASE_NOT_FOLLOWUP', 'form',
      `"${ctx.formName}" has a close_case block but isn't a followup form. Only followup forms can close cases because they're the ones that load an existing case. Change the form type to "followup" or remove the close_case block.`,
      loc))
    return errors
  }

  const cc = form.close_case
  if (cc.question && !cc.answer) {
    errors.push(validationError('CLOSE_CASE_MISSING_ANSWER', 'form',
      `"${ctx.formName}" has a conditional close_case with a question ("${cc.question}") but no answer to match against. Add an "answer" value so CommCare knows when to close the case (e.g. answer: "yes"), or use an empty close_case {} for unconditional close.`,
      loc))
  }
  if (!cc.question && cc.answer) {
    errors.push(validationError('CLOSE_CASE_MISSING_QUESTION', 'form',
      `"${ctx.formName}" has a conditional close_case with an answer ("${cc.answer}") but no question to check. Add a "question" ID so CommCare knows which answer to compare, or use an empty close_case {} for unconditional close.`,
      loc))
  }
  if (cc.question) {
    const ids = collectQuestionIds(form.questions || [])
    if (!ids.includes(cc.question)) {
      errors.push(validationError('CLOSE_CASE_QUESTION_NOT_FOUND', 'form',
        `"${ctx.formName}" has close_case checking question "${cc.question}", but no question with that ID exists in the form. Either add the question or update close_case to reference an existing one.`,
        loc))
    }
  }
  return errors
}

export function connectValidation(form: BlueprintForm, ctx: FormContext, _caseConfig: DerivedCaseConfig, _mod: BlueprintModule, blueprint: AppBlueprint): ValidationError[] {
  if (!blueprint.connect_type || !form.connect) return []
  const errors: ValidationError[] = []
  const loc = { formIndex: ctx.formIndex, formName: ctx.formName }

  if (blueprint.connect_type === 'learn' && !form.connect.learn_module && !form.connect.assessment) {
    errors.push(validationError('CONNECT_MISSING_LEARN', 'form',
      `"${ctx.formName}" is opted into Connect but has neither a learn module nor an assessment. Enable at least one.`,
      loc))
  }
  if (blueprint.connect_type === 'deliver' && !form.connect.deliver_unit) {
    errors.push(validationError('CONNECT_MISSING_DELIVER', 'form',
      `"${ctx.formName}" is opted into Connect but is missing deliver_unit config. This app is a Connect Deliver app, so each Connect form needs a deliver_unit with at least a name.`,
      loc))
  }

  const connectXPaths: Array<[string, string]> = []
  if (form.connect.assessment?.user_score) connectXPaths.push(['Connect assessment user_score', form.connect.assessment.user_score])
  if (form.connect.deliver_unit?.entity_id) connectXPaths.push(['Connect deliver entity_id', form.connect.deliver_unit.entity_id])
  if (form.connect.deliver_unit?.entity_name) connectXPaths.push(['Connect deliver entity_name', form.connect.deliver_unit.entity_name])
  for (const [label, expr] of connectXPaths) {
    const bare = detectUnquotedStringLiteral(expr)
    if (bare) {
      errors.push(validationError('CONNECT_UNQUOTED_XPATH', 'form',
        `"${ctx.formName}" ${label} has "${bare}" without quotes. This looks like a string value, not an XPath expression — wrap it in single quotes: '${bare}'.`,
        loc))
    }
  }
  return errors
}

/**
 * Question IDs must be unique among siblings (same parent scope).
 * /data/abc and /data/group/abc are fine — they have different XML paths.
 * /data/abc and /data/abc are not — they collide at the same level.
 */
export function duplicateQuestionIds(form: BlueprintForm, ctx: FormContext): ValidationError[] {
  const errors: ValidationError[] = []
  checkDuplicatesInScope(form.questions || [], '/data', ctx, errors)
  return errors
}

function checkDuplicatesInScope(questions: Question[], parentPath: string, ctx: FormContext, errors: ValidationError[]): void {
  const counts = new Map<string, number>()
  for (const q of questions) {
    counts.set(q.id, (counts.get(q.id) ?? 0) + 1)
  }
  for (const [id, count] of counts) {
    if (count > 1) {
      errors.push(validationError('DUPLICATE_QUESTION_ID', 'form',
        `"${ctx.formName}" in "${ctx.moduleName}" has ${count} questions with the ID "${id}" at the same level (${parentPath}). Questions at the same level share an XML path, so they need unique IDs. Rename the duplicates.`,
        { moduleIndex: ctx.modIndex, moduleName: ctx.moduleName, formIndex: ctx.formIndex, formName: ctx.formName }))
    }
  }
  for (const q of questions) {
    if ((q.type === 'group' || q.type === 'repeat') && q.children) {
      checkDuplicatesInScope(q.children, `${parentPath}/${q.id}`, ctx, errors)
    }
  }
}

export function casePropertyBadFormat(form: BlueprintForm, ctx: FormContext, caseConfig: DerivedCaseConfig): ValidationError[] {
  if (!caseConfig.case_properties) return []
  const errors: ValidationError[] = []
  for (const { case_property: prop } of caseConfig.case_properties) {
    if (prop === 'case_name') continue
    if (!CASE_PROPERTY_REGEX.test(prop)) {
      errors.push(validationError('CASE_PROPERTY_BAD_FORMAT', 'form',
        `"${ctx.formName}" has case property "${prop}" which isn't a valid identifier. Property names must start with a letter and can only contain letters, digits, underscores, or hyphens. Try renaming it to something like "${prop.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^[^a-zA-Z]/, 'q_')}".`,
        { formIndex: ctx.formIndex, formName: ctx.formName },
        { property: prop }))
    }
  }
  return errors
}

export function casePropertyTooLong(form: BlueprintForm, ctx: FormContext, caseConfig: DerivedCaseConfig): ValidationError[] {
  if (!caseConfig.case_properties) return []
  const errors: ValidationError[] = []
  for (const { case_property: prop } of caseConfig.case_properties) {
    if (prop.length > MAX_CASE_PROPERTY_LENGTH) {
      errors.push(validationError('CASE_PROPERTY_TOO_LONG', 'form',
        `"${ctx.formName}" has case property "${prop.slice(0, 40)}..." which is ${prop.length} characters long. CommCare limits property names to ${MAX_CASE_PROPERTY_LENGTH} characters. Use a shorter, more concise name.`,
        { formIndex: ctx.formIndex, formName: ctx.formName },
        { property: prop }))
    }
  }
  return errors
}

// ── Rule runner ────────────────────────────────────────────────────

export function runFormRules(
  form: BlueprintForm,
  formIndex: number,
  mod: BlueprintModule,
  modIndex: number,
  blueprint: AppBlueprint,
): ValidationError[] {
  const ctx: FormContext = { formIndex, modIndex, formName: form.name, moduleName: mod.name }
  const caseConfig = deriveCaseConfig(form.questions || [], form.type, mod.case_type ?? undefined, blueprint.case_types)
  const errors: ValidationError[] = []

  errors.push(...emptyForm(form, ctx))
  errors.push(...closeCaseValidation(form, ctx))
  errors.push(...duplicateQuestionIds(form, ctx))
  errors.push(...noCaseNameField(form, ctx, caseConfig))
  errors.push(...caseNameFieldMissing(form, ctx, caseConfig))
  errors.push(...reservedCaseProperty(form, ctx, caseConfig))
  errors.push(...casePropertyMissingQuestion(form, ctx, caseConfig))
  errors.push(...mediaCaseProperty(form, ctx, caseConfig))
  errors.push(...casePreloadMissingQuestion(form, ctx, caseConfig))
  errors.push(...casePreloadReserved(form, ctx, caseConfig))
  errors.push(...duplicateCasePropertyMapping(form, ctx, caseConfig))
  errors.push(...registrationNoCaseProperties(form, ctx, caseConfig, mod))
  errors.push(...casePropertyBadFormat(form, ctx, caseConfig))
  errors.push(...casePropertyTooLong(form, ctx, caseConfig))
  errors.push(...connectValidation(form, ctx, caseConfig, mod, blueprint))

  return errors
}
