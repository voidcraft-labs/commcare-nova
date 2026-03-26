import type { AppBlueprint, Question } from '../schemas/blueprint'
import { deriveCaseConfig } from '../schemas/blueprint'
import {
  RESERVED_CASE_PROPERTIES, MEDIA_QUESTION_TYPES,
  genHexId, genShortId,
  detailColumn, detailPair, applicationShell, formShell, moduleShell,
} from './commcare'
import type { HqApplication } from './commcare'
import { buildXForm } from './xformBuilder'
import { buildFormActions, buildCaseReferencesLoad } from './formActions'
import { parser } from '@/lib/codemirror/xpath-parser'
import { NameTest } from '@/lib/codemirror/xpath-parser.terms'
import { validateBlueprintDeep } from './commcare/validate/index'

/** XPath fields on questions that should contain valid XPath expressions. */
const XPATH_FIELDS = ['validation', 'relevant', 'calculate', 'default_value', 'required'] as const

/**
 * Detect unquoted string literals in XPath expressions using the Lezer parser.
 * A bare word like "no" parses as a single NameTest — almost always an error
 * where the author forgot to quote a string literal.
 */
export function detectUnquotedStringLiteral(expr: string): string | null {
  const trimmed = expr.trim()
  if (!trimmed) return null

  const tree = parser.parse(trimmed)
  const top = tree.topNode
  const child = top.firstChild
  if (!child || child.nextSibling) return null
  if (child.type.id !== NameTest) return null

  // Verify no error nodes
  let hasError = false
  tree.iterate({ enter(node) { if (node.type.isError) hasError = true } })
  if (hasError) return null

  return trimmed
}


/**
 * Expand an AppBlueprint into the full HQ import JSON.
 *
 * Generates all boilerplate that CommCare HQ expects: doc_types, unique_ids,
 * xmlns, XForm XML with itext/binds/body, form actions, case details, etc.
 * The output can be imported directly into HQ or compiled into a .ccz.
 */
export function expandBlueprint(blueprint: AppBlueprint): HqApplication {
  const attachments: Record<string, string> = {}

  // Build child case type map: child_case_type → parent module index
  // Derived from case_types[].parent_type — no form-level child_cases needed.
  const childCaseParents = new Map<string, number>()
  if (blueprint.case_types) {
    for (const ct of blueprint.case_types) {
      if (ct.parent_type) {
        const parentIdx = blueprint.modules.findIndex(m => m.case_type === ct.parent_type)
        if (parentIdx !== -1) childCaseParents.set(ct.name, parentIdx)
      }
    }
  }

  const modules = blueprint.modules.map((bm) => {
    const hasCases = bm.case_type && (bm.case_list_only || bm.forms.some(f => f.type !== 'survey'))
    const caseType = hasCases ? bm.case_type! : ''

    const forms = bm.forms.map((bf) => {
      const formUniqueId = genHexId()
      const xmlns = `http://openrosa.org/formdesigner/${genShortId()}`

      // Only include Connect config in export when app-level connect_type is set
      const effectiveConnect = blueprint.connect_type ? bf.connect : undefined
      const exportForm = effectiveConnect === bf.connect ? bf : { ...bf, connect: effectiveConnect }

      attachments[`${formUniqueId}.xml`] = buildXForm(exportForm, xmlns, {
        ...(blueprint.connect_type && { autoGps: true }),
      })

      return formShell(
        formUniqueId, bf.name, xmlns,
        bf.type === 'followup' ? 'case' : 'none',
        buildFormActions(bf, caseType, blueprint.case_types),
        buildCaseReferencesLoad(bf.questions || [], effectiveConnect),
      )
    })

    const shortColumns = (bm.case_list_columns || []).map(col => detailColumn(col.field, col.header))
    const longColumns = bm.case_detail_columns
      ? bm.case_detail_columns.map(col => detailColumn(col.field, col.header))
      : bm.case_list_columns
        ? shortColumns // mirror short columns when no explicit long columns
        : undefined
    const caseDetails = hasCases
      ? detailPair(shortColumns, longColumns)
      : detailPair([])

    return moduleShell(genHexId(), bm.name, caseType, forms, caseDetails)
  })

  // case_list_only modules need case_list.show so HQ doesn't reject them
  // with "no forms or case list" (CommCare requires either forms or a visible case list)
  for (let mIdx = 0; mIdx < modules.length; mIdx++) {
    if (blueprint.modules[mIdx].case_list_only) {
      modules[mIdx].case_list.show = true
      modules[mIdx].case_list.label = { en: blueprint.modules[mIdx].name }
    }
  }

  // Activate parent_select on modules whose case_type is created as a child case elsewhere
  for (let mIdx = 0; mIdx < modules.length; mIdx++) {
    const bm = blueprint.modules[mIdx]
    if (bm.case_type) {
      const parentIdx = childCaseParents.get(bm.case_type)
      if (parentIdx !== undefined && parentIdx !== mIdx) {
        modules[mIdx].parent_select = {
          active: true,
          relationship: 'parent',
          module_id: modules[parentIdx].unique_id,
        }
      }
    }
  }

  return applicationShell(blueprint.app_name, modules, attachments)
}


