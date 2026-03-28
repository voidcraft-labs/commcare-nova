import { describe, it, expect } from 'vitest'
import { deriveConnectDefaults } from '../connectConfig'
import { expandBlueprint } from '../hqJsonExpander'
import { runValidation } from '../commcare/validate/runner'
import { MutableBlueprint } from '../mutableBlueprint'
import type { AppBlueprint, BlueprintForm, ConnectConfig } from '../../schemas/blueprint'

// ── Helpers ──────────────────────────────────────────────────────────

function makeLearnForm(connect?: ConnectConfig, questions: BlueprintForm['questions'] = []): BlueprintForm {
  return {
    name: 'ILC Training',
    type: 'survey',
    connect,
    questions: questions.length ? questions : [
      { id: 'intro', type: 'label', label: 'Welcome to the training module' },
      { id: 'q1', type: 'single_select', label: 'What is the correct dosage?', options: [{ value: 'a', label: '10mg' }, { value: 'b', label: '20mg' }] },
      { id: 'q2', type: 'single_select', label: 'How often should you check?', options: [{ value: 'daily', label: 'Daily' }, { value: 'weekly', label: 'Weekly' }] },
      { id: 'assessment_score', type: 'hidden', calculate: "if(/data/q1 = 'b' and /data/q2 = 'daily', 100, 0)" },
    ],
  }
}

function makeDeliverForm(connect?: ConnectConfig): BlueprintForm {
  return {
    name: 'Weekly Report',
    type: 'survey',
    connect,
    questions: [
      { id: 'report_date', type: 'date', label: 'Report Date', required: 'true()' },
      { id: 'chlorine_level', type: 'int', label: 'Chlorine Level', validation: '. >= 0 and . <= 10' },
    ],
  }
}

function makeConnectBlueprint(connectType: 'learn' | 'deliver', form: BlueprintForm): AppBlueprint {
  return {
    app_name: 'Connect Test App',
    connect_type: connectType,
    modules: [{ name: 'Main', forms: [form] }],
    case_types: null,
  }
}

// ── deriveConnectDefaults ────────────────────────────────────────────

describe('deriveConnectDefaults', () => {
  it('does nothing when form has no connect config', () => {
    const form = makeLearnForm()
    deriveConnectDefaults('learn', form)
    expect(form.connect).toBeUndefined()
  })

  it('auto-populates learn_module from form name and question count', () => {
    const form = makeLearnForm({})
    deriveConnectDefaults('learn', form)
    expect(form.connect!.learn_module).toEqual({
      name: 'ILC Training',
      description: 'ILC Training',
      time_estimate: 2, // 4 questions / 3, rounded up, min 1
    })
  })

  it('auto-detects assessment score from hidden question with score in id', () => {
    const form = makeLearnForm({})
    deriveConnectDefaults('learn', form)
    expect(form.connect!.assessment).toEqual({
      user_score: "if(/data/q1 = 'b' and /data/q2 = 'daily', 100, 0)",
    })
  })

  it('does not overwrite existing learn_module', () => {
    const form = makeLearnForm({
      learn_module: { name: 'Custom Name', description: 'Custom Desc', time_estimate: 10 },
    })
    deriveConnectDefaults('learn', form)
    expect(form.connect!.learn_module!.name).toBe('Custom Name')
    expect(form.connect!.learn_module!.time_estimate).toBe(10)
  })

  it('does not overwrite existing assessment', () => {
    const form = makeLearnForm({
      assessment: { user_score: '50' },
    })
    deriveConnectDefaults('learn', form)
    expect(form.connect!.assessment!.user_score).toBe('50')
  })

  it('auto-populates deliver_unit with sensible defaults', () => {
    const form = makeDeliverForm({})
    deriveConnectDefaults('deliver', form)
    expect(form.connect!.deliver_unit).toEqual({
      name: 'Weekly Report',
      entity_id: "concat(#user/username, '-', today())",
      entity_name: "#user/username",
    })
  })

  it('does not overwrite existing deliver_unit', () => {
    const form = makeDeliverForm({
      deliver_unit: { name: 'Custom Unit', entity_id: 'custom_id', entity_name: 'custom_name' },
    })
    deriveConnectDefaults('deliver', form)
    expect(form.connect!.deliver_unit!.name).toBe('Custom Unit')
  })

  it('handles learn form with no score question', () => {
    const form: BlueprintForm = {
      name: 'Simple Learn',
      type: 'survey',
      connect: {},
      questions: [
        { id: 'content', type: 'label', label: 'Read this.' },
      ],
    }
    deriveConnectDefaults('learn', form)
    expect(form.connect!.learn_module).toBeDefined()
    expect(form.connect!.assessment).toEqual({ user_score: '100' })
  })
})

