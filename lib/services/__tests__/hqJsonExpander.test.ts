import { describe, it, expect } from 'vitest'
import { expandBlueprint, validateBlueprint } from '../hqJsonExpander'
import { mergeQuestionDefaults, mergeFormQuestions } from '../../schemas/blueprint'
import type { AppBlueprint, CaseType, Question } from '../../schemas/blueprint'

const followupBlueprint: AppBlueprint = {
  app_name: 'Test App',
  modules: [{
    name: 'Visits',
    case_type: 'patient',
    forms: [{
      name: 'Follow-up Visit',
      type: 'followup',
      questions: [
        { id: 'client_info', type: 'group', label: 'Client Info', children: [
          { id: 'full_name', type: 'text', label: 'Name', is_case_property: true },
        ]},
        { id: 'total_visits', type: 'hidden', calculate: '#case/total_visits + 1', is_case_property: true },
        { id: 'notes', type: 'text', label: 'Notes' },
      ],
    }],
    case_list_columns: [{ field: 'full_name', header: 'Name' }],
  }],
  case_types: [{ name: 'patient', properties: [{ name: 'full_name', label: 'Full Name' }, { name: 'total_visits', label: 'Total Visits' }] }],
}

const registrationBlueprint: AppBlueprint = {
  app_name: 'Reg App',
  modules: [{
    name: 'Registration',
    case_type: 'patient',
    forms: [{
      name: 'Register Patient',
      type: 'registration',
      questions: [
        { id: 'case_name', type: 'text', label: 'Full Name', required: 'true()', is_case_property: true },
        { id: 'age', type: 'int', label: 'Age', validation: '. > 0 and . < 150', is_case_property: true },
        { id: 'risk', type: 'hidden', calculate: "if(/data/age > 65, 'high', 'low')" },
      ],
    }],
  }],
  case_types: [{ name: 'patient', properties: [{ name: 'case_name', label: 'Full Name' }, { name: 'age', label: 'Age' }] }],
}

describe('expandBlueprint', () => {
  it('populates case_references_data.load with #case/ hashtag references', () => {
    const hq = expandBlueprint(followupBlueprint)
    const form = hq.modules[0].forms[0]
    const load = form.case_references_data.load

    expect(load['/data/total_visits']).toEqual(['#case/total_visits'])
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
          questions: [{
            id: 'grp', type: 'group', label: 'G', children: [
              { id: 'some_prop', type: 'hidden', calculate: '#case/some_prop + #user/role', is_case_property: true },
            ],
          }],
        }],
      }],
      case_types: [{ name: 'case', properties: [{ name: 'some_prop', label: 'Some Prop' }] }],
    }
    const load = expandBlueprint(bp).modules[0].forms[0].case_references_data.load
    expect(load['/data/grp/some_prop']).toEqual(expect.arrayContaining(['#case/some_prop', '#user/role']))
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
    expect(actions.open_case.name_update.question_path).toBe('/data/case_name')
    expect(actions.update_case.update.age.question_path).toBe('/data/age')
  })

  it('wires followup preload and update actions correctly', () => {
    const hq = expandBlueprint(followupBlueprint)
    const actions = hq.modules[0].forms[0].actions

    expect(actions.open_case.condition.type).toBe('never')
    expect(actions.case_preload.condition.type).toBe('always')
    expect(actions.case_preload.preload['/data/total_visits']).toBe('total_visits')
    // Nested question paths should be resolved
    expect(actions.case_preload.preload['/data/client_info/full_name']).toBe('full_name')
    expect(actions.update_case.update.total_visits.question_path).toBe('/data/total_visits')
  })

  it('generates XForm with setvalue for default_value', () => {
    const bp: AppBlueprint = {
      app_name: 'DV', modules: [{
        name: 'M', forms: [{
          name: 'F', type: 'survey',
          questions: [{ id: 'status', type: 'hidden', default_value: "'pending'" }],
        }],
      }],
      case_types: null,
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
          questions: [{ id: 'full_name', type: 'text', label: 'Name', default_value: '#case/full_name', is_case_property: true }],
        }],
      }],
      case_types: [{ name: 'c', properties: [{ name: 'full_name', label: 'Full Name' }] }],
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
    // Hidden question 'total_visits' has no label — should not get an itext entry
    expect(xform).not.toContain("id=\"total_visits-label\"")
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
              { id: 'confirm', type: 'single_select', label: 'Close?', options: [
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
      case_types: [{ name: 'case', properties: [{ name: 'name', label: 'Name' }] }],
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
        name: 'F', type: 'registration',
        questions: [{ id: 'case_name', type: 'text', label: 'Name', is_case_property: true }],
      }],
      case_list_columns: [{ field: 'case_name', header: 'Full Name' }, { field: 'age', header: 'Age' }],
    }],
    case_types: [{ name: 'patient', properties: [{ name: 'case_name', label: 'Name' }] }],
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
          name: 'F', type: 'registration',
          questions: [{ id: 'case_name', type: 'text', label: 'Q', is_case_property: true }],
        }],
      }],
      case_types: null,
    }
    const errors = validateBlueprint(bp)
    expect(errors.some(e => e.includes('case_type'))).toBe(true)
  })

  it('catches reserved case property names', () => {
    const bp: AppBlueprint = {
      app_name: 'Bad', modules: [{
        name: 'M', case_type: 'c', forms: [{
          name: 'F', type: 'registration',
          questions: [{ id: 'name', type: 'text', label: 'Q', is_case_property: true }],
        }],
      }],
      case_types: [{ name: 'c', properties: [{ name: 'name', label: 'Q' }] }],
    }
    const errors = validateBlueprint(bp)
    expect(errors.some(e => e.includes('reserved'))).toBe(true)
  })

  it('catches registration form without case_name question', () => {
    const bp: AppBlueprint = {
      app_name: 'Bad', modules: [{
        name: 'M', case_type: 'c', forms: [{
          name: 'F', type: 'registration',
          questions: [{ id: 'q', type: 'text', label: 'Q' }],
        }],
      }],
      case_types: [{ name: 'c', properties: [{ name: 'q', label: 'Q' }] }],
    }
    const errors = validateBlueprint(bp)
    expect(errors.some(e => e.includes('case_name_field'))).toBe(true)
  })
})

