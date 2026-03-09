import { randomBytes } from 'crypto'
import type { AppBlueprint, BlueprintForm, BlueprintQuestion } from '../schemas/blueprint'

/** Reserved case property names — HQ rejects these in update_case */
const RESERVED_CASE_PROPERTIES = new Set([
  'case_id', 'case_name', 'case_type', 'closed', 'closed_by', 'closed_on',
  'date', 'date_modified', 'date_opened', 'doc_type', 'domain',
  'external_id', 'index', 'indices', 'modified_on', 'opened_by',
  'opened_on', 'owner_id', 'server_modified_on', 'status', 'type',
  'user_id', 'xform_id', 'name'
])

/** Media/binary question types — cannot be saved as case properties */
const MEDIA_QUESTION_TYPES = new Set(['image', 'audio', 'video', 'signature'])

/**
 * Expand an AppBlueprint into the full HQ import JSON.
 *
 * Generates all boilerplate that CommCare HQ expects: doc_types, unique_ids,
 * xmlns, XForm XML with itext/binds/body, form actions, case details, etc.
 * The output can be imported directly into HQ or compiled into a .ccz.
 */
export function expandBlueprint(blueprint: AppBlueprint): Record<string, any> {
  const attachments: Record<string, string> = {}
  const modules: any[] = []

  for (let mIdx = 0; mIdx < blueprint.modules.length; mIdx++) {
    const bm = blueprint.modules[mIdx]
    const moduleUniqueId = genHexId()
    const hasCases = bm.case_type && bm.forms.some(f => f.type !== 'survey')
    const caseType = hasCases ? bm.case_type! : ''

    const forms: any[] = []

    for (let fIdx = 0; fIdx < bm.forms.length; fIdx++) {
      const bf = bm.forms[fIdx]
      const formUniqueId = genHexId()
      const xmlns = `http://openrosa.org/formdesigner/${genShortId()}`

      const xform = buildXForm(bf, xmlns)
      attachments[`${formUniqueId}.xml`] = xform

      const actions = buildFormActions(bf, caseType)

      forms.push({
        doc_type: 'Form',
        form_type: 'module_form',
        unique_id: formUniqueId,
        name: { en: bf.name },
        xmlns,
        requires: bf.type === 'followup' ? 'case' : 'none',
        version: null,
        actions,
        case_references_data: { load: {}, save: {}, doc_type: 'CaseReferences' },
        form_filter: null,
        post_form_workflow: 'default',
        no_vellum: false,
        media_image: {}, media_audio: {}, custom_icons: [],
        custom_assertions: [], custom_instances: [], form_links: [],
        comment: ''
      })
    }

    const caseDetails = hasCases ? buildCaseDetails(bm.case_list_columns || []) : buildEmptyCaseDetails()

    modules.push({
      doc_type: 'Module',
      module_type: 'basic',
      unique_id: moduleUniqueId,
      name: { en: bm.name },
      case_type: caseType,
      put_in_root: false,
      root_module_id: null,
      forms,
      case_details: caseDetails,
      case_list: { doc_type: 'CaseList', show: false, label: {}, media_image: {}, media_audio: {}, custom_icons: [] },
      case_list_form: { doc_type: 'CaseListForm', form_id: null, label: {} },
      search_config: { doc_type: 'CaseSearch', properties: [], default_properties: [], include_closed: false },
      display_style: 'list',
      media_image: {}, media_audio: {}, custom_icons: [],
      is_training_module: false, module_filter: null, auto_select_case: false,
      parent_select: { active: false, module_id: null },
      comment: ''
    })
  }

  return {
    doc_type: 'Application',
    application_version: '2.0',
    name: blueprint.app_name,
    langs: ['en'],
    build_spec: { doc_type: 'BuildSpec', version: '2.53.0', build_number: null },
    profile: { doc_type: 'Profile', features: {}, properties: {} },
    vellum_case_management: true,
    cloudcare_enabled: false,
    case_sharing: false,
    secure_submissions: false,
    multimedia_map: {},
    translations: {},
    modules,
    _attachments: attachments
  }
}

