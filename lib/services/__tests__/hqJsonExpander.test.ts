import { describe, it, expect } from 'vitest'
import { expandBlueprint, validateBlueprint } from '../hqJsonExpander'
import type { AppBlueprint, Question } from '../../schemas/blueprint'

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
          { id: 'full_name', type: 'text', label: 'Name', case_property_on: 'patient' },
        ]},
        { id: 'total_visits', type: 'hidden', calculate: '#case/total_visits + 1', case_property_on: 'patient' },
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
        { id: 'case_name', type: 'text', label: 'Full Name', required: 'true()', case_property_on: 'patient' },
        { id: 'age', type: 'int', label: 'Age', validation: '. > 0 and . < 150', case_property_on: 'patient' },
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
              { id: 'some_prop', type: 'hidden', calculate: '#case/some_prop + #user/role', case_property_on: 'case' },
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
    expect(xform).toContain('vellum:ref="#form/status" ref="/data/status"')
    expect(xform).toContain("value=\"&apos;pending&apos;\"")
    // No vellum:value when there are no hashtags in the value expression
    expect(xform).not.toContain('vellum:value=')
  })

  it('expands #case/ in setvalue default_value, keeps shorthand in vellum:value', () => {
    const bp: AppBlueprint = {
      app_name: 'DV', modules: [{
        name: 'M', case_type: 'c', forms: [{
          name: 'F', type: 'followup',
          questions: [{ id: 'full_name', type: 'text', label: 'Name', default_value: '#case/full_name', case_property_on: 'c' }],
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
        questions: [{ id: 'case_name', type: 'text', label: 'Name', case_property_on: 'patient' }],
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
          questions: [{ id: 'case_name', type: 'text', label: 'Q', case_property_on: 'patient' }],
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
          questions: [{ id: 'name', type: 'text', label: 'Q', case_property_on: 'c' }],
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
            { id: 'full_name', type: 'text', label: 'Name', case_property_on: 'c' },
            { id: 'msg', type: 'label', label: 'Patient: <output value="#case/full_name"/>' },
          ],
        }],
      }],
      case_types: [{ name: 'c', properties: [{ name: 'full_name', label: 'Full Name' }] }],
    }
    const hq = expandBlueprint(bp)
    const xform: string = Object.values(hq._attachments)[0] as string
    // The output value= should have expanded XPath, vellum:value preserves shorthand
    expect(xform).toContain('<output value="instance(')
    expect(xform).toContain('vellum:value="#case/full_name"')
  })

  it('wraps bare #case/ in label text as <output> tags with expanded XPath', () => {
    const bp: AppBlueprint = {
      app_name: 'BareRef', modules: [{
        name: 'M', case_type: 'c', forms: [{
          name: 'F', type: 'followup',
          questions: [
            { id: 'case_name', type: 'text', label: 'Name', case_property_on: 'c' },
            { id: 'start_date', type: 'date', label: 'Start', case_property_on: 'c' },
            { id: 'end_date', type: 'date', label: 'End', case_property_on: 'c' },
            { id: 'summary', type: 'label', label: 'Plan: **#case/case_name**, from #case/start_date to #case/end_date' },
          ],
        }],
      }],
      case_types: [{ name: 'c', properties: [
        { name: 'case_name', label: 'Name' },
        { name: 'start_date', label: 'Start' },
        { name: 'end_date', label: 'End' },
      ] }],
    }
    const hq = expandBlueprint(bp)
    const xform: string = Object.values(hq._attachments)[0] as string
    // Bare #case/ text should not appear in label content
    expect(xform).not.toContain('#case/case_name**')
    expect(xform).not.toContain('to #case/end_date')
    // Shorthand preserved in vellum:value attributes on output tags
    expect(xform).toContain('vellum:value="#case/case_name"')
    expect(xform).toContain('vellum:value="#case/start_date"')
    expect(xform).toContain('vellum:value="#case/end_date"')
    // Each output tag should have expanded instance() XPath
    expect(xform).toContain('<output value="instance(')
    // Label type gets both <value> and <value form="markdown">, so 3 refs × 2 = 6
    const outputCount = (xform.match(/vellum:value="#case\//g) || []).length
    expect(outputCount).toBe(6)
  })

  it('wraps bare #form/ in label text as <output> tags', () => {
    const bp: AppBlueprint = {
      app_name: 'BareForm', modules: [{
        name: 'M', forms: [{
          name: 'F', type: 'survey',
          questions: [
            { id: 'user_name', type: 'text', label: 'Your name' },
            { id: 'greeting', type: 'label', label: 'Hello #form/user_name!' },
          ],
        }],
      }],
      case_types: null,
    }
    const hq = expandBlueprint(bp)
    const xform: string = Object.values(hq._attachments)[0] as string
    expect(xform).not.toContain('#form/user_name!')
    expect(xform).toContain('<output value="/data/user_name" vellum:value="#form/user_name"/>')
  })

  it('handles mixed bare hashtags and existing <output> tags in one label', () => {
    const bp: AppBlueprint = {
      app_name: 'Mixed', modules: [{
        name: 'M', case_type: 'c', forms: [{
          name: 'F', type: 'followup',
          questions: [
            { id: 'case_name', type: 'text', label: 'Name', case_property_on: 'c' },
            { id: 'status', type: 'text', label: 'Status', case_property_on: 'c' },
            { id: 'info', type: 'label', label: 'Hello <output value="#case/case_name"/>, status: #case/status' },
          ],
        }],
      }],
      case_types: [{ name: 'c', properties: [
        { name: 'case_name', label: 'Name' },
        { name: 'status', label: 'Status' },
      ] }],
    }
    const hq = expandBlueprint(bp)
    const xform: string = Object.values(hq._attachments)[0] as string
    // The bare #case/status from the label should be wrapped and expanded
    const infoLabel = xform.match(/<text id="info-label">.*?<\/text>/s)?.[0] || ''
    expect(infoLabel).not.toContain('status: #case/status')
    // Both existing <output> and bare ref should be expanded with vellum:value
    expect(infoLabel).toContain('vellum:value="#case/case_name"')
    expect(infoLabel).toContain('vellum:value="#case/status"')
  })
})

