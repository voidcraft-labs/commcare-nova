/** TypeScript interfaces for CommCare HQ import JSON structures. */

import type { MultimediaMapItem } from "./multimedia/bundle";
import type { LogoRef } from "./multimedia/logoEntry";

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
	external_id: string | null;
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
	| "enum-image"
	| "time-ago"
	| "late-flag"
	| "translatable-enum"
	| "calculate"
	// Renders the cell through CommCare's markdown renderer, which is the
	// only way a case-list cell becomes a link. Registered upstream at
	// `detail_screen.py::Markdown` (`@register_format_type('markdown')`) and
	// unconstrained on the wire — `models/case_list.py::DetailColumn.format`
	// is a bare `StringProperty()` with no `choices`, so it imports cleanly.
	| "markdown"
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
	/**
	 * Custom-tile placement, zero-based. CCHQ's own names are
	 * `grid_x` / `grid_y` for the origin and the unprefixed
	 * `width` / `height` for the span
	 * (`commcare-hq/corehq/apps/app_manager/models/case_list.py::DetailColumn`),
	 * and its emitter maps them onto the wire's `grid-x` / `grid-y` /
	 * `grid-width` / `grid-height` attributes. All four are `null` on a
	 * column with no tile placement; Nova emits them as a complete set or
	 * not at all, because a partial set is what makes CCHQ produce a
	 * `<grid>` the device cannot parse.
	 */
	grid_x: number | null;
	grid_y: number | null;
	width: number | null;
	height: number | null;
	/** `<style horz-align>` / `<style vert-align>` / `<style font-size>`. */
	horizontal_align: string | null;
	vertical_align: string | null;
	font_size: string | null;
	/** `<style show-border>` / `<style show-shading>`. */
	show_border: boolean | null;
	show_shading: boolean | null;
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
	/**
	 * CommCare's case-list cardinality. These fields are written only on the
	 * short detail: the long detail is a confirmation surface, not a selector.
	 * Omission keeps CommCare's single-select defaults.
	 */
	multi_select?: boolean;
	max_select_value?: number;
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
	/**
	 * Keeps the short detail on screen above every form in the module —
	 * the persistent case tile. CCHQ turns it into `detail-persistent` on
	 * each of the module's case-loading datums
	 * (`suite_xml/sections/entries.py::EntriesHelper.get_detail_persistent_attr`).
	 */
	persist_tile_on_forms: boolean | null;
	persistent_case_tile_from_module: null;
	pull_down_tile: null;
	/**
	 * Which tile vocabulary CCHQ regenerates this detail with. Nova emits
	 * only `"custom"` — the arm where every column carries its own grid
	 * placement — never CCHQ's two named templates (`person_simple`,
	 * `icon_text_grid`), whose slots are filled by name and whose
	 * emission carries a hardcoded profile-image cell and a literal
	 * `m0-f0` registration action. `null` is a detail with no tile.
	 *
	 * CCHQ's own field is a bare `StringProperty` with no `choices`
	 * constraint (`models/case_list.py::Detail`); the vocabulary is
	 * enforced at build time by lookup failure in
	 * `suite_xml/features/case_tiles.py::case_tile_template_config`. The
	 * `"custom"` literal is deliberately NOT a member of CCHQ's
	 * `CaseTileTemplates` enum — it is a module-level sibling constant,
	 * which is exactly why it bypasses the per-template slot-mapping
	 * validators.
	 */
	case_tile_template: "custom" | null;
	/**
	 * Grouping for a tile-laid-out short detail: which case index keys
	 * the groups, and how many of the tile's top rows are the group
	 * header. Present ONLY when Nova authors grouping —
	 * `models/modules.py::Module.has_grouped_tiles` gates the `<group>`
	 * emission on a truthy `index_identifier`, and CCHQ's `Detail.wrap`
	 * default-constructs the `SchemaProperty` when the key is absent, so
	 * omission is the correct spelling for "not grouped". An in-place
	 * republish cannot strand a stale value either: the import's overlay
	 * merge replaces `modules` wholesale
	 * (`models/applications.py::_merge_source_into_app`, pinned by
	 * `tests/test_app_update_from_source.py::test_merge_replaces_content_from_source`).
	 *
	 * `index_identifier` is interpolated raw into
	 * `string(./index/{index_identifier})` by
	 * `suite_xml/features/case_tiles.py::CaseTileHelper.build_case_tile_detail`,
	 * and `header_rows` becomes the `header-rows` attribute. CCHQ
	 * validates neither — its authoring surface is a free-text box — so
	 * the domain schema is the only thing standing between an author and
	 * an unparseable group function.
	 */
	case_tile_group?: {
		doc_type: "CaseTileGroupConfig";
		index_identifier: string;
		header_rows: number;
	};
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
export interface CaseSearchAssertion {
	test: string;
	text: LocalizedString;
}

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
	validations?: CaseSearchAssertion[];
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
 * carries the same shape Nova's local suite emitter renders.
 *
 * Android-runtime handling: the `auto_launch` XPath lands on every
 * regenerated `<action>` element regardless of platform, but
 * `commcare-android`'s `EntitySelectActivity` never calls
 * `commcare-core`'s `Action::isAutoLaunchAction` — only formplayer
 * (the web runtime) does, at `formplayer/.../MenuSession.java::next`.
 * Android's case list therefore stays list-first regardless of the
 * persisted flag. The web runtime honors the flag, which is the
 * shape Nova's `compileForPlatform` decision tree produces for
 * web. Persisting one shape gives both runtimes the right UX.
 * `include_all_related_cases` is derived wire state: Nova sets it only
 * when effective Search emits information that reads a supporting parent.
 * It is never an author-facing option.
 */
