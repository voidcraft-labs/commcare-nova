/** Factory functions for boilerplate HQ JSON structures. */

import type {
	DetailBase,
	DetailColumn,
	DetailPair,
	FormActionCondition,
	FormActions,
	HqApplication,
	HqForm,
	HqModule,
} from "./types";

// ── Condition factories ──────────────────────────────────────────────

export function neverCondition(): FormActionCondition {
	return {
		type: "never",
		question: null,
		answer: null,
		operator: null,
		doc_type: "FormActionCondition",
	};
}

export function alwaysCondition(): FormActionCondition {
	return {
		type: "always",
		question: null,
		answer: null,
		operator: null,
		doc_type: "FormActionCondition",
	};
}

export function ifCondition(
	question: string,
	answer: string,
	operator: "=" | "selected" = "=",
): FormActionCondition {
	return {
		type: "if",
		question,
		answer,
		operator,
		doc_type: "FormActionCondition",
	};
}

// ── Form actions ─────────────────────────────────────────────────────

export function emptyFormActions(): FormActions {
	return {
		doc_type: "FormActions",
		open_case: {
			doc_type: "OpenCaseAction",
			name_update: { question_path: "" },
			external_id: null,
			condition: neverCondition(),
		},
		update_case: {
			doc_type: "UpdateCaseAction",
			update: {},
			condition: neverCondition(),
		},
		close_case: { doc_type: "FormAction", condition: neverCondition() },
		case_preload: {
			doc_type: "PreloadAction",
			preload: {},
			condition: neverCondition(),
		},
		subcases: [],
		usercase_preload: {
			doc_type: "PreloadAction",
			preload: {},
			condition: neverCondition(),
		},
		usercase_update: {
			doc_type: "UpdateCaseAction",
			update: {},
			condition: neverCondition(),
		},
		load_from_form: {
			doc_type: "PreloadAction",
			preload: {},
			condition: neverCondition(),
		},
	};
}

// ── Detail / case list ───────────────────────────────────────────────

function detailBase(): DetailBase {
	return {
		sort_elements: [],
		tabs: [],
		filter: null,
		lookup_enabled: false,
		lookup_autolaunch: false,
		lookup_display_results: false,
		lookup_name: null,
		lookup_image: null,
		lookup_action: null,
		lookup_field_template: null,
		lookup_field_header: {},
		lookup_extras: [],
		lookup_responses: [],
		persist_case_context: null,
		persistent_case_context_xml: "case_name",
		persist_tile_on_forms: null,
		persistent_case_tile_from_module: null,
		pull_down_tile: null,
		case_tile_template: null,
		custom_xml: null,
		custom_variables: null,
	};
}

export function detailColumn(
	field: string,
	header: string | Record<string, string>,
): DetailColumn {
	const headerRecord: Record<string, string> =
		typeof header === "string" ? { en: header } : header;
	return {
		doc_type: "DetailColumn",
		header: headerRecord,
		field,
		model: "case",
		format: "plain",
		calc_xpath: ".",
		filter_xpath: "",
		advanced: "",
		late_flag: 30,
		time_ago_interval: 365.25,
		useXpathExpression: false,
		hasNodeset: false,
		hasAutocomplete: false,
		isTab: false,
		enum: [],
		graph_configuration: null,
		relevant: "",
		case_tile_field: null,
		nodeset: "",
	};
}

/** Build a DetailPair from short columns and optional long (detail view) columns. */
export function detailPair(
	shortColumns: DetailColumn[],
	longColumns?: DetailColumn[],
): DetailPair {
	return {
		doc_type: "DetailPair",
		short: {
			doc_type: "Detail",
			display: "short",
			columns: shortColumns,
			...detailBase(),
		},
		long: {
			doc_type: "Detail",
			display: "long",
			columns: longColumns ?? [],
			...detailBase(),
		},
	};
}

// ── Top-level shells ─────────────────────────────────────────────────

