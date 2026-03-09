/**
 * AutoFixer — programmatic fixes for common CommCare app issues.
 * Runs instantly (no API calls) before validation, fixing everything it can
 * so the validator ideally passes on the first attempt.
 */

const RESERVED_CASE_PROPERTIES = new Set([
  'actions', 'case_id', 'case_name', 'case_type', 'case_type_id',
  'create', 'closed', 'closed_by', 'closed_on', 'commtrack',
  'computed_', 'computed_modified_on_', 'date', 'date_modified',
  'date-opened', 'date_opened', 'doc_type', 'domain',
  'external-id', 'index', 'indices', 'initial_processing_complete',
  'last_modified', 'modified_on', 'modified_by', 'opened_by', 'opened_on',
  'parent', 'referrals', 'server_modified_on', 'server_opened_on',
  'status', 'type', 'user_id', 'userid', 'version', 'xform_id', 'xform_ids'
])

const RESERVED_RENAME_MAP: Record<string, string> = {
  date: 'visit_date',
  status: 'case_status',
  type: 'case_category',
  parent: 'parent_case',
  index: 'case_index',
  version: 'form_version',
  domain: 'case_domain',
  closed: 'is_closed',
  actions: 'case_actions',
  create: 'create_info'
}

export class AutoFixer {
  /**
   * Apply all automatic fixes to generated files.
   * Returns the fixed files and a list of fixes applied (for logging).
   */
  fix(files: Record<string, string>): { files: Record<string, string>; fixes: string[] } {
    const fixes: string[] = []
    const result = { ...files }

    // Fix each XForm file
    for (const [path, content] of Object.entries(result)) {
      if (!path.endsWith('.xml') || path === 'suite.xml' || path === 'media_suite.xml') continue
      if (path.endsWith('.ccpr')) continue
      if (!content.includes('<model>') && !content.includes('<model ')) continue

      const { xml, applied } = this.fixXForm(path, content)
      if (applied.length > 0) {
        result[path] = xml
        fixes.push(...applied)
      }
    }

    // Fix app_strings.txt — ensure all locale IDs from suite.xml have entries
    const suiteXml = result['suite.xml']
    const appStringsPath = 'default/app_strings.txt'
    if (suiteXml && result[appStringsPath] !== undefined) {
      const { content: fixedStrings, applied } = this.fixAppStrings(suiteXml, result[appStringsPath])
      if (applied.length > 0) {
        result[appStringsPath] = fixedStrings
        fixes.push(...applied)
      }
    }

    return { files: result, fixes }
  }

  private fixXForm(path: string, xml: string): { xml: string; applied: string[] } {
    const applied: string[] = []
    let result = xml

    // 1. Fix itext — add itext block and convert inline labels to jr:itext() refs
    const itextResult = this.fixItext(path, result)
    if (itextResult.changed) {
      result = itextResult.xml
      applied.push(...itextResult.applied)
    }

    // 2. Fix reserved case property names
    const reservedResult = this.fixReservedProperties(path, result)
    if (reservedResult.changed) {
      result = reservedResult.xml
      applied.push(...reservedResult.applied)
    }

    // 3. Fix missing case create binds
    const createResult = this.fixMissingCreateBinds(path, result)
    if (createResult.changed) {
      result = createResult.xml
      applied.push(...createResult.applied)
    }

    // 4. Fix missing case update binds
    const updateResult = this.fixMissingUpdateBinds(path, result)
    if (updateResult.changed) {
      result = updateResult.xml
      applied.push(...updateResult.applied)
    }

    return { xml: result, applied }
  }

  // -------------------------------------------------------------------
  // 1. itext fixer — the big one
  // -------------------------------------------------------------------