// ── Feature 1: Output References in Labels ──────────────────────────────

describe('output references in labels', () => {
  it('preserves <output value="..."/> in label itext, escaping surrounding text', () => {
    const bp: AppBlueprint = {
      app_name: 'Output', modules: [{
        name: 'M', forms: [{
          name: 'F', type: 'survey',
          questions: [
            { id: 'name', type: 'text', label: 'Name' },
            { id: 'greeting', type: 'label', label: 'Hello <output value="/data/name"/>, welcome!' },
          ],
        }],
      }],
      case_types: null,
    }
    const hq = expandBlueprint(bp)
    const xform: string = Object.values(hq._attachments)[0] as string
    expect(xform).toContain('<text id="greeting-label"><value>Hello <output value="/data/name"/>, welcome!</value><value form="markdown">Hello <output value="/data/name"/>, welcome!</value></text>')
  })

  it('expands #case/ hashtags inside <output value="..."/> tags', () => {
    const bp: AppBlueprint = {
      app_name: 'Output', modules: [{
        name: 'M', case_type: 'c', forms: [{
          name: 'F', type: 'followup',
          questions: [
            { id: 'full_name', type: 'text', label: 'Name', is_case_property: true },
            { id: 'msg', type: 'label', label: 'Patient: <output value="#case/full_name"/>' },
          ],
        }],
      }],
      case_types: [{ name: 'c', properties: [{ name: 'full_name', label: 'Full Name' }] }],
    }
    const hq = expandBlueprint(bp)
    const xform: string = Object.values(hq._attachments)[0] as string
    // The output tag should have expanded XPath, not the #case/ shorthand
    expect(xform).toContain('<output value="')
    expect(xform).toContain('/full_name"/>')
    expect(xform).not.toContain('#case/full_name"/>')
  })
})

// ── Feature 2: Help Text ────────────────────────────────────────────────

