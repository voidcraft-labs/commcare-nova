/** Factory functions for boilerplate HQ JSON structures. */

import { CASE_SEARCH_BUTTON_LABEL } from "@/lib/domain";
import {
	type HqApplicationTree,
	type HqFormLinkTree,
	type HqFormTree,
	type HqModuleTree,
	type HqXPath,
	hqXPath,
} from "./hqJson/xpath";
import type {
	CaseSearchConfig,
	DetailBase,
	DetailColumn,
	DetailPair,
	FormActionCondition,
	FormActions,
	HqCaseSaveReference,
} from "./types";
import { w } from "./xpath/wire/builders";

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

/**
 * Build an HQ `FormActionCondition` with `type: "if"`. Parameter names
 * mirror the HQ wire fields verbatim (`question`, `answer`, `operator`)
 * — this is the emission boundary where CommCare's JSON vocabulary wins.
 */
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

function detailBase(): DetailBase<HqXPath> {
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
		persistent_case_context_xml: hqXPath(w.context([w.step("case_name")])),
		persist_tile_on_forms: null,
		persistent_case_tile_from_module: null,
		pull_down_tile: null,
		case_tile_template: null,
		custom_xml: null,
	};
}

/**
 * Build a baseline plain `DetailColumn`. The `format` defaults
 * here align with CCHQ's `DetailColumn` schema defaults
 * (`commcare-hq/.../models.py::DetailColumn`). Callers override
 * any subset of fields for non-plain kinds (date / phone / enum /
 * time-ago / late-flag / calculate / invisible) before placing the
 * column in the wire structure — the expander composes the per-
 * kind shape from `Column`, holding the defaults stable for slots
 * the kind doesn't author.
 *
 * `late_flag` defaults to 30 days and `time_ago_interval` to
 * 365.25 days per CCHQ; these are inactive for non-interval kinds
 * (CCHQ ignores them when `format` is not `"late-flag"` /
 * `"time-ago"`).
 */
export function detailColumn(
	field: string | HqXPath,
	header: string | Record<string, string>,
): DetailColumn<HqXPath, "plain"> {
	const headerRecord: Record<string, string> =
		typeof header === "string" ? { en: header } : header;
	return {
		doc_type: "DetailColumn",
		header: headerRecord,
		...(typeof field === "string"
			? { field, useXpathExpression: false as const }
			: { field, useXpathExpression: true as const }),
		model: "case",
		format: "plain",
		calc_xpath: hqXPath(w.context([w.self()])),
		filter_xpath: "",
		advanced: "",
		late_flag: 30,
		time_ago_interval: 365.25,
		hasNodeset: false,
		hasAutocomplete: false,
		isTab: false,
		enum: [],
		graph_configuration: null,
		relevant: "",
		case_tile_field: null,
		grid_x: null,
		grid_y: null,
		width: null,
		height: null,
		horizontal_align: null,
		vertical_align: null,
		font_size: null,
		show_border: null,
		show_shading: null,
		nodeset: "",
		date_format: "%d/%m/%y",
	};
}

/**
 * Build a baseline `CaseSearchConfig` matching CCHQ's `CaseSearch`
 * schema defaults (`commcare-hq/.../models.py::CaseSearch`). The
 * expander mutates this shell with the authored
 * `caseSearchConfig` + `caseListConfig.searchInputs` slots before
 * the module reaches the wire JSON; new modules with no search
 * config land here as the no-search baseline. The shell is the
 * single seed point — keeps CCHQ default drift to one file.
 *
 * `title_label` and `description` hold an empty text under every app
 * language, which is what HQ's Case List save writes into both on every
 * menu, whether or not it offers search
 * (`views/modules.py::_gather_and_update_search_properties`). The projection
 * writes an authored title or subtitle over the seed.
 */
export function caseSearchConfigShell(
	languages: readonly string[],
): CaseSearchConfig<HqXPath> {
	const blank = () =>
		Object.fromEntries(languages.map((language) => [language, ""]));
	return {
		doc_type: "CaseSearch",
		// HQ's default and the only label its Case List save keeps, keyed
		// `en` alone (`CaseSearch.search_button_label`).
		search_button_label: { en: CASE_SEARCH_BUTTON_LABEL },
		properties: [],
		// CCHQ defaults — the HQ JSON projection at
		// `lib/commcare/hqJson/caseList.ts::buildSearchConfigDocument`
		// overrides every slot from `compileForPlatform`'s web-context
		// output. The shell carries the defaults so a module with no
		// `caseSearchConfig` (no override path) lands as CCHQ would
		// otherwise materialize it from an empty author state.
		auto_launch: false,
		default_search: false,
		inline_search: false,
		include_all_related_cases: false,
		default_properties: [],
		title_label: blank(),
		description: blank(),
	};
}