  private fixItext(path: string, xml: string): { xml: string; changed: boolean; applied: string[] } {
    const applied: string[] = []

    // Extract body to check for inline labels
    const bodyMatch = xml.match(/<h:body>([\s\S]*)<\/h:body>/)
    if (!bodyMatch) return { xml, changed: false, applied }

    const body = bodyMatch[1]

    // Collect all inline labels from the body
    // Matches: <label>Some Text</label> (NOT <label ref="..."/>)
    const inlineLabelRegex = /<label>([^<]+)<\/label>/g
    const inlineLabels: { full: string; text: string; questionId: string }[] = []

    // We need the context around each label to figure out the question ID
    // Look for patterns like <input ref="/data/xyz">...<label>Text</label>
    // or <select1 ref="/data/xyz">...<label>Text</label>
    // Also handle <item><label>Text</label><value>val</value></item>

    let bodyResult = body
    let hasInlineLabels = false

    // First pass: collect all question/item labels with their context
    const entries = this.collectLabelEntries(body)

    if (entries.length === 0) {
      // No inline labels found — but check if itext block exists
      if (!xml.includes('<itext>')) {
        // No itext and no inline labels — might have jr:itext refs already but missing the block
        // Check for jr:itext references
        const refs = [...xml.matchAll(/jr:itext\('([^']+)'\)/g)].map(m => m[1])
        if (refs.length > 0) {
          // Has refs but no itext block — need to create one from the labels
          // We can't know the text without context, so use the ID as placeholder
          const textEntries = refs.map(id => `          <text id="${id}">\n            <value>${this.idToLabel(id)}</value>\n          </text>`).join('\n')
          const itextBlock = `      <itext>\n        <translation lang="en" default="">\n${textEntries}\n        </translation>\n      </itext>`
          xml = xml.replace('</model>', `${itextBlock}\n    </model>`)
          applied.push(`${path}: Generated itext block for ${refs.length} existing jr:itext() references`)
          return { xml, changed: true, applied }
        }
      }
      return { xml, changed: false, applied }
    }

    // Build itext entries and replace inline labels
    const itextEntries: Map<string, string> = new Map() // id -> text value
    let fixedBody = body

    for (const entry of entries) {
      if (entry.type === 'question-label') {
        const id = `${entry.questionId}-label`
        itextEntries.set(id, entry.text)
        // Replace the inline label with itext ref
        // Be specific to avoid replacing item labels
        fixedBody = this.replaceQuestionLabel(fixedBody, entry.questionId, entry.text, id)
      } else if (entry.type === 'question-hint') {
        const id = `${entry.questionId}-hint`
        itextEntries.set(id, entry.text)
        fixedBody = fixedBody.replace(
          new RegExp(`(<hint>)${this.escapeRegex(entry.text)}(</hint>)`),
          `<hint ref="jr:itext('${id}')"/>`
        )
      } else if (entry.type === 'item-label') {
        const id = `${entry.questionId}-${entry.itemValue}-label`
        itextEntries.set(id, entry.text)
        fixedBody = this.replaceItemLabel(fixedBody, entry.text, entry.itemValue!, id)
      }
      hasInlineLabels = true
    }

    if (!hasInlineLabels) return { xml, changed: false, applied }

    // Also collect any existing itext entries so we don't duplicate
    const existingItextMatch = xml.match(/<itext>([\s\S]*?)<\/itext>/)
    if (existingItextMatch) {
      const existingIds = [...existingItextMatch[1].matchAll(/<text\s+id="([^"]+)"/g)].map(m => m[1])
      for (const id of existingIds) {
        itextEntries.delete(id) // Don't add duplicates
      }
    }

    // Build or augment the itext block
    if (itextEntries.size > 0) {
      const textElements = [...itextEntries.entries()]
        .map(([id, text]) => `          <text id="${id}">\n            <value>${this.escapeXml(text)}</value>\n          </text>`)
        .join('\n')

      if (existingItextMatch) {
        // Augment existing itext — add new entries before </translation>
        xml = xml.replace(
          '</translation>',
          `${textElements}\n        </translation>`
        )
      } else {
        // Create new itext block — insert before </model>
        const itextBlock = `      <itext>\n        <translation lang="en" default="">\n${textElements}\n        </translation>\n      </itext>`
        xml = xml.replace('</model>', `${itextBlock}\n    </model>`)
      }
    }

    // Replace the body
    xml = xml.replace(/<h:body>[\s\S]*<\/h:body>/, `<h:body>${fixedBody}</h:body>`)

    applied.push(`${path}: Converted ${entries.length} inline labels to itext references`)
    return { xml, changed: true, applied }
  }

  /**
   * Collect all inline labels from the body with their context (question ID, item value, etc.)
   */
  private collectLabelEntries(body: string): Array<{
    type: 'question-label' | 'question-hint' | 'item-label'
    questionId: string
    text: string
    itemValue?: string
  }> {
    const entries: Array<{
      type: 'question-label' | 'question-hint' | 'item-label'
      questionId: string
      text: string
      itemValue?: string
    }> = []

    // Parse question blocks: <input ref="/data/xyz">, <select1 ref="/data/xyz">, <select ref="/data/xyz">
    const questionBlockRegex = /<(input|select1?|trigger|upload)\s+ref="\/data\/([^"]+)"[^>]*>([\s\S]*?)(?:<\/\1>)/g
    let match

