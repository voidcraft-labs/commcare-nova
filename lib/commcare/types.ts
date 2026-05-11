/** TypeScript interfaces for CommCare HQ import JSON structures. */

export interface LocalizedString {
	[lang: string]: string;
}

export interface FormActionCondition {
	type: "never" | "always" | "if";
	/** HQ wire field — XForm path of the field whose answer the condition
	 *  compares. Named `question` in HQ's JSON and preserved verbatim. */
	question: string | null;
	answer: string | null;
	operator: string | null;
	doc_type: "FormActionCondition";
}

export interface OpenCaseAction {
	doc_type: "OpenCaseAction";
	name_update: { question_path: string };
	external_id: null;
	condition: FormActionCondition;
}

export interface UpdateCaseAction {
	doc_type: "UpdateCaseAction";
	update: Record<string, { question_path: string; update_mode: string }>;
	condition: FormActionCondition;
}

export interface PreloadAction {
	doc_type: "PreloadAction";
	preload: Record<string, string>;
	condition: FormActionCondition;
}

export interface FormAction {
	doc_type: "FormAction";
	condition: FormActionCondition;
}

export interface OpenSubCaseAction {
	doc_type: "OpenSubCaseAction";
	case_type: string;
	name_update: { question_path: string; update_mode: string };
	reference_id: string;
	case_properties: Record<
		string,
		{ question_path: string; update_mode: string }
	>;
	repeat_context: string;
	relationship: string;
	close_condition: FormActionCondition;
	condition: FormActionCondition;
}

export interface FormActions {
	doc_type: "FormActions";
	open_case: OpenCaseAction;
	update_case: UpdateCaseAction;
	close_case: FormAction;
	case_preload: PreloadAction;
	subcases: OpenSubCaseAction[];
	usercase_preload: PreloadAction;
	usercase_update: UpdateCaseAction;
	load_from_form: PreloadAction;
}

/**
 * One entry of a `DetailColumn.enum` lookup table. CCHQ's
 * `MappingItem` carries `(key, {lang: label})`; the per-language
 * label dict reuses `LocalizedString`. `key` is the raw property
 * value the runtime matches against; the per-language string
 * surfaces in place of the key when the row matches.
 */
export interface MappingItem {
	key: string;
	value: LocalizedString;
}

/**
 * One detail-column wire shape — CCHQ's `DetailColumn`. The `format`
 * discriminator dispatches the runtime render: `plain` is bare text,
 * `date` formats via `date_format`, `phone` renders a tap link,
 * `enum` projects through `enum`, `time-ago` shows a relative
 * interval scaled by `time_ago_interval`, `late-flag` flags rows
 * past `late_flag` days, `calculate` carries an inline XPath via
 * `useXpathExpression`, `invisible` is search-only (column tracked
 * for sort / index but hidden in the case list).
 */
export type DetailColumnFormat =
	| "plain"
	| "date"
	| "phone"
	| "enum"
	| "time-ago"
	| "late-flag"
	| "calculate"
	| "invisible";

export interface DetailColumn {
	doc_type: "DetailColumn";
	header: LocalizedString;
	/** The case property name for property-rooted formats; the inline
	 *  XPath expression when `useXpathExpression` is true (CCHQ's
	 *  `useXpathExpression` branch reads `column.field` directly as the
	 *  display xpath per `detail_screen.py::FormattedDetailColumn.xpath`). */
	field: string;
	model: string;
	format: DetailColumnFormat;
	calc_xpath: string;
	filter_xpath: string;
	advanced: string;
	/** Threshold-in-days for `late-flag`. CCHQ's authoring UI rounds the
	 *  user-authored unit count × unit-divisor to an integer before
	 *  persisting (CCHQ's schema is `IntegerProperty(default=30)`). */
	late_flag: number;
	/** Unit divisor in days for `time-ago` — days→1, weeks→7,
	 *  months→30.4375, years→365.25 (per CCHQ's
	 *  `static/app_manager/js/details/utils.js::module.TIME_AGO`). */
	time_ago_interval: number;
	/** `true` for calculated columns — CCHQ's
	 *  `detail_screen.py::FormattedDetailColumn.xpath` switches to
	 *  reading `column.field` as the inline XPath when this is set. */
	useXpathExpression: boolean;
	hasNodeset: boolean;
	hasAutocomplete: boolean;
	isTab: boolean;
	/** ID-mapping entries — populated for `format === "enum"`. CCHQ's
	 *  `MappingItem.value` is a per-language dict, so each entry's
	 *  `value` carries the runtime-displayed label keyed by lang. */
	enum: MappingItem[];
	graph_configuration: null;
	relevant: string;
	case_tile_field: null;
	nodeset: string;
	/** CCHQ `date_format` pattern, e.g. `%d/%m/%y` or `%Y-%m-%d`. The
	 *  runtime formatter consumes this for `format === "date"`. */
	date_format: string;
}