export interface CaseSearchConfig {
	doc_type: "CaseSearch";
	search_button_label: LocalizedString | Record<string, never>;
	properties: CaseSearchProperty[];
	auto_launch: boolean;
	default_search: boolean;
	inline_search: boolean;
	include_all_related_cases: boolean;
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
 * One explicit session value on an HQ `form_links[*]` entry. The shape is
 * HQ's `FormLinkDatum` (`app_manager/models/forms.py`): `name` is the
 * target datum id the value satisfies, `xpath` the session-scope
 * expression Core evaluates at push.
 */
export interface HqFormLinkDatum {
	name: string;
	xpath: string;
}

/**
 * HQ `form_links[*]` entry shape — `FormLink` in
 * `app_manager/models/forms.py`, field for field.
 *
 * `xpath` is the link's guard; HQ reads the empty string as an
 * unconditional link, and Nova's projection writes the exclusive guard the
 * local suite emits so the two paths derive the same `<create if>`. A form
 * target carries `form_id` + `form_module_id` (HQ's `update_form_unique_ids`
 * re-ids forms on import and rewrites `form_id` with them, so the expander
 * pre-generates every form id before the module map and references only
 * those); a module target carries `module_unique_id` (modules are never
 * re-ided). `datums` is empty when the target's session is matched from the
 * source entry (HQ's `_get_datums_matched_to_source`) and lists explicit
 * values otherwise (`_get_datums_matched_to_manual_values`). HQ reads
 * `form_links` only while `post_form_workflow === "form"`.
 */
export type HqFormLink =
	| {
			xpath: string;
			form_id: string;
			form_module_id: string;
			datums: HqFormLinkDatum[];
	  }
	| {
			xpath: string;
			module_unique_id: string;
			datums: HqFormLinkDatum[];
	  };

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
	form_filter: string | null;
	post_form_workflow: string;
	/**
	 * The workflow HQ falls back to when every `form_links[*].xpath` is
	 * false (`post_process/workflow.py::_get_fallback_frame`). `null` emits
	 * no fallback frame; HQ's `WORKFLOW_FALLBACK_OPTIONS` is `None`, so the
	 * slot carries no choice validation and `null` is its stored default.
	 */
	post_form_workflow_fallback: string | null;
	no_vellum: boolean;
	media_image: Record<string, string>;
	media_audio: Record<string, string>;
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
	root_module_id: string | null;
	forms: HqForm[];
	case_details: DetailPair;
	case_list: {
		doc_type: "CaseList";
		show: boolean;
		label: Record<string, string> | Record<string, never>;
		media_image: Record<string, string>;
		media_audio: Record<string, string>;
		custom_icons: unknown[];
	};
	case_list_form: {
		doc_type: "CaseListForm";
		form_id: null;
		label: Record<string, never>;
	};
	search_config: CaseSearchConfig;
	display_style: string;
	media_image: Record<string, string>;
	media_audio: Record<string, string>;
	custom_icons: unknown[];
	is_training_module: boolean;
	module_filter: string | null;
	auto_select_case: boolean;
	parent_select: {
		active: boolean;
		relationship: string;
		module_id: string | null;
	};
	comment: string;
}