export function applicationShell(
	appName: string,
	modules: HqModule[],
	attachments: Record<string, string>,
	options?: { autoGpsCapture?: boolean },
): HqApplication {
	return {
		doc_type: "Application",
		application_version: "2.0",
		name: appName,
		langs: ["en"],
		build_spec: {
			doc_type: "BuildSpec",
			version: "2.53.0",
			build_number: null,
		},
		profile: { doc_type: "Profile", features: {}, properties: {} },
		vellum_case_management: true,
		cloudcare_enabled: false,
		case_sharing: false,
		secure_submissions: false,
		multimedia_map: {},
		translations: {},
		// Standard HQ app properties before _attachments — secondary WAF defense.
		// Primary bypass is the 16KB multipart padding in client.ts importApp().
		// These add ~1.9KB of buffer; insufficient alone for small apps but
		// still worth keeping to reduce the attack surface. Do not reorder.
		admin_password: null,
		admin_password_charset: "n",
		amplifies_project: "not_set",
		amplifies_workers: "not_set",
		archived_media: {},
		attribution_notes: null,
		auto_gps_capture: options?.autoGpsCapture ?? false,
		build_broken: false,
		build_broken_reason: null,
		build_comment: null,
		build_profiles: {},
		build_signed: true,
		built_on: null,
		built_with: {
			signed: true,
			datetime: null,
			doc_type: "BuildRecord",
			version: null,
			build_number: null,
			latest: null,
		},
		cached_properties: {},
		comment: "",
		comment_from: null,
		copy_history: [],
		created_from_template: null,
		custom_assertions: [],
		custom_base_url: null,
		date_created: null,
		deployment_date: null,
		description: null,
		experienced_threshold: "3",
		family_id: null,
		grid_form_menus: "none",
		has_submissions: false,
		is_auto_generated: false,
		is_released: false,
		last_modified: null,
		last_released: null,
		location_fixture_restore: "project_default",
		logo_refs: {},
		media_form_errors: false,
		minimum_use_threshold: "15",
		mobile_ucr_restore_version: "2.0",
		persistent_menu: false,
		phone_model: null,
		practice_mobile_worker_id: null,
		recipients: "",
		show_breadcrumbs: true,
		smart_lang_display: null,
		split_screen_dynamic_search: false,
		target_commcare_flavor: "none",
		translation_strategy: "select-known",
		use_custom_suite: false,
		use_grid_menus: false,
		user_type: null,
		add_ons: {
			advanced_itemsets: true,
			calc_xpaths: true,
			case_detail_overwrite: true,
			case_list_menu_item: true,
			conditional_enum: true,
			conditional_form_actions: true,
			display_conditions: true,
			enum_image: true,
			subcases: true,
			register_from_case_list: true,
		},
		modules,
		_attachments: attachments,
	};
}

export function formShell(
	uniqueId: string,
	name: string,
	xmlns: string,
	requires: string,
	actions: FormActions,
	caseRefsLoad: Record<string, string[]>,
	postFormWorkflow: string = "default",
): HqForm {
	return {
		doc_type: "Form",
		form_type: "module_form",
		unique_id: uniqueId,
		name: { en: name },
		xmlns,
		requires,
		version: null,
		actions,
		case_references_data: {
			load: caseRefsLoad,
			save: {},
			doc_type: "CaseReferences",
		},
		form_filter: null,
		post_form_workflow: postFormWorkflow,
		no_vellum: false,
		media_image: {},
		media_audio: {},
		custom_icons: [],
		custom_assertions: [],
		custom_instances: [],
		form_links: [],
		comment: "",
	};
}

export function moduleShell(
	uniqueId: string,
	name: string,
	caseType: string,
	forms: HqForm[],
	caseDetails: DetailPair,
): HqModule {
	return {
		doc_type: "Module",
		module_type: "basic",
		unique_id: uniqueId,
		name: { en: name },
		case_type: caseType,
		put_in_root: false,
		root_module_id: null,
		forms,
		case_details: caseDetails,
		case_list: {
			doc_type: "CaseList",
			show: false,
			label: {},
			media_image: {},
			media_audio: {},
			custom_icons: [],
		},
		case_list_form: { doc_type: "CaseListForm", form_id: null, label: {} },
		search_config: {
			doc_type: "CaseSearch",
			properties: [],
			default_properties: [],
			include_closed: false,
		},
		display_style: "list",
		media_image: {},
		media_audio: {},
		custom_icons: [],
		is_training_module: false,
		module_filter: null,
		auto_select_case: false,
		parent_select: { active: false, relationship: "parent", module_id: null },
		comment: "",
	};
}
