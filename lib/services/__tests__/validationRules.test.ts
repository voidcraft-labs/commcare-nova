import { describe, it, expect } from 'vitest'
import { runValidation } from '../commcare/validate/runner'
import { FIX_REGISTRY } from '../commcare/validate/fixes'
import type { AppBlueprint } from '../../schemas/blueprint'

// ── Helpers ────────────────────────────────────────────────────────

const minBlueprint = (overrides: Partial<AppBlueprint> = {}): AppBlueprint => ({
  app_name: 'Test',
  modules: [{
    name: 'Mod',
    case_type: 'patient',
    case_list_columns: [{ field: 'case_name', header: 'Name' }],
    forms: [{
      name: 'Form',
      type: 'registration',
      questions: [{ id: 'case_name', type: 'text', label: 'Name', case_property_on: 'patient' }],
    }],
  }],
  case_types: [{ name: 'patient', properties: [{ name: 'case_name', label: 'Name' }] }],
  ...overrides,
})

const surveyBlueprint = (questions: AppBlueprint['modules'][0]['forms'][0]['questions']): AppBlueprint => ({
  app_name: 'Test',
  modules: [{ name: 'M', forms: [{ name: 'F', type: 'survey', questions }] }],
  case_types: null,
})

// ── App-level rules ────────────────────────────────────────────────

describe('app rules', () => {
  it('catches empty app name', () => {
    const errors = runValidation(minBlueprint({ app_name: '' }))
    expect(errors.some(e => e.code === 'EMPTY_APP_NAME')).toBe(true)
  })

  it('catches duplicate module names', () => {
    const bp = minBlueprint({
      modules: [
        { name: 'Same', forms: [{ name: 'F1', type: 'survey', questions: [{ id: 'q', type: 'text', label: 'Q' }] }] },
        { name: 'Same', forms: [{ name: 'F2', type: 'survey', questions: [{ id: 'q', type: 'text', label: 'Q' }] }] },
      ],
    })
    const errors = runValidation(bp)
    expect(errors.some(e => e.code === 'DUPLICATE_MODULE_NAME')).toBe(true)
  })

  it('catches child case type missing module', () => {
    const bp = minBlueprint({
      case_types: [
        { name: 'patient', properties: [] },
        { name: 'visit', parent_type: 'patient', properties: [] },
      ],
    })
    const errors = runValidation(bp)
    expect(errors.some(e => e.code === 'MISSING_CHILD_CASE_MODULE')).toBe(true)
  })
})

// ── Module-level rules ─────────────────────────────────────────────

describe('module rules', () => {
  it('catches invalid case_type — starts with digit', () => {
    const bp = minBlueprint()
    bp.modules[0].case_type = '123_bad'
    expect(runValidation(bp).some(e => e.code === 'INVALID_CASE_TYPE_FORMAT')).toBe(true)
  })

  it('catches invalid case_type — contains spaces', () => {
    const bp = minBlueprint()
    bp.modules[0].case_type = 'my case'
    expect(runValidation(bp).some(e => e.code === 'INVALID_CASE_TYPE_FORMAT')).toBe(true)
  })

  it('catches invalid case_type — special characters', () => {
    const bp = minBlueprint()
    bp.modules[0].case_type = 'case@type!'
    expect(runValidation(bp).some(e => e.code === 'INVALID_CASE_TYPE_FORMAT')).toBe(true)
  })

  it('allows valid case_type with hyphens and underscores', () => {
    const bp = minBlueprint()
    bp.modules[0].case_type = 'health-check_v2'
    expect(runValidation(bp).some(e => e.code === 'INVALID_CASE_TYPE_FORMAT')).toBe(false)
  })

  it('catches case_type too long', () => {
    const bp = minBlueprint()
    bp.modules[0].case_type = 'a'.repeat(256)
    expect(runValidation(bp).some(e => e.code === 'CASE_TYPE_TOO_LONG')).toBe(true)
  })

  it('catches missing case list columns', () => {
    const bp = minBlueprint()
    delete (bp.modules[0] as any).case_list_columns
    expect(runValidation(bp).some(e => e.code === 'MISSING_CASE_LIST_COLUMNS')).toBe(true)
  })

  it('does not require columns on case_list_only modules', () => {
    const bp: AppBlueprint = {
      app_name: 'Test',
      modules: [{ name: 'M', case_type: 'c', case_list_only: true, forms: [] }],
      case_types: [{ name: 'c', properties: [] }],
    }
    expect(runValidation(bp).some(e => e.code === 'MISSING_CASE_LIST_COLUMNS')).toBe(false)
  })
})

