import type { AppBlueprint, BlueprintForm, Question, BlueprintModule } from '../schemas/blueprint'
import { deriveCaseConfig } from '../schemas/blueprint'
import {
  RESERVED_CASE_PROPERTIES, MEDIA_QUESTION_TYPES,
  escapeXml, genHexId, genShortId,
  VELLUM_HASHTAG_TRANSFORMS, expandHashtags, hasHashtags, extractHashtags,
  emptyFormActions, alwaysCondition, neverCondition, ifCondition,
  detailColumn, detailPair, applicationShell, formShell, moduleShell,
} from './commcare'
import type { FormActions, HqApplication, OpenSubCaseAction } from './commcare'

/**
 * Process label/hint/help text that may contain <output value="..."/> tags.
 * Plain text segments are XML-escaped. <output> tags are preserved as raw XML
 * with hashtag expansion on the value attribute.
 */
function processLabelText(text: string): string {
  // Split on <output value="..."/> tags, preserving the tags
  const parts = text.split(/(<output\s+value="[^"]*"\s*\/>)/g)
  return parts.map(part => {
    const outputMatch = part.match(/^<output\s+value="([^"]*)"\s*\/>$/)
    if (outputMatch) {
      const expandedValue = expandHashtags(outputMatch[1])
      return `<output value="${escapeXml(expandedValue)}"/>`
    }
    return escapeXml(part)
  }).join('')
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
  const modules = blueprint.modules.map((bm) => {
    const hasCases = bm.case_type && bm.forms.some(f => f.type !== 'survey')
    const caseType = hasCases ? bm.case_type! : ''

    const forms = bm.forms.map((bf) => {
      const formUniqueId = genHexId()
      const xmlns = `http://openrosa.org/formdesigner/${genShortId()}`

      attachments[`${formUniqueId}.xml`] = buildXForm(bf, xmlns)

      return formShell(
        formUniqueId, bf.name, xmlns,
        bf.type === 'followup' ? 'case' : 'none',
        buildFormActions(bf, caseType),
        buildCaseReferencesLoad(bf.questions || []),
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

  return applicationShell(blueprint.app_name, modules, attachments)
}


/**
 * Build the case_references_data.load map for a form.
 *
 * Scans all questions for #case/ and #user/ references in XPath expressions
 * (calculate, relevant, constraint, default_value) and maps each question's
 * full path to the array of hashtag references it uses. CommCare's Vellum
 * editor uses this to resolve hashtag shorthand at build time.
 */
function buildCaseReferencesLoad(questions: Question[], parentPath = '/data'): Record<string, string[]> {
  const load: Record<string, string[]> = {}
  for (const q of questions) {
    const nodePath = `${parentPath}/${q.id}`
    const xpathExprs = [q.relevant, q.constraint, q.calculate, q.default_value, q.required].filter(Boolean) as string[]
    const hashtags = extractHashtags(xpathExprs)
    if (hashtags.length > 0) {
      load[nodePath] = hashtags
    }
    if ((q.type === 'group' || q.type === 'repeat') && q.children) {
      Object.assign(load, buildCaseReferencesLoad(q.children, nodePath))
    }
  }
  return load
}

/** Build complete XForm XML from question definitions. */
function buildXForm(form: BlueprintForm, xmlns: string): string {
  const questions = form.questions || []
  const dataElements: string[] = []
  const binds: string[] = []
  const setvalues: string[] = []
  const bodyElements: string[] = []

  // Collect itext entries (single language)
  const itextEntries: string[] = []

  const addItext = (id: string, text: string | undefined) => {
    if (!text) return
    itextEntries.push(`<text id="${id}"><value>${processLabelText(text)}</value></text>`)
  }

  for (const q of questions) {
    buildQuestionParts(q, '/data', dataElements, binds, setvalues, bodyElements, false, addItext)
  }

  const dataContent = dataElements.length > 0
    ? '\n' + dataElements.map(e => `          ${e}`).join('\n') + '\n        '
    : ''

  const bindContent = binds.length > 0
    ? '\n' + binds.map(b => `      ${b}`).join('\n')
    : ''

  const setvalueContent = setvalues.length > 0
    ? '\n' + setvalues.map(s => `      ${s}`).join('\n')
    : ''

  const formName = form.name

  // Build itext translation block (single language)
  const content = itextEntries.map(e => `          ${e}`).join('\n')
  const translations = `        <translation lang="en" default="">\n${content}\n        </translation>`

  const bodyContent = bodyElements.map(e => `    ${e}`).join('\n')

  return `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:jr="http://openrosa.org/javarosa" xmlns:vellum="http://commcarehq.org/xforms/vellum">
  <h:head>
    <h:title>${escapeXml(formName)}</h:title>
    <model>
      <instance>
        <data xmlns="${xmlns}" xmlns:jrm="http://dev.commcarehq.org/jr/xforms" uiVersion="1" version="1" name="${escapeXml(formName.toLowerCase().replace(/[^a-z0-9]+/g, '_'))}">${dataContent}</data>
      </instance>${bindContent}${setvalueContent}
      <itext>
${translations}
      </itext>
    </model>
  </h:head>
  <h:body>
${bodyContent}
  </h:body>
</h:html>`
}

/**
 * Recursively generate the four XForm parts for a question:
 * - dataElements: <instance> data nodes
 * - binds: <bind> elements with type, required, constraint, etc.
 * - itextEntries: <itext> translation entries for labels/hints/options
 * - bodyElements: <h:body> input/select/group elements
 *
 * Groups and repeats recurse into their children, building nested paths.
 */
function buildQuestionParts(
  q: Question,
  parentPath: string,
  dataElements: string[],
  binds: string[],
  setvalues: string[],
  bodyElements: string[],
  insideRepeat: boolean,
  addItext: (id: string, text: string | undefined) => void
): void {
  const nodePath = `${parentPath}/${q.id}`

  // Data element
  dataElements.push(`<${q.id}/>`)

  // Bind — real attributes get expanded XPath, vellum: attributes keep shorthand
  const bindParts = [`nodeset="${nodePath}"`]
  const xsdType = getXsdType(q.type)
  if (xsdType) bindParts.push(`type="${xsdType}"`)
  if (q.required) {
    const expandedReq = expandHashtags(q.required)
    if (hasHashtags(q.required)) bindParts.push(`vellum:required="${escapeXml(q.required)}"`)
    bindParts.push(`required="${escapeXml(expandedReq)}"`)
  }
  if (q.readonly) bindParts.push(`readonly="true()"`)
  if (q.constraint) {
    if (hasHashtags(q.constraint)) bindParts.push(`vellum:constraint="${escapeXml(q.constraint)}"`)
    bindParts.push(`constraint="${escapeXml(expandHashtags(q.constraint))}"`)
  }
  if (q.constraint_msg) {
    bindParts.push(`jr:constraintMsg="${escapeXml(q.constraint_msg)}"`)
  }
  if (q.relevant) {
    if (hasHashtags(q.relevant)) bindParts.push(`vellum:relevant="${escapeXml(q.relevant)}"`)
    bindParts.push(`relevant="${escapeXml(expandHashtags(q.relevant))}"`)
  }
  if (q.calculate) {
    if (hasHashtags(q.calculate)) bindParts.push(`vellum:calculate="${escapeXml(q.calculate)}"`)
    bindParts.push(`calculate="${escapeXml(expandHashtags(q.calculate))}"`)
  }
  // Setvalue for default_value — same dual-attribute pattern
  // Inside repeats, use jr-insert event so defaults fire per iteration, not just on form load
  if (q.default_value) {
    const expandedValue = expandHashtags(q.default_value)
    const vellumAttrs = hasHashtags(q.default_value)
      ? ` vellum:value="${escapeXml(q.default_value)}"`
      : ''
    const event = insideRepeat ? 'jr-insert' : 'xforms-ready'
    setvalues.push(`<setvalue event="${event}" ref="${nodePath}"${vellumAttrs} value="${escapeXml(expandedValue)}"/>`)
  }
  // Add Vellum hashtag metadata for #case/ and #user/ references
  const xpathExprs = [q.relevant, q.constraint, q.calculate, q.default_value, q.required].filter(Boolean) as string[]
  const hashtags = extractHashtags(xpathExprs)
  if (hashtags.length > 0) {
    const hashtagMap = Object.fromEntries(hashtags.map(h => [h, null]))
    bindParts.push(`vellum:hashtags="${escapeXml(JSON.stringify(hashtagMap))}"`)
    bindParts.push(`vellum:hashtagTransforms="${escapeXml(JSON.stringify(VELLUM_HASHTAG_TRANSFORMS))}"`)
  }
  binds.push(`<bind ${bindParts.join(' ')}/>`)

  // itext (hidden questions have no body element, so no label to reference)
  if (q.type !== 'hidden' && q.label) {
    addItext(`${q.id}-label`, q.label)
    addItext(`${q.id}-hint`, q.hint)
    addItext(`${q.id}-help`, q.help)
  }

  // itext for select options
  if (q.options && q.options.length > 0) {
    for (const opt of q.options) {
      addItext(`${q.id}-${opt.value}-label`, opt.label)
    }
  }

  // Body element
  if (q.type === 'hidden') {
    // Hidden values have no body element — data + bind only
    return
  } else if (q.type === 'group' || q.type === 'repeat') {
    // Group/repeat: contains nested child questions
    const childData: string[] = []
    const childBinds: string[] = []
    const childBody: string[] = []
    const childInsideRepeat = q.type === 'repeat' ? true : insideRepeat
    for (const child of (q.children || [])) {
      buildQuestionParts(child, nodePath, childData, childBinds, setvalues, childBody, childInsideRepeat, addItext)
    }
    // Replace the self-closing data element with a proper parent element wrapping children
    dataElements.pop()
    const templateAttr = q.type === 'repeat' ? ' jr:template=""' : ''
    dataElements.push(`<${q.id}${templateAttr}>${childData.join('')}</${q.id}>`)
    // Replace the group bind with just a relevant bind if needed
    binds.pop()
    if (q.relevant) {
      binds.push(`<bind nodeset="${nodePath}" relevant="${escapeXml(q.relevant)}"/>`)
    }
    binds.push(...childBinds)
    // Re-indent ALL lines of child body elements for proper nesting.
    // Child elements have: line 0 at 0 indent (relative), subsequent lines with absolute indent.
    // For group: line 0 needs +6 (4 base + 2 nesting), subsequent lines need +2.
    // For repeat: line 0 needs +8 (4 base + 2 group + 2 repeat), subsequent lines need +4.
    if (q.type === 'repeat') {
      const indentedChildren = childBody.map(el => {
        const lines = el.split('\n')
        lines[0] = `        ${lines[0]}`
        for (let i = 1; i < lines.length; i++) lines[i] = `    ${lines[i]}`
        return lines.join('\n')
      })
      const innerLines = indentedChildren.join('\n')
      bodyElements.push(`<group ref="${nodePath}">\n      <label ref="jr:itext('${q.id}-label')"/>\n      <repeat nodeset="${nodePath}">\n${innerLines}\n      </repeat>\n    </group>`)
    } else {
      const indentedChildren = childBody.map(el => {
        const lines = el.split('\n')
        lines[0] = `      ${lines[0]}`
        for (let i = 1; i < lines.length; i++) lines[i] = `  ${lines[i]}`
        return lines.join('\n')
      })
      const innerLines = indentedChildren.join('\n')
      bodyElements.push(`<group ref="${nodePath}" appearance="field-list">\n      <label ref="jr:itext('${q.id}-label')"/>\n${innerLines}\n    </group>`)
    }
    return
  } else if (q.type === 'select1' || q.type === 'select') {
    const tag = q.type === 'select1' ? 'select1' : 'select'
    const items = (q.options ?? []).map(opt =>
      `  <item><label ref="jr:itext('${q.id}-${opt.value}-label')"/><value>${escapeXml(opt.value)}</value></item>`
    ).join('\n    ')
    let el = `<${tag} ref="${nodePath}">\n      <label ref="jr:itext('${q.id}-label')"/>`
    if (q.hint) el += `\n      <hint ref="jr:itext('${q.id}-hint')"/>`
    if (q.help) el += `\n      <help ref="jr:itext('${q.id}-help')"/>`
    el += `\n    ${items}\n    </${tag}>`
    bodyElements.push(el)
  } else if (q.type === 'trigger') {
    let el = `<trigger ref="${nodePath}">\n      <label ref="jr:itext('${q.id}-label')"/>`
    if (q.hint) el += `\n      <hint ref="jr:itext('${q.id}-hint')"/>`
    if (q.help) el += `\n      <help ref="jr:itext('${q.id}-help')"/>`
    el += `\n    </trigger>`
    bodyElements.push(el)
  } else if (q.type === 'secret') {
    let el = `<secret ref="${nodePath}">\n      <label ref="jr:itext('${q.id}-label')"/>`
    if (q.hint) el += `\n      <hint ref="jr:itext('${q.id}-hint')"/>`
    if (q.help) el += `\n      <help ref="jr:itext('${q.id}-help')"/>`
    el += `\n    </secret>`
    bodyElements.push(el)
  } else if (q.type === 'image' || q.type === 'audio' || q.type === 'video' || q.type === 'signature') {
    const mediatype = q.type === 'audio' ? 'audio/*' : q.type === 'video' ? 'video/*' : 'image/*'
    const appearance = q.type === 'signature' ? ' appearance="signature"' : ''
    let el = `<upload ref="${nodePath}" mediatype="${mediatype}"${appearance}>\n      <label ref="jr:itext('${q.id}-label')"/>`
    if (q.hint) el += `\n      <hint ref="jr:itext('${q.id}-hint')"/>`
    if (q.help) el += `\n      <help ref="jr:itext('${q.id}-help')"/>`
    el += `\n    </upload>`
    bodyElements.push(el)
  } else {
    // Input types: text, int, decimal, long, date, time, datetime, geopoint, barcode, phone
    const appearance = getAppearance(q.type)
    const appearanceAttr = appearance ? ` appearance="${appearance}"` : ''
    let el = `<input ref="${nodePath}"${appearanceAttr}>\n      <label ref="jr:itext('${q.id}-label')"/>`
    if (q.hint) el += `\n      <hint ref="jr:itext('${q.id}-hint')"/>`
    if (q.help) el += `\n      <help ref="jr:itext('${q.id}-help')"/>`
    el += `\n    </input>`
    bodyElements.push(el)
  }
}

/** Map question type to XForm appearance attribute (e.g. "phone" -> "numeric"). */
function getAppearance(type: string): string | null {
  switch (type) {
    case 'phone': return 'numeric'
    default: return null
  }
}

/** Map question type to its XSD type for XForm <bind> elements. */
function getXsdType(type: string): string | null {
  switch (type) {
    case 'text': return 'xsd:string'
    case 'phone': return 'xsd:string'
    case 'int': return 'xsd:int'
    case 'long': return 'xsd:long'
    case 'decimal': return 'xsd:decimal'
    case 'date': return 'xsd:date'
    case 'time': return 'xsd:time'
    case 'datetime': return 'xsd:dateTime'
    case 'geopoint': return 'xsd:string'
    case 'barcode': return 'xsd:string'
    case 'image': return 'xsd:string'
    case 'audio': return 'xsd:string'
    case 'video': return 'xsd:string'
    case 'signature': return 'xsd:string'
    case 'hidden': return 'xsd:string'
    case 'secret': return 'xsd:string'
    case 'trigger': return null
    case 'group': return null
    case 'repeat': return null
    case 'select1': return 'xsd:string'
    case 'select': return 'xsd:string'
    default: return 'xsd:string'
  }
}

/**
 * Resolve a question ID to its full /data/... path (including parent groups/repeats).
 * Questions inside groups need paths like /data/group_id/question_id.
 */
function resolveQuestionPath(questions: Question[], questionId: string, prefix = '/data'): string | null {
  for (const q of questions) {
    if (q.id === questionId) return `${prefix}/${q.id}`
    if ((q.type === 'group' || q.type === 'repeat') && q.children) {
      const found = resolveQuestionPath(q.children, questionId, `${prefix}/${q.id}`)
      if (found) return found
    }
  }
  return null
}

/**
 * Build the HQ FormActions object for a form.
 *
 * Maps blueprint case config (case_properties, case_preload, close_case,
 * child_cases) to HQ's action format with question_path references.
 * Silently filters reserved property names and media questions.
 * All question paths are resolved through the group/repeat hierarchy.
 */
function buildFormActions(form: BlueprintForm, caseType: string): FormActions {
  const base = emptyFormActions()

  if (form.type === 'survey' || !caseType) {
    return base
  }

  // Derive case config on-demand from per-question fields
  const { case_name_field, case_properties, case_preload } = deriveCaseConfig(form.questions || [], form.type)

  // Build a safe update map, filtering out reserved property names and media questions
  function buildSafeUpdateMap(caseProperties: Array<{ case_property: string; question_id: string }> | undefined): Record<string, { question_path: string; update_mode: string }> {
    const updateMap: Record<string, { question_path: string; update_mode: string }> = {}
    if (!caseProperties) return updateMap
    // Build a lookup of question id -> type for media filtering
    function getQuestionType(questions: Question[], id: string): string | undefined {
      for (const q of questions) {
        if (q.id === id) return q.type
        if ((q.type === 'group' || q.type === 'repeat') && q.children) {
          const t = getQuestionType(q.children, id)
          if (t) return t
        }
      }
      return undefined
    }
    for (const { case_property: caseProp, question_id: questionId } of caseProperties) {
      if (RESERVED_CASE_PROPERTIES.has(caseProp)) continue // skip reserved words
      const qType = getQuestionType(form.questions || [], questionId)
      if (qType && MEDIA_QUESTION_TYPES.has(qType)) continue // skip media/binary questions
      const qPath = resolveQuestionPath(form.questions || [], questionId) || `/data/${questionId}`
      updateMap[caseProp] = { question_path: qPath, update_mode: 'always' }
    }
    return updateMap
  }

  if (form.type === 'registration') {
    // Open case
    base.open_case.condition = alwaysCondition()
    const nameFieldId = case_name_field || form.questions[0]?.id || 'name'
    base.open_case.name_update.question_path = resolveQuestionPath(form.questions || [], nameFieldId) || `/data/${nameFieldId}`

    // Update case properties (filtered)
    const updateMap = buildSafeUpdateMap(case_properties)
    if (Object.keys(updateMap).length > 0) {
      base.update_case.condition = alwaysCondition()
      base.update_case.update = updateMap
    }
  }

  if (form.type === 'followup') {
    // Update case (filtered)
    const updateMap = buildSafeUpdateMap(case_properties)
    if (Object.keys(updateMap).length > 0) {
      base.update_case.condition = alwaysCondition()
      base.update_case.update = updateMap
    }

    // Preload case data — filter reserved words (HQ rejects them in preloads too)
    if (case_preload && case_preload.length > 0) {
      const preloadMap: Record<string, string> = {}
      for (const { question_id: questionId, case_property: caseProp } of case_preload) {
        if (RESERVED_CASE_PROPERTIES.has(caseProp)) continue // HQ rejects reserved words in preloads
        const qPath = resolveQuestionPath(form.questions || [], questionId) || `/data/${questionId}`
        preloadMap[qPath] = caseProp
      }
      if (Object.keys(preloadMap).length > 0) {
        base.case_preload.condition = alwaysCondition()
        base.case_preload.preload = preloadMap
      }
    }
  }

  // Close case (followup forms only)
  if (form.type === 'followup' && form.close_case) {
    if (form.close_case.question && form.close_case.answer) {
      // Conditional close
      base.close_case = {
        doc_type: 'FormAction',
        condition: ifCondition(
          resolveQuestionPath(form.questions || [], form.close_case.question) || `/data/${form.close_case.question}`,
          form.close_case.answer,
        ),
      }
    } else {
      // Unconditional close
      base.close_case = { doc_type: 'FormAction', condition: alwaysCondition() }
    }
  }

  // Child cases / subcases
  if (form.child_cases && form.child_cases.length > 0) {
    base.subcases = form.child_cases.map((child): OpenSubCaseAction => {
      const childProps: Record<string, { question_path: string; update_mode: string }> = {}
      if (child.case_properties) {
        for (const { case_property: caseProp, question_id: questionId } of child.case_properties) {
          if (RESERVED_CASE_PROPERTIES.has(caseProp)) continue
          const qPath = resolveQuestionPath(form.questions || [], questionId) || `/data/${questionId}`
          childProps[caseProp] = { question_path: qPath, update_mode: 'always' }
        }
      }

      const nameFieldPath = resolveQuestionPath(form.questions || [], child.case_name_field) || `/data/${child.case_name_field}`

      return {
        doc_type: 'OpenSubCaseAction',
        case_type: child.case_type,
        name_update: { question_path: nameFieldPath, update_mode: 'always' },
        reference_id: '',
        case_properties: childProps,
        repeat_context: child.repeat_context ? resolveQuestionPath(form.questions || [], child.repeat_context) || `/data/${child.repeat_context}` : '',
        relationship: child.relationship || 'child',
        close_condition: neverCondition(),
        condition: alwaysCondition(),
      }
    })
  }

  return base
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

    for (let fIdx = 0; fIdx < mod.forms.length; fIdx++) {
      const form = mod.forms[fIdx]
      if (!form.questions || form.questions.length === 0) {
        errors.push(`"${form.name}" in "${mod.name}" has no questions`)
      }

      // Derive case config on-demand from per-question fields
      const { case_name_field, case_properties, case_preload } = deriveCaseConfig(form.questions || [], form.type)

      if (form.type === 'registration' && !case_name_field) {
        errors.push(`"${form.name}" is a registration form but has no case_name_field`)
      }

      // Validate select questions have options (recursively for group/repeat children)
      function validateQuestions(questions: Question[], formName: string) {
        for (const q of questions) {
          if ((q.type === 'select1' || q.type === 'select') && (!q.options || q.options.length === 0)) {
            errors.push(`Question "${q.id}" in "${formName}" is a select but has no options`)
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
          if (RESERVED_CASE_PROPERTIES.has(prop)) {
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

      // Validate child_cases
      if (form.child_cases) {
        const questionIds = collectQuestionIds(form.questions || [])
        for (let cIdx = 0; cIdx < form.child_cases.length; cIdx++) {
          const child = form.child_cases[cIdx]
          const prefix = `"${fn}" child_cases[${cIdx}]`

          if (!child.case_type) {
            errors.push(`${prefix} is missing case_type`)
          }
          if (!child.case_name_field) {
            errors.push(`${prefix} is missing case_name_field`)
          } else if (!questionIds.includes(child.case_name_field)) {
            errors.push(`${prefix} case_name_field "${child.case_name_field}" doesn't match any question id`)
          }
          if (child.case_properties) {
            for (const { case_property: prop, question_id: qId } of child.case_properties) {
              if (RESERVED_CASE_PROPERTIES.has(prop)) {
                errors.push(`${prefix} uses reserved case property name "${prop}"`)
              }
              if (!questionIds.includes(qId)) {
                errors.push(`${prefix} case property "${prop}" maps to question "${qId}" which doesn't exist`)
              }
            }
          }
          if (child.repeat_context) {
            const repeatQ = (form.questions || []).find(q => q.id === child.repeat_context)
            if (!repeatQ) {
              errors.push(`${prefix} repeat_context "${child.repeat_context}" doesn't match any question id`)
            } else if (repeatQ.type !== 'repeat') {
              errors.push(`${prefix} repeat_context "${child.repeat_context}" is not a repeat group`)
            }
          }
        }
      }

    }
  }

  return errors
}