/**
 * One `<sort>` directive on a case-list short detail. CCHQ's
 * `SortElement` (`commcare-hq/corehq/apps/app_manager/models.py::SortElement`)
 * carries `field` for property-rooted sorts and `sort_calculation`
 * for calculated-column sorts (the latter takes precedence when both
 * are set per the docstring on `SortElement`). `direction` is the
 * long-form `ascending` / `descending` token; `type` is the wire
 * comparator (`string` / `int` / `double` / `index`).
 */
export interface SortElement {
	field: string;
	type: string;
	direction: string;
	/** `first` / `last` — empty string means the runtime default. */
	blanks: string;
	/** Per-language display label dict. Empty when no override. */
	display: LocalizedString | Record<string, never>;
	/** XPath expression used when the sort key is a calculated column.
	 *  Per CCHQ's `SortElement` docstring, when present this takes
	 *  precedence over `field` (the legacy slot). */
	sort_calculation: string;
}

export interface DetailBase {
	sort_elements: SortElement[];
	tabs: unknown[];
	/** Always-on filter applied to the case list nodeset, before user
	 *  search. The bare on-device XPath wire string lands here per
	 *  CCHQ's `Detail.filter = StringProperty(exclude_if_none=True)`.
	 *  Mirrors `module.case_list_filter` (CCHQ surfaces both — the
	 *  authoritative storage is on the short detail). */
	filter: string | null;
	lookup_enabled: boolean;
	lookup_autolaunch: boolean;
	lookup_display_results: boolean;
	lookup_name: null;
	lookup_image: null;
	lookup_action: null;
	lookup_field_template: null;
	lookup_field_header: Record<string, never>;
	lookup_extras: unknown[];
	lookup_responses: unknown[];
	persist_case_context: null;
	persistent_case_context_xml: string;
	persist_tile_on_forms: null;
	persistent_case_tile_from_module: null;
	pull_down_tile: null;
	case_tile_template: null;
	custom_xml: null;
	custom_variables: null;
}

export interface Detail extends DetailBase {
	doc_type: "Detail";
	display: "short" | "long";
	columns: DetailColumn[];
}

export interface DetailPair {
	doc_type: "DetailPair";
	short: Detail;
	long: Detail;
}

/**
 * One user-facing search input — CCHQ's `CaseSearchProperty`. The
 * runtime renders one prompt per entry on the search screen, keyed
 * by `name`. The two type discriminators are split between two
 * slots: `input_` is the widget kind (`select1` / `date` /
 * `daterange`), `appearance` rides `barcode_scan` (CCHQ overlays a
 * scanner UI on top of an otherwise-text input). Plain text inputs
 * leave both slots absent and CCHQ renders the default text widget.
 *
 * Verified against `commcare-hq/corehq/apps/app_manager/models.py::CaseSearchProperty`.
 * The optional slots use CCHQ's `exclude_if_none=True` semantics —
 * we omit the key when no override is authored. The boolean slots
 * default to `false` in CCHQ; we emit them only when authoring intent
 * differs from the default.
 *
 * Note on per-property matcher strategy. CCHQ's `CaseSearchProperty`
 * carries NO per-input flag for fuzzy / starts-with / phonetic
 * matching — those strategies are domain-level decisions on
 * `CaseSearchConfig.fuzzy_properties` (a many-to-many table per
 * domain) or are expressed as explicit XPath function calls
 * (`fuzzy-match` / `phonetic-match` / `starts-with` / `fuzzy-date`)
 * inside the `_xpath_query` slot. Nova therefore drops every
 * non-`exact` simple-arm input into the AND-composed `_xpath_query`
 * predicate via `simpleArmDerivation.ts`; the bare `<prompt>` slot
 * carries only the user-typed value, never a matcher hint.
 *
 * Note on name vs property. CCHQ collapses Nova's separate prompt
 * key (`SearchInputDef.name`) and targeted case property
 * (`SearchInputDef.property`) into ONE slot — `name` on the wire
 * (`build_query_prompts` sets `'key': prop.name`, and the runtime's
 * `_apply_filter` treats the prompt key as the case property name).
 * When Nova's authoring carries `name !== property`, the wire
 * emitter routes the input through `_xpath_query` AND sets
 * `exclude` so CCHQ's runtime skips the auto-match against the
 * prompt key (which would query a property by the wrong name) and
 * defers to the explicit predicate in the `_xpath_query` slot.
 */
