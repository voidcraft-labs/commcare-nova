// lib/commcare/hqJson/caseList.ts
//
// Per-module case-list HQ JSON projection. Translates a domain
// `caseListConfig` + `caseSearchConfig` into the wire fields
// `module.case_details` (per-detail columns + sort + filter) and
// `module.search_config` (`CaseSearch` document). The projection
// is the bridge from Nova's authoring shapes to CCHQ's persistent
// document model — every authored slot must land here, otherwise
// "Upload to CommCare HQ" silently drops the slot.
//
// Two CCHQ surfaces compose:
//
//   - `case_details.short.columns` / `long.columns` — per-`Column`
//     mapping to CCHQ's `DetailColumn`. Each Nova column kind
//     dispatches to one CCHQ `format` token in
//     `projectColumnToDetail`. The mapping mirrors the suite-XML
//     emitter at `lib/commcare/suite/case-list/columns.ts`; CCHQ
//     stores both surfaces and the runtime regenerates the suite
//     from the persistent document, so the two surfaces project
//     the same authored content via the same kind → format
//     dispatch.
//
//   - `case_details.short.sort_elements` — per-column sort directive
//     mapping. Reuses `buildSortDirectives` from the suite-XML
//     emitter so the priority + tie-break rule binds at one source;
//     the only divergence is the wire shape (a SortElement struct
//     here vs. a `<sort>` XML element there).
//
//   - `case_details.short.filter` — the always-on `caseListConfig.filter`
//     compiled to on-device XPath. CCHQ's `case_list_filter` getter
//     reads from this slot; nothing else stores the filter at module
//     scope.
//
//   - `search_config` (CCHQ's `CaseSearch`) — search-screen chrome,
//     per-input `<prompt>` projection, and the `_xpath_query` slot
//     (filter + advanced-arm predicates AND-composed via the shared
//     `composeXPathQueryEmission` helper). Wire-tokens used here
//     stay consistent with the suite-XML side via the shared
//     `PROMPT_ATTRIBUTE_MAPPINGS` table.

import type {
	BlueprintDoc,
	CaseListConfig,
	Column,
	CaseSearchConfig as DomainCaseSearchConfig,
	Module,
	SearchInputDef,
	SimpleSearchInputDef,
} from "@/lib/domain";
import { emitOnDeviceExpression } from "../expression/onDeviceEmitter";
import { caseSearchConfigShell, detailColumn, detailPair } from "../hqShells";
import { emitCaseListFilter } from "../predicate";
import { TIME_AGO_DIVISOR_DAYS } from "../suite/case-list/columns";
import {
	buildSortDirectives,
	SORT_DIRECTION_WIRE_MAP,
	SORT_TYPE_WIRE_MAP,
} from "../suite/case-list/sortKeys";
import { PROMPT_ATTRIBUTE_MAPPINGS } from "../suite/case-search/searchPrompts";
import { composeXPathQueryEmission } from "../suite/case-search/xpathQuery";
import type {
	CaseSearchProperty,
	DefaultCaseSearchProperty,
	DetailColumnFormat,
	DetailPair,
	SortElement,
	CaseSearchConfig as WireCaseSearchConfig,
	DetailColumn as WireDetailColumn,
} from "../types";

// ============================================================
// `DetailColumn` projection
// ============================================================

/**
 * Per-kind dispatch table — translates a Nova `Column` to its
 * CCHQ `DetailColumn` slot overrides. Each handler returns ONLY
 * the slots that differ from `detailColumn()`'s plain baseline;
 * unset slots inherit the baseline's CCHQ-default values. Keeps
 * the dispatch site readable and the per-kind shape declarative.
 *
 * Calc columns route through CCHQ's `useXpathExpression` branch:
 * `format: "calculate"`, `useXpathExpression: true`, and `field`
 * carries the inline lowered XPath rather than a property name
 * (CCHQ's `detail_screen.py::FormattedDetailColumn.xpath` reads
 * `column.field` directly as the XPath when this flag is set).
 *
 * The `id-mapping` arm produces CCHQ's `enum` format with the
 * `(key, {lang: label})` per-entry shape — each entry's label
 * lives under the `en` key (Nova has no multi-language authoring
 * yet).
 *
 * The `interval` arm splits on `display`: `"always"` becomes
 * CCHQ's `time-ago` format scaled by `TIME_AGO_DIVISOR_DAYS[unit]`;
 * `"flag"` becomes CCHQ's `late-flag` format with the threshold
 * stored as an integer days count. CCHQ's `DetailColumn.late_flag`
 * is `IntegerProperty(default=30)`, so the float result of
 * `threshold × divisor` rounds to the nearest integer at the wire
 * boundary; the suite-XML emitter retains the float in the inline
 * XPath because the runtime evaluator coerces.
 */