/**
 * Validate an AppBlueprint's cross-field semantic rules before expanding.
 *
 * Structural checks (app_name, module/form/question names, types) are handled
 * by the Zod schema at the MCP/tool boundary. This function catches semantic
 * issues like missing case_type on case modules, reserved property names,
 * dangling question references, etc.
 *
 * @returns Array of human-readable error strings (empty = valid)
 */
export function validateBlueprint(blueprint: AppBlueprint): string[] {
  const errors: string[] = []

  for (let mIdx = 0; mIdx < blueprint.modules.length; mIdx++) {
    const mod = blueprint.modules[mIdx]

    const hasCaseForms = mod.forms?.some(f => f.type !== 'survey')
    if (hasCaseForms && !mod.case_type) {
      errors.push(`"${mod.name}" has case forms but no case_type`)
    }

    // case_list_only validation
    if (mod.case_list_only && mod.forms.length > 0) {
      errors.push(`"${mod.name}" is marked case_list_only but has forms`)
    }
    if (mod.case_list_only && !mod.case_type) {
      errors.push(`"${mod.name}" is marked case_list_only but has no case_type`)
    }
    if (!mod.case_list_only && mod.case_type && mod.forms.length === 0) {
      errors.push(`"${mod.name}" has a case_type but no forms — set case_list_only: true if this is a case-list viewer, or add forms`)
    }

    for (let fIdx = 0; fIdx < mod.forms.length; fIdx++) {
      const form = mod.forms[fIdx]
      if (!form.questions || form.questions.length === 0) {
        errors.push(`"${form.name}" in "${mod.name}" has no questions`)
      }

      // Derive case config on-demand from per-question fields
      const { case_name_field, case_properties, case_preload } = deriveCaseConfig(
        form.questions || [], form.type, mod.case_type, blueprint.case_types,
      )

      if (form.type === 'registration' && !case_name_field) {
        errors.push(`"${form.name}" is a registration form but has no case_name_field`)
      }

      // Validate questions recursively
      function validateQuestions(questions: Question[], formName: string) {
        for (const q of questions) {
          if ((q.type === 'single_select' || q.type === 'multi_select') && (!q.options || q.options.length === 0)) {
            errors.push(`Question "${q.id}" in "${formName}" is a select but has no options`)
          }
          if (q.type === 'hidden' && !q.calculate && !q.default_value) {
            errors.push(`Question "${q.id}" in "${formName}" is hidden but has no calculate or default_value — it will save blank data`)
          }
          for (const field of XPATH_FIELDS) {
            const val = q[field]
            if (typeof val === 'string') {
              const bare = detectUnquotedStringLiteral(val)
              if (bare) {
                errors.push(`Question "${q.id}" in "${formName}" has unquoted string "${bare}" in ${field} — use "'${bare}'" instead`)
              }
            }
          }
          if ((q.type === 'group' || q.type === 'repeat') && q.children) {
            validateQuestions(q.children, formName)
          }
        }
      }
      const fn = form.name
      validateQuestions(form.questions || [], fn)

      // Collect all question IDs including those inside groups/repeats
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

      // Check for duplicate question IDs
      const allIds = collectQuestionIds(form.questions || [])
      const idCounts = new Map<string, number>()
      for (const id of allIds) {
        idCounts.set(id, (idCounts.get(id) ?? 0) + 1)
      }
      for (const [id, count] of idCounts) {
        if (count > 1) {
          errors.push(`"${fn}" in "${mod.name}" has duplicate question ID "${id}" (${count} occurrences)`)
        }
      }

      // Find a question by id (recursively searching groups/repeats)
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

      // Check case_name_field refers to a valid question
      if (form.type === 'registration' && case_name_field) {
        const questionIds = collectQuestionIds(form.questions || [])
        if (!questionIds.includes(case_name_field)) {
          errors.push(`"${fn}" case_name_field "${case_name_field}" doesn't match any question id`)
        }
      }

      // Check case_properties are not reserved words and refer to valid questions
      if (case_properties) {
        const questionIds = collectQuestionIds(form.questions || [])
        for (const { case_property: prop, question_id: qId } of case_properties) {
          if (RESERVED_CASE_PROPERTIES.has(prop) && prop !== 'case_name') {
            errors.push(`"${fn}" uses reserved case property name "${prop}" — use a different name`)
          }
          if (!questionIds.includes(qId)) {
            errors.push(`"${fn}" case property "${prop}" maps to question "${qId}" which doesn't exist`)
          } else {
            const q = findQuestionById(form.questions || [], qId)
            if (q && MEDIA_QUESTION_TYPES.has(q.type)) {
              errors.push(`"${fn}" case property "${prop}" maps to a ${q.type} question — media/binary questions cannot be saved as case properties`)
            }
          }
        }
      }

      // Check case_preload entries refer to valid question ids and aren't reserved
      if (case_preload) {
        const questionIds = collectQuestionIds(form.questions || [])
        for (const { question_id: qId, case_property: caseProp } of case_preload) {
          if (!questionIds.includes(qId)) {
            errors.push(`"${fn}" case_preload references question "${qId}" which doesn't exist`)
          }
          if (RESERVED_CASE_PROPERTIES.has(caseProp)) {
            errors.push(`"${fn}" case_preload uses reserved property "${caseProp}" — use a custom property name instead`)
          }
        }
      }

      // Validate close_case
      if (form.close_case) {
        if (form.type !== 'followup') {
          errors.push(`"${fn}" has close_case but is not a followup form — only followup forms can close cases`)
        }
        const cc = form.close_case
        // If one of question/answer is set, both must be
        if (cc.question && !cc.answer) {
          errors.push(`"${fn}" close_case condition is missing "answer"`)
        }
        if (!cc.question && cc.answer) {
          errors.push(`"${fn}" close_case condition is missing "question"`)
        }
        if (cc.question) {
          const questionIds = collectQuestionIds(form.questions || [])
          if (!questionIds.includes(cc.question)) {
            errors.push(`"${fn}" close_case references question "${cc.question}" which doesn't exist`)
          }
        }
      }

      // Validate Connect config (only when app-level connect_type is set)
      if (blueprint.connect_type && form.connect) {
        const ct = blueprint.connect_type
        if (ct === 'learn' && !form.connect.learn_module) {
          errors.push(`"${fn}" is a Connect Learn form but has no learn_module config`)
        }
        if (ct === 'deliver' && !form.connect.deliver_unit) {
          errors.push(`"${fn}" is a Connect Deliver form but has no deliver_unit config`)
        }
        // Check XPath expressions for unquoted string literals
        const connectXPaths: Array<[string, string]> = []
        if (form.connect.assessment?.user_score) connectXPaths.push(['Connect assessment user_score', form.connect.assessment.user_score])
        if (form.connect.deliver_unit?.entity_id) connectXPaths.push(['Connect deliver entity_id', form.connect.deliver_unit.entity_id])
        if (form.connect.deliver_unit?.entity_name) connectXPaths.push(['Connect deliver entity_name', form.connect.deliver_unit.entity_name])
        for (const [label, expr] of connectXPaths) {
          const bare = detectUnquotedStringLiteral(expr)
          if (bare) {
            errors.push(`"${fn}" ${label} has unquoted string "${bare}" — use "'${bare}'" instead`)
          }
        }
      }

    }
  }

  // Check that every child case type has its own module
  if (blueprint.case_types) {
    const moduleCaseTypes = new Set(blueprint.modules.map(m => m.case_type).filter(Boolean))
    for (const ct of blueprint.case_types) {
      if (ct.parent_type && !moduleCaseTypes.has(ct.name)) {
        errors.push(
          `Child case type "${ct.name}" is used in forms but has no module — ` +
          `create a module with case_type "${ct.name}" and case_list_columns so these cases are viewable`
        )
      }
    }
  }

  // Deep validation: XPath syntax/semantics, cycles, node refs
  errors.push(...validateBlueprintDeep(blueprint))

  return errors
}