    while ((match = questionBlockRegex.exec(body)) !== null) {
      const questionId = match[2]
      const blockContent = match[3]

      // Check for inline question label (direct child, not inside <item>)
      // We need to find labels NOT inside <item> blocks
      const withoutItems = blockContent.replace(/<item>[\s\S]*?<\/item>/g, '')
      const labelMatch = withoutItems.match(/<label>([^<]+)<\/label>/)
      if (labelMatch) {
        entries.push({ type: 'question-label', questionId, text: labelMatch[1].trim() })
      }

      // Check for inline hint
      const hintMatch = withoutItems.match(/<hint>([^<]+)<\/hint>/)
      if (hintMatch) {
        entries.push({ type: 'question-hint', questionId, text: hintMatch[1].trim() })
      }

      // Check for inline item labels
      const itemRegex = /<item>\s*<label>([^<]+)<\/label>\s*<value>([^<]+)<\/value>\s*<\/item>/g
      let itemMatch
      while ((itemMatch = itemRegex.exec(blockContent)) !== null) {
        entries.push({
          type: 'item-label',
          questionId,
          text: itemMatch[1].trim(),
          itemValue: itemMatch[2].trim()
        })
      }
    }

    // Also handle <group> labels
    const groupRegex = /<group[^>]*ref="\/data\/([^"]+)"[^>]*>[\s\S]*?<label>([^<]+)<\/label>/g
    while ((match = groupRegex.exec(body)) !== null) {
      entries.push({ type: 'question-label', questionId: match[1], text: match[2].trim() })
    }

    return entries
  }

  private replaceQuestionLabel(body: string, questionId: string, text: string, itextId: string): string {
    // Replace <label>Text</label> that directly follows ref="/data/questionId"
    // We need to be careful not to replace item labels
    const escapedText = this.escapeRegex(text)
    // Match the question opening tag and its label
    const pattern = new RegExp(
      `((?:input|select1?|trigger|upload)\\s+ref="/data/${this.escapeRegex(questionId)}"[^>]*>[\\s\\S]*?)<label>${escapedText}</label>`,
    )
    const replaced = body.replace(pattern, `$1<label ref="jr:itext('${itextId}')"/>`)
    if (replaced !== body) return replaced

    // Fallback: simple replacement of the first occurrence in question context
    return body.replace(`<label>${text}</label>`, `<label ref="jr:itext('${itextId}')"/>`)
  }

  private replaceItemLabel(body: string, text: string, value: string, itextId: string): string {
    // Replace <item><label>Text</label><value>val</value></item>
    const escapedText = this.escapeRegex(text)
    const escapedValue = this.escapeRegex(value)
    const pattern = new RegExp(
      `<item>\\s*<label>${escapedText}</label>\\s*<value>${escapedValue}</value>\\s*</item>`
    )
    return body.replace(pattern, `<item>\n        <label ref="jr:itext('${itextId}')"/>\n        <value>${value}</value>\n      </item>`)
  }

  // -------------------------------------------------------------------
  // 2. Reserved property name fixer
  // -------------------------------------------------------------------

  private fixReservedProperties(path: string, xml: string): { xml: string; changed: boolean; applied: string[] } {
    const applied: string[] = []
    let result = xml
    let changed = false

    // Find update properties that use reserved names
    const updateBlocks = xml.match(/<update>([\s\S]*?)<\/update>/g)
    if (!updateBlocks) return { xml, changed: false, applied }

    for (const block of updateBlocks) {
      const childTags = [...block.matchAll(/<(\w+)\s*\/?>/g)]
      for (const tagMatch of childTags) {
        const prop = tagMatch[1]
        if (prop === 'update') continue
        if (RESERVED_CASE_PROPERTIES.has(prop.toLowerCase())) {
          const newName = RESERVED_RENAME_MAP[prop.toLowerCase()] || `${prop}_value`
          // Replace in instance data
          result = result.replace(new RegExp(`(<update>[\\s\\S]*?)<${prop}\\s*/?>`, 'g'), `$1<${newName}/>`)
          result = result.replace(new RegExp(`</${prop}>`, 'g'), `</${newName}>`)
          // Replace in binds
          result = result.replace(
            new RegExp(`nodeset="/data/case/update/${prop}"`, 'g'),
            `nodeset="/data/case/update/${newName}"`
          )
          applied.push(`${path}: Renamed reserved case property "${prop}" to "${newName}"`)
          changed = true
        }
      }
    }

    return { xml: result, changed, applied }
  }

  // -------------------------------------------------------------------
  // 3. Missing case create bind fixer
  // -------------------------------------------------------------------

  private fixMissingCreateBinds(path: string, xml: string): { xml: string; changed: boolean; applied: string[] } {
    const applied: string[] = []
    let result = xml
    let changed = false

    const createBlocks = xml.match(/<create>([\s\S]*?)<\/create>/g)
    if (!createBlocks) return { xml, changed: false, applied }

    // Check for missing case_type bind
    if (!(/nodeset="\/data\/case\/create\/case_type"\s+calculate=/.test(xml))) {
      // Try to infer case type from context
      const caseType = this.inferCaseType(xml) || 'case'
      if (this.isValidCaseType(caseType)) {
        const bind = `\n      <bind nodeset="/data/case/create/case_type" calculate="'${caseType}'"/>`
        result = this.insertBindBefore(result, bind)
        applied.push(`${path}: Added missing case_type calculate bind`)
        changed = true
      }
    }

    // Check for missing case_name bind
    if (!(/nodeset="\/data\/case\/create\/case_name"\s+calculate=/.test(xml))) {
      // Use the first question as case name
      const firstQuestion = this.findFirstQuestion(xml)
      if (firstQuestion && this.isValidPropertyName(firstQuestion)) {
        const bind = `\n      <bind nodeset="/data/case/create/case_name" calculate="/data/${firstQuestion}"/>`
        result = this.insertBindBefore(result, bind)
        applied.push(`${path}: Added missing case_name calculate bind (using /data/${firstQuestion})`)
        changed = true
      }
    }

    // Check for missing owner_id bind
    if (!(/nodeset="\/data\/case\/create\/owner_id"\s+calculate=/.test(xml))) {
      const bind = `\n      <bind nodeset="/data/case/create/owner_id" calculate="instance('commcaresession')/session/context/userid"/>`
      result = this.insertBindBefore(result, bind)
      applied.push(`${path}: Added missing owner_id calculate bind`)
      changed = true
    }

    return { xml: result, changed, applied }
  }

  // -------------------------------------------------------------------
  // 4. Missing case update bind fixer
  // -------------------------------------------------------------------

  private fixMissingUpdateBinds(path: string, xml: string): { xml: string; changed: boolean; applied: string[] } {
    const applied: string[] = []
    let result = xml
    let changed = false

    const updateBlocks = xml.match(/<update>([\s\S]*?)<\/update>/g)
    if (!updateBlocks) return { xml, changed: false, applied }

    for (const block of updateBlocks) {
      const childTags = [...block.matchAll(/<(\w+)\s*\/?>/g)]
      for (const tagMatch of childTags) {
        const prop = tagMatch[1]
        if (prop === 'update') continue

        if (!this.isValidPropertyName(prop)) continue
        const bindPattern = new RegExp(`nodeset="/data/case/update/${prop}"\\s+calculate=`)
        if (!bindPattern.test(result)) {
          // Try to find a matching question in the instance data
          const questionExists = result.includes(`<${prop}/>`) || result.includes(`<${prop}>`)
          const calcValue = questionExists ? `/data/${prop}` : `''`
          const bind = `\n      <bind nodeset="/data/case/update/${prop}" calculate="${calcValue}"/>`
          result = this.insertBindBefore(result, bind)
          applied.push(`${path}: Added missing calculate bind for case update property "${prop}"`)
          changed = true
        }
      }
    }

    return { xml: result, changed, applied }
  }

  // -------------------------------------------------------------------
  // 5. app_strings.txt fixer
  // -------------------------------------------------------------------

  private fixAppStrings(suiteXml: string, appStrings: string): { content: string; applied: string[] } {
    const applied: string[] = []
    const existingKeys = new Set(
      appStrings.split('\n')
        .map(line => line.split('=')[0]?.trim())
        .filter(k => k)
    )

    const localeIds = [...suiteXml.matchAll(/<locale\s+id="([^"]+)"/g)].map(m => m[1])
    const missing: string[] = []

    for (const id of localeIds) {
      if (!existingKeys.has(id)) {
        missing.push(id)
      }
    }

    if (missing.length === 0) return { content: appStrings, applied }

    let result = appStrings.trimEnd()
    for (const id of missing) {
      const value = this.idToLabel(id)
      result += `\n${id}=${value}`
    }

    applied.push(`Added ${missing.length} missing key(s) to app_strings.txt: ${missing.join(', ')}`)
    return { content: result, applied }
  }

  // -------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  /** Check if a string is a valid CommCare case type identifier */
  private isValidCaseType(ct: string): boolean {
    return /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(ct)
  }

  /** Check if a string is a valid XForm data path */
  private isValidXFormPath(p: string): boolean {
    return /^\/data\/[a-zA-Z0-9_/]+$/.test(p)
  }

  /** Check if a string is a valid XML element / case property name */
  private isValidPropertyName(name: string): boolean {
    return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)
  }

  private escapeXml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  /** Convert an itext ID to a human-readable label. e.g. "patient_name-label" -> "Patient Name" */
  private idToLabel(id: string): string {
    return id
      .replace(/-label$/, '')
      .replace(/-hint$/, '')
      .replace(/^forms\.m(\d+)f(\d+)$/, 'Form $2')
      .replace(/^modules\.m(\d+)$/, 'Module $1')
      .replace(/^app\.name$/, 'App')
      .replace(/^case_list_title$/, 'Cases')
      .replace(/^case_name_header$/, 'Name')
      .replace(/[._-]/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase())
      .trim()
  }

  /** Insert a bind element before </model> or before <itext> if present */
  private insertBindBefore(xml: string, bind: string): string {
    if (xml.includes('<itext>')) {
      return xml.replace('<itext>', `${bind}\n      <itext>`)
    }
    return xml.replace('</model>', `${bind}\n    </model>`)
  }

  /** Find the first question element in the instance data */
  private findFirstQuestion(xml: string): string | null {
    const instanceMatch = xml.match(/<instance>\s*<data[^>]*>([\s\S]*?)<\/data>\s*<\/instance>/)
    if (!instanceMatch) return null

    const content = instanceMatch[1]
    // Find first self-closing element that isn't <case> or inside <case>
    const beforeCase = content.split('<case>')[0] || content
    const match = beforeCase.match(/<(\w+)\s*\/>/)
    return match ? match[1] : null
  }

  /** Try to infer case type from existing binds or file path */
  private inferCaseType(xml: string): string | null {
    // Check for existing case_type calculate bind value
    const calcMatch = xml.match(/nodeset="\/data\/case\/create\/case_type"\s+calculate="'([^']+)'"/)
    if (calcMatch) return calcMatch[1]
    // Check for literal case_type content
    const literalMatch = xml.match(/<case_type>([^<]+)<\/case_type>/)
    if (literalMatch) return literalMatch[1].trim()
    return null
  }
}