describe('help text', () => {
  it('generates <help> element and itext entry for questions with help text', () => {
    const bp: AppBlueprint = {
      app_name: 'Help', modules: [{
        name: 'M', forms: [{
          name: 'F', type: 'survey',
          questions: [
            { id: 'q', type: 'text', label: 'Name', help: 'Enter the full legal name as shown on ID' },
          ],
        }],
      }],
      case_types: null,
    }
    const hq = expandBlueprint(bp)
    const xform: string = Object.values(hq._attachments)[0] as string
    expect(xform).toContain('id="q-help"')
    expect(xform).toContain('Enter the full legal name as shown on ID')
    expect(xform).toContain('<help ref="jr:itext(\'q-help\')"/>')
  })

  it('does not generate <help> when help is absent', () => {
    const bp: AppBlueprint = {
      app_name: 'NoHelp', modules: [{
        name: 'M', forms: [{
          name: 'F', type: 'survey',
          questions: [{ id: 'q', type: 'text', label: 'Name' }],
        }],
      }],
      case_types: null,
    }
    const hq = expandBlueprint(bp)
    const xform: string = Object.values(hq._attachments)[0] as string
    expect(xform).not.toContain('-help')
    expect(xform).not.toContain('<help')
  })
})

// ── Feature 3: Conditional Required ─────────────────────────────────────

describe('conditional required', () => {
  it('generates required="true()" for required: "true()"', () => {
    const bp: AppBlueprint = {
      app_name: 'R', modules: [{
        name: 'M', forms: [{
          name: 'F', type: 'survey',
          questions: [{ id: 'q', type: 'text', label: 'Q', required: 'true()' }],
        }],
      }],
      case_types: null,
    }
    const hq = expandBlueprint(bp)
    const xform: string = Object.values(hq._attachments)[0] as string
    expect(xform).toContain('required="true()"')
  })

  it('generates required XPath expression for string required', () => {
    const bp: AppBlueprint = {
      app_name: 'R', modules: [{
        name: 'M', forms: [{
          name: 'F', type: 'survey',
          questions: [
            { id: 'consent', type: 'single_select', label: 'Consent?', options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] },
            { id: 'details', type: 'text', label: 'Details', required: "/data/consent = 'yes'" },
          ],
        }],
      }],
      case_types: null,
    }
    const hq = expandBlueprint(bp)
    const xform: string = Object.values(hq._attachments)[0] as string
    expect(xform).toContain("required=\"/data/consent = &apos;yes&apos;\"")
    expect(xform).not.toContain('required="true()"')
  })

  it('expands #case/ hashtags in required XPath and adds vellum:required', () => {
    const bp: AppBlueprint = {
      app_name: 'R', modules: [{
        name: 'M', case_type: 'c', forms: [{
          name: 'F', type: 'followup',
          questions: [
            { id: 'risk', type: 'text', label: 'Q', is_case_property: true },
            { id: 'notes', type: 'text', label: 'Notes', required: "#case/risk = 'high'" },
          ],
        }],
      }],
      case_types: [{ name: 'c', properties: [{ name: 'risk', label: 'Risk' }] }],
    }
    const hq = expandBlueprint(bp)
    const xform: string = Object.values(hq._attachments)[0] as string
    expect(xform).toContain("vellum:required=\"#case/risk = &apos;high&apos;\"")
    expect(xform).toContain("instance(&apos;casedb&apos;)")
  })
})

// ── Feature 4: Case Detail (Long) View ──────────────────────────────────

describe('case detail (long) view', () => {
  it('mirrors short columns to long detail when case_detail_columns is not set', () => {
    const bp: AppBlueprint = {
      app_name: 'D', modules: [{
        name: 'M', case_type: 'c', forms: [{
          name: 'F', type: 'registration',
          questions: [{ id: 'case_name', type: 'text', label: 'Name', is_case_property: true }],
        }],
        case_list_columns: [{ field: 'case_name', header: 'Name' }, { field: 'age', header: 'Age' }],
      }],
      case_types: [{ name: 'c', properties: [{ name: 'case_name', label: 'Name' }] }],
    }
    const hq = expandBlueprint(bp)
    const longCols = hq.modules[0].case_details.long.columns
    expect(longCols.length).toBe(2)
    expect(longCols[0].field).toBe('case_name')
  })

  it('uses explicit case_detail_columns for long detail when provided', () => {
    const bp: AppBlueprint = {
      app_name: 'D', modules: [{
        name: 'M', case_type: 'c', forms: [{
          name: 'F', type: 'registration',
          questions: [{ id: 'case_name', type: 'text', label: 'Name', is_case_property: true }],
        }],
        case_list_columns: [{ field: 'case_name', header: 'Name' }],
        case_detail_columns: [
          { field: 'case_name', header: 'Full Name' },
          { field: 'age', header: 'Age' },
          { field: 'dob', header: 'Date of Birth' },
        ],
      }],
      case_types: [{ name: 'c', properties: [{ name: 'case_name', label: 'Name' }] }],
    }
    const hq = expandBlueprint(bp)
    const longCols = hq.modules[0].case_details.long.columns
    expect(longCols.length).toBe(3)
    expect(longCols[0].header.en).toBe('Full Name')
    expect(longCols[2].field).toBe('dob')
  })
})