function projectColumnToDetail(column: Column): WireDetailColumn {
	const headerRecord = { en: column.header };

	if (column.kind === "calculated") {
		const calcXpath = emitOnDeviceExpression(column.expression);
		return {
			...detailColumn(calcXpath, headerRecord),
			format: "calculate",
			useXpathExpression: true,
		};
	}

	const base: WireDetailColumn = detailColumn(column.field, headerRecord);

	switch (column.kind) {
		case "plain":
			// Baseline already carries `format: "plain"` — no overrides
			// needed beyond the shared `(field, header)` shape.
			return base;
		case "date":
			return {
				...base,
				format: "date",
				date_format: column.pattern,
			};
		case "phone":
			return {
				...base,
				format: "phone",
			};
		case "id-mapping": {
			// CCHQ's `MappingItem.value` is `{lang: label}`; Nova authors
			// in one language (`en`) so each entry's label lifts into the
			// `en` slot.
			const enumEntries = column.mapping.map((entry) => ({
				key: entry.value,
				value: { en: entry.label },
			}));
			return {
				...base,
				format: "enum",
				enum: enumEntries,
			};
		}
		case "interval": {
			const divisor = TIME_AGO_DIVISOR_DAYS[column.unit];
			if (column.display === "always") {
				return {
					...base,
					format: "time-ago",
					time_ago_interval: divisor,
				};
			}
			// `late-flag` shape: CCHQ's `late_flag` is an
			// `IntegerProperty(default=30)` — a strict integer days
			// count. The authored threshold-in-unit × the unit divisor
			// is a float for non-day units (months, years), so we
			// round at the wire boundary so the persisted document
			// round-trips. The suite-XML emitter renders the float
			// into the inline XPath unrounded (e.g. `91.3125` for
			// "3 months"); CCHQ regenerates the suite from the persisted
			// integer (`91`) so a sub-day rounding delta exists between
			// local preview and post-import runtime. Both deltas are
			// sub-day on every authoring entry; the XPath evaluator
			// coerces the comparator either way.
			return {
				...base,
				format: "late-flag",
				late_flag: Math.round(column.threshold * divisor),
			};
		}
	}
}

/**
 * Visibility-respecting projection of a `Column` for one detail
 * surface. Returns the projected column with `format: "invisible"`
 * substituted when the surface-visibility flag is false. CCHQ's
 * `"invisible"` format renders the column at zero width but keeps
 * it present for sort + index purposes — matching CCHQ's
 * `detail_screen.py::Invisible.HideShortColumn` template behavior.
 */
function projectColumnForDetail(
	column: Column,
	surface: "short" | "long",
): WireDetailColumn {
	const projected = projectColumnToDetail(column);
	const visible =
		surface === "short"
			? (column.visibleInList ?? true)
			: (column.visibleInDetail ?? true);
	if (visible) return projected;
	// Search-only / detail-only columns: keep the column shape (so
	// sort + index keep working) but mark `format: "invisible"`. The
	// short-circuit on `useXpathExpression` is preserved — a calc
	// column hidden from one surface keeps its inline-XPath shape on
	// the wire.
	return { ...projected, format: "invisible" satisfies DetailColumnFormat };
}

// ============================================================
// `SortElement` projection
// ============================================================

/**
 * Translate the per-module `ResolvedSortDirective` map (built by the
 * suite-XML emitter's `buildSortDirectives`) into CCHQ's `SortElement[]`.
 *
 * Reusing `buildSortDirectives` keeps the priority + tie-break rule
 * binding at one source — CCHQ's persistent document carries the
 * same sort sequence the suite-XML emits. The output array is
 * sorted by 1-based `order` ascending, matching the CCHQ wire shape
 * (CCHQ's `Detail.sort_elements` is an ordered list; `SortElement.order`
 * is not stored — the array position IS the order).
 *
 * Property-rooted directives populate `field` with the bare
 * property name; calc directives populate `field` with a stable
 * placeholder string (`"_calculated_property"`) and put the lowered
 * XPath in `sort_calculation`. CCHQ's `SortElement.valid()` requires
 * at least one of `field` / `sort_calculation` to be non-empty;
 * populating both keeps the document round-trippable and matches
 * CCHQ's `detail_screen.py` precedence rule (when `sort_calculation`
 * is set, it wins; `field` becomes a labeling slot).
 */
