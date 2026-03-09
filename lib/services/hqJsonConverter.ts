import { randomBytes } from 'crypto'

/**
 * Converts CommCare XML app files into HQ import JSON format.
 * Replaces the Claude API call — pure code, executes instantly.
 */
export class HqJsonConverter {
  convert(files: Record<string, string>, appName: string): Record<string, any> {
    const modules = this.extractModules(files)
    const attachments = this.buildAttachments(files)

    return {
      doc_type: 'Application',
      application_version: '2.0',
      name: appName,
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

  private extractModules(files: Record<string, string>): any[] {
    const suiteXml = files['suite.xml'] || ''
    const appStrings = files['default/app_strings.txt'] || ''
    const strings = this.parseAppStrings(appStrings)

    // Parse menus from suite.xml
    const menuPattern = /<menu\s+id="([^"]*)"[^>]*>([\s\S]*?)<\/menu>/g
    const entryPattern = /<entry>([\s\S]*?)<\/entry>/g
    const modules: any[] = []

    const menus = [...suiteXml.matchAll(menuPattern)]
    const entries = [...suiteXml.matchAll(entryPattern)]

    // Build a map of command ID -> entry content
    const entryMap = new Map<string, string>()
    for (const entry of entries) {
      const cmdMatch = entry[1].match(/<command\s+id="([^"]*)"/)
      if (cmdMatch) {
        entryMap.set(cmdMatch[1], entry[1])
      }
    }

    for (let mIdx = 0; mIdx < menus.length; mIdx++) {
      const menu = menus[mIdx]
      const menuId = menu[1]
      const menuBody = menu[2]

      // Module name from locale
      const textMatch = menuBody.match(/<text>\s*<locale\s+id="([^"]*)"\s*\/>/)
      const moduleName = textMatch ? (strings[textMatch[1]] || textMatch[1]) : `Module ${mIdx}`

      // Find commands in this menu
      const commands = [...menuBody.matchAll(/<command\s+id="([^"]*)"\s*\/>/g)]
      const forms: any[] = []
      let caseType = ''

      for (let fIdx = 0; fIdx < commands.length; fIdx++) {
        const cmdId = commands[fIdx][1]
        const entryContent = entryMap.get(cmdId) || ''

        // Find which XForm file this entry references
        const formMatch = entryContent.match(/<form>(.*?)<\/form>/)
        const xmlns = formMatch ? formMatch[1] : ''

        // Find the actual XForm file by xmlns
        const xformFile = this.findXFormByXmlns(files, xmlns)
        const xformContent = xformFile ? files[xformFile] : ''

        // Extract form name from locale
        const formTextMatch = entryContent.match(/<text>\s*<locale\s+id="([^"]*)"\s*\/>/)
        const formName = formTextMatch ? (strings[formTextMatch[1]] || formTextMatch[1]) : `Form ${fIdx}`

        // Parse case info from XForm
        const caseInfo = this.parseCaseInfo(xformContent)
        if (caseInfo.caseType) caseType = caseInfo.caseType