// ── Feature 5: Single Language itext ────────────────────────────────────

describe('single language itext', () => {
  it('generates a single English translation block', () => {
    const bp: AppBlueprint = {
      app_name: 'App',
      modules: [{
        name: 'M', forms: [{
          name: 'F', type: 'survey',
          questions: [{ id: 'name', type: 'text', label: 'Patient Name' }],
        }],
      }],
      case_types: null,
    }
    const hq = expandBlueprint(bp)
    const xform: string = Object.values(hq._attachments)[0] as string
    expect(xform).toContain('lang="en" default=""')
    expect(xform).toContain('Patient Name')
    expect(hq.langs).toEqual(['en'])
  })
})

// ── Feature 6: jr-insert for Repeat Defaults ────────────────────────────

describe('jr-insert for repeat defaults', () => {
  it('uses jr-insert event for default_value inside repeat groups', () => {
    const bp: AppBlueprint = {
      app_name: 'Rep', modules: [{
        name: 'M', forms: [{
          name: 'F', type: 'survey',
          questions: [{
            id: 'items', type: 'repeat', label: 'Items', children: [
              { id: 'status', type: 'hidden', default_value: "'pending'" },
            ],
          }],
        }],
      }],
      case_types: null,
    }
    const hq = expandBlueprint(bp)
    const xform: string = Object.values(hq._attachments)[0] as string
    expect(xform).toContain('event="jr-insert"')
    expect(xform).not.toContain('event="xforms-ready"')
  })

  it('uses xforms-ready event for default_value outside repeat groups', () => {
    const bp: AppBlueprint = {
      app_name: 'NR', modules: [{
        name: 'M', forms: [{
          name: 'F', type: 'survey',
          questions: [
            { id: 'status', type: 'hidden', default_value: "'pending'" },
          ],
        }],
      }],
      case_types: null,
    }
    const hq = expandBlueprint(bp)
    const xform: string = Object.values(hq._attachments)[0] as string
    expect(xform).toContain('event="xforms-ready"')
    expect(xform).not.toContain('event="jr-insert"')
  })

  it('adds jr:template="" attribute on repeat data elements', () => {
    const bp: AppBlueprint = {
      app_name: 'Rep', modules: [{
        name: 'M', forms: [{
          name: 'F', type: 'survey',
          questions: [{
            id: 'items', type: 'repeat', label: 'Items', children: [
              { id: 'item_name', type: 'text', label: 'Item' },
            ],
          }],
        }],
      }],
      case_types: null,
    }
    const hq = expandBlueprint(bp)
    const xform: string = Object.values(hq._attachments)[0] as string
    expect(xform).toContain('<items jr:template="">')
  })
})

// ── Data Model Defaults Merge ────────────────────────────────────────────

const testCaseTypes: CaseType[] = [{
  name: 'patient',
  properties: [
    { name: 'case_name', label: 'Full Name' },
    { name: 'age', label: 'Patient Age', data_type: 'int', required: 'true()', validation: '. > 0 and . < 150', validation_msg: 'Age must be between 1 and 149' },
    { name: 'gender', label: 'Gender', data_type: 'single_select', options: [{ value: 'male', label: 'Male' }, { value: 'female', label: 'Female' }] },
    { name: 'phone', label: 'Phone Number', data_type: 'phone', hint: 'Include country code' },
  ],
}]