// ── XForm Export ─────────────────────────────────────────────────────

describe('Connect XForm export', () => {
  it('generates correct learn module data block', () => {
    const form = makeLearnForm({
      learn_module: { name: 'ILC Module', description: 'Training for ILC', time_estimate: 5 },
    })
    const bp = makeConnectBlueprint('learn', form)
    const hq = expandBlueprint(bp)
    const xml = Object.values(hq._attachments)[0] as string

    expect(xml).toContain('<connect_learn vellum:role="ConnectLearnModule">')
    expect(xml).toContain('xmlns="http://commcareconnect.com/data/v1/learn"')
    expect(xml).toContain('<name>ILC Module</name>')
    expect(xml).toContain('<description>Training for ILC</description>')
    expect(xml).toContain('<time_estimate>5</time_estimate>')
    expect(xml).toContain('</connect_learn>')
  })

  it('generates correct assessment block with calculate bind', () => {
    const form = makeLearnForm({
      learn_module: { name: 'Test', description: 'Test', time_estimate: 1 },
      assessment: { user_score: '100' },
    })
    const bp = makeConnectBlueprint('learn', form)
    const hq = expandBlueprint(bp)
    const xml = Object.values(hq._attachments)[0] as string

    expect(xml).toContain('<connect_assessment vellum:role="ConnectAssessment">')
    expect(xml).toContain('<user_score/>')
    expect(xml).toContain('nodeset="/data/connect_assessment/assessment/user_score" calculate="100"')
  })

  it('generates correct deliver unit block with XPath binds', () => {
    const form = makeDeliverForm({
      deliver_unit: {
        name: 'Weekly Report',
        entity_id: "concat('user', '-', today())",
        entity_name: "'test_user'",
      },
    })
    const bp = makeConnectBlueprint('deliver', form)
    const hq = expandBlueprint(bp)
    const xml = Object.values(hq._attachments)[0] as string

    expect(xml).toContain('<connect_deliver vellum:role="ConnectDeliverUnit">')
    expect(xml).toContain('<deliver xmlns="http://commcareconnect.com/data/v1/learn"')
    expect(xml).toContain('<name>Weekly Report</name>')
    expect(xml).toContain('<entity_id/>')
    expect(xml).toContain('<entity_name/>')
    expect(xml).toContain('nodeset="/data/connect_deliver/deliver/entity_id"')
    expect(xml).toContain('nodeset="/data/connect_deliver/deliver/entity_name"')
  })

  it('generates task block', () => {
    const form = makeDeliverForm({
      deliver_unit: { name: 'Unit', entity_id: "'id'", entity_name: "'name'" },
      task: { name: 'Delivery Task', description: 'Complete the delivery' },
    })
    const bp = makeConnectBlueprint('deliver', form)
    const hq = expandBlueprint(bp)
    const xml = Object.values(hq._attachments)[0] as string

    expect(xml).toContain('<connect_task vellum:role="ConnectTask">')
    expect(xml).toContain('<name>Delivery Task</name>')
    expect(xml).toContain('<description>Complete the delivery</description>')
  })

  it('includes secondary instances when Connect XPaths reference session data', () => {
    const form = makeDeliverForm({
      deliver_unit: {
        name: 'Unit',
        entity_id: "concat(#user/username, '-', today())",
        entity_name: "#user/username",
      },
    })
    const bp = makeConnectBlueprint('deliver', form)
    const hq = expandBlueprint(bp)
    const xml = Object.values(hq._attachments)[0] as string

    expect(xml).toContain('id="commcaresession"')
  })

  it('does not emit Connect blocks when connect is absent', () => {
    const form = makeLearnForm()
    const bp = makeConnectBlueprint('learn', form)
    const hq = expandBlueprint(bp)
    const xml = Object.values(hq._attachments)[0] as string

    expect(xml).not.toContain('commcareconnect.com')
    expect(xml).not.toContain('connect_learn')
  })
})