        const uniqueId = randomBytes(20).toString('hex')
        const form = this.buildFormJson(uniqueId, formName, xmlns, caseInfo)
        forms.push(form)
      }

      const moduleId = randomBytes(20).toString('hex')
      modules.push(this.buildModuleJson(moduleId, moduleName, caseType, forms, files))
    }

    return modules
  }

  private buildAttachments(files: Record<string, string>): Record<string, string> {
    const attachments: Record<string, string> = {}

    for (const [path, content] of Object.entries(files)) {
      if (!path.endsWith('.xml') || path === 'suite.xml' || path === 'media_suite.xml' || path === 'profile.ccpr') continue
      // Only include XForm files (modules-N/forms-N.xml pattern)
      if (!path.match(/modules-\d+\/forms-\d+\.xml/)) continue

      const cleaned = this.stripCaseBlocks(content)
      // Use a unique ID as the key (same pattern as HQ)
      const formId = randomBytes(20).toString('hex')
      attachments[`${formId}.xml`] = cleaned
    }

    return attachments
  }

  private stripCaseBlocks(xml: string): string {
    let cleaned = xml.replace(/\s*<case[\s>][\s\S]*?<\/case>/g, '')
    cleaned = cleaned.replace(/\s*<bind\s+[^>]*nodeset="\/data\/case\/[^"]*"[^>]*\/>/g, '')
    return cleaned
  }

  private parseCaseInfo(xform: string): {
    caseType: string
    hasCreate: boolean
    hasUpdate: boolean
    caseNamePath: string
    createProps: Record<string, string>
    updateProps: Record<string, string>
  } {
    const result = {
      caseType: '',
      hasCreate: false,
      hasUpdate: false,
      caseNamePath: '',
      createProps: {} as Record<string, string>,
      updateProps: {} as Record<string, string>
    }

    // Check for create block
    const createMatch = xform.match(/<create>([\s\S]*?)<\/create>/)
    if (createMatch) {
      result.hasCreate = true

      // Get case_type from bind
      const caseTypeBind = xform.match(/<bind[^>]*nodeset="\/data\/case\/create\/case_type"[^>]*calculate="'([^']*)'"/);
      if (caseTypeBind) result.caseType = caseTypeBind[1]
      // Fallback: look inside create block
      if (!result.caseType) {
        const ctMatch = createMatch[1].match(/<case_type\/>/)
        if (ctMatch) {
          const ctBind = xform.match(/<bind[^>]*nodeset="\/data\/case\/create\/case_type"[^>]*calculate="'?([^'"]*)'?"/)
          if (ctBind) result.caseType = ctBind[1]
        }
      }

      // Get case_name path
      const caseNameBind = xform.match(/<bind[^>]*nodeset="\/data\/case\/create\/case_name"[^>]*calculate="([^"]*)"/)
      if (caseNameBind) result.caseNamePath = caseNameBind[1]
    }

    // Check for update block
    const updateMatch = xform.match(/<update>([\s\S]*?)<\/update>/)
    if (updateMatch) {
      result.hasUpdate = true

      // Extract update property binds
      const updateBinds = [...xform.matchAll(/<bind[^>]*nodeset="\/data\/case\/update\/([^"]*)"[^>]*calculate="([^"]*)"[^>]*\/>/g)]
      for (const bind of updateBinds) {
        result.updateProps[bind[1]] = bind[2]
      }
    }

    // If no case_name path found, try first question
    if (result.hasCreate && !result.caseNamePath) {
      const firstInput = xform.match(/<(?:input|select1?)\s+ref="(\/data\/[^"]*)"/)
      if (firstInput) result.caseNamePath = firstInput[1]
    }

    return result
  }

  private buildFormJson(uniqueId: string, name: string, xmlns: string, caseInfo: ReturnType<typeof this.parseCaseInfo>): any {
    const neverCondition = { type: 'never', question: null, answer: null, operator: null, doc_type: 'FormActionCondition' }
    const alwaysCondition = { type: 'always', question: null, answer: null, operator: null, doc_type: 'FormActionCondition' }
    const neverAction = { doc_type: 'FormAction', condition: neverCondition }
    const neverPreload = { doc_type: 'PreloadAction', preload: {}, condition: neverCondition }
    const neverUpdate = { doc_type: 'UpdateCaseAction', update: {}, condition: neverCondition }

    // Build update_case.update map (exclude the case_name field to avoid duplication)
    const updateMap: Record<string, any> = {}
    for (const [prop, path] of Object.entries(caseInfo.updateProps)) {
      // Skip if this is the same field used for case_name
      if (caseInfo.caseNamePath && path === caseInfo.caseNamePath) continue
      updateMap[prop] = { question_path: path, update_mode: 'always' }
    }

    // Build case_preload for follow-up forms
    const preloadMap: Record<string, string> = {}
    if (!caseInfo.hasCreate && caseInfo.hasUpdate) {
      for (const [prop, path] of Object.entries(caseInfo.updateProps)) {
        preloadMap[path] = prop
      }
    }

    const isRegistration = caseInfo.hasCreate

    return {
      doc_type: 'Form',
      form_type: 'module_form',
      unique_id: uniqueId,
      name: { en: name },
      xmlns,
      requires: isRegistration ? 'none' : 'case',
      version: null,
      actions: {
        doc_type: 'FormActions',
        open_case: {
          doc_type: 'OpenCaseAction',
          name_update: isRegistration && caseInfo.caseNamePath
            ? { question_path: caseInfo.caseNamePath }
            : { question_path: '' },
          external_id: null,
          condition: isRegistration ? alwaysCondition : neverCondition
        },
        update_case: {
          doc_type: 'UpdateCaseAction',
          update: updateMap,
          condition: (isRegistration && Object.keys(updateMap).length > 0) || caseInfo.hasUpdate
            ? alwaysCondition
            : neverCondition
        },
        close_case: neverAction,
        case_preload: {
          doc_type: 'PreloadAction',
          preload: preloadMap,
          condition: Object.keys(preloadMap).length > 0 ? alwaysCondition : neverCondition
        },
        subcases: [],
        usercase_preload: neverPreload,
        usercase_update: neverUpdate,
        load_from_form: neverPreload
      },
      case_references_data: { load: {}, save: {}, doc_type: 'CaseReferences' },
      form_filter: null,
      post_form_workflow: 'default',
      no_vellum: false,
      media_image: {}, media_audio: {}, custom_icons: [],
      custom_assertions: [], custom_instances: [], form_links: [],
      comment: ''
    }
  }

  private buildModuleJson(moduleId: string, name: string, caseType: string, forms: any[], files: Record<string, string>): any {
    // Build case detail columns from update properties
    const columns = this.buildCaseColumns(files, caseType)

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
      doc_type: 'Module',
      module_type: 'basic',
      unique_id: moduleId,
      name: { en: name },
      case_type: caseType || '',
      put_in_root: false,
      root_module_id: null,
      forms,
      case_details: {
        doc_type: 'DetailPair',
        short: {
          doc_type: 'Detail', display: 'short',
          columns,
          ...detailBase
        },
        long: {
          doc_type: 'Detail', display: 'long',
          columns: [],
          ...detailBase
        }
      },
      case_list: { doc_type: 'CaseList', show: false, label: {}, media_image: {}, media_audio: {}, custom_icons: [] },
      case_list_form: { doc_type: 'CaseListForm', form_id: null, label: {} },
      search_config: { doc_type: 'CaseSearch', properties: [], default_properties: [], include_closed: false },
      display_style: 'list',
      media_image: {}, media_audio: {}, custom_icons: [],
      is_training_module: false, module_filter: null, auto_select_case: false,
      parent_select: { active: false, module_id: null },
      comment: ''
    }
  }

  private buildCaseColumns(files: Record<string, string>, caseType: string): any[] {
    // Collect all case properties from all XForms with matching case type
    const props = new Set<string>()
    for (const [path, content] of Object.entries(files)) {
      if (!path.endsWith('.xml')) continue
      const updateBinds = [...content.matchAll(/<bind[^>]*nodeset="\/data\/case\/update\/([^"]*)"[^>]*\/>/g)]
      for (const bind of updateBinds) {
        const prop = bind[1]
        if (prop !== 'name' && prop !== 'case_name') {
          props.add(prop)
        }
      }
    }

    return [...props].map(field => ({
      doc_type: 'DetailColumn',
      header: { en: this.humanize(field) },
      field,
      model: 'case',
      format: 'plain',
      calc_xpath: '.',
      filter_xpath: '',
      advanced: '',
      late_flag: 30,
      time_ago_interval: 365.25,
      useXpathExpression: false,
      hasNodeset: false,
      hasAutocomplete: false,
      isTab: false,
      enum: [],
      graph_configuration: null,
      relevant: '',
      case_tile_field: null,
      nodeset: ''
    }))
  }

  private findXFormByXmlns(files: Record<string, string>, xmlns: string): string | null {
    for (const [path, content] of Object.entries(files)) {
      if (!path.endsWith('.xml')) continue
      const dataMatch = content.match(/<data[^>]*xmlns="([^"]*)"/)
      if (dataMatch && dataMatch[1] === xmlns) return path
    }
    return null
  }

  private parseAppStrings(content: string): Record<string, string> {
    const result: Record<string, string> = {}
    for (const line of content.split('\n')) {
      const eq = line.indexOf('=')
      if (eq > 0) {
        result[line.substring(0, eq).trim()] = line.substring(eq + 1).trim()
      }
    }
    return result
  }

  private humanize(field: string): string {
    return field.replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  }
}