/**
 * The HQ app document Nova emits, listing ONLY fields Nova authors.
 *
 * Target-owned settings and state — `cloudcare_enabled`, `profile`,
 * `case_sharing`, `secure_submissions`, the build/release metadata, and
 * the rest of HQ's app Settings page attributes — are deliberately
 * absent. HQ's create path supplies its own schema defaults for a
 * missing field (each was previously emitted at exactly that default),
 * and the in-place update's overlay merge retains a field absent from
 * source, so omitting them keeps the project's HQ-side configuration
 * standing across republishes. The rule lives at
 * `hqShells.ts::applicationShell`.
 */
export interface HqApplication {
	doc_type: "Application";
	application_version: string;
	name: string;
	langs: string[];
	build_spec: { doc_type: "BuildSpec"; version: string; build_number: null };
	multimedia_map: Record<string, MultimediaMapItem>;
	/** Per-language app_strings overrides. */
	translations: Record<string, Record<string, string>>;
	auto_gps_capture: boolean;
	/**
	 * Present only when the app has a Nova-authored logo: an empty
	 * `logo_refs` on the update path would remove a logo uploaded on
	 * CommCare HQ, while an absent one is retained by the merge.
	 */
	logo_refs?: Record<string, LogoRef>;
	/**
	 * Present only when the app reads `instance('locations')`, and then
	 * always `both_fixtures`.
	 *
	 * CommCare HQ decides whether to put that fixture in a worker's
	 * restore, and by default it asks the PROJECT SPACE:
	 * `locations/fixtures.py::should_sync_flat_fixture` falls through to
	 * `LocationFixtureConfiguration.for_domain(...).sync_flat_fixture`, a
	 * row an administrator can switch off. An app that declares
	 * `jr://fixture/locations` and does not get one fails to resolve the
	 * instance on the device, so leaving that to a setting nobody told
	 * the author about is not an option.
	 *
	 * The app can settle it: the same function returns True as soon as
	 * `app.location_fixture_restore` is in `const.py::SYNC_FLAT_FIXTURES`,
	 * BEFORE it reads the project row. `both_fixtures` rather than
	 * `only_flat_fixture` because Nova is answering for its own needs and
	 * has no business switching the hierarchical fixture OFF —
	 * `::should_sync_hierarchical_fixture` keeps deciding that from the
	 * `HIERARCHICAL_LOCATION_FIXTURE` toggle, exactly as it did.
	 *
	 * Absent otherwise, for the reason `logo_refs` is: an app with no
	 * place-based rule has no opinion, and emitting one would overwrite a
	 * choice somebody made on CommCare HQ on every republish.
	 */
	location_fixture_restore?: "both_fixtures";
	add_ons: Record<string, boolean>;
	modules: HqModule[];
	_attachments: Record<string, string>;
}
