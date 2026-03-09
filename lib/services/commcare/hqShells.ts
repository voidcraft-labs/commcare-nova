/** Factory functions for boilerplate HQ JSON structures. */

import type {
  FormActionCondition, FormActions, DetailBase, DetailColumn, DetailPair,
  HqApplication, HqForm, HqModule,
} from './hqTypes'

// ── Condition factories ──────────────────────────────────────────────

export function neverCondition(): FormActionCondition {
  return { type: 'never', question: null, answer: null, operator: null, doc_type: 'FormActionCondition' }
}

export function alwaysCondition(): FormActionCondition {
  return { type: 'always', question: null, answer: null, operator: null, doc_type: 'FormActionCondition' }
}

export function ifCondition(question: string, answer: string): FormActionCondition {
  return { type: 'if', question, answer, operator: '=', doc_type: 'FormActionCondition' }
}

// ── Form actions ─────────────────────────────────────────────────────

export function emptyFormActions(): FormActions {
  return {
    doc_type: 'FormActions',
    open_case: {
      doc_type: 'OpenCaseAction',
      name_update: { question_path: '' },
      external_id: null,
      condition: neverCondition(),
    },
    update_case: {
      doc_type: 'UpdateCaseAction',
      update: {},
      condition: neverCondition(),
    },
    close_case: { doc_type: 'FormAction', condition: neverCondition() },
    case_preload: { doc_type: 'PreloadAction', preload: {}, condition: neverCondition() },
    subcases: [],
    usercase_preload: { doc_type: 'PreloadAction', preload: {}, condition: neverCondition() },
    usercase_update: { doc_type: 'UpdateCaseAction', update: {}, condition: neverCondition() },
    load_from_form: { doc_type: 'PreloadAction', preload: {}, condition: neverCondition() },
  }
}

// ── Detail / case list ───────────────────────────────────────────────

function detailBase(): DetailBase {
  return {
    sort_elements: [], tabs: [], filter: null,
    lookup_enabled: false, lookup_autolaunch: false, lookup_display_results: false,
    lookup_name: null, lookup_image: null, lookup_action: null,
    lookup_field_template: null, lookup_field_header: {},
    lookup_extras: [], lookup_responses: [],
    persist_case_context: null, persistent_case_context_xml: 'case_name',
    persist_tile_on_forms: null, persistent_case_tile_from_module: null,
    pull_down_tile: null, case_tile_template: null,
    custom_xml: null, custom_variables: null,
  }
}

export function detailColumn(field: string, header: string): DetailColumn {
  return {
    doc_type: 'DetailColumn',
    header: { en: header },
    field,
    model: 'case',
    format: 'plain',
    calc_xpath: '.', filter_xpath: '', advanced: '',
    late_flag: 30, time_ago_interval: 365.25,
    useXpathExpression: false, hasNodeset: false, hasAutocomplete: false,
    isTab: false, enum: [], graph_configuration: null,
    relevant: '', case_tile_field: null, nodeset: '',
  }
}

/** Build a DetailPair from short columns. Long detail is always empty. */
export function detailPair(shortColumns: DetailColumn[]): DetailPair {
  return {
    doc_type: 'DetailPair',
    short: { doc_type: 'Detail', display: 'short', columns: shortColumns, ...detailBase() },
    long: { doc_type: 'Detail', display: 'long', columns: [], ...detailBase() },
  }
}

// ── Top-level shells ─────────────────────────────────────────────────

export function applicationShell(
  appName: string,
  modules: HqModule[],
  attachments: Record<string, string>,
): HqApplication {
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
    _attachments: attachments,
  }
}

export function formShell(
  uniqueId: string,
  name: string,
  xmlns: string,
  requires: string,
  actions: FormActions,
  caseRefsLoad: Record<string, string[]>,
): HqForm {
  return {
    doc_type: 'Form',
    form_type: 'module_form',
    unique_id: uniqueId,
    name: { en: name },
    xmlns,
    requires,
    version: null,
    actions,
    case_references_data: { load: caseRefsLoad, save: {}, doc_type: 'CaseReferences' },
    form_filter: null,
    post_form_workflow: 'default',
    no_vellum: false,
    media_image: {}, media_audio: {}, custom_icons: [],
    custom_assertions: [], custom_instances: [], form_links: [],
    comment: '',
  }
}

export function moduleShell(
  uniqueId: string,
  name: string,
  caseType: string,
  forms: HqForm[],
  caseDetails: DetailPair,
): HqModule {
  return {
    doc_type: 'Module',
    module_type: 'basic',
    unique_id: uniqueId,
    name: { en: name },
    case_type: caseType,
    put_in_root: false,
    root_module_id: null,
    forms,
    case_details: caseDetails,
    case_list: { doc_type: 'CaseList', show: false, label: {}, media_image: {}, media_audio: {}, custom_icons: [] },
    case_list_form: { doc_type: 'CaseListForm', form_id: null, label: {} },
    search_config: { doc_type: 'CaseSearch', properties: [], default_properties: [], include_closed: false },
    display_style: 'list',
    media_image: {}, media_audio: {}, custom_icons: [],
    is_training_module: false, module_filter: null, auto_select_case: false,
    parent_select: { active: false, module_id: null },
    comment: '',
  }
}
