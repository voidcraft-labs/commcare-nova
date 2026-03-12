import { describe, it, expect } from 'vitest'
import { expandBlueprint, validateBlueprint } from '../hqJsonExpander'
import type { AppBlueprint } from '../../schemas/blueprint'

/** Helper to create a localized string from plain text. */
function L(text: string): Array<{ lang: string; text: string }> {
  return [{ lang: 'en', text }]
}

/** Minimal followup form with a #case/ calculate — the scenario that broke builds. */
const followupBlueprint: AppBlueprint = {
  app_name: 'Test App',
  modules: [{
    name: L('Visits'),
    case_type: 'patient',
    forms: [{
      name: L('Follow-up Visit'),
      type: 'followup',
      case_properties: [{ case_property: 'total_visits', question_id: 'visit_number' }],
      case_preload: [{ question_id: 'visit_number', case_property: 'total_visits' }, { question_id: 'display_name', case_property: 'full_name' }],
      questions: [
        { id: 'client_info', type: 'group', label: L('Client Info'), children: [
          { id: 'display_name', type: 'text', label: L('Name'), readonly: true },
        ]},
        { id: 'visit_number', type: 'hidden', calculate: '#case/total_visits + 1' },
        { id: 'notes', type: 'text', label: L('Notes') },
      ],
    }],
    case_list_columns: [{ field: 'full_name', header: L('Name') }],
  }],
}

