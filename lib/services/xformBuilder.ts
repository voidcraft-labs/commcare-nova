/**
 * XForm XML builder for CommCare forms.
 *
 * Generates complete XForm XML from blueprint question definitions, including
 * itext translations, binds, setvalues, body elements, and secondary instances.
 * Extracted from hqJsonExpander.ts to isolate XForm construction logic.
 */
import type { BlueprintForm, Question } from '../schemas/blueprint'
import {
  escapeXml,
  VELLUM_HASHTAG_TRANSFORMS, expandHashtags, hasHashtags, extractHashtags,
} from './commcare'
import { parseDocument } from 'htmlparser2'
import { findAll } from 'domutils'
import render from 'dom-serializer'
import type { Element } from 'domhandler'

const PARSE_OPTS = { xmlMode: true } as const
const RENDER_OPTS = { xmlMode: true, selfClosingTags: true, encodeEntities: 'utf8' as const } as const

/**
 * Process label/hint/help text that may contain <output value="..."/> tags.
 * Plain text segments are XML-escaped. <output> tags are preserved as raw XML
 * with hashtag expansion on the value attribute.
 */
function processLabelText(text: string): string {
  const doc = parseDocument(text, PARSE_OPTS)

  // Expand hashtags in output tag value attributes
  const outputs = findAll(
    (node): node is Element => node.type === 'tag' && node.name === 'output',
    doc.children,
  )
  for (const el of outputs) {
    if (el.attribs.value) {
      el.attribs.value = expandHashtags(el.attribs.value)
    }
  }

  // Serialize back — dom-serializer handles XML escaping of text nodes
  return render(doc, RENDER_OPTS)
}

/** Collect all XPath expressions from a question tree (pre-expansion). */
function collectAllXPaths(questions: Question[]): string[] {
  const exprs: string[] = []
  for (const q of questions) {
    if (q.relevant) exprs.push(q.relevant)
    if (q.validation) exprs.push(q.validation)
    if (q.calculate) exprs.push(q.calculate)
    if (q.default_value) exprs.push(q.default_value)
    if (q.required) exprs.push(q.required)
    if (q.children) exprs.push(...collectAllXPaths(q.children))
  }
  return exprs
}

/** Build complete XForm XML from question definitions. */
export function buildXForm(form: BlueprintForm, xmlns: string): string {
  const questions = form.questions || []
  const dataElements: string[] = []
  const binds: string[] = []
  const setvalues: string[] = []
  const bodyElements: string[] = []

  // Collect itext entries (single language)
  const itextEntries: string[] = []

  const addItext = (id: string, text: string | undefined, markdown?: boolean) => {
    if (!text) return
    const processed = processLabelText(text)
    if (markdown) {
      itextEntries.push(`<text id="${id}"><value>${processed}</value><value form="markdown">${processed}</value></text>`)
    } else {
      itextEntries.push(`<text id="${id}"><value>${processed}</value></text>`)
    }
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

  // Check if any XPath references need secondary instances
  const allXPaths = collectAllXPaths(questions)
  const needsCasedb = allXPaths.some(x => x.includes('#case/') || x.includes('#user/') || x.includes("instance('casedb')"))
  const needsSession = needsCasedb || allXPaths.some(x => x.includes("instance('commcaresession')"))

  const secondaryInstances = [
    ...(needsCasedb ? ['      <instance src="jr://instance/casedb" id="casedb" />'] : []),
    ...(needsSession ? ['      <instance src="jr://instance/session" id="commcaresession" />'] : []),
  ]
  const secondaryContent = secondaryInstances.length > 0 ? '\n' + secondaryInstances.join('\n') : ''

  return `<?xml version="1.0"?>
<h:html xmlns:h="http://www.w3.org/1999/xhtml" xmlns="http://www.w3.org/2002/xforms" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:jr="http://openrosa.org/javarosa" xmlns:vellum="http://commcarehq.org/xforms/vellum">
  <h:head>
    <h:title>${escapeXml(formName)}</h:title>
    <model>
      <instance>
        <data xmlns="${xmlns}" xmlns:jrm="http://dev.commcarehq.org/jr/xforms" uiVersion="1" version="1" name="${escapeXml(formName.toLowerCase().replace(/[^a-z0-9]+/g, '_'))}">${dataContent}</data>
      </instance>${secondaryContent}${bindContent}${setvalueContent}
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
 * - binds: <bind> elements with type, required, validation, etc.
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
  addItext: (id: string, text: string | undefined, markdown?: boolean) => void
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
  if (q.validation) {
    if (hasHashtags(q.validation)) bindParts.push(`vellum:constraint="${escapeXml(q.validation)}"`)
    bindParts.push(`constraint="${escapeXml(expandHashtags(q.validation))}"`)
  }
  if (q.validation_msg) {
    bindParts.push(`jr:constraintMsg="${escapeXml(q.validation_msg)}"`)
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
  const xpathExprs = [q.relevant, q.validation, q.calculate, q.default_value, q.required].filter(Boolean) as string[]
  const hashtags = extractHashtags(xpathExprs)
  if (hashtags.length > 0) {
    const hashtagMap = Object.fromEntries(hashtags.map(h => [h, null]))
    bindParts.push(`vellum:hashtags="${escapeXml(JSON.stringify(hashtagMap))}"`)
    bindParts.push(`vellum:hashtagTransforms="${escapeXml(JSON.stringify(VELLUM_HASHTAG_TRANSFORMS))}"`)
  }
  binds.push(`<bind ${bindParts.join(' ')}/>`)

  // itext (hidden questions have no body element, so no label to reference)
  if (q.type !== 'hidden' && q.label) {
    addItext(`${q.id}-label`, q.label, q.type === 'label')
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
  } else if (q.type === 'single_select' || q.type === 'multi_select') {
    const tag = q.type === 'single_select' ? 'select1' : 'select'
    const items = (q.options ?? []).map(opt =>
      `  <item><label ref="jr:itext('${q.id}-${opt.value}-label')"/><value>${escapeXml(opt.value)}</value></item>`
    ).join('\n    ')
    let el = `<${tag} ref="${nodePath}">\n      <label ref="jr:itext('${q.id}-label')"/>`
    if (q.hint) el += `\n      <hint ref="jr:itext('${q.id}-hint')"/>`
    if (q.help) el += `\n      <help ref="jr:itext('${q.id}-help')"/>`
    el += `\n    ${items}\n    </${tag}>`
    bodyElements.push(el)
  } else if (q.type === 'label') {
    let el = `<trigger ref="${nodePath}" appearance="minimal">\n      <label ref="jr:itext('${q.id}-label')"/>`
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
    // Input types: text, int, decimal, date, time, datetime, geopoint, barcode, phone
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
    case 'label': return null
    case 'group': return null
    case 'repeat': return null
    case 'single_select': return 'xsd:string'
    case 'multi_select': return 'xsd:string'
    default: return 'xsd:string'
  }
}
