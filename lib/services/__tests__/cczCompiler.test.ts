import { describe, it, expect } from 'vitest'
import AdmZip from 'adm-zip'
import { CczCompiler } from '../cczCompiler'
import { expandBlueprint } from '../hqJsonExpander'
import type { AppBlueprint } from '../../schemas/blueprint'

const blueprint: AppBlueprint = {
  app_name: 'CHW App',
  modules: [{
    name: 'Patients',
    case_type: 'patient',
    forms: [
      {
        name: 'Register', type: 'registration',
        case_name_field: 'name',
        case_properties: [{ case_property: 'age', question_id: 'age' }],
        questions: [
          { id: 'name', type: 'text', label: 'Name', is_case_name: true },
          { id: 'age', type: 'int', label: 'Age' },
        ],
      },
      {
        name: 'Visit', type: 'followup',
        case_properties: [{ case_property: 'total_visits', question_id: 'visit_count' }],
        case_preload: [{ question_id: 'visit_count', case_property: 'total_visits' }],
        questions: [
          { id: 'visit_count', type: 'hidden', label: 'Visits', calculate: '#case/total_visits + 1' },
          { id: 'notes', type: 'text', label: 'Notes' },
        ],
      },
    ],
    case_list_columns: [{ field: 'age', header: 'Age' }],
  }],
}

describe('CczCompiler', () => {
  it('produces a valid zip with expected files', async () => {
    const hq = expandBlueprint(blueprint)
    const buf = await new CczCompiler().compile(hq, 'CHW App')
    const zip = new AdmZip(buf)
    const entries = zip.getEntries().map(e => e.entryName).sort()

    expect(entries).toContain('suite.xml')
    expect(entries).toContain('profile.ccpr')
    expect(entries).toContain('default/app_strings.txt')
    // One XForm per form
    expect(entries.filter(e => e.match(/modules-\d+\/forms-\d+\.xml/))).toHaveLength(2)
  })

  it('injects case create block into registration XForms', async () => {
    const hq = expandBlueprint(blueprint)
    const buf = await new CczCompiler().compile(hq, 'CHW App')
    const zip = new AdmZip(buf)
    const regXform = zip.readAsText('modules-0/forms-0.xml')

    expect(regXform).toContain('<create>')
    expect(regXform).toContain('<case_type/>')
    expect(regXform).toContain('<case_name/>')
    expect(regXform).toContain("calculate=\"'patient'\"") // case type bind
  })

  it('injects case update block into followup XForms', async () => {
    const hq = expandBlueprint(blueprint)
    const buf = await new CczCompiler().compile(hq, 'CHW App')
    const zip = new AdmZip(buf)
    const followupXform = zip.readAsText('modules-0/forms-1.xml')

    expect(followupXform).toContain('<update>')
    expect(followupXform).toContain('<total_visits/>')
    expect(followupXform).not.toContain('<create>') // followup should not create
  })

  it('generates suite.xml with case detail and menu entries', async () => {
    const hq = expandBlueprint(blueprint)
    const buf = await new CczCompiler().compile(hq, 'CHW App')
    const zip = new AdmZip(buf)
    const suite = zip.readAsText('suite.xml')

    expect(suite).toContain('<menu id="m0">')
    expect(suite).toContain('<command id="m0-f0"/>')
    expect(suite).toContain('<command id="m0-f1"/>')
    expect(suite).toContain('<detail id="m0_case_short">')
    expect(suite).toContain("@case_type='patient'")
  })
})
