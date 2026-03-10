import { describe, it, expect } from 'vitest'
import { expandBlueprint, validateBlueprint } from '../hqJsonExpander'
import type { AppBlueprint } from '../../schemas/blueprint'

/** Minimal followup form with a #case/ calculate — the scenario that broke builds. */
const followupBlueprint: AppBlueprint = {
  app_name: 'Test App',
  modules: [{
    name: 'Visits',
    case_type: 'patient',
    forms: [{
      name: 'Follow-up Visit',
      type: 'followup',
      case_properties: [{ case_property: 'total_visits', question_id: 'visit_number' }],
      case_preload: [{ question_id: 'visit_number', case_property: 'total_visits' }, { question_id: 'display_name', case_property: 'full_name' }],
      questions: [
        { id: 'client_info', type: 'group', label: 'Client Info', children: [
          { id: 'display_name', type: 'text', label: 'Name', readonly: true },
        ]},
        { id: 'visit_number', type: 'hidden', calculate: '#case/total_visits + 1' },
        { id: 'notes', type: 'text', label: 'Notes' },
      ],
    }],
    case_list_columns: [{ field: 'full_name', header: 'Name' }],
  }],
}

/** Registration form with case properties. */
const registrationBlueprint: AppBlueprint = {
  app_name: 'Reg App',
  modules: [{
    name: 'Registration',
    case_type: 'patient',
    forms: [{
      name: 'Register Patient',
      type: 'registration',
      case_name_field: 'full_name',
      case_properties: [{ case_property: 'age', question_id: 'patient_age' }],
      questions: [
        { id: 'full_name', type: 'text', label: 'Full Name', required: true, is_case_name: true },
        { id: 'patient_age', type: 'int', label: 'Age', constraint: '. > 0 and . < 150' },
        { id: 'risk', type: 'hidden', calculate: "if(/data/patient_age > 65, 'high', 'low')" },
      ],
    }],
  }],
}

