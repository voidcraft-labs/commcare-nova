import type { ValidationResult } from '../types'

// Reserved case property names from CommCare HQ
// Source: commcare-hq/corehq/apps/app_manager/static/app_manager/json/case-reserved-words.json
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

// HQ regex for valid case property names
const CASE_PROPERTY_REGEX = /^[a-zA-Z][\w_-]*$/
// HQ regex for valid case type names
const CASE_TYPE_REGEX = /^[\w-]+$/
// Standard create block properties (not case properties)
const STANDARD_CREATE_PROPS = new Set(['case_type', 'case_name', 'owner_id'])

export class HqValidator {
  /**
   * Validates generated files for HQ-specific and Formplayer-specific issues
   * that the CLI doesn't catch. Checks individual XForm files and cross-file consistency.
   */
  validate(files: Record<string, string>): ValidationResult {
    const errors: string[] = []

    // Per-XForm checks
    const xformXmlns: Map<string, string> = new Map() // xmlns -> filePath
    for (const [filePath, content] of Object.entries(files)) {
      if (!filePath.endsWith('.xml') || filePath === 'suite.xml' || filePath === 'media_suite.xml') continue
      if (filePath.endsWith('.ccpr')) continue

      const formErrors = this.checkXForm(filePath, content)
      errors.push(...formErrors)

      // Collect xmlns for uniqueness check
      const xmlns = this.extractXmlns(content)
      if (xmlns) {
        if (xformXmlns.has(xmlns)) {
          errors.push(`Duplicate xmlns "${xmlns}" in ${filePath} and ${xformXmlns.get(xmlns)}. Each form must have a unique xmlns.`)
        } else {
          xformXmlns.set(xmlns, filePath)
        }
      }
    }

    // Cross-file checks
    const crossFileErrors = this.checkCrossFile(files, xformXmlns)
    errors.push(...crossFileErrors)

    return {
      success: errors.length === 0,
      skipped: false,
      errors,
      stdout: '',
      stderr: ''
    }
  }

  private checkXForm(filePath: string, content: string): string[] {
    const errors: string[] = []

    // A. itext / Localization (CRITICAL — Formplayer crashes without this)
    const itextErrors = this.checkItext(filePath, content)
    errors.push(...itextErrors)

    // B. Reserved property names
    const caseUpdateProps = this.extractCaseUpdateProperties(content)
    for (const prop of caseUpdateProps) {
      if (RESERVED_CASE_PROPERTIES.has(prop.toLowerCase())) {
        errors.push(`Reserved case property "${prop}" in ${filePath}. HQ will reject this. Rename to something like "${prop}_value" or "${prop}_info".`)
      }
    }

    // C. Case property name format
    for (const prop of caseUpdateProps) {
      if (!CASE_PROPERTY_REGEX.test(prop)) {
        errors.push(`Invalid case property name "${prop}" in ${filePath}. Must start with a letter and contain only letters, digits, underscores, or hyphens.`)
      }
    }

    // D. Case type format
    const caseTypes = this.extractCaseTypes(content)
    for (const ct of caseTypes) {
      if (!CASE_TYPE_REGEX.test(ct)) {
        errors.push(`Invalid case type "${ct}" in ${filePath}. Case types can only contain letters, digits, underscores, and hyphens.`)
      }
    }

    // E. Case create block validation
    const createErrors = this.checkCaseCreateBlocks(filePath, content)
    errors.push(...createErrors)

    // F. Case update bind validation
    const updateBindErrors = this.checkCaseUpdateBinds(filePath, content)
    errors.push(...updateBindErrors)

    // G. Bind-instance consistency
    const bindErrors = this.checkBinds(filePath, content)
    errors.push(...bindErrors)

    return errors
  }

  // --- itext validation ---

  private checkItext(filePath: string, content: string): string[] {
    const errors: string[] = []

    // Check for <model> presence
    if (!content.includes('<model>') && !content.includes('<model ')) {
      return errors // Not an XForm
    }

    // 1. Must have an <itext> block
    const hasItext = content.includes('<itext>') || content.includes('<itext ')
    if (!hasItext) {
      errors.push(`XForm ${filePath} is missing <itext> block. Formplayer (Web Apps) REQUIRES itext localization. Add an <itext> block with <translation lang="en" default=""> inside <model>, and convert all inline labels to jr:itext() references.`)
      // If no itext at all, no point checking further itext details
      return errors
    }

    // 2. Must have at least one <translation> with a lang attribute
    const translationMatch = content.match(/<translation\s+[^>]*lang="([^"]+)"/)
    if (!translationMatch) {
      errors.push(`XForm ${filePath} has <itext> but no <translation lang="..."> element. Add at least one translation (e.g. <translation lang="en" default="">).`)
    }

