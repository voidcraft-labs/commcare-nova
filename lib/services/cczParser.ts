import AdmZip from 'adm-zip'
import path from 'path'

export interface CczParseResult {
  appName: string
  markdownSummary: string
  files: Record<string, string>
}

interface ParsedModule {
  id: string
  name: string
  forms: { id: string; name: string }[]
}

interface ParsedStructure {
  modules: ParsedModule[]
  caseTypes: string[]
  formDetails: Record<string, string[]>
}

const TEXT_EXTENSIONS = new Set(['.xml', '.ccpr', '.txt', '.properties'])

export class CczParser {
  /**
   * Parse a .ccz archive from either a file path (string) or a Buffer.
   */
  parse(input: Buffer | string): CczParseResult {
    const zip = typeof input === 'string' ? new AdmZip(input) : new AdmZip(input)
    const entries = zip.getEntries()

    const files: Record<string, string> = {}
    for (const entry of entries) {
      if (entry.isDirectory) continue
      // Zip slip prevention: reject entries with path traversal
      const normalized = path.normalize(entry.entryName)
      if (normalized.includes('..') || path.isAbsolute(normalized) || normalized.startsWith('/') || normalized.startsWith('\\')) continue
      const ext = path.extname(entry.entryName).toLowerCase()
      if (TEXT_EXTENSIONS.has(ext) || entry.entryName.includes('app_strings')) {
        files[entry.entryName] = entry.getData().toString('utf-8')
      }
    }

    const appName = this.extractAppName(files)
    const structure = this.extractStructure(files)
    const markdownSummary = this.buildMarkdown(appName, structure, Object.keys(files).length)

    return { appName, markdownSummary, files }
  }

  private extractAppName(files: Record<string, string>): string {
    const profile = files['profile.ccpr'] || files['profile.xml']
    if (profile) {
      const nameMatch = profile.match(/name="([^"]+)"/)
      if (nameMatch) return nameMatch[1]
      const propMatch = profile.match(/key="CommCare App Name"\s+value="([^"]+)"/)
      if (propMatch) return propMatch[1]
    }
    return 'Uploaded App'
  }

  private extractStructure(files: Record<string, string>): ParsedStructure {
    const appStrings = this.parseAppStrings(files['default/app_strings.txt'] || '')
    const suiteXml = files['suite.xml'] || ''

    const modules: ParsedModule[] = []
    const menuRegex = /<menu\s+id="(m\d+)"[^>]*>([\s\S]*?)<\/menu>/g
    let menuMatch: RegExpExecArray | null
    while ((menuMatch = menuRegex.exec(suiteXml)) !== null) {
      const menuId = menuMatch[1]
      const menuContent = menuMatch[2]
      if (menuId === 'root') continue

      const moduleName = this.resolveLocale(menuContent, appStrings)
        || appStrings[`modules.${menuId}`]
        || menuId

      const cmdRefs: string[] = []
      const cmdRegex = /<command\s+id="([^"]+)"\s*\/>/g
      let cmdMatch: RegExpExecArray | null
      while ((cmdMatch = cmdRegex.exec(menuContent)) !== null) {
        cmdRefs.push(cmdMatch[1])
      }

      const forms = cmdRefs.map(cmdId => {
        const formKey = `forms.${cmdId.replace(/-/g, '')}`
        const formName = appStrings[formKey] || appStrings[`forms.${cmdId}`] || cmdId
        return { id: cmdId, name: formName }
      })

      modules.push({ id: menuId, name: moduleName, forms })
    }

    const caseTypes = new Set<string>()
    const caseTypeRegex = /@case_type='([^']+)'/g
    let ctMatch: RegExpExecArray | null
    while ((ctMatch = caseTypeRegex.exec(suiteXml)) !== null) {
      caseTypes.add(ctMatch[1])
    }

    const formDetails: Record<string, string[]> = {}
    for (const [filePath, content] of Object.entries(files)) {
      if (filePath.match(/modules-\d+\/forms-\d+\.xml/)) {
        formDetails[filePath] = this.extractFormFields(content)
      }
    }

    return { modules, caseTypes: Array.from(caseTypes), formDetails }
  }

  private extractFormFields(xformXml: string): string[] {
    const labels: string[] = []
    const labelRegex = /<(?:input|select1?)\s[^>]*>[\s\S]*?<label>([^<]+)<\/label>/g
    let match: RegExpExecArray | null
    while ((match = labelRegex.exec(xformXml)) !== null) {
      labels.push(match[1].trim())
    }
    return labels
  }

  private parseAppStrings(content: string): Record<string, string> {
    const result: Record<string, string> = {}
    for (const line of content.split('\n')) {
      const eqIdx = line.indexOf('=')
      if (eqIdx > 0) {
        result[line.substring(0, eqIdx).trim()] = line.substring(eqIdx + 1).trim()
      }
    }
    return result
  }

  private resolveLocale(xmlFragment: string, appStrings: Record<string, string>): string | null {
    const localeMatch = xmlFragment.match(/<locale\s+id="([^"]+)"/)
    if (localeMatch) {
      return appStrings[localeMatch[1]] || null
    }
    return null
  }

  private buildMarkdown(appName: string, structure: ParsedStructure, fileCount: number): string {
    const lines: string[] = []
    lines.push(`## ${appName}`)
    lines.push('')

    if (structure.modules.length > 0) {
      lines.push('### Modules')
      lines.push('')
      for (const mod of structure.modules) {
        lines.push(`#### ${mod.name}`)
        if (mod.forms.length > 0) {
          lines.push('**Forms:**')
          for (const form of mod.forms) {
            lines.push(`- ${form.name}`)
            const fileKey = this.formIdToFilePath(form.id)
            const fields = structure.formDetails[fileKey]
            if (fields && fields.length > 0) {
              for (const field of fields.slice(0, 10)) {
                lines.push(`  - ${field}`)
              }
              if (fields.length > 10) {
                lines.push(`  - ... and ${fields.length - 10} more fields`)
              }
            }
          }
        }
        lines.push('')
      }
    }

    if (structure.caseTypes.length > 0) {
      lines.push('### Case Types')
      for (const ct of structure.caseTypes) {
        lines.push(`- \`${ct}\``)
      }
      lines.push('')
    }

    lines.push('### Files')
    lines.push(`Total files in archive: ${fileCount}`)

    return lines.join('\n')
  }

  private formIdToFilePath(formId: string): string {
    const match = formId.match(/m(\d+)-f(\d+)/)
    if (match) {
      return `modules-${match[1]}/forms-${match[2]}.xml`
    }
    return ''
  }
}