// ── #form/ hashtag expansion ─────────────────────────────────────────────

describe('#form/ hashtag expansion', () => {
  it('expands #form/ in calculate to /data/, keeps shorthand in vellum:calculate', () => {
    const bp: AppBlueprint = {
      app_name: 'FormRef', modules: [{
        name: 'M', forms: [{
          name: 'F', type: 'survey',
          questions: [
            { id: 'first_name', type: 'text', label: 'First' },
            { id: 'last_name', type: 'text', label: 'Last' },
            { id: 'full_name', type: 'hidden', calculate: "concat(#form/first_name, ' ', #form/last_name)" },
          ],
        }],
      }],
      case_types: null,
    }
    const hq = expandBlueprint(bp)
    const xform: string = Object.values(hq._attachments)[0] as string
    expect(xform).toContain("calculate=\"concat(/data/first_name, &apos; &apos;, /data/last_name)\"")
    expect(xform).toContain("vellum:calculate=\"concat(#form/first_name, &apos; &apos;, #form/last_name)\"")
  })

  it('expands #form/ in relevant to /data/, keeps shorthand in vellum:relevant', () => {
    const bp: AppBlueprint = {
      app_name: 'FormRef', modules: [{
        name: 'M', forms: [{
          name: 'F', type: 'survey',
          questions: [
            { id: 'consent', type: 'single_select', label: 'Consent?', options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] },
            { id: 'details', type: 'text', label: 'Details', relevant: "#form/consent = 'yes'" },
          ],
        }],
      }],
      case_types: null,
    }
    const hq = expandBlueprint(bp)
    const xform: string = Object.values(hq._attachments)[0] as string
    expect(xform).toContain("relevant=\"/data/consent = &apos;yes&apos;\"")
    expect(xform).toContain("vellum:relevant=\"#form/consent = &apos;yes&apos;\"")
  })

  it('expands #form/ in validation constraint', () => {
    const bp: AppBlueprint = {
      app_name: 'FormRef', modules: [{
        name: 'M', forms: [{
          name: 'F', type: 'survey',
          questions: [
            { id: 'start_date', type: 'date', label: 'Start' },
            { id: 'end_date', type: 'date', label: 'End', validation: '. >= #form/start_date' },
          ],
        }],
      }],
      case_types: null,
    }
    const hq = expandBlueprint(bp)
    const xform: string = Object.values(hq._attachments)[0] as string
    expect(xform).toContain('constraint=". &gt;= /data/start_date"')
    expect(xform).toContain('vellum:constraint=". &gt;= #form/start_date"')
  })

  it('expands #form/ in required condition', () => {
    const bp: AppBlueprint = {
      app_name: 'FormRef', modules: [{
        name: 'M', forms: [{
          name: 'F', type: 'survey',
          questions: [
            { id: 'has_issue', type: 'single_select', label: 'Issue?', options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] },
            { id: 'details', type: 'text', label: 'Details', required: "#form/has_issue = 'yes'" },
          ],
        }],
      }],
      case_types: null,
    }
    const hq = expandBlueprint(bp)
    const xform: string = Object.values(hq._attachments)[0] as string
    expect(xform).toContain("required=\"/data/has_issue = &apos;yes&apos;\"")
    expect(xform).toContain("vellum:required=\"#form/has_issue = &apos;yes&apos;\"")
  })

  it('expands #form/ in <output> tags with vellum:value', () => {
    const bp: AppBlueprint = {
      app_name: 'FormRef', modules: [{
        name: 'M', forms: [{
          name: 'F', type: 'survey',
          questions: [
            { id: 'text_value', type: 'hidden', default_value: "'Text'" },
            { id: 'here', type: 'label', label: 'Here <output value="#form/text_value"/>' },
          ],
        }],
      }],
      case_types: null,
    }
    const hq = expandBlueprint(bp)
    const xform: string = Object.values(hq._attachments)[0] as string
    expect(xform).toContain('<output value="/data/text_value" vellum:value="#form/text_value"/>')
  })

  it('expands #form/ in default_value setvalue', () => {
    const bp: AppBlueprint = {
      app_name: 'FormRef', modules: [{
        name: 'M', forms: [{
          name: 'F', type: 'survey',
          questions: [
            { id: 'score_a', type: 'int', label: 'Score A' },
            { id: 'score_b', type: 'int', label: 'Score B' },
            { id: 'total', type: 'hidden', default_value: '#form/score_a + #form/score_b' },
          ],
        }],
      }],
      case_types: null,
    }
    const hq = expandBlueprint(bp)
    const xform: string = Object.values(hq._attachments)[0] as string
    expect(xform).toContain('value="/data/score_a + /data/score_b"')
    expect(xform).toContain('vellum:value="#form/score_a + #form/score_b"')
  })

  it('generates vellum:nodeset on all binds', () => {
    const bp: AppBlueprint = {
      app_name: 'VN', modules: [{
        name: 'M', forms: [{
          name: 'F', type: 'survey',
          questions: [
            { id: 'name', type: 'text', label: 'Name' },
            { id: 'age', type: 'int', label: 'Age' },
          ],
        }],
      }],
      case_types: null,
    }
    const hq = expandBlueprint(bp)
    const xform: string = Object.values(hq._attachments)[0] as string
    expect(xform).toContain('vellum:nodeset="#form/name" nodeset="/data/name"')
    expect(xform).toContain('vellum:nodeset="#form/age" nodeset="/data/age"')
  })

  it('generates vellum:nodeset for nested questions in groups', () => {
    const bp: AppBlueprint = {
      app_name: 'VN', modules: [{
        name: 'M', forms: [{
          name: 'F', type: 'survey',
          questions: [{
            id: 'grp', type: 'group', label: 'Group', children: [
              { id: 'inner', type: 'text', label: 'Inner' },
            ],
          }],
        }],
      }],
      case_types: null,
    }
    const hq = expandBlueprint(bp)
    const xform: string = Object.values(hq._attachments)[0] as string
    expect(xform).toContain('vellum:nodeset="#form/grp/inner" nodeset="/data/grp/inner"')
  })

  it('generates vellum:ref on setvalue elements', () => {
    const bp: AppBlueprint = {
      app_name: 'VR', modules: [{
        name: 'M', forms: [{
          name: 'F', type: 'survey',
          questions: [{ id: 'ts', type: 'hidden', default_value: 'now()' }],
        }],
      }],
      case_types: null,
    }
    const hq = expandBlueprint(bp)
    const xform: string = Object.values(hq._attachments)[0] as string
    expect(xform).toContain('vellum:ref="#form/ts" ref="/data/ts"')
  })

  it('expands #form/ in group relevant and adds vellum attributes', () => {
    const bp: AppBlueprint = {
      app_name: 'GR', modules: [{
        name: 'M', forms: [{
          name: 'F', type: 'survey',
          questions: [
            { id: 'show', type: 'single_select', label: 'Show?', options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] },
            { id: 'details', type: 'group', label: 'Details', relevant: "#form/show = 'yes'", children: [
              { id: 'info', type: 'text', label: 'Info' },
            ]},
          ],
        }],
      }],
      case_types: null,
    }
    const hq = expandBlueprint(bp)
    const xform: string = Object.values(hq._attachments)[0] as string
    expect(xform).toContain("relevant=\"/data/show = &apos;yes&apos;\"")
    expect(xform).toContain("vellum:relevant=\"#form/show = &apos;yes&apos;\"")
    expect(xform).toContain('vellum:nodeset="#form/details"')
  })

  it('does not add vellum:hashtags or vellum:hashtagTransforms for #form/-only expressions', () => {
    const bp: AppBlueprint = {
      app_name: 'FormRef', modules: [{
        name: 'M', forms: [{
          name: 'F', type: 'survey',
          questions: [
            { id: 'a', type: 'int', label: 'A' },
            { id: 'b', type: 'hidden', calculate: '#form/a * 2' },
          ],
        }],
      }],
      case_types: null,
    }
    const hq = expandBlueprint(bp)
    const xform: string = Object.values(hq._attachments)[0] as string
    // #form/ is NOT in VELLUM_HASHTAG_TRANSFORMS — no transforms metadata needed
    expect(xform).not.toContain('vellum:hashtags=')
    expect(xform).not.toContain('vellum:hashtagTransforms=')
    // But vellum:calculate IS present (preserves shorthand for Vellum editor)
    expect(xform).toContain('vellum:calculate="#form/a * 2"')
    expect(xform).toContain('calculate="/data/a * 2"')
  })

  it('does not require secondary instances for #form/-only expressions', () => {
    const bp: AppBlueprint = {
      app_name: 'FormRef', modules: [{
        name: 'M', forms: [{
          name: 'F', type: 'survey',
          questions: [
            { id: 'a', type: 'int', label: 'A' },
            { id: 'b', type: 'hidden', calculate: '#form/a * 2' },
          ],
        }],
      }],
      case_types: null,
    }
    const hq = expandBlueprint(bp)
    const xform: string = Object.values(hq._attachments)[0] as string
    expect(xform).not.toContain('id="casedb"')
    expect(xform).not.toContain('id="commcaresession"')
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
            { id: 'risk', type: 'text', label: 'Q', case_property_on: 'c' },
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
          questions: [{ id: 'case_name', type: 'text', label: 'Name', case_property_on: 'c' }],
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
          questions: [{ id: 'case_name', type: 'text', label: 'Name', case_property_on: 'c' }],
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

// ── Expansion with complete questions (no merge from case_types) ──────────

describe('expansion with complete questions', () => {
  it('derives case name from question with id "case_name"', () => {
    const bp: AppBlueprint = {
      app_name: 'Case Name Test',
      case_types: [{ name: 'patient', properties: [{ name: 'case_name', label: 'Name' }] }],
      modules: [{
        name: 'M', case_type: 'patient', forms: [{
          name: 'Register', type: 'registration',
          questions: [
            { id: 'case_name', type: 'text', label: 'Patient Name', case_property_on: 'patient' },
            { id: 'age', type: 'int', label: 'Age', case_property_on: 'patient' },
          ],
        }],
      }],
    }
    const hq = expandBlueprint(bp)
    const actions = hq.modules[0].forms[0].actions
    expect(actions.open_case.condition.type).toBe('always')
    expect(actions.open_case.name_update.question_path).toBe('/data/case_name')
  })

  it('uses question labels directly without case_types merge', () => {
    const bp: AppBlueprint = {
      app_name: 'Complete Questions',
      case_types: [{ name: 'patient', properties: [{ name: 'case_name', label: 'WRONG' }] }],
      modules: [{
        name: 'M', case_type: 'patient', forms: [{
          name: 'F', type: 'registration',
          questions: [
            { id: 'case_name', type: 'text', label: 'Patient Name', case_property_on: 'patient' },
          ],
        }],
      }],
    }
    const hq = expandBlueprint(bp)
    const xform: string = Object.values(hq._attachments)[0] as string
    // Should use the question's own label, not the case_types label
    expect(xform).toContain('Patient Name')
    expect(xform).not.toContain('WRONG')
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

// ── Child Case Type Module Requirement ─────────────────────────────────

describe('child case type module requirement', () => {
  it('errors when child case type has no module', () => {
    const bp: AppBlueprint = {
      app_name: 'Test',
      modules: [{
        name: 'Plans',
        case_type: 'plan',
        forms: [{
          name: 'Create Plan',
          type: 'registration',
          questions: [
            { id: 'case_name', type: 'text', label: 'Plan Name', case_property_on: 'plan' },
          ],
        }],
      }],
      case_types: [
        { name: 'plan', properties: [{ name: 'case_name', label: 'Plan Name' }] },
        { name: 'service', parent_type: 'plan', properties: [{ name: 'case_name', label: 'Service Name' }] },
      ],
    }
    const errors = validateBlueprint(bp)
    expect(errors.some(e => e.includes('Child case type "service"') && e.includes('has no module'))).toBe(true)
  })

  it('no error when child case type has a case_list_only module', () => {
    const bp: AppBlueprint = {
      app_name: 'Test',
      modules: [
        {
          name: 'Plans',
          case_type: 'plan',
          forms: [{
            name: 'Create Plan',
            type: 'registration',
            questions: [
              { id: 'case_name', type: 'text', label: 'Plan Name', case_property_on: 'plan' },
            ],
          }],
        },
        {
          name: 'Services',
          case_type: 'service',
          case_list_only: true,
          forms: [],
          case_list_columns: [{ field: 'case_name', header: 'Name' }],
        },
      ],
      case_types: [
        { name: 'plan', properties: [{ name: 'case_name', label: 'Plan Name' }] },
        { name: 'service', parent_type: 'plan', properties: [{ name: 'case_name', label: 'Service Name' }] },
      ],
    }
    const errors = validateBlueprint(bp)
    expect(errors.some(e => e.includes('Child case type "service"'))).toBe(false)
    expect(errors.some(e => e.includes('case_list_only'))).toBe(false)
  })
})

// ── case_list_only Validation ──────────────────────────────────────────

describe('case_list_only validation', () => {
  it('errors when case_list_only module has forms', () => {
    const bp: AppBlueprint = {
      app_name: 'Test',
      modules: [{
        name: 'Bad',
        case_type: 'thing',
        case_list_only: true,
        forms: [{ name: 'F', type: 'followup', questions: [{ id: 'q', type: 'text', label: 'Q' }] }],
      }],
      case_types: [{ name: 'thing', properties: [] }],
    }
    const errors = validateBlueprint(bp)
    expect(errors.some(e => e.includes('case_list_only but has forms'))).toBe(true)
  })

  it('errors when case_list_only module has no case_type', () => {
    const bp: AppBlueprint = {
      app_name: 'Test',
      modules: [{
        name: 'Bad',
        case_list_only: true,
        forms: [],
      }],
      case_types: null,
    }
    const errors = validateBlueprint(bp)
    expect(errors.some(e => e.includes('case_list_only but has no case_type'))).toBe(true)
  })

  it('errors when module has case_type and no forms but missing case_list_only flag', () => {
    const bp: AppBlueprint = {
      app_name: 'Test',
      modules: [{
        name: 'Ambiguous',
        case_type: 'thing',
        forms: [],
      }],
      case_types: [{ name: 'thing', properties: [] }],
    }
    const errors = validateBlueprint(bp)
    expect(errors.some(e => e.includes('set case_list_only: true'))).toBe(true)
  })
})

// ── case_list_only Expansion ───────────────────────────────────────────

describe('case_list_only expansion', () => {
  it('sets case_list.show on case_list_only modules', () => {
    const bp: AppBlueprint = {
      app_name: 'Test',
      modules: [
        {
          name: 'Plans',
          case_type: 'plan',
          forms: [{
            name: 'Create Plan',
            type: 'registration',
            questions: [
              { id: 'case_name', type: 'text', label: 'Plan Name', case_property_on: 'plan' },
            ],
          }],
        },
        {
          name: 'Services',
          case_type: 'service',
          case_list_only: true,
          forms: [],
          case_list_columns: [{ field: 'case_name', header: 'Name' }],
        },
      ],
      case_types: [
        { name: 'plan', properties: [{ name: 'case_name', label: 'Plan Name' }] },
        { name: 'service', parent_type: 'plan', properties: [{ name: 'case_name', label: 'Service Name' }] },
      ],
    }
    const hq = expandBlueprint(bp)
    expect(hq.modules[1].case_list.show).toBe(true)
    expect(hq.modules[1].case_list.label).toEqual({ en: 'Services' })
    expect(hq.modules[0].case_list.show).toBe(false)
  })

  it('sets case_type on case_list_only modules', () => {
    const bp: AppBlueprint = {
      app_name: 'Test',
      modules: [{
        name: 'Services',
        case_type: 'service',
        case_list_only: true,
        forms: [],
        case_list_columns: [{ field: 'case_name', header: 'Name' }],
      }],
      case_types: [{ name: 'service', properties: [{ name: 'case_name', label: 'Name' }] }],
    }
    const hq = expandBlueprint(bp)
    expect(hq.modules[0].case_type).toBe('service')
  })

  it('sets parent_select on child case type modules', () => {
    const bp: AppBlueprint = {
      app_name: 'Test',
      modules: [
        {
          name: 'Plans',
          case_type: 'plan',
          forms: [{
            name: 'Create Plan',
            type: 'registration',
            questions: [
              { id: 'case_name', type: 'text', label: 'Plan Name', case_property_on: 'plan' },
            ],
          }],
        },
        {
          name: 'Services',
          case_type: 'service',
          case_list_only: true,
          forms: [],
          case_list_columns: [{ field: 'case_name', header: 'Name' }],
        },
      ],
      case_types: [
        { name: 'plan', properties: [{ name: 'case_name', label: 'Plan Name' }] },
        { name: 'service', parent_type: 'plan', properties: [{ name: 'case_name', label: 'Service Name' }] },
      ],
    }
    const hq = expandBlueprint(bp)
    expect(hq.modules[1].parent_select.active).toBe(true)
    expect(hq.modules[1].parent_select.module_id).toBe(hq.modules[0].unique_id)
  })
})