/** Build a DetailPair from short columns and optional long (detail view) columns. */
export function detailPair(
	shortColumns: DetailColumn<HqXPath>[],
	longColumns?: DetailColumn<HqXPath>[],
): DetailPair<HqXPath> {
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
	modules: HqModuleTree[],
	attachments: Record<string, string>,
	options?: {
		autoGpsCapture?: boolean;
		langs?: string[];
		translations?: Record<string, Record<string, string>>;
		/** The needed add-on slugs, each written `true`; none writes no `add_ons`. */
		addOns?: readonly string[];
		/** The profile settings, written into `profile.properties` as `{ key: value }`. */
		profileProperties?: readonly {
			readonly key: string;
			readonly value: string;
		}[];
		profileCustomProperties?: Readonly<Record<string, string>>;
	},
): HqApplicationTree {
	/* Only fields Nova AUTHORS go on a new-app wire document. CommCare HQ's import is an
	 * overlay merge on the update path (`models/applications.py::
	 * _merge_source_into_app`): every field present in the source
	 * overwrites the HQ app's value, and a field absent from the source is
	 * retained. So app content Nova does not author yet (`cloudcare_enabled`,
	 * `case_sharing`) and target-owned settings and state
	 * (`secure_submissions`, the build/release metadata, and the rest of HQ's
	 * app Settings page attributes) are deliberately NOT emitted. Three keys carry Nova's values beside the
	 * target's own, `translations`, `add_ons` and `profile`; the update path
	 * projects each onto the target's current value before import
	 * (`targetOverlay.ts`). `auto_gps_capture` is written only `true`, for a
	 * Connect app: an absent key keeps the Auto Capture Location a person
	 * turned on in HQ. Every other omitted field was previously sent at
	 * exactly HQ's own schema default, so create behaves identically (couch
	 * `wrap` supplies the same default, and `_create_app_from_doc` sets
	 * `cloudcare_enabled` itself from the domain's Web Apps privilege),
	 * while an in-place update leaves the project's HQ-side configuration
	 * standing instead of resetting it on every republish. No `build_spec`
	 * is written: a create stores the server's default build
	 * (`_import_app` deletes the body's), an update excludes the key
	 * (`_merge_source_into_app`), and publish reads HQ's version from the
	 * app's source. No `logo_refs` is written either: a logo reaches an app
	 * built on CommCare HQ when a person adds it there.
	 * `location_fixture_restore` is `project_default` on every app, so a
	 * device and Web Apps both take the flat location list by the project
	 * space's own setting (`locations/fixtures.py::should_sync_flat_fixture`
	 * falls to `LocationFixtureConfiguration.sync_flat_fixture`). */
	const properties = options?.profileProperties ?? [];
	const customProperties = options?.profileCustomProperties ?? {};
	const profile = {
		...(properties.length > 0 && {
			properties: Object.fromEntries(
				properties.map(({ key, value }) => [key, value]),
			),
		}),
		...(Object.keys(customProperties).length > 0 && {
			custom_properties: { ...customProperties },
		}),
	};
	const addOns = options?.addOns ?? [];
	return {
		doc_type: "Application",
		application_version: "2.0",
		name: appName,
		langs: options?.langs ?? ["en"],
		translations: options?.translations ?? {},
		...(options?.autoGpsCapture === true && { auto_gps_capture: true }),
		location_fixture_restore: "project_default",
		...(Object.keys(profile).length > 0 && { profile }),
		...(addOns.length > 0 && {
			add_ons: Object.fromEntries(addOns.map((slug) => [slug, true])),
		}),
		// `_attachments` last, so the serialized JSON keeps a stable,
		// deterministic property order with the form XML at the end.
		modules,
		_attachments: attachments,
	};
}

export function formShell(
	uniqueId: string,
	name: string | Record<string, string>,
	xmlns: string,
	requires: string,
	actions: FormActions,
	caseRefsLoad: Record<string, string[]>,
	caseRefsSave: Record<string, HqCaseSaveReference>,
	postFormWorkflow: string,
	postFormWorkflowFallback: string | null,
	formLinks: HqFormLinkTree[],
): HqFormTree {
	return {
		doc_type: "Form",
		form_type: "module_form",
		unique_id: uniqueId,
		name: typeof name === "string" ? { en: name } : name,
		xmlns,
		requires,
		version: null,
		actions,
		case_references_data: {
			load: caseRefsLoad,
			save: caseRefsSave,
			doc_type: "CaseReferences",
		},
		form_filter: null,
		post_form_workflow: postFormWorkflow,
		post_form_workflow_fallback: postFormWorkflowFallback,
		media_image: {},
		media_audio: {},
		custom_icons: [],
		custom_assertions: [],
		custom_instances: [],
		form_links: formLinks,
		comment: "",
	};
}

export function moduleShell(
	uniqueId: string,
	name: string | Record<string, string>,
	caseType: string,
	forms: HqFormTree[],
	caseDetails: DetailPair<HqXPath>,
	languages: readonly string[],
): HqModuleTree {
	return {
		doc_type: "Module",
		module_type: "basic",
		unique_id: uniqueId,
		name: typeof name === "string" ? { en: name } : name,
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
		search_config: caseSearchConfigShell(languages),
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