    // 3. Check for inline labels (should use jr:itext instead)
    const inlineLabels = this.findInlineLabels(content)
    if (inlineLabels.length > 0) {
      const examples = inlineLabels.slice(0, 3).join(', ')
      errors.push(`XForm ${filePath} has ${inlineLabels.length} inline label(s) (${examples}). All labels MUST use ref="jr:itext('...')" instead of inline text. Formplayer requires itext references.`)
    }

    // 4. Check that every jr:itext() reference has a matching <text id="..."> in itext
    const itextRefs = this.extractItextReferences(content)
    const itextIds = this.extractItextDefinitions(content)
    for (const ref of itextRefs) {
      if (!itextIds.has(ref)) {
        errors.push(`XForm ${filePath} references jr:itext('${ref}') but no matching <text id="${ref}"> found in <itext>.`)
      }
    }

    // 5. Check for orphaned itext definitions (IDs defined but never referenced) — warning only, not error
    // Skipping this as it's not a breaking issue

    return errors
  }

  /**
   * Find inline labels in the body section (labels with text content instead of ref attribute).
   * Only checks inside <h:body> to avoid false positives from itext <value> elements.
   */
  private findInlineLabels(content: string): string[] {
    const inlineLabels: string[] = []

    // Extract body section
    const bodyMatch = content.match(/<h:body>([\s\S]*)<\/h:body>/)
    if (!bodyMatch) return inlineLabels

    const body = bodyMatch[1]

    // Find <label> elements that have text content (not ref attribute)
    // Match <label>some text</label> but NOT <label ref="..."/>
    const labelMatches = body.matchAll(/<label>([^<]+)<\/label>/g)
    for (const match of labelMatches) {
      const text = match[1].trim()
      if (text) {
        inlineLabels.push(`<label>${text}</label>`)
      }
    }

    return inlineLabels
  }

  /**
   * Extract all jr:itext('...') references from the body.
   */
  private extractItextReferences(content: string): string[] {
    const refs: string[] = []
    const matches = content.matchAll(/jr:itext\('([^']+)'\)/g)
    for (const m of matches) {
      refs.push(m[1])
    }
    return refs
  }

  /**
   * Extract all <text id="..."> definitions from itext block.
   */
  private extractItextDefinitions(content: string): Set<string> {
    const ids = new Set<string>()
    // Only look inside <itext>...</itext>
    const itextMatch = content.match(/<itext>([\s\S]*?)<\/itext>/)
    if (!itextMatch) return ids

    const itextContent = itextMatch[1]
    const matches = itextContent.matchAll(/<text\s+id="([^"]+)"/g)
    for (const m of matches) {
      ids.add(m[1])
    }
    return ids
  }

  // --- Cross-file validation ---

  /**
   * Cross-file validation: suite.xml <-> XForms <-> app_strings.txt consistency
   */
  private checkCrossFile(files: Record<string, string>, xformXmlns: Map<string, string>): string[] {
    const errors: string[] = []
    const suiteXml = files['suite.xml']
    if (!suiteXml) return errors

    // G1. Suite <form> values must match an XForm xmlns
    const suiteFormValues = this.extractSuiteFormValues(suiteXml)
    for (const formUri of suiteFormValues) {
      if (!xformXmlns.has(formUri)) {
        errors.push(`Suite entry references form xmlns "${formUri}" but no XForm file has this xmlns.`)
      }
    }

    // G2. Every command in a menu must have a matching entry
    const menuCommands = this.extractMenuCommands(suiteXml)
    const entryCommands = this.extractEntryCommands(suiteXml)
    // Menu IDs (like "m0") that reference submenus don't need entries — only leaf commands (like "m0-f0") do
    const menuIds = this.extractMenuIds(suiteXml)
    for (const cmd of menuCommands) {
      if (!entryCommands.has(cmd) && !menuIds.has(cmd)) {
        errors.push(`Suite menu references command "${cmd}" but no <entry> defines this command.`)
      }
    }

    // G3. Every locale ID in suite.xml must have a key in app_strings.txt
    const appStrings = files['default/app_strings.txt'] || ''
    const appStringKeys = new Set(
      appStrings.split('\n')
        .map(line => line.split('=')[0]?.trim())
        .filter(k => k)
    )
    const localeIds = this.extractLocaleIds(suiteXml)
    for (const locId of localeIds) {
      if (!appStringKeys.has(locId)) {
        errors.push(`Suite references locale id "${locId}" but no matching key in app_strings.txt.`)
      }
    }

    // H. detail-select references must match detail definitions
    const detailSelectIds = this.extractDetailSelectIds(suiteXml)
    const detailDefinitionIds = this.extractDetailDefinitionIds(suiteXml)
    for (const dsId of detailSelectIds) {
      if (!detailDefinitionIds.has(dsId)) {
        errors.push(`Entry datum references detail-select="${dsId}" but no <detail id="${dsId}"> exists in suite.xml.`)
      }
    }

    return errors
  }

  // --- XForm extraction helpers ---

  private extractXmlns(content: string): string | null {
    // Match xmlns on the <data> element: <data xmlns="http://..." ...>
    const match = content.match(/<data[^>]*\sxmlns="([^"]+)"/)
    return match ? match[1] : null
  }

  private extractCaseUpdateProperties(content: string): string[] {
    const props: string[] = []

    const updateBlocks = content.match(/<update>([\s\S]*?)<\/update>/g)
    if (updateBlocks) {
      for (const block of updateBlocks) {
        const childTags = block.match(/<(\w+)\s*\/?>/g)
        if (childTags) {
          for (const tag of childTags) {
            const match = tag.match(/<(\w+)/)
            if (match && match[1] !== 'update') {
              props.push(match[1])
            }
          }
        }
      }
    }

    // Extra properties in <create> blocks beyond standard ones
    const createBlocks = content.match(/<create>([\s\S]*?)<\/create>/g)
    if (createBlocks) {
      for (const block of createBlocks) {
        const childTags = block.match(/<(\w+)\s*\/?>/g)
        if (childTags) {
          for (const tag of childTags) {
            const match = tag.match(/<(\w+)/)
            if (match && match[1] !== 'create' && !STANDARD_CREATE_PROPS.has(match[1])) {
              props.push(match[1])
            }
          }
        }
      }
    }

    return props
  }

  private extractCaseTypes(content: string): string[] {
    const types: string[] = []
    // From <case_type> elements with calculate binds
    const calcMatches = content.matchAll(/nodeset="\/data\/case\/create\/case_type"\s+calculate="'([^']+)'"/g)
    for (const m of calcMatches) {
      types.push(m[1])
    }
    // From literal <case_type>value</case_type>
    const literalMatches = content.matchAll(/<case_type>([^<]+)<\/case_type>/g)
    for (const m of literalMatches) {
      types.push(m[1].trim())
    }
    return types
  }

  private checkCaseCreateBlocks(filePath: string, content: string): string[] {
    const errors: string[] = []
    const createBlocks = content.match(/<create>([\s\S]*?)<\/create>/g)
    if (!createBlocks) return errors

    for (const block of createBlocks) {
      // Must have case_type
      if (!block.includes('<case_type')) {
        errors.push(`Case <create> block in ${filePath} is missing <case_type>. Every case must have a type.`)
      }
      // Must have case_name
      if (!block.includes('<case_name')) {
        errors.push(`Case <create> block in ${filePath} is missing <case_name>. Every case must have a name.`)
      }
      // Must have owner_id
      if (!block.includes('<owner_id')) {
        errors.push(`Case <create> block in ${filePath} is missing <owner_id>. Every case must have an owner.`)
      }
    }

    // Verify case_name has a calculate bind
    if (createBlocks.length > 0) {
      const hasNameBind = /nodeset="\/data\/case\/create\/case_name"\s+calculate=/.test(content)
      if (!hasNameBind) {
        errors.push(`Case <create> in ${filePath} has <case_name> but no calculate bind for it. Add: <bind nodeset="/data/case/create/case_name" calculate="..."/>`)
      }
      const hasTypeBind = /nodeset="\/data\/case\/create\/case_type"\s+calculate=/.test(content)
      if (!hasTypeBind) {
        errors.push(`Case <create> in ${filePath} has <case_type> but no calculate bind for it. Add: <bind nodeset="/data/case/create/case_type" calculate="'type_name'"/>`)
      }
      const hasOwnerBind = /nodeset="\/data\/case\/create\/owner_id"\s+calculate=/.test(content)
      if (!hasOwnerBind) {
        errors.push(`Case <create> in ${filePath} has <owner_id> but no calculate bind for it. Add: <bind nodeset="/data/case/create/owner_id" calculate="instance('commcaresession')/session/context/userid"/>`)
      }
    }

    return errors
  }

  private checkCaseUpdateBinds(filePath: string, content: string): string[] {
    const errors: string[] = []
    const updateBlocks = content.match(/<update>([\s\S]*?)<\/update>/g)
    if (!updateBlocks) return errors

    // Extract update property names
    for (const block of updateBlocks) {
      const childTags = block.match(/<(\w+)\s*\/?>/g)
      if (!childTags) continue
      for (const tag of childTags) {
        const match = tag.match(/<(\w+)/)
        if (!match || match[1] === 'update') continue
        const propName = match[1]

        // Check that a bind exists for this property with a calculate
        const bindPattern = new RegExp(`nodeset="/data/case/update/${propName}"\\s+calculate=`)
        if (!bindPattern.test(content)) {
          errors.push(`Case update property "${propName}" in ${filePath} has no calculate bind. Add: <bind nodeset="/data/case/update/${propName}" calculate="..."/>`)
        }
      }
    }

    return errors
  }

  private checkBinds(filePath: string, content: string): string[] {
    const errors: string[] = []

    const instanceMatch = content.match(/<instance>\s*<data[^>]*>([\s\S]*?)<\/data>\s*<\/instance>/)
    if (!instanceMatch) return errors

    const instanceContent = instanceMatch[1]

    const binds = content.matchAll(/nodeset="([^"]+)"/g)
    for (const bind of binds) {
      const nodeset = bind[1]
      if (!nodeset.startsWith('/data/')) continue

      const subPath = nodeset.substring(6)
      const parts = subPath.split('/')
      const leafNode = parts[parts.length - 1]

      if (!instanceContent.includes(`<${leafNode}`) && !instanceContent.includes(`<${leafNode}/>`)) {
        errors.push(`Bind references "${nodeset}" but <${leafNode}> not found in instance data in ${filePath}.`)
      }
    }

    return errors
  }

  // --- Suite.xml extraction helpers ---

  private extractSuiteFormValues(suiteXml: string): string[] {
    const values: string[] = []
    const matches = suiteXml.matchAll(/<entry>[\s\S]*?<form>([^<]+)<\/form>/g)
    for (const m of matches) {
      values.push(m[1].trim())
    }
    return values
  }

  private extractMenuCommands(suiteXml: string): string[] {
    const commands: string[] = []
    const menuBlocks = suiteXml.matchAll(/<menu\s[^>]*>([\s\S]*?)<\/menu>/g)
    for (const block of menuBlocks) {
      const cmdMatches = block[1].matchAll(/<command\s+id="([^"]+)"\s*\/>/g)
      for (const cmd of cmdMatches) {
        commands.push(cmd[1])
      }
    }
    return commands
  }

  private extractEntryCommands(suiteXml: string): Set<string> {
    const commands = new Set<string>()
    const matches = suiteXml.matchAll(/<entry>[\s\S]*?<command\s+id="([^"]+)"/g)
    for (const m of matches) {
      commands.add(m[1])
    }
    return commands
  }

  private extractMenuIds(suiteXml: string): Set<string> {
    const ids = new Set<string>()
    const matches = suiteXml.matchAll(/<menu\s+id="([^"]+)"/g)
    for (const m of matches) {
      ids.add(m[1])
    }
    return ids
  }

  private extractLocaleIds(suiteXml: string): string[] {
    const ids: string[] = []
    const matches = suiteXml.matchAll(/<locale\s+id="([^"]+)"/g)
    for (const m of matches) {
      ids.push(m[1])
    }
    return ids
  }

  private extractDetailSelectIds(suiteXml: string): string[] {
    const ids: string[] = []
    const matches = suiteXml.matchAll(/detail-select="([^"]+)"/g)
    for (const m of matches) {
      ids.push(m[1])
    }
    return ids
  }

  private extractDetailDefinitionIds(suiteXml: string): Set<string> {
    const ids = new Set<string>()
    const matches = suiteXml.matchAll(/<detail\s+id="([^"]+)"/g)
    for (const m of matches) {
      ids.add(m[1])
    }
    return ids
  }
}