describe('expandBlueprint', () => {
  it('populates case_references_data.load with #case/ hashtag references', () => {
    const hq = expandBlueprint(followupBlueprint)
    const form = hq.modules[0].forms[0]
    const load = form.case_references_data.load

    expect(load['/data/visit_number']).toEqual(['#case/total_visits'])
    // Questions without hashtags should not appear in load
    expect(load['/data/notes']).toBeUndefined()
  })

  it('leaves case_references_data.load empty when no hashtags exist', () => {
    const hq = expandBlueprint(registrationBlueprint)
    const form = hq.modules[0].forms[0]

    expect(form.case_references_data.load).toEqual({})
  })

  it('resolves nested question paths in case_references_data', () => {
    const bp: AppBlueprint = {
      app_name: 'Nested',
      modules: [{
        name: 'M', case_type: 'case', forms: [{
          name: 'F', type: 'followup',
          case_preload: [{ question_id: 'nested_q', case_property: 'some_prop' }],
          questions: [{
            id: 'grp', type: 'group', label: 'G', children: [
              { id: 'nested_q', type: 'hidden', calculate: '#case/some_prop + #user/role' },
            ],
          }],
        }],
      }],
    }
    const load = expandBlueprint(bp).modules[0].forms[0].case_references_data.load
    expect(load['/data/grp/nested_q']).toEqual(expect.arrayContaining(['#case/some_prop', '#user/role']))
  })

  it('expands #case/ to full XPath in calculate, keeps shorthand in vellum:calculate', () => {
    const hq = expandBlueprint(followupBlueprint)
    const xform: string = Object.values(hq._attachments)[0] as string

    // Real calculate should have the expanded instance() XPath
    expect(xform).toContain(
      "calculate=\"instance(&apos;casedb&apos;)/casedb/case[@case_id = instance(&apos;commcaresession&apos;)/session/data/case_id]/total_visits + 1\""
    )
    // Vellum calculate preserves the shorthand for the editor
    expect(xform).toContain('vellum:calculate="#case/total_visits + 1"')
    // Hashtag metadata still present
    expect(xform).toContain('vellum:hashtags=')
    expect(xform).toContain('vellum:hashtagTransforms=')
  })

  it('wires registration form actions correctly', () => {
    const hq = expandBlueprint(registrationBlueprint)
    const actions = hq.modules[0].forms[0].actions

    expect(actions.open_case.condition.type).toBe('always')
    expect(actions.open_case.name_update.question_path).toBe('/data/full_name')
    expect(actions.update_case.update.age.question_path).toBe('/data/patient_age')
  })

  it('wires followup preload and update actions correctly', () => {
    const hq = expandBlueprint(followupBlueprint)
    const actions = hq.modules[0].forms[0].actions

    expect(actions.open_case.condition.type).toBe('never')
    expect(actions.case_preload.condition.type).toBe('always')
    expect(actions.case_preload.preload['/data/visit_number']).toBe('total_visits')
    // Nested question paths should be resolved
    expect(actions.case_preload.preload['/data/client_info/display_name']).toBe('full_name')
    expect(actions.update_case.update.total_visits.question_path).toBe('/data/visit_number')
  })

  it('generates XForm with setvalue for default_value', () => {
    const bp: AppBlueprint = {
      app_name: 'DV', modules: [{
        name: 'M', forms: [{
          name: 'F', type: 'survey',
          questions: [{ id: 'status', type: 'hidden', default_value: "'pending'" }],
        }],
      }],
    }
    const hq = expandBlueprint(bp)
    const xform: string = Object.values(hq._attachments)[0] as string
    expect(xform).toContain('<setvalue event="xforms-ready" ref="/data/status"')
    expect(xform).toContain("value=\"&apos;pending&apos;\"")
    // No vellum:value when there are no hashtags
    expect(xform).not.toContain('vellum:value=')
  })

  it('expands #case/ in setvalue default_value, keeps shorthand in vellum:value', () => {
    const bp: AppBlueprint = {
      app_name: 'DV', modules: [{
        name: 'M', case_type: 'c', forms: [{
          name: 'F', type: 'followup',
          case_preload: [{ question_id: 'display_name', case_property: 'full_name' }],
          questions: [{ id: 'display_name', type: 'text', label: 'Name', readonly: true, default_value: '#case/full_name' }],
        }],
      }],
    }
    const hq = expandBlueprint(bp)
    const xform: string = Object.values(hq._attachments)[0] as string
    // Real value attribute should have expanded XPath (XML-escaped)
    expect(xform).toContain("instance(&apos;casedb&apos;)")
    expect(xform).toContain('/full_name"')
    // Vellum value preserves shorthand
    expect(xform).toContain('vellum:value="#case/full_name"')
  })

  it('omits itext label for hidden questions without a label', () => {
    const hq = expandBlueprint(followupBlueprint)
    const xform: string = Object.values(hq._attachments)[0] as string
    // Hidden question 'visit_number' has no label — should not get an itext entry
    expect(xform).not.toContain("id=\"visit_number-label\"")
    // Visible question 'notes' should still get one
    expect(xform).toContain("id=\"notes-label\"")
  })

  it('handles close_case — conditional and unconditional', () => {
    const bp: AppBlueprint = {
      app_name: 'Close', modules: [{
        name: 'M', case_type: 'case', forms: [
          {
            name: 'Conditional Close', type: 'followup',
            close_case: { question: 'confirm', answer: 'yes' },
            questions: [
              { id: 'confirm', type: 'select1', label: 'Close?', options: [
                { value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' },
              ]},
            ],
          },
          {
            name: 'Always Close', type: 'followup',
            close_case: {},
            questions: [{ id: 'note', type: 'text', label: 'Note' }],
          },
        ],
      }],
    }
    const hq = expandBlueprint(bp)
    expect(hq.modules[0].forms[0].actions.close_case.condition.type).toBe('if')
    expect(hq.modules[0].forms[0].actions.close_case.condition.answer).toBe('yes')
    expect(hq.modules[0].forms[1].actions.close_case.condition.type).toBe('always')
  })
})

describe('case_name in case list columns', () => {
  const bp: AppBlueprint = {
    app_name: 'CL', modules: [{
      name: 'M', case_type: 'patient', forms: [{
        name: 'F', type: 'registration', case_name_field: 'q',
        questions: [{ id: 'q', type: 'text', label: 'Name', is_case_name: true }],
      }],
      case_list_columns: [{ field: 'case_name', header: 'Full Name' }, { field: 'age', header: 'Age' }],
    }],
  }

  it('expander keeps case_name column in case details', () => {
    const hq = expandBlueprint(bp)
    const cols = hq.modules[0].case_details.short.columns
    expect(cols.some((c: any) => c.field === 'case_name')).toBe(true)
  })

  it('validator allows case_name in case_list_columns', () => {
    expect(validateBlueprint(bp).some(e => e.includes('case_name'))).toBe(false)
  })
})

describe('validateBlueprint', () => {
  it('passes for a valid blueprint', () => {
    expect(validateBlueprint(registrationBlueprint)).toEqual([])
  })

  it('catches missing case_type on case forms', () => {
    const bp: AppBlueprint = {
      app_name: 'Bad', modules: [{
        name: 'M', forms: [{
          name: 'F', type: 'registration', case_name_field: 'q',
          questions: [{ id: 'q', type: 'text', label: 'Q' }],
        }],
      }],
    }
    const errors = validateBlueprint(bp)
    expect(errors.some(e => e.includes('case_type'))).toBe(true)
  })

  it('catches reserved case property names', () => {
    const bp: AppBlueprint = {
      app_name: 'Bad', modules: [{
        name: 'M', case_type: 'c', forms: [{
          name: 'F', type: 'registration', case_name_field: 'q',
          case_properties: [{ case_property: 'name', question_id: 'q' }],
          questions: [{ id: 'q', type: 'text', label: 'Q' }],
        }],
      }],
    }
    const errors = validateBlueprint(bp)
    expect(errors.some(e => e.includes('reserved'))).toBe(true)
  })

  it('catches dangling case_properties question references', () => {
    const bp: AppBlueprint = {
      app_name: 'Bad', modules: [{
        name: 'M', case_type: 'c', forms: [{
          name: 'F', type: 'registration', case_name_field: 'q',
          case_properties: [{ case_property: 'foo', question_id: 'nonexistent' }],
          questions: [{ id: 'q', type: 'text', label: 'Q' }],
        }],
      }],
    }
    const errors = validateBlueprint(bp)
    expect(errors.some(e => e.includes('nonexistent'))).toBe(true)
  })
})