function projectSortElements(mod: Module, doc: BlueprintDoc): SortElement[] {
	const directives = buildSortDirectives(mod, doc);
	if (directives.size === 0) return [];

	// `buildSortDirectives` keys by uuid; the directive `order` is
	// already the 1-based priority + tie-break position. Collect
	// values, sort by `order`, then translate each.
	const ordered = [...directives.values()].sort((a, b) => a.order - b.order);
	return ordered.map((directive) => {
		const type = SORT_TYPE_WIRE_MAP[directive.type];
		const direction = SORT_DIRECTION_WIRE_MAP[directive.direction];
		if (directive.kind === "property") {
			return {
				field: directive.xpath,
				type,
				direction,
				blanks: "",
				display: {},
				sort_calculation: "",
			};
		}
		return {
			// Calc-column placeholder — CCHQ's `SortElement.valid()`
			// requires a non-empty `field`. The runtime reads
			// `sort_calculation` when it's set; `field` becomes the
			// display-label slot.
			field: "_calculated_property",
			type,
			direction,
			blanks: "",
			display: {},
			sort_calculation: directive.calcXpath,
		};
	});
}

// ============================================================
// `case_list_filter` projection
// ============================================================

/**
 * Compile `caseListConfig.filter` to the wire-form XPath string
 * stored at `case_details.short.filter` (CCHQ's getter
 * `module.case_list_filter` reads through to this slot). Absent
 * filter and the `match-all` sentinel both collapse to `null` —
 * CCHQ omits the slot when no filter is authored.
 *
 * The compiled XPath is identical to the bracketed body of the
 * suite-XML nodeset filter at `lib/commcare/suite/case-list/nodesetFilter.ts`;
 * the HQ JSON stores it bare (CCHQ's `EntriesHelper.get_filter_xpath`
 * wraps it in `[...]` at suite-emission time on the CCHQ side too).
 */
function projectCaseListFilter(
	filter: CaseListConfig["filter"],
): string | null {
	if (filter === undefined) return null;
	if (filter.kind === "match-all") return null;
	return emitCaseListFilter(filter);
}

// ============================================================
// `search_config` projection
// ============================================================

/**
 * Translate one simple-arm `SearchInputDef` to a CCHQ
 * `CaseSearchProperty`. The runtime renders one prompt per entry on
 * the search screen, keyed by `name`.
 *
 * Wire-attribute mapping reuses `PROMPT_ATTRIBUTE_MAPPINGS` from the
 * suite-XML prompt emitter — both surfaces project the same
 * `(input_type) → (input_, appearance)` rule so the wire shape
 * stays consistent regardless of which CCHQ ingest path the JSON
 * flows through.
 *
 * The bare `<prompt>` slot carries only the widget kind + label +
 * optional default value. CCHQ has no per-property matcher-strategy
 * flag on `CaseSearchProperty` — fuzzy / phonetic / starts-with /
 * fuzzy-date matching is expressed as explicit XPath function calls
 * inside `_xpath_query`. Every non-`exact` simple-arm input routes
 * through `composeXPathQueryEmission` via `simpleArmDerivation.ts`,
 * which emits the matching XPath function predicate AND-composed
 * with the rest of the filter set. The validator's
 * `searchInputViaModeCompatibility` rule rejects the one mode the
 * single-binding wire shape can't carry (`multi-select-contains`).
 *
 * `default` (an authored seed expression) compiles to on-device
 * XPath via `emitOnDeviceExpression` and lands on CCHQ's
 * `default_value` attribute — same dialect the suite-XML
 * `<prompt default>` attribute carries.
 */
function projectSimpleSearchInput(
	input: SimpleSearchInputDef,
): CaseSearchProperty {
	const mapping = PROMPT_ATTRIBUTE_MAPPINGS[input.type];
	const property: CaseSearchProperty = {
		name: input.name,
		// Empty author labels resolve to the input's `name` at runtime so
		// the screen always has something readable to render — same
		// fallback the suite-XML prompts apply.
		label: { en: input.label !== "" ? input.label : input.name },
	};
	if (mapping.input !== undefined) property.input_ = mapping.input;
	if (mapping.appearance !== undefined)
		property.appearance = mapping.appearance;
	if (input.default !== undefined) {
		property.default_value = emitOnDeviceExpression(input.default);
	}
	return property;
}