// ── Form-level rules ───────────────────────────────────────────────

describe('form rules', () => {
  it('allows different questions saving to different case properties', () => {
    const bp = minBlueprint()
    bp.modules[0].forms[0].questions = [
      { id: 'case_name', type: 'text', label: 'Name', case_property_on: 'patient' },
      { id: 'age', type: 'int', label: 'Age', case_property_on: 'patient' },
    ]
    expect(runValidation(bp).some(e => e.code === 'DUPLICATE_CASE_PROPERTY')).toBe(false)
  })

  it('catches registration form with no case properties', () => {
    const bp = minBlueprint()
    bp.modules[0].forms[0].questions = [
      { id: 'q', type: 'text', label: 'Name' }, // no case_property_on
    ]
    expect(runValidation(bp).some(e => e.code === 'REGISTRATION_NO_CASE_PROPS')).toBe(true)
  })

  it('catches case property with bad format (leading digit)', () => {
    // Use a valid question ID that is also used as case property name.
    // Since case_property derives from question ID, we need a question ID
    // that's a valid XML name but not a valid CommCare case property.
    // XML allows underscores starting; CommCare case properties also allow that.
    // Leading digits fail both — so use a separate survey form to isolate.
    const bp = minBlueprint()
    bp.modules[0].forms[0].questions = [
      { id: 'case_name', type: 'text', label: 'Name', case_property_on: 'patient' },
      { id: '123bad', type: 'text', label: 'Bad', case_property_on: 'patient' },
    ]
    // This fires both INVALID_QUESTION_ID and CASE_PROPERTY_BAD_FORMAT
    const errors = runValidation(bp)
    expect(errors.some(e => e.code === 'CASE_PROPERTY_BAD_FORMAT')).toBe(true)
    expect(errors.some(e => e.code === 'INVALID_QUESTION_ID')).toBe(true)
  })

  it('catches case property name too long', () => {
    const longId = 'a'.repeat(256)
    const bp = minBlueprint()
    bp.modules[0].forms[0].questions = [
      { id: 'case_name', type: 'text', label: 'Name', case_property_on: 'patient' },
      { id: longId, type: 'text', label: 'Long', case_property_on: 'patient' },
    ]
    expect(runValidation(bp).some(e => e.code === 'CASE_PROPERTY_TOO_LONG')).toBe(true)
  })

  it('allows case_name even though it is technically reserved', () => {
    const bp = minBlueprint() // minBlueprint has case_name with case_property_on
    expect(runValidation(bp).some(e => e.code === 'RESERVED_CASE_PROPERTY')).toBe(false)
  })

  it('duplicate question IDs at the same scope are caught', () => {
    const bp = surveyBlueprint([
      { id: 'name', type: 'text', label: 'A' },
      { id: 'name', type: 'text', label: 'B' },
    ])
    expect(runValidation(bp).some(e => e.code === 'DUPLICATE_QUESTION_ID')).toBe(true)
  })

  it('same question ID in different groups is allowed (different XML paths)', () => {
    const bp = surveyBlueprint([
      { id: 'name', type: 'text', label: 'Top-level name' },
      { id: 'details', type: 'group', label: 'Details', children: [
        { id: 'name', type: 'text', label: 'Nested name' },
      ] },
    ])
    expect(runValidation(bp).some(e => e.code === 'DUPLICATE_QUESTION_ID')).toBe(false)
  })

  it('duplicate question IDs within a group are caught', () => {
    const bp = surveyBlueprint([
      { id: 'grp', type: 'group', label: 'G', children: [
        { id: 'q', type: 'text', label: 'A' },
        { id: 'q', type: 'text', label: 'B' },
      ] },
    ])
    expect(runValidation(bp).some(e => e.code === 'DUPLICATE_QUESTION_ID')).toBe(true)
  })
})

