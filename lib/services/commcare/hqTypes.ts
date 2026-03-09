/** TypeScript interfaces for CommCare HQ import JSON structures. */

export interface LocalizedString {
  en: string
  [lang: string]: string
}

export interface FormActionCondition {
  type: 'never' | 'always' | 'if'
  question: string | null
  answer: string | null
  operator: string | null
  doc_type: 'FormActionCondition'
}

export interface OpenCaseAction {
  doc_type: 'OpenCaseAction'
  name_update: { question_path: string }
  external_id: null
  condition: FormActionCondition
}

export interface UpdateCaseAction {
  doc_type: 'UpdateCaseAction'
  update: Record<string, { question_path: string; update_mode: string }>
  condition: FormActionCondition
}

export interface PreloadAction {
  doc_type: 'PreloadAction'
  preload: Record<string, string>
  condition: FormActionCondition
}

export interface FormAction {
  doc_type: 'FormAction'
  condition: FormActionCondition
}

export interface OpenSubCaseAction {
  doc_type: 'OpenSubCaseAction'
  case_type: string
  name_update: { question_path: string; update_mode: string }
  reference_id: string
  case_properties: Record<string, { question_path: string; update_mode: string }>
  repeat_context: string
  relationship: string
  close_condition: FormActionCondition
  condition: FormActionCondition
}

export interface FormActions {
  doc_type: 'FormActions'
  open_case: OpenCaseAction
  update_case: UpdateCaseAction
  close_case: FormAction
  case_preload: PreloadAction
  subcases: OpenSubCaseAction[]
  usercase_preload: PreloadAction
  usercase_update: UpdateCaseAction
  load_from_form: PreloadAction
}

export interface DetailColumn {
  doc_type: 'DetailColumn'
  header: LocalizedString
  field: string
  model: string
  format: string
  calc_xpath: string
  filter_xpath: string
  advanced: string
  late_flag: number
  time_ago_interval: number
  useXpathExpression: boolean
  hasNodeset: boolean
  hasAutocomplete: boolean
  isTab: boolean
  enum: unknown[]
  graph_configuration: null
  relevant: string
  case_tile_field: null
  nodeset: string
}

export interface DetailBase {
  sort_elements: unknown[]
  tabs: unknown[]
  filter: null
  lookup_enabled: boolean
  lookup_autolaunch: boolean
  lookup_display_results: boolean
  lookup_name: null
  lookup_image: null
  lookup_action: null
  lookup_field_template: null
  lookup_field_header: Record<string, never>
  lookup_extras: unknown[]
  lookup_responses: unknown[]
  persist_case_context: null
  persistent_case_context_xml: string
  persist_tile_on_forms: null
  persistent_case_tile_from_module: null
  pull_down_tile: null
  case_tile_template: null
  custom_xml: null
  custom_variables: null
}

export interface Detail extends DetailBase {
  doc_type: 'Detail'
  display: 'short' | 'long'
  columns: DetailColumn[]
}

export interface DetailPair {
  doc_type: 'DetailPair'
  short: Detail
  long: Detail
}

export interface CaseReferencesData {
  load: Record<string, string[]>
  save: Record<string, never>
  doc_type: 'CaseReferences'
}

export interface HqForm {
  doc_type: 'Form'
  form_type: string
  unique_id: string
  name: LocalizedString
  xmlns: string
  requires: string
  version: null
  actions: FormActions
  case_references_data: CaseReferencesData
  form_filter: null
  post_form_workflow: string
  no_vellum: boolean
  media_image: Record<string, never>
  media_audio: Record<string, never>
  custom_icons: unknown[]
  custom_assertions: unknown[]
  custom_instances: unknown[]
  form_links: unknown[]
  comment: string
}

export interface HqModule {
  doc_type: 'Module'
  module_type: string
  unique_id: string
  name: LocalizedString
  case_type: string
  put_in_root: boolean
  root_module_id: null
  forms: HqForm[]
  case_details: DetailPair
  case_list: {
    doc_type: 'CaseList'
    show: boolean
    label: Record<string, never>
    media_image: Record<string, never>
    media_audio: Record<string, never>
    custom_icons: unknown[]
  }
  case_list_form: { doc_type: 'CaseListForm'; form_id: null; label: Record<string, never> }
  search_config: {
    doc_type: 'CaseSearch'
    properties: unknown[]
    default_properties: unknown[]
    include_closed: boolean
  }
  display_style: string
  media_image: Record<string, never>
  media_audio: Record<string, never>
  custom_icons: unknown[]
  is_training_module: boolean
  module_filter: null
  auto_select_case: boolean
  parent_select: { active: boolean; module_id: null }
  comment: string
}

export interface HqApplication {
  doc_type: 'Application'
  application_version: string
  name: string
  langs: string[]
  build_spec: { doc_type: 'BuildSpec'; version: string; build_number: null }
  profile: { doc_type: 'Profile'; features: Record<string, never>; properties: Record<string, never> }
  vellum_case_management: boolean
  cloudcare_enabled: boolean
  case_sharing: boolean
  secure_submissions: boolean
  multimedia_map: Record<string, never>
  translations: Record<string, never>
  modules: HqModule[]
  _attachments: Record<string, string>
}