/** Generate a 40-char hex ID for HQ unique_id fields. */
function genHexId(): string {
  return randomBytes(20).toString('hex')
}

/** Generate a 16-char hex ID for xmlns URIs. */
function genShortId(): string {
  return randomBytes(8).toString('hex')
}

/** Escape special XML characters in attribute values and text content. */
function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

/** Vellum hashtag transform prefixes — tells HQ how to expand #case/ and #user/ shorthand. */
const VELLUM_HASHTAG_TRANSFORMS = {
  prefixes: {
    '#case/': "instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]/",
    '#user/': "instance('casedb')/casedb/case[@case_type = 'commcare-user'][hq_user_id = instance('commcaresession')/session/context/userid]/",
  }
}

/** Extract #case/... and #user/... hashtag references from XPath expressions. */
function extractHashtags(exprs: string[]): string[] {
  const hashtags = new Set<string>()
  for (const expr of exprs) {
    const matches = expr.matchAll(/#(?:case|user)\/[\w-]+/g)
    for (const m of matches) {
      hashtags.add(m[0])
    }
  }
  return [...hashtags]
}

/** Build complete XForm XML from question definitions. */
function buildXForm(form: BlueprintForm, xmlns: string): string {
  const questions = form.questions || []
  const dataElements: string[] = []
  const binds: string[] = []
  const setvalues: string[] = []
  const itextEntries: string[] = []
  const bodyElements: string[] = []

  for (const q of questions) {
    buildQuestionParts(q, '/data', dataElements, binds, setvalues, itextEntries, bodyElements)
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

  const itextContent = itextEntries.map(e => `          ${e}`).join('\n')

  const bodyContent = bodyElements.map(e => `    ${e}`).join('\n')

  return `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:jr="http://openrosa.org/javarosa" xmlns:vellum="http://commcarehq.org/xforms/vellum">
  <h:head>
    <h:title>${escapeXml(form.name)}</h:title>
    <model>
      <instance>
        <data xmlns="${xmlns}" xmlns:jrm="http://dev.commcarehq.org/jr/xforms" uiVersion="1" version="1" name="${escapeXml(form.name.toLowerCase().replace(/[^a-z0-9]+/g, '_'))}">${dataContent}</data>
      </instance>${bindContent}${setvalueContent}
      <itext>
        <translation lang="en" default="">
${itextContent}
        </translation>
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
  q: BlueprintQuestion,
  parentPath: string,
  dataElements: string[],
  binds: string[],
  setvalues: string[],
  itextEntries: string[],
  bodyElements: string[]
): void {
  const nodePath = `${parentPath}/${q.id}`

  // Data element
  dataElements.push(`<${q.id}/>`)

  // Bind
  const bindParts = [`nodeset="${nodePath}"`]
  const xsdType = getXsdType(q.type)
  if (xsdType) bindParts.push(`type="${xsdType}"`)
  if (q.required) bindParts.push(`required="true()"`)
  if (q.readonly) bindParts.push(`readonly="true()"`)
  if (q.constraint) bindParts.push(`constraint="${escapeXml(q.constraint)}"`)
  if (q.constraint_msg) bindParts.push(`jr:constraintMsg="${escapeXml(q.constraint_msg)}"`)
  if (q.relevant) bindParts.push(`relevant="${escapeXml(q.relevant)}"`)
  if (q.calculate) bindParts.push(`calculate="${escapeXml(q.calculate)}"`)
  // Setvalue for default_value
  if (q.default_value) {
    setvalues.push(`<setvalue event="xforms-ready" ref="${nodePath}" value="${escapeXml(q.default_value)}"/>`)
  }
  // Add Vellum hashtag metadata for #case/ and #user/ references
  const xpathExprs = [q.relevant, q.constraint, q.calculate, q.default_value].filter(Boolean) as string[]
  const hashtags = extractHashtags(xpathExprs)
  if (hashtags.length > 0) {
    const hashtagMap = Object.fromEntries(hashtags.map(h => [h, null]))
    bindParts.push(`vellum:hashtags="${escapeXml(JSON.stringify(hashtagMap))}"`)
    bindParts.push(`vellum:hashtagTransforms="${escapeXml(JSON.stringify(VELLUM_HASHTAG_TRANSFORMS))}"`)
  }
  binds.push(`<bind ${bindParts.join(' ')}/>`)

  // itext (hidden questions have no body element, so no label to reference)
  if (q.type !== 'hidden') {
    itextEntries.push(`<text id="${q.id}-label"><value>${escapeXml(q.label)}</value></text>`)
    if (q.hint) {
      itextEntries.push(`<text id="${q.id}-hint"><value>${escapeXml(q.hint)}</value></text>`)
    }
  }

  // itext for select options
  if (q.options) {
    for (const opt of q.options) {
      itextEntries.push(`<text id="${q.id}-${opt.value}-label"><value>${escapeXml(opt.label)}</value></text>`)
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
    const childItext: string[] = []
    const childBody: string[] = []
    for (const child of (q.children || [])) {
      buildQuestionParts(child, nodePath, childData, childBinds, setvalues, childItext, childBody)
    }
    // Replace the self-closing data element with a proper parent element wrapping children
    dataElements.pop()
    dataElements.push(`<${q.id}>${childData.join('')}</${q.id}>`)
    // Replace the group bind with just a relevant bind if needed
    binds.pop()
    if (q.relevant) {
      binds.push(`<bind nodeset="${nodePath}" relevant="${escapeXml(q.relevant)}"/>`)
    }
    binds.push(...childBinds)
    itextEntries.push(...childItext)
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
    const items = (q.options || []).map(opt =>
      `  <item><label ref="jr:itext('${q.id}-${opt.value}-label')"/><value>${escapeXml(opt.value)}</value></item>`
    ).join('\n    ')
    let el = `<${tag} ref="${nodePath}">\n      <label ref="jr:itext('${q.id}-label')"/>`
    if (q.hint) el += `\n      <hint ref="jr:itext('${q.id}-hint')"/>`
    el += `\n    ${items}\n    </${tag}>`
    bodyElements.push(el)
  } else if (q.type === 'trigger') {
    let el = `<trigger ref="${nodePath}">\n      <label ref="jr:itext('${q.id}-label')"/>`
    if (q.hint) el += `\n      <hint ref="jr:itext('${q.id}-hint')"/>`
    el += `\n    </trigger>`
    bodyElements.push(el)
  } else if (q.type === 'secret') {
    let el = `<secret ref="${nodePath}">\n      <label ref="jr:itext('${q.id}-label')"/>`
    if (q.hint) el += `\n      <hint ref="jr:itext('${q.id}-hint')"/>`
    el += `\n    </secret>`
    bodyElements.push(el)
  } else if (q.type === 'image' || q.type === 'audio' || q.type === 'video' || q.type === 'signature') {
    const mediatype = q.type === 'audio' ? 'audio/*' : q.type === 'video' ? 'video/*' : 'image/*'
    const appearance = q.type === 'signature' ? ' appearance="signature"' : ''
    let el = `<upload ref="${nodePath}" mediatype="${mediatype}"${appearance}>\n      <label ref="jr:itext('${q.id}-label')"/>`
    if (q.hint) el += `\n      <hint ref="jr:itext('${q.id}-hint')"/>`
    el += `\n    </upload>`
    bodyElements.push(el)
  } else {
    // Input types: text, int, decimal, long, date, time, datetime, geopoint, barcode, phone
    const appearance = getAppearance(q.type)
    const appearanceAttr = appearance ? ` appearance="${appearance}"` : ''
    let el = `<input ref="${nodePath}"${appearanceAttr}>\n      <label ref="jr:itext('${q.id}-label')"/>`
    if (q.hint) el += `\n      <hint ref="jr:itext('${q.id}-hint')"/>`
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
function resolveQuestionPath(questions: BlueprintQuestion[], questionId: string, prefix = '/data'): string | null {
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
function buildFormActions(form: BlueprintForm, caseType: string): any {
  const neverCondition: Record<string, any> = { type: 'never', question: null, answer: null, operator: null, doc_type: 'FormActionCondition' }
  const alwaysCondition: Record<string, any> = { type: 'always', question: null, answer: null, operator: null, doc_type: 'FormActionCondition' }

  const base = {
    doc_type: 'FormActions',
    open_case: {
      doc_type: 'OpenCaseAction',
      name_update: { question_path: '' },
      external_id: null,
      condition: { ...neverCondition }
    },
    update_case: {
      doc_type: 'UpdateCaseAction',
      update: {},
      condition: { ...neverCondition }
    },
    close_case: { doc_type: 'FormAction', condition: { ...neverCondition } },
    case_preload: { doc_type: 'PreloadAction', preload: {}, condition: { ...neverCondition } },
    subcases: [] as any[],
    usercase_preload: { doc_type: 'PreloadAction', preload: {}, condition: { ...neverCondition } },
    usercase_update: { doc_type: 'UpdateCaseAction', update: {}, condition: { ...neverCondition } },
    load_from_form: { doc_type: 'PreloadAction', preload: {}, condition: { ...neverCondition } }
  }

  if (form.type === 'survey' || !caseType) {
    return base
  }

  // Build a safe update map, filtering out reserved property names and media questions
  function buildSafeUpdateMap(caseProperties: Record<string, string> | undefined): Record<string, any> {
    const updateMap: Record<string, any> = {}
    if (!caseProperties) return updateMap
    // Build a lookup of question id -> type for media filtering
    function getQuestionType(questions: BlueprintQuestion[], id: string): string | undefined {
      for (const q of questions) {
        if (q.id === id) return q.type
        if ((q.type === 'group' || q.type === 'repeat') && q.children) {
          const t = getQuestionType(q.children, id)
          if (t) return t
        }
      }
      return undefined
    }
    for (const [caseProp, questionId] of Object.entries(caseProperties)) {
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
    base.open_case.condition = { ...alwaysCondition }
    const nameFieldId = form.case_name_field || form.questions[0]?.id || 'name'
    base.open_case.name_update.question_path = resolveQuestionPath(form.questions || [], nameFieldId) || `/data/${nameFieldId}`

    // Update case properties (filtered)
    const updateMap = buildSafeUpdateMap(form.case_properties)
    if (Object.keys(updateMap).length > 0) {
      base.update_case.condition = { ...alwaysCondition }
      base.update_case.update = updateMap
    }
  }

  if (form.type === 'followup') {
    // Update case (filtered)
    const updateMap = buildSafeUpdateMap(form.case_properties)
    if (Object.keys(updateMap).length > 0) {
      base.update_case.condition = { ...alwaysCondition }
      base.update_case.update = updateMap
    }

    // Preload case data — filter reserved words (HQ rejects them in preloads too)
    if (form.case_preload && Object.keys(form.case_preload).length > 0) {
      const preloadMap: Record<string, string> = {}
      for (const [questionId, caseProp] of Object.entries(form.case_preload)) {
        if (RESERVED_CASE_PROPERTIES.has(caseProp)) continue // HQ rejects reserved words in preloads
        const qPath = resolveQuestionPath(form.questions || [], questionId) || `/data/${questionId}`
        preloadMap[qPath] = caseProp
      }
      if (Object.keys(preloadMap).length > 0) {
        base.case_preload.condition = { ...alwaysCondition }
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
        condition: {
          type: 'if',
          question: resolveQuestionPath(form.questions || [], form.close_case.question) || `/data/${form.close_case.question}`,
          answer: form.close_case.answer,
          operator: '=',
          doc_type: 'FormActionCondition'
        }
      }
    } else {
      // Unconditional close
      base.close_case = { doc_type: 'FormAction', condition: { ...alwaysCondition } }
    }
  }

  // Child cases / subcases
  if (form.child_cases && form.child_cases.length > 0) {
    base.subcases = form.child_cases.map((child) => {
      const childProps: Record<string, any> = {}
      if (child.case_properties) {
        for (const [caseProp, questionId] of Object.entries(child.case_properties)) {
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
        close_condition: { ...neverCondition },
        condition: { ...alwaysCondition }
      }
    })
  }

  return base
}

/** Build the HQ DetailPair for case list/detail views from blueprint columns. */
function buildCaseDetails(columns: { field: string; header: string }[]): any {
  const safeColumns = columns.filter(col => !RESERVED_CASE_PROPERTIES.has(col.field))

  const shortColumns = safeColumns.map(col => ({
    doc_type: 'DetailColumn',
    header: { en: col.header },
    field: col.field,
    model: 'case',
    format: 'plain',
    calc_xpath: '.', filter_xpath: '', advanced: '',
    late_flag: 30, time_ago_interval: 365.25,
    useXpathExpression: false, hasNodeset: false, hasAutocomplete: false,
    isTab: false, enum: [], graph_configuration: null,
    relevant: '', case_tile_field: null, nodeset: ''
  }))

  // Always ensure case_name is the first column in the case list
  if (!shortColumns.some(col => col.field === 'case_name' || col.field === 'name')) {
    shortColumns.unshift({
      doc_type: 'DetailColumn',
      header: { en: 'Name' },
      field: 'case_name',
      model: 'case',
      format: 'plain',
      calc_xpath: '.', filter_xpath: '', advanced: '',
      late_flag: 30, time_ago_interval: 365.25,
      useXpathExpression: false, hasNodeset: false, hasAutocomplete: false,
      isTab: false, enum: [], graph_configuration: null,
      relevant: '', case_tile_field: null, nodeset: ''
    })
  }

  const detailBase = {
    sort_elements: [], tabs: [], filter: null,
    lookup_enabled: false, lookup_autolaunch: false, lookup_display_results: false,
    lookup_name: null, lookup_image: null, lookup_action: null,
    lookup_field_template: null, lookup_field_header: {},
    lookup_extras: [], lookup_responses: [],
    persist_case_context: null, persistent_case_context_xml: 'case_name',
    persist_tile_on_forms: null, persistent_case_tile_from_module: null,
    pull_down_tile: null, case_tile_template: null,
    custom_xml: null, custom_variables: null
  }

  return {
    doc_type: 'DetailPair',
    short: {
      doc_type: 'Detail', display: 'short',
      columns: shortColumns,
      ...detailBase
    },
    long: {
      doc_type: 'Detail', display: 'long',
      columns: [],
      ...detailBase
    }
  }
}

/** Build an empty DetailPair for survey-only modules (no case list). */
function buildEmptyCaseDetails(): any {
  const detailBase = {
    sort_elements: [], tabs: [], filter: null,
    lookup_enabled: false, lookup_autolaunch: false, lookup_display_results: false,
    lookup_name: null, lookup_image: null, lookup_action: null,
    lookup_field_template: null, lookup_field_header: {},
    lookup_extras: [], lookup_responses: [],
    persist_case_context: null, persistent_case_context_xml: 'case_name',
    persist_tile_on_forms: null, persistent_case_tile_from_module: null,
    pull_down_tile: null, case_tile_template: null,
    custom_xml: null, custom_variables: null
  }

  return {
    doc_type: 'DetailPair',
    short: { doc_type: 'Detail', display: 'short', columns: [], ...detailBase },
    long: { doc_type: 'Detail', display: 'long', columns: [], ...detailBase }
  }
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
      if (form.type === 'registration' && !form.case_name_field) {
        errors.push(`"${form.name}" is a registration form but has no case_name_field`)
      }

      // Validate select questions have options (recursively for group/repeat children)
      function validateQuestions(questions: BlueprintQuestion[], formName: string) {
        for (const q of questions) {
          if ((q.type === 'select1' || q.type === 'select') && (!q.options || q.options.length === 0)) {
            errors.push(`Question "${q.id}" in "${formName}" is a select but has no options`)
          }
          if ((q.type === 'group' || q.type === 'repeat') && q.children) {
            validateQuestions(q.children, formName)
          }
        }
      }
      validateQuestions(form.questions || [], form.name)

      // Collect all question IDs including those inside groups/repeats
      function collectQuestionIds(questions: BlueprintQuestion[]): string[] {
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
      function findQuestionById(questions: BlueprintQuestion[], id: string): BlueprintQuestion | undefined {
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
      if (form.type === 'registration' && form.case_name_field) {
        const questionIds = collectQuestionIds(form.questions || [])
        if (!questionIds.includes(form.case_name_field)) {
          errors.push(`"${form.name}" case_name_field "${form.case_name_field}" doesn't match any question id`)
        }
      }

      // Check case_properties keys are not reserved words
      if (form.case_properties) {
        for (const prop of Object.keys(form.case_properties)) {
          if (RESERVED_CASE_PROPERTIES.has(prop)) {
            errors.push(`"${form.name}" uses reserved case property name "${prop}" — use a different name`)
          }
        }
      }

      // Check case_properties values refer to valid question ids and are not media types
      if (form.case_properties) {
        const questionIds = collectQuestionIds(form.questions || [])
        for (const [prop, qId] of Object.entries(form.case_properties)) {
          if (!questionIds.includes(qId)) {
            errors.push(`"${form.name}" case property "${prop}" maps to question "${qId}" which doesn't exist`)
          } else {
            const q = findQuestionById(form.questions || [], qId)
            if (q && MEDIA_QUESTION_TYPES.has(q.type)) {
              errors.push(`"${form.name}" case property "${prop}" maps to a ${q.type} question — media/binary questions cannot be saved as case properties`)
            }
          }
        }
      }

      // Check case_preload keys refer to valid question ids and values aren't reserved
      if (form.case_preload) {
        const questionIds = collectQuestionIds(form.questions || [])
        for (const [qId, caseProp] of Object.entries(form.case_preload)) {
          if (!questionIds.includes(qId)) {
            errors.push(`"${form.name}" case_preload references question "${qId}" which doesn't exist`)
          }
          if (RESERVED_CASE_PROPERTIES.has(caseProp)) {
            errors.push(`"${form.name}" case_preload uses reserved property "${caseProp}" — use a custom property name instead`)
          }
        }
      }

      // Validate close_case
      if (form.close_case) {
        if (form.type !== 'followup') {
          errors.push(`"${form.name}" has close_case but is not a followup form — only followup forms can close cases`)
        }
        const cc = form.close_case
        // If one of question/answer is set, both must be
        if (cc.question && !cc.answer) {
          errors.push(`"${form.name}" close_case condition is missing "answer"`)
        }
        if (!cc.question && cc.answer) {
          errors.push(`"${form.name}" close_case condition is missing "question"`)
        }
        if (cc.question) {
          const questionIds = collectQuestionIds(form.questions || [])
          if (!questionIds.includes(cc.question)) {
            errors.push(`"${form.name}" close_case references question "${cc.question}" which doesn't exist`)
          }
        }
      }

      // Validate child_cases
      if (form.child_cases) {
        const questionIds = collectQuestionIds(form.questions || [])
        for (let cIdx = 0; cIdx < form.child_cases.length; cIdx++) {
          const child = form.child_cases[cIdx]
          const prefix = `"${form.name}" child_cases[${cIdx}]`

          if (!child.case_type) {
            errors.push(`${prefix} is missing case_type`)
          }
          if (!child.case_name_field) {
            errors.push(`${prefix} is missing case_name_field`)
          } else if (!questionIds.includes(child.case_name_field)) {
            errors.push(`${prefix} case_name_field "${child.case_name_field}" doesn't match any question id`)
          }
          if (child.case_properties) {
            for (const [prop, qId] of Object.entries(child.case_properties)) {
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

      // Check case_list_columns don't use reserved words
      if (mod.case_list_columns) {
        for (const col of mod.case_list_columns) {
          if (RESERVED_CASE_PROPERTIES.has(col.field)) {
            errors.push(`Case list column "${col.field}" in "${mod.name}" uses a reserved property name`)
          }
        }
      }
    }
  }

  return errors
}