// ── Question-level rules ───────────────────────────────────────────

describe('question rules', () => {
  it('catches question ID starting with digit', () => {
    const errors = runValidation(surveyBlueprint([{ id: '123_bad', type: 'text', label: 'Q' }]))
    expect(errors.some(e => e.code === 'INVALID_QUESTION_ID')).toBe(true)
  })

  it('catches question ID with hyphens (not valid XML element name)', () => {
    const errors = runValidation(surveyBlueprint([{ id: 'my-question', type: 'text', label: 'Q' }]))
    expect(errors.some(e => e.code === 'INVALID_QUESTION_ID')).toBe(true)
  })

  it('allows question IDs with underscores', () => {
    const errors = runValidation(surveyBlueprint([{ id: 'my_question', type: 'text', label: 'Q' }]))
    expect(errors.some(e => e.code === 'INVALID_QUESTION_ID')).toBe(false)
  })

  it('allows question IDs starting with underscore', () => {
    const errors = runValidation(surveyBlueprint([{ id: '_hidden', type: 'text', label: 'Q' }]))
    expect(errors.some(e => e.code === 'INVALID_QUESTION_ID')).toBe(false)
  })
})

// ── Fix registry ───────────────────────────────────────────────────

describe('fix registry', () => {
  it('fixes invalid question ID', () => {
    const bp = surveyBlueprint([{ id: '123-bad', type: 'text', label: 'Q' }])
    const errors = runValidation(bp)
    const err = errors.find(e => e.code === 'INVALID_QUESTION_ID')!
    const fix = FIX_REGISTRY.get('INVALID_QUESTION_ID')!
    expect(fix(err, bp)).toBe(true)
    expect(bp.modules[0].forms[0].questions[0].id).toBe('q_123_bad')
  })

  it('fixes NO_CASE_TYPE by deriving from module name', () => {
    const bp: AppBlueprint = {
      app_name: 'Test',
      modules: [{ name: 'Patient Records', forms: [{
        name: 'F', type: 'registration',
        questions: [{ id: 'case_name', type: 'text', label: 'N' }],
      }] }],
      case_types: null,
    }
    const errors = runValidation(bp)
    const err = errors.find(e => e.code === 'NO_CASE_TYPE')!
    const fix = FIX_REGISTRY.get('NO_CASE_TYPE')!
    expect(fix(err, bp)).toBe(true)
    expect(bp.modules[0].case_type).toBe('patient_records')
  })

  it('fixes SELECT_NO_OPTIONS by adding defaults', () => {
    const bp = surveyBlueprint([{ id: 'q', type: 'single_select', label: 'Q' }])
    const errors = runValidation(bp)
    const err = errors.find(e => e.code === 'SELECT_NO_OPTIONS')!
    const fix = FIX_REGISTRY.get('SELECT_NO_OPTIONS')!
    expect(fix(err, bp)).toBe(true)
    expect(bp.modules[0].forms[0].questions[0].options).toHaveLength(2)
  })
})

// ── Post-submit validation ────────────────────────────────────────