/** Registration form with case properties. */
const registrationBlueprint: AppBlueprint = {
  app_name: 'Reg App',
  modules: [{
    name: L('Registration'),
    case_type: 'patient',
    forms: [{
      name: L('Register Patient'),
      type: 'registration',
      case_name_field: 'full_name',
      case_properties: [{ case_property: 'age', question_id: 'patient_age' }],
      questions: [
        { id: 'full_name', type: 'text', label: L('Full Name'), required: 'true()', is_case_name: true },
        { id: 'patient_age', type: 'int', label: L('Age'), constraint: '. > 0 and . < 150' },
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
        name: L('M'), case_type: 'case', forms: [{
          name: L('F'), type: 'followup',
          case_preload: [{ question_id: 'nested_q', case_property: 'some_prop' }],
          questions: [{
            id: 'grp', type: 'group', label: L('G'), children: [
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
        name: L('M'), forms: [{
          name: L('F'), type: 'survey',
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
        name: L('M'), case_type: 'c', forms: [{
          name: L('F'), type: 'followup',
          case_preload: [{ question_id: 'display_name', case_property: 'full_name' }],
          questions: [{ id: 'display_name', type: 'text', label: L('Name'), readonly: true, default_value: '#case/full_name' }],
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
        name: L('M'), case_type: 'case', forms: [
          {
            name: L('Conditional Close'), type: 'followup',
            close_case: { question: 'confirm', answer: 'yes' },
            questions: [
              { id: 'confirm', type: 'select1', label: L('Close?'), options: [
                { value: 'yes', label: L('Yes') }, { value: 'no', label: L('No') },
              ]},
            ],
          },
          {
            name: L('Always Close'), type: 'followup',
            close_case: {},
            questions: [{ id: 'note', type: 'text', label: L('Note') }],
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
      name: L('M'), case_type: 'patient', forms: [{
        name: L('F'), type: 'registration', case_name_field: 'q',
        questions: [{ id: 'q', type: 'text', label: L('Name'), is_case_name: true }],
      }],
      case_list_columns: [{ field: 'case_name', header: L('Full Name') }, { field: 'age', header: L('Age') }],
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
        name: L('M'), forms: [{
          name: L('F'), type: 'registration', case_name_field: 'q',
          questions: [{ id: 'q', type: 'text', label: L('Q') }],
        }],
      }],
    }
    const errors = validateBlueprint(bp)
    expect(errors.some(e => e.includes('case_type'))).toBe(true)
  })

  it('catches reserved case property names', () => {
    const bp: AppBlueprint = {
      app_name: 'Bad', modules: [{
        name: L('M'), case_type: 'c', forms: [{
          name: L('F'), type: 'registration', case_name_field: 'q',
          case_properties: [{ case_property: 'name', question_id: 'q' }],
          questions: [{ id: 'q', type: 'text', label: L('Q') }],
        }],
      }],
    }
    const errors = validateBlueprint(bp)
    expect(errors.some(e => e.includes('reserved'))).toBe(true)
  })

  it('catches dangling case_properties question references', () => {
    const bp: AppBlueprint = {
      app_name: 'Bad', modules: [{
        name: L('M'), case_type: 'c', forms: [{
          name: L('F'), type: 'registration', case_name_field: 'q',
          case_properties: [{ case_property: 'foo', question_id: 'nonexistent' }],
          questions: [{ id: 'q', type: 'text', label: L('Q') }],
        }],
      }],
    }
    const errors = validateBlueprint(bp)
    expect(errors.some(e => e.includes('nonexistent'))).toBe(true)
  })
})

// ── Feature 1: Output References in Labels ──────────────────────────────

describe('output references in labels', () => {
  it('preserves <output value="..."/> in label itext, escaping surrounding text', () => {
    const bp: AppBlueprint = {
      app_name: 'Output', modules: [{
        name: L('M'), forms: [{
          name: L('F'), type: 'survey',
          questions: [
            { id: 'name', type: 'text', label: L('Name') },
            { id: 'greeting', type: 'trigger', label: L('Hello <output value="/data/name"/>, welcome!') },
          ],
        }],
      }],
    }
    const hq = expandBlueprint(bp)
    const xform: string = Object.values(hq._attachments)[0] as string
    expect(xform).toContain('<text id="greeting-label"><value>Hello <output value="/data/name"/>, welcome!</value></text>')
  })

  it('expands #case/ hashtags inside <output value="..."/> tags', () => {
    const bp: AppBlueprint = {
      app_name: 'Output', modules: [{
        name: L('M'), case_type: 'c', forms: [{
          name: L('F'), type: 'followup',
          case_preload: [{ question_id: 'n', case_property: 'full_name' }],
          questions: [
            { id: 'n', type: 'text', label: L('Name'), readonly: true },
            { id: 'msg', type: 'trigger', label: L('Patient: <output value="#case/full_name"/>') },
          ],
        }],
      }],
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
        name: L('M'), forms: [{
          name: L('F'), type: 'survey',
          questions: [
            { id: 'q', type: 'text', label: L('Name'), help: L('Enter the full legal name as shown on ID') },
          ],
        }],
      }],
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
        name: L('M'), forms: [{
          name: L('F'), type: 'survey',
          questions: [{ id: 'q', type: 'text', label: L('Name') }],
        }],
      }],
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
        name: L('M'), forms: [{
          name: L('F'), type: 'survey',
          questions: [{ id: 'q', type: 'text', label: L('Q'), required: 'true()' }],
        }],
      }],
    }
    const hq = expandBlueprint(bp)
    const xform: string = Object.values(hq._attachments)[0] as string
    expect(xform).toContain('required="true()"')
  })

  it('generates required XPath expression for string required', () => {
    const bp: AppBlueprint = {
      app_name: 'R', modules: [{
        name: L('M'), forms: [{
          name: L('F'), type: 'survey',
          questions: [
            { id: 'consent', type: 'select1', label: L('Consent?'), options: [{ value: 'yes', label: L('Yes') }, { value: 'no', label: L('No') }] },
            { id: 'details', type: 'text', label: L('Details'), required: "/data/consent = 'yes'" },
          ],
        }],
      }],
    }
    const hq = expandBlueprint(bp)
    const xform: string = Object.values(hq._attachments)[0] as string
    expect(xform).toContain("required=\"/data/consent = &apos;yes&apos;\"")
    expect(xform).not.toContain('required="true()"')
  })

  it('expands #case/ hashtags in required XPath and adds vellum:required', () => {
    const bp: AppBlueprint = {
      app_name: 'R', modules: [{
        name: L('M'), case_type: 'c', forms: [{
          name: L('F'), type: 'followup',
          case_preload: [{ question_id: 'q', case_property: 'risk' }],
          questions: [
            { id: 'q', type: 'text', label: L('Q'), readonly: true },
            { id: 'notes', type: 'text', label: L('Notes'), required: "#case/risk = 'high'" },
          ],
        }],
      }],
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
        name: L('M'), case_type: 'c', forms: [{
          name: L('F'), type: 'registration', case_name_field: 'q',
          questions: [{ id: 'q', type: 'text', label: L('Name'), is_case_name: true }],
        }],
        case_list_columns: [{ field: 'case_name', header: L('Name') }, { field: 'age', header: L('Age') }],
      }],
    }
    const hq = expandBlueprint(bp)
    const longCols = hq.modules[0].case_details.long.columns
    expect(longCols.length).toBe(2)
    expect(longCols[0].field).toBe('case_name')
  })

  it('uses explicit case_detail_columns for long detail when provided', () => {
    const bp: AppBlueprint = {
      app_name: 'D', modules: [{
        name: L('M'), case_type: 'c', forms: [{
          name: L('F'), type: 'registration', case_name_field: 'q',
          questions: [{ id: 'q', type: 'text', label: L('Name'), is_case_name: true }],
        }],
        case_list_columns: [{ field: 'case_name', header: L('Name') }],
        case_detail_columns: [
          { field: 'case_name', header: L('Full Name') },
          { field: 'age', header: L('Age') },
          { field: 'dob', header: L('Date of Birth') },
        ],
      }],
    }
    const hq = expandBlueprint(bp)
    const longCols = hq.modules[0].case_details.long.columns
    expect(longCols.length).toBe(3)
    expect(longCols[0].header.en).toBe('Full Name')
    expect(longCols[2].field).toBe('dob')
  })
})

// ── Feature 5: Multi-Language Support ───────────────────────────────────

describe('multi-language support', () => {
  it('generates multiple translation blocks for multilingual apps', () => {
    const bp: AppBlueprint = {
      app_name: 'ML', languages: ['en', 'hin'],
      modules: [{
        name: L('M'), forms: [{
          name: L('F'), type: 'survey',
          questions: [{
            id: 'name', type: 'text',
            label: [{ lang: 'en', text: 'Patient Name' }, { lang: 'hin', text: 'रोगी का नाम' }],
            hint: [{ lang: 'en', text: 'Enter full name' }, { lang: 'hin', text: 'पूरा नाम दर्ज करें' }],
          }],
        }],
      }],
    }
    const hq = expandBlueprint(bp)
    const xform: string = Object.values(hq._attachments)[0] as string
    expect(xform).toContain('lang="en" default=""')
    expect(xform).toContain('lang="hin"')
    expect(xform).toContain('Patient Name')
    expect(xform).toContain('रोगी का नाम')
    expect(xform).toContain('Enter full name')
    expect(xform).toContain('पूरा नाम दर्ज करें')
  })

  it('sets langs on the HQ application shell', () => {
    const bp: AppBlueprint = {
      app_name: 'ML', languages: ['en', 'fra'],
      modules: [{
        name: L('M'), forms: [{
          name: L('F'), type: 'survey',
          questions: [{ id: 'q', type: 'text', label: L('Q') }],
        }],
      }],
    }
    const hq = expandBlueprint(bp)
    expect(hq.langs).toEqual(['en', 'fra'])
  })

  it('falls back to plain string for all languages when label is not a record', () => {
    const bp: AppBlueprint = {
      app_name: 'ML', languages: ['en', 'hin'],
      modules: [{
        name: L('M'), forms: [{
          name: L('F'), type: 'survey',
          questions: [{ id: 'q', type: 'text', label: L('Simple Label') }],
        }],
      }],
    }
    const hq = expandBlueprint(bp)
    const xform: string = Object.values(hq._attachments)[0] as string
    // Both translations should contain the same label
    const matches = xform.match(/Simple Label/g) || []
    expect(matches.length).toBe(2) // one per language
  })
})

// ── Feature 6: jr-insert for Repeat Defaults ────────────────────────────

describe('jr-insert for repeat defaults', () => {
  it('uses jr-insert event for default_value inside repeat groups', () => {
    const bp: AppBlueprint = {
      app_name: 'Rep', modules: [{
        name: L('M'), forms: [{
          name: L('F'), type: 'survey',
          questions: [{
            id: 'items', type: 'repeat', label: L('Items'), children: [
              { id: 'status', type: 'hidden', default_value: "'pending'" },
            ],
          }],
        }],
      }],
    }
    const hq = expandBlueprint(bp)
    const xform: string = Object.values(hq._attachments)[0] as string
    expect(xform).toContain('event="jr-insert"')
    expect(xform).not.toContain('event="xforms-ready"')
  })

  it('uses xforms-ready event for default_value outside repeat groups', () => {
    const bp: AppBlueprint = {
      app_name: 'NR', modules: [{
        name: L('M'), forms: [{
          name: L('F'), type: 'survey',
          questions: [
            { id: 'status', type: 'hidden', default_value: "'pending'" },
          ],
        }],
      }],
    }
    const hq = expandBlueprint(bp)
    const xform: string = Object.values(hq._attachments)[0] as string
    expect(xform).toContain('event="xforms-ready"')
    expect(xform).not.toContain('event="jr-insert"')
  })

  it('adds jr:template="" attribute on repeat data elements', () => {
    const bp: AppBlueprint = {
      app_name: 'Rep', modules: [{
        name: L('M'), forms: [{
          name: L('F'), type: 'survey',
          questions: [{
            id: 'items', type: 'repeat', label: L('Items'), children: [
              { id: 'item_name', type: 'text', label: L('Item') },
            ],
          }],
        }],
      }],
    }
    const hq = expandBlueprint(bp)
    const xform: string = Object.values(hq._attachments)[0] as string
    expect(xform).toContain('<items jr:template="">')
  })
})