/**
 * Translate a `SearchInputDef[]` to the `properties` slot of
 * `search_config`. Only the simple-arm rows surface as
 * `CaseSearchProperty` entries — advanced-arm rows carry no
 * runtime prompt config (their entire contribution is the
 * AND-composed predicate slot that lands in `_xpath_query`).
 */
function projectSearchProperties(
	searchInputs: ReadonlyArray<SearchInputDef>,
): CaseSearchProperty[] {
	const out: CaseSearchProperty[] = [];
	for (const input of searchInputs) {
		if (input.kind === "simple") {
			out.push(projectSimpleSearchInput(input));
		}
	}
	return out;
}

/**
 * Project the `caseListConfig.filter` + every advanced-arm
 * predicate + every simple-arm input with a non-self relation walk
 * into the CCHQ-side `default_properties` array. Each hoist from
 * the CSQL emitter takes its own slot BEFORE the `_xpath_query`
 * slot so its inputs resolve first at runtime (CCHQ's runtime
 * evaluates default_properties in array order).
 *
 * `caseType` threads through `composeXPathQueryEmission` so the
 * simple-arm-with-via derivation builds correctly-qualified
 * property references. Modules without a case type skip the
 * simple-arm derivation; the validator surfaces the structural
 * error separately.
 *
 * Empty-list output when there is nothing to AND-compose — the
 * absent `_xpath_query` slot is how CCHQ encodes "no server-side
 * filter."
 */
function projectDefaultProperties(
	caseListConfig: CaseListConfig,
	caseType: string | undefined,
): DefaultCaseSearchProperty[] {
	const emission = composeXPathQueryEmission(caseListConfig, caseType);
	if (emission === undefined) return [];
	const out: DefaultCaseSearchProperty[] = [];
	for (const hoist of emission.hoists) {
		// Each hoist binds a synthetic search-input name to its
		// on-device wrapper XPath. CCHQ's `DefaultCaseSearchProperty`
		// stores the (name, value) pair as a single slot.
		out.push({
			property: hoist.inputRef,
			defaultValue: emitOnDeviceExpression(hoist.expression),
		});
	}
	// CCHQ's special `_xpath_query` key routes the value through the
	// CSQL parser at runtime; the wrapper string is the on-device
	// concat expression that builds the CSQL query.
	out.push({
		property: "_xpath_query",
		defaultValue: emission.wrapper,
	});
	return out;
}

/**
 * Build the full `module.search_config` document from a module's
 * `caseSearchConfig` + `caseListConfig`. Returns a fresh
 * `CaseSearchConfig` document carrying every authored slot mapped
 * to its CCHQ wire field; the expander overwrites the shell's
 * `search_config` with this result.
 *
 * Slots covered:
 *
 *   - `caseSearchConfig.searchScreenTitle` → `title_label`.
 *   - `caseSearchConfig.searchScreenSubtitle` → `description`.
 *   - `caseSearchConfig.searchButtonLabel` → `search_button_label`.
 *   - `caseSearchConfig.searchButtonDisplayCondition` →
 *     `search_button_display_condition` (compiled to on-device XPath).
 *   - `caseSearchConfig.excludedOwnerIds` →
 *     `blacklisted_owner_ids_expression` (the value expression
 *     compiles to on-device XPath; the suite-XML side wraps it as a
 *     `<data>` slot at search time. The HQ JSON persists the
 *     expression directly — CCHQ regenerates the suite at runtime).
 *   - `caseListConfig.searchInputs` (simple arm) → `properties`.
 *   - `caseListConfig.filter` + advanced-arm predicates →
 *     `default_properties` (AND-composed `_xpath_query` + hoists).
 *
 * `auto_launch` and `default_search` stay at CCHQ's defaults
 * (`false` / `false`). The suite-XML side derives the runtime
 * equivalents from `compileForPlatform`'s decision tree at
 * wire-emit time; persisting a platform-conditional value would
 * tie the doc to one platform.
 */