describe('post_submit validation', () => {
  it('accepts valid destinations without errors', () => {
    for (const dest of ['default', 'root', 'module', 'previous'] as const) {
      const bp = minBlueprint()
      bp.modules[0].forms[0].post_submit = dest
      const errors = runValidation(bp)
      expect(errors.filter(e => e.code.startsWith('POST_SUBMIT') || e.code === 'INVALID_POST_SUBMIT')).toEqual([])
    }
  })

  it('catches invalid destination with helpful message', () => {
    const bp = minBlueprint()
    ;(bp.modules[0].forms[0] as any).post_submit = 'nowhere'
    const errors = runValidation(bp)
    const err = errors.find(e => e.code === 'INVALID_POST_SUBMIT')
    expect(err).toBeDefined()
    expect(err!.message).toContain('"nowhere"')
    expect(err!.message).toContain('default')
    expect(err!.message).toContain('module')
    expect(err!.message).toContain('previous')
  })

  it('errors on parent_module since parent modules are not yet supported', () => {
    const bp = minBlueprint()
    bp.modules[0].forms[0].post_submit = 'parent_module'
    const errors = runValidation(bp)
    const err = errors.find(e => e.code === 'POST_SUBMIT_PARENT_MODULE_UNSUPPORTED')
    expect(err).toBeDefined()
    expect(err!.message).toContain("doesn't have a parent module")
    expect(err!.message).toContain('"module"')
    expect(err!.message).toContain('"previous"')
  })

  it('catches module destination on case_list_only modules', () => {
    const bp: AppBlueprint = {
      app_name: 'Test',
      modules: [{
        name: 'View Only',
        case_type: 'patient',
        case_list_only: true,
        forms: [{ name: 'F', type: 'survey', post_submit: 'module', questions: [{ id: 'q', type: 'text', label: 'Q' }] }],
        case_list_columns: [{ field: 'case_name', header: 'Name' }],
      }],
      case_types: [{ name: 'patient', properties: [{ name: 'case_name', label: 'Name' }] }],
    }
    const errors = runValidation(bp)
    const err = errors.find(e => e.code === 'POST_SUBMIT_MODULE_CASE_LIST_ONLY')
    expect(err).toBeDefined()
    expect(err!.message).toContain('case-list-only')
    expect(err!.message).toContain('"previous"')
  })

  it('does not produce errors when post_submit is absent', () => {
    const bp = minBlueprint()
    delete bp.modules[0].forms[0].post_submit
    const errors = runValidation(bp)
    expect(errors.filter(e => e.code.startsWith('POST_SUBMIT') || e.code === 'INVALID_POST_SUBMIT')).toEqual([])
  })
})

// ── Form link validation ──────────────────────────────────────────