// ── Validation ──────────────────────────────────────────────────────

describe('Connect validation', () => {
  it('validates learn form missing learn_module', () => {
    const form = makeLearnForm({})
    const bp = makeConnectBlueprint('learn', form)
    const errors = runValidation(bp)
    expect(errors.some(e => e.code === 'CONNECT_MISSING_LEARN')).toBe(true)
  })

  it('validates deliver form missing deliver_unit', () => {
    const form = makeDeliverForm({})
    const bp = makeConnectBlueprint('deliver', form)
    const errors = runValidation(bp)
    expect(errors.some(e => e.code === 'CONNECT_MISSING_DELIVER')).toBe(true)
  })

  it('passes validation for well-formed learn config', () => {
    const form = makeLearnForm({
      learn_module: { name: 'Module', description: 'Desc', time_estimate: 5 },
      assessment: { user_score: '100' },
    })
    const bp = makeConnectBlueprint('learn', form)
    const errors = runValidation(bp)
    expect(errors).toHaveLength(0)
  })

  it('passes validation for well-formed deliver config', () => {
    const form = makeDeliverForm({
      deliver_unit: {
        name: 'Unit',
        entity_id: "concat('user', '-', today())",
        entity_name: "'test_user'",
      },
    })
    const bp = makeConnectBlueprint('deliver', form)
    const errors = runValidation(bp)
    expect(errors).toHaveLength(0)
  })
})

// ── MutableBlueprint ────────────────────────────────────────────────

describe('MutableBlueprint Connect support', () => {
  it('setScaffold stores app-level connect_type', () => {
    const mb = new MutableBlueprint({ app_name: '', modules: [], case_types: null })
    mb.setScaffold({
      app_name: 'Connect App',
      connect_type: 'learn',
      modules: [{
        name: 'Training',
        case_type: null,
        forms: [{ name: 'Learn Form', type: 'survey' }],
      }],
    })
    expect(mb.getBlueprint().connect_type).toBe('learn')
  })

  it('setScaffold ignores empty connect_type', () => {
    const mb = new MutableBlueprint({ app_name: '', modules: [], case_types: null })
    mb.setScaffold({
      app_name: 'Normal App',
      connect_type: '',
      modules: [{
        name: 'Main',
        case_type: null,
        forms: [{ name: 'Survey', type: 'survey' }],
      }],
    })
    expect(mb.getBlueprint().connect_type).toBeUndefined()
  })

  it('updateForm sets connect config', () => {
    const mb = new MutableBlueprint({
      app_name: 'Test',
      connect_type: 'learn',
      modules: [{ name: 'M', forms: [{ name: 'F', type: 'survey', questions: [] }] }],
      case_types: null,
    })
    mb.updateForm(0, 0, {
      connect: { learn_module: { name: 'Mod', description: 'Desc', time_estimate: 5 } },
    })
    expect(mb.getForm(0, 0)!.connect!.learn_module!.name).toBe('Mod')
  })

  it('updateForm removes connect with null', () => {
    const mb = new MutableBlueprint({
      app_name: 'Test',
      connect_type: 'learn',
      modules: [{ name: 'M', forms: [{ name: 'F', type: 'survey', connect: {}, questions: [] }] }],
      case_types: null,
    })
    mb.updateForm(0, 0, { connect: null })
    expect(mb.getForm(0, 0)!.connect).toBeUndefined()
  })
})