export interface CaseSearchProperty {
	name: string;
	label: LocalizedString;
	hint?: LocalizedString;
	/** CCHQ field name is `input_` (with trailing underscore) — CCHQ
	 *  collides on `input` with Python's builtin, so the wire field is
	 *  the underscore form. Values are `select1` / `date` / `daterange`. */
	input_?: string;
	appearance?: string;
	default_value?: string;
	hidden?: boolean;
	allow_blank_value?: boolean;
	exclude?: boolean;
	is_group?: boolean;
	group_key?: string;
}

/**
 * One server-side filter — CCHQ's `DefaultCaseSearchProperty`. The
 * `property` slot keys the filter (CCHQ's special key `_xpath_query`
 * routes the value through the XPath query parser; any other key
 * matches the named case property literally); `defaultValue` is the
 * filter value (an XPath string when `property === "_xpath_query"`).
 *
 * Verified against `commcare-hq/.../models.py::DefaultCaseSearchProperty`.
 */
export interface DefaultCaseSearchProperty {
	property: string;
	defaultValue: string;
}

/**
 * CCHQ's `CaseSearch` document schema — `module.search_config`. Wraps
 * the user-facing search inputs (`properties`), the server-side
 * filters (`default_properties`), and the search-screen chrome
 * (`search_button_label`, `title_label`, `description`,
 * `search_button_display_condition`, `blacklisted_owner_ids_expression`).
 *
 * Verified against `commcare-hq/.../models.py::CaseSearch`. The
 * `additional_relevant` slot is intentionally NOT modelled —
 * CCHQ deprecated the authoring affordance (`CASE_SEARCH_DEPRECATED`)
 * and Nova's authoring layer doesn't surface it.
 *
 * `auto_launch`, `default_search`, and `inline_search` are
 * persistent author-state in CCHQ. The CCHQ runtime regenerates
 * the suite XML from this document on every sync, reading these
 * flags from the persisted doc (see
 * `commcare-hq/.../app_manager/suite_xml/sections/details.py::_get_auto_launch_expression`,
 * `commcare-hq/.../app_manager/suite_xml/post_process/remote_requests.py`,
 * and `commcare-hq/.../app_manager/util.py::module_uses_inline_search`).
 * Nova projects `compileForPlatform`'s web-context output onto
 * these slots at HQ JSON emission so the CCHQ-regenerated suite
 * carries the same shape Nova's local suite emitter renders. The
 * Android runtime ignores all three flags (per `_get_auto_launch_expression`'s
 * `if not in_search` guard), so persisting the web-correct values
 * is right for both runtimes.
 */
export interface CaseSearchConfig {
	doc_type: "CaseSearch";
	search_button_label: LocalizedString | Record<string, never>;
	properties: CaseSearchProperty[];
	auto_launch: boolean;
	default_search: boolean;
	inline_search: boolean;
	search_button_display_condition?: string;
	default_properties: DefaultCaseSearchProperty[];
	blacklisted_owner_ids_expression?: string;
	title_label: LocalizedString | Record<string, never>;
	description: LocalizedString | Record<string, never>;
}

export interface CaseReferencesData {
	load: Record<string, string[]>;
	save: Record<string, never>;
	doc_type: "CaseReferences";
}

/**
 * HQ `form_links[*].target` discriminant.
 *
 * HQ addresses forms + modules by 0-based index — the indices are stable
 * across the wire payload because every other field (`modules[].forms[]`,
 * suite-level `m{n}-f{k}` commands, app strings) shares the same
 * ordering. Domain `FormLink.target` carries uuids; the expander resolves
 * them to indices at the emission boundary before writing the HQ shape.
 */
export type HqFormLinkTarget =
	| { type: "form"; moduleIndex: number; formIndex: number }
	| { type: "module"; moduleIndex: number };