describe('mergeQuestionDefaults', () => {
  it('fills in label from data model for sparse question', () => {
    const q: Question = { id: 'case_name', type: 'text', is_case_property: true }
    const merged = mergeQuestionDefaults(q, testCaseTypes, 'patient')
    expect(merged.label).toBe('Full Name')
  })

  it('preserves explicit label when provided', () => {
    const q: Question = { id: 'case_name', type: 'text', label: 'Custom Label', is_case_property: true }
    const merged = mergeQuestionDefaults(q, testCaseTypes, 'patient')
    expect(merged.label).toBe('Custom Label')
  })

  it('fills in validation, required, and validation_msg', () => {
    const q: Question = { id: 'age', type: 'int', is_case_property: true }
    const merged = mergeQuestionDefaults(q, testCaseTypes, 'patient')
    expect(merged.required).toBe('true()')
    expect(merged.validation).toBe('. > 0 and . < 150')
    expect(merged.validation_msg).toBe('Age must be between 1 and 149')
  })

  it('fills in options for select properties', () => {
    const q: Question = { id: 'gender', type: 'single_select', is_case_property: true }
    const merged = mergeQuestionDefaults(q, testCaseTypes, 'patient')
    expect(merged.options).toEqual([{ value: 'male', label: 'Male' }, { value: 'female', label: 'Female' }])
  })

  it('fills in hint from data model', () => {
    const q: Question = { id: 'phone', type: 'phone', is_case_property: true }
    const merged = mergeQuestionDefaults(q, testCaseTypes, 'patient')
    expect(merged.hint).toBe('Include country code')
  })

  it('returns question unchanged when no is_case_property', () => {
    const q: Question = { id: 'notes', type: 'text', label: 'Notes' }
    const merged = mergeQuestionDefaults(q, testCaseTypes, 'patient')
    expect(merged).toEqual(q)
  })

  it('returns question unchanged when case_types is undefined', () => {
    const q: Question = { id: 'case_name', type: 'text', is_case_property: true }
    const merged = mergeQuestionDefaults(q, undefined, 'patient')
    expect(merged).toEqual(q)
  })

  it('returns question unchanged when property not found', () => {
    const q: Question = { id: 'nonexistent', type: 'text', is_case_property: true }
    const merged = mergeQuestionDefaults(q, testCaseTypes, 'patient')
    expect(merged).toEqual(q)
  })
})

describe('mergeFormQuestions', () => {
  it('recursively merges children inside groups', () => {
    const questions: Question[] = [{
      id: 'grp', type: 'group', label: 'Group', children: [
        { id: 'age', type: 'int', is_case_property: true },
      ],
    }]
    const merged = mergeFormQuestions(questions, testCaseTypes, 'patient')
    expect(merged[0].children![0].label).toBe('Patient Age')
    expect(merged[0].children![0].required).toBe('true()')
  })
})

describe('expander merges data model defaults', () => {
  it('produces correct XForm for sparse question with data model defaults', () => {
    const bp: AppBlueprint = {
      app_name: 'Merge Test',
      case_types: testCaseTypes,
      modules: [{
        name: 'M', case_type: 'patient', forms: [{
          name: 'F', type: 'registration',
          questions: [
            { id: 'case_name', type: 'text', is_case_property: true },
            { id: 'age', type: 'int', is_case_property: true },
            { id: 'gender', type: 'single_select', is_case_property: true },
          ],
        }],
      }],
    }
    const hq = expandBlueprint(bp)
    const xform: string = Object.values(hq._attachments)[0] as string

    // Label from data model should appear in itext
    expect(xform).toContain('Full Name')
    expect(xform).toContain('Patient Age')
    expect(xform).toContain('Gender')

    // Constraint from data model on age
    expect(xform).toContain('. &gt; 0 and . &lt; 150')

    // Options from data model on gender
    expect(xform).toContain('Male')
    expect(xform).toContain('Female')
  })

  it('derives case name from question with id "case_name"', () => {
    const bp: AppBlueprint = {
      app_name: 'Auto Case Name',
      case_types: testCaseTypes,
      modules: [{
        name: 'M', case_type: 'patient', forms: [{
          name: 'Register', type: 'registration',
          questions: [
            { id: 'case_name', type: 'text', is_case_property: true },
            { id: 'age', type: 'int', is_case_property: true },
          ],
        }],
      }],
    }
    const hq = expandBlueprint(bp)
    const actions = hq.modules[0].forms[0].actions
    // open_case should be wired with case_name as the case name field
    expect(actions.open_case.condition.type).toBe('always')
    expect(actions.open_case.name_update.question_path).toBe('/data/case_name')
  })

  it('validator passes for select question with options from data model', () => {
    const bp: AppBlueprint = {
      app_name: 'V',
      case_types: testCaseTypes,
      modules: [{
        name: 'M', case_type: 'patient', forms: [{
          name: 'F', type: 'registration',
          questions: [
            { id: 'case_name', type: 'text', is_case_property: true },
            { id: 'gender', type: 'single_select', is_case_property: true },
          ],
        }],
      }],
    }
    const errors = validateBlueprint(bp)
    // Should NOT report "select but has no options" since options come from data model
    expect(errors.some(e => e.includes('no options'))).toBe(false)
  })
})