function buildSearchConfigDocument(
	caseSearchConfig: DomainCaseSearchConfig | undefined,
	caseListConfig: CaseListConfig | undefined,
	caseType: string | undefined,
): WireCaseSearchConfig {
	// One CCHQ-defaults seed point — `caseSearchConfigShell` in
	// `hqShells.ts`. Mutate the shell with authored overrides so the
	// CCHQ-default baseline lives in one file (any future CCHQ
	// upstream default change is a one-edit fix).
	const config = caseSearchConfigShell();

	if (caseSearchConfig !== undefined) {
		if (caseSearchConfig.searchScreenTitle !== undefined) {
			config.title_label = { en: caseSearchConfig.searchScreenTitle };
		}
		if (
			caseSearchConfig.searchScreenSubtitle !== undefined &&
			caseSearchConfig.searchScreenSubtitle !== ""
		) {
			config.description = { en: caseSearchConfig.searchScreenSubtitle };
		}
		if (caseSearchConfig.searchButtonLabel !== undefined) {
			config.search_button_label = { en: caseSearchConfig.searchButtonLabel };
		}
		if (caseSearchConfig.searchButtonDisplayCondition !== undefined) {
			// CCHQ stores the gating predicate as a bare on-device XPath
			// string; the runtime evaluates it before rendering the
			// search button.
			config.search_button_display_condition = emitCaseListFilter(
				caseSearchConfig.searchButtonDisplayCondition,
			);
		}
		if (caseSearchConfig.excludedOwnerIds !== undefined) {
			config.blacklisted_owner_ids_expression = emitOnDeviceExpression(
				caseSearchConfig.excludedOwnerIds,
			);
		}
	}

	if (caseListConfig !== undefined) {
		config.properties = projectSearchProperties(caseListConfig.searchInputs);
		config.default_properties = projectDefaultProperties(
			caseListConfig,
			caseType,
		);
	}

	return config;
}

// ============================================================
// Public surface
// ============================================================

/**
 * One-call HQ-JSON projection for a module's case-list-side state.
 * Returns the three wire fields the expander composes onto the
 * `HqModule` shell:
 *
 *   - `caseDetails` — the `DetailPair` with per-kind columns
 *     (short + long, visibility-aware), the per-priority sort
 *     directive list (short only), and the `case_list_filter`
 *     XPath (short only) lifted from `caseListConfig.filter`.
 *
 *   - `searchConfig` — the full `CaseSearch` document, composed
 *     from `caseSearchConfig` + `caseListConfig.searchInputs` /
 *     `caseListConfig.filter`.
 *
 * The expander's `hasCases` guard decides whether the module gets
 * the populated `caseDetails` shape or the empty fallback — this
 * helper builds the populated shape and leaves the decision to the
 * caller. A null `caseListConfig` is treated as the empty-list arm
 * (no columns, no sort, no filter, no search inputs); a null
 * `caseSearchConfig` is treated as no-search-chrome (CCHQ defaults).
 */
export interface CaseListHqProjection {
	readonly caseDetails: DetailPair;
	readonly searchConfig: WireCaseSearchConfig;
}

export function projectCaseListForHq(
	mod: Module,
	doc: BlueprintDoc,
): CaseListHqProjection {
	const caseListConfig = mod.caseListConfig;
	const caseSearchConfig = mod.caseSearchConfig;
	const allColumns = caseListConfig?.columns ?? [];

	const shortColumns = allColumns.map((c) =>
		projectColumnForDetail(c, "short"),
	);
	const longColumns = allColumns.map((c) => projectColumnForDetail(c, "long"));
	const sortElements = projectSortElements(mod, doc);
	const filter = projectCaseListFilter(caseListConfig?.filter);

	// `detailPair` from `hqShells` seeds the `(short, long)` pair
	// with default DetailBase slots; this projection then writes the
	// short detail's sort + filter overrides. CCHQ stores both
	// `sort_elements` and `filter` on the short detail per CCHQ's
	// `module.case_list_filter` getter (which reads `case_details.
	// short.filter`); the long detail's slots stay at defaults.
	const pair = detailPair(shortColumns, longColumns);
	pair.short.sort_elements = sortElements;
	pair.short.filter = filter;

	const searchConfig = buildSearchConfigDocument(
		caseSearchConfig,
		caseListConfig,
		mod.caseType,
	);

	return { caseDetails: pair, searchConfig };
}

// Re-export the per-column projection so tests can pin per-kind
// shapes without re-deriving a module-level fixture.
export { projectColumnForDetail, projectColumnToDetail };