describe('form_links validation', () => {
  it('catches empty form_links array', () => {
    const bp = surveyBlueprint([{ id: 'q', type: 'text', label: 'Q' }])
    bp.modules[0].forms[0].form_links = []
    const errors = runValidation(bp)
    expect(errors.find(e => e.code === 'FORM_LINK_EMPTY')).toBeDefined()
  })

  it('catches non-existent target module', () => {
    const bp = surveyBlueprint([{ id: 'q', type: 'text', label: 'Q' }])
    bp.modules[0].forms[0].form_links = [
      { target: { type: 'form', moduleIndex: 99, formIndex: 0 } },
    ]
    const errors = runValidation(bp)
    const err = errors.find(e => e.code === 'FORM_LINK_TARGET_NOT_FOUND')
    expect(err).toBeDefined()
    expect(err!.message).toContain('module 99')
  })

  it('catches non-existent target form', () => {
    const bp: AppBlueprint = {
      app_name: 'Test',
      modules: [
        { name: 'M0', forms: [
          { name: 'F0', type: 'survey', questions: [{ id: 'q', type: 'text', label: 'Q' }],
            form_links: [{ target: { type: 'form', moduleIndex: 0, formIndex: 99 } }] },
        ]},
      ],
      case_types: null,
    }
    const errors = runValidation(bp)
    const err = errors.find(e => e.code === 'FORM_LINK_TARGET_NOT_FOUND')
    expect(err).toBeDefined()
    expect(err!.message).toContain('form 99')
  })

  it('catches self-referencing link', () => {
    const bp = surveyBlueprint([{ id: 'q', type: 'text', label: 'Q' }])
    bp.modules[0].forms[0].form_links = [
      { target: { type: 'form', moduleIndex: 0, formIndex: 0 } },
    ]
    const errors = runValidation(bp)
    expect(errors.find(e => e.code === 'FORM_LINK_SELF_REFERENCE')).toBeDefined()
  })

  it('catches conditional links without post_submit fallback', () => {
    const bp: AppBlueprint = {
      app_name: 'Test',
      modules: [
        { name: 'M0', forms: [
          { name: 'F0', type: 'survey', questions: [{ id: 'q', type: 'text', label: 'Q' }],
            form_links: [{ condition: 'x = 1', target: { type: 'form', moduleIndex: 0, formIndex: 1 } }] },
          { name: 'F1', type: 'survey', questions: [{ id: 'q', type: 'text', label: 'Q' }] },
        ]},
      ],
      case_types: null,
    }
    const errors = runValidation(bp)
    expect(errors.find(e => e.code === 'FORM_LINK_NO_FALLBACK')).toBeDefined()
  })

  it('accepts conditional links when post_submit fallback is set', () => {
    const bp: AppBlueprint = {
      app_name: 'Test',
      modules: [
        { name: 'M0', forms: [
          { name: 'F0', type: 'survey', questions: [{ id: 'q', type: 'text', label: 'Q' }],
            post_submit: 'module',
            form_links: [{ condition: 'x = 1', target: { type: 'form', moduleIndex: 0, formIndex: 1 } }] },
          { name: 'F1', type: 'survey', questions: [{ id: 'q', type: 'text', label: 'Q' }] },
        ]},
      ],
      case_types: null,
    }
    const errors = runValidation(bp)
    expect(errors.find(e => e.code === 'FORM_LINK_NO_FALLBACK')).toBeUndefined()
  })

  it('detects circular form links at app level', () => {
    const bp: AppBlueprint = {
      app_name: 'Test',
      modules: [{
        name: 'M0', forms: [
          { name: 'F0', type: 'survey', questions: [{ id: 'q', type: 'text', label: 'Q' }],
            form_links: [{ target: { type: 'form', moduleIndex: 0, formIndex: 1 } }] },
          { name: 'F1', type: 'survey', questions: [{ id: 'q', type: 'text', label: 'Q' }],
            form_links: [{ target: { type: 'form', moduleIndex: 0, formIndex: 0 } }] },
        ],
      }],
      case_types: null,
    }
    const errors = runValidation(bp)
    expect(errors.find(e => e.code === 'FORM_LINK_CIRCULAR')).toBeDefined()
  })

  it('accepts valid form links', () => {
    const bp: AppBlueprint = {
      app_name: 'Test',
      modules: [{
        name: 'M0', forms: [
          { name: 'F0', type: 'survey', questions: [{ id: 'q', type: 'text', label: 'Q' }],
            form_links: [{ target: { type: 'form', moduleIndex: 0, formIndex: 1 } }] },
          { name: 'F1', type: 'survey', questions: [{ id: 'q', type: 'text', label: 'Q' }] },
        ],
      }],
      case_types: null,
    }
    const errors = runValidation(bp)
    const linkErrors = errors.filter(e => e.code.startsWith('FORM_LINK'))
    expect(linkErrors).toEqual([])
  })

  it('accepts module target links', () => {
    const bp: AppBlueprint = {
      app_name: 'Test',
      modules: [
        { name: 'M0', forms: [
          { name: 'F0', type: 'survey', questions: [{ id: 'q', type: 'text', label: 'Q' }],
            form_links: [{ target: { type: 'module', moduleIndex: 1 } }] },
        ]},
        { name: 'M1', forms: [
          { name: 'F0', type: 'survey', questions: [{ id: 'q', type: 'text', label: 'Q' }] },
        ]},
      ],
      case_types: null,
    }
    const errors = runValidation(bp)
    expect(errors.filter(e => e.code.startsWith('FORM_LINK'))).toEqual([])
  })
})