// ── Unquoted String Literal Detection ────────────────────────────────────

describe('unquoted string literal detection', () => {
  const makeBp = (questionOverrides: Partial<Question>): AppBlueprint => ({
    app_name: 'Test',
    modules: [{
      name: 'M',
      forms: [{
        name: 'F',
        type: 'survey',
        questions: [{ id: 'q', type: 'text', label: 'Q', ...questionOverrides }],
      }],
    }],
    case_types: null,
  })

  it('catches bare string in default_value', () => {
    const errors = validateBlueprint(makeBp({ type: 'hidden', default_value: 'no' }))
    expect(errors.some(e => e.includes('unquoted string "no"') && e.includes('default_value'))).toBe(true)
  })

  it('catches bare string in calculate', () => {
    const errors = validateBlueprint(makeBp({ type: 'hidden', calculate: 'pending' }))
    expect(errors.some(e => e.includes('unquoted string "pending"') && e.includes('calculate'))).toBe(true)
  })

  it('catches bare string in relevant', () => {
    const errors = validateBlueprint(makeBp({ relevant: 'yes' }))
    expect(errors.some(e => e.includes('unquoted string "yes"') && e.includes('relevant'))).toBe(true)
  })

  it('allows quoted string literal', () => {
    const errors = validateBlueprint(makeBp({ type: 'hidden', default_value: "'no'" }))
    expect(errors.some(e => e.includes('unquoted string'))).toBe(false)
  })

  it('allows function calls', () => {
    const errors = validateBlueprint(makeBp({ required: 'true()' }))
    expect(errors.some(e => e.includes('unquoted string'))).toBe(false)
  })

  it('allows XPath expressions', () => {
    const errors = validateBlueprint(makeBp({ relevant: '/data/age > 18' }))
    expect(errors.some(e => e.includes('unquoted string'))).toBe(false)
  })

  it('allows hashtag references', () => {
    const errors = validateBlueprint(makeBp({ type: 'hidden', calculate: '#case/status' }))
    expect(errors.some(e => e.includes('unquoted string'))).toBe(false)
  })

  it('allows number literals', () => {
    const errors = validateBlueprint(makeBp({ type: 'hidden', default_value: '0' }))
    expect(errors.some(e => e.includes('unquoted string'))).toBe(false)
  })

  it('allows today() function', () => {
    const errors = validateBlueprint(makeBp({ type: 'hidden', default_value: 'today()' }))
    expect(errors.some(e => e.includes('unquoted string'))).toBe(false)
  })

  it('allows dot expressions', () => {
    const errors = validateBlueprint(makeBp({ validation: '. > 0' }))
    expect(errors.some(e => e.includes('unquoted string'))).toBe(false)
  })

  it('catches bare string inside group children', () => {
    const bp: AppBlueprint = {
      app_name: 'Test',
      modules: [{
        name: 'M',
        forms: [{
          name: 'F',
          type: 'survey',
          questions: [{
            id: 'grp', type: 'group', label: 'Group', children: [
              { id: 'status', type: 'hidden', default_value: 'active' },
            ],
          }],
        }],
      }],
      case_types: null,
    }
    const errors = validateBlueprint(bp)
    expect(errors.some(e => e.includes('unquoted string "active"'))).toBe(true)
  })
})