/** A datum override on an HQ `form_link` (explicit session variable). */
export interface HqFormLinkDatum {
	name: string;
	xpath: string;
}

/**
 * HQ `form_links[*]` entry shape.
 *
 * `condition` is an XPath expression; `undefined` means the link matches
 * unconditionally. `datums` overrides auto-derived session variables for
 * the target. Matches CommCare HQ's form-link payload field-for-field —
 * HQ validates the shape on upload.
 */
export interface HqFormLink {
	condition?: string;
	target: HqFormLinkTarget;
	datums?: HqFormLinkDatum[];
}

export interface HqForm {
	doc_type: "Form";
	form_type: string;
	unique_id: string;
	name: LocalizedString;
	xmlns: string;
	requires: string;
	version: null;
	actions: FormActions;
	case_references_data: CaseReferencesData;
	form_filter: null;
	post_form_workflow: string;
	no_vellum: boolean;
	media_image: Record<string, never>;
	media_audio: Record<string, never>;
	custom_icons: unknown[];
	custom_assertions: unknown[];
	custom_instances: unknown[];
	form_links: HqFormLink[];
	comment: string;
}

export interface HqModule {
	doc_type: "Module";
	module_type: string;
	unique_id: string;
	name: LocalizedString;
	case_type: string;
	put_in_root: boolean;
	root_module_id: null;
	forms: HqForm[];
	case_details: DetailPair;
	case_list: {
		doc_type: "CaseList";
		show: boolean;
		label: Record<string, string> | Record<string, never>;
		media_image: Record<string, never>;
		media_audio: Record<string, never>;
		custom_icons: unknown[];
	};
	case_list_form: {
		doc_type: "CaseListForm";
		form_id: null;
		label: Record<string, never>;
	};
	search_config: CaseSearchConfig;
	display_style: string;
	media_image: Record<string, never>;
	media_audio: Record<string, never>;
	custom_icons: unknown[];
	is_training_module: boolean;
	module_filter: null;
	auto_select_case: boolean;
	parent_select: {
		active: boolean;
		relationship: string;
		module_id: string | null;
	};
	comment: string;
}

export interface HqApplication {
	doc_type: "Application";
	application_version: string;
	name: string;
	langs: string[];
	build_spec: { doc_type: "BuildSpec"; version: string; build_number: null };
	profile: {
		doc_type: "Profile";
		features: Record<string, never>;
		properties: Record<string, never>;
	};
	vellum_case_management: boolean;
	cloudcare_enabled: boolean;
	case_sharing: boolean;
	secure_submissions: boolean;
	multimedia_map: Record<string, never>;
	translations: Record<string, never>;
	/** Standard HQ app properties before _attachments (secondary WAF defense — see client.ts) */
	admin_password: null;
	admin_password_charset: string;
	amplifies_project: string;
	amplifies_workers: string;
	archived_media: Record<string, never>;
	attribution_notes: null;
	auto_gps_capture: boolean;
	build_broken: boolean;
	build_broken_reason: null;
	build_comment: null;
	build_profiles: Record<string, never>;
	build_signed: boolean;
	built_on: null;
	built_with: {
		signed: boolean;
		datetime: null;
		doc_type: "BuildRecord";
		version: null;
		build_number: null;
		latest: null;
	};
	cached_properties: Record<string, never>;
	comment: string;
	comment_from: null;
	copy_history: never[];
	created_from_template: null;
	custom_assertions: never[];
	custom_base_url: null;
	date_created: null;
	deployment_date: null;
	description: null;
	experienced_threshold: string;
	family_id: null;
	grid_form_menus: string;
	has_submissions: boolean;
	is_auto_generated: boolean;
	is_released: boolean;
	last_modified: null;
	last_released: null;
	location_fixture_restore: string;
	logo_refs: Record<string, never>;
	media_form_errors: boolean;
	minimum_use_threshold: string;
	mobile_ucr_restore_version: string;
	persistent_menu: boolean;
	phone_model: null;
	practice_mobile_worker_id: null;
	recipients: string;
	show_breadcrumbs: boolean;
	smart_lang_display: null;
	split_screen_dynamic_search: boolean;
	target_commcare_flavor: string;
	translation_strategy: string;
	use_custom_suite: boolean;
	use_grid_menus: boolean;
	user_type: null;
	add_ons: Record<string, boolean>;
	modules: HqModule[];
	_attachments: Record<string, string>;
}
