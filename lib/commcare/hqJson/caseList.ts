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
//   - `case_details.short.filter` — the always-on
//     `caseListConfig.filter` plus owner availability from
//     `caseSearchConfig.excludedOwnerIds`, compiled to one on-device XPath.
//     CCHQ's `case_list_filter` getter reads from this slot; keeping owner
//     exclusion here makes it apply to the ordinary list as well as Search.
//
//   - `search_config` (CCHQ's `CaseSearch`) — search-screen chrome,
//     per-input `<prompt>` projection, and the `_xpath_query` slot
//     (filter + advanced-arm predicates AND-composed via the shared
//     `composeXPathQueryEmission` helper). Wire-tokens used here
//     stay consistent with the suite-XML side via the shared
//     `PROMPT_ATTRIBUTE_MAPPINGS` table.

import type { LookupWireNaming } from "@/lib/commcare/lookup/naming";
import {
	byDetailColumnOrder,
	byListColumnOrder,
	bySortKey,
} from "@/lib/doc/order/compare";
import type {
	BlueprintDoc,
	CaseListConfig,
	CaseProperty,
	Column,
	CaseSearchConfig as DomainCaseSearchConfig,
	Module,
	SearchInputDef,
} from "@/lib/domain";
import {
	canonicalCasePropertyName,
	DEFAULT_CASE_SEARCH_BUTTON_LABEL,
	DEFAULT_CASE_SEARCH_TITLE,
	effectiveCaseSearchConfig,
	effectiveCaseTypes,
	resolveCommCareDatePattern,
} from "@/lib/domain";
import {
	effectiveFilterForEmission,
	simplifyForEmission,
	substituteUnansweredSearchInputsInPredicate,
} from "@/lib/domain/predicate";
import type { TypeContext } from "@/lib/domain/predicate/typeChecker";
import { emitCasePropertyWirePath } from "../casePropertyWire";
import { emitOnDeviceExpression } from "../expression/onDeviceEmitter";
import { caseSearchConfigShell, detailColumn, detailPair } from "../hqShells";
import {
	type AssetManifest,
	requireAssetRef,
} from "../multimedia/assetWirePath";
import { emitCaseListFilter } from "../predicate";
import {
	intervalColumnDisplayXpath,
	plainSelectDisplayXpath,
} from "../suite/case-list/columns";
import {
	emitExcludedOwnerFilterExpression,
	emitNormalizedExcludedOwnerIdsExpression,
} from "../suite/case-list/nodesetFilter";
import {
	buildSortDirectives,
	SORT_DIRECTION_WIRE_MAP,
	SORT_TYPE_WIRE_MAP,
} from "../suite/case-list/sortKeys";
import { compileForPlatform } from "../suite/case-search/compileForPlatform";
import {
	PROMPT_ATTRIBUTE_MAPPINGS,
	type RuntimeCsqlPromptValidation,
	searchInputSuppressesAutoMatch,
} from "../suite/case-search/searchPrompts";
import {
	buildRuntimeCsqlPromptValidations,
	type ComposedXPathQuery,
	composeXPathQueryEmission,
} from "../suite/case-search/xpathQuery";
import type {
	CaseSearchProperty,
	DefaultCaseSearchProperty,
	DetailColumnFormat,
	DetailPair,
	SortElement,
	CaseSearchConfig as WireCaseSearchConfig,
	DetailColumn as WireDetailColumn,
} from "../types";
import { moduleTypeContext } from "../validator/rules/case-list/shared";

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
 * The `interval` arm uses CCHQ's supported calculated-expression format for
 * both display modes. Its stock `time-ago` model cannot store Nova's overdue
 * threshold/text and its stock `late-flag` hard-codes `*`; the calculate arm
 * preserves the exact expression shared with suite.xml.
 */
function projectColumnToDetail(
	column: Column,
	assets?: AssetManifest,
	caseProperties: readonly CaseProperty[] = [],
	typeContext?: TypeContext,
	lookupNaming?: LookupWireNaming,
): WireDetailColumn {
	const headerRecord = { en: column.header };

	if (column.kind === "calculated") {
		const calcXpath = emitOnDeviceExpression(
			column.expression,
			undefined,
			typeContext ?? {},
			undefined,
			lookupNaming === undefined ? {} : { lookup: { naming: lookupNaming } },
		);
		return {
			...detailColumn(calcXpath, headerRecord),
			format: "calculate",
			useXpathExpression: true,
		};
	}

	const base: WireDetailColumn = detailColumn(
		canonicalCasePropertyName(column.field),
		headerRecord,
	);

	switch (column.kind) {
		case "plain": {
			const property = caseProperties.find(
				(candidate) => candidate.name === column.field,
			);
			if (
				property?.data_type === "single_select" ||
				property?.data_type === "multi_select"
			) {
				return {
					...base,
					field: plainSelectDisplayXpath(
						emitCasePropertyWirePath(column.field),
						property,
					),
					format: "calculate",
					useXpathExpression: true,
				};
			}
			// Baseline already carries `format: "plain"` — no overrides
			// needed beyond the shared `(field, header)` shape.
			return base;
		}
		case "date":
			return {
				...base,
				format: "date",
				date_format: resolveCommCareDatePattern(column.pattern),
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
		case "image-map": {
			// `enum-image` shares the id-mapping `enum` shape, but each
			// entry's value is the IMAGE path (`{lang: jr://...}`), not a
			// text label — verified against
			// `commcare-hq/.../detail_screen.py::EnumImage` (`template_form
			// = 'image'`). Media-off (no manifest) has no paths to emit, so
			// the column degrades to the plain `base` (raw property value).
			if (!assets) return base;
			const enumEntries = column.mapping.map((entry) => ({
				key: entry.value,
				value: {
					en: requireAssetRef(
						entry.assetId,
						assets,
						"projectColumnToDetail image-map",
					),
				},
			}));
			return {
				...base,
				format: "enum-image",
				enum: enumEntries,
			};
		}
		case "interval":
			// CCHQ's stock `time-ago` format stores only the divisor and
			// `late-flag` hard-codes `*`; neither can preserve Nova's authored
			// threshold + text. The supported calculate arm carries the exact
			// same XPath as Nova's suite emitter, so upload cannot change what
			// the author saw in Preview.
			return {
				...base,
				field: intervalColumnDisplayXpath(column),
				format: "calculate",
				useXpathExpression: true,
			};
	}
}

/**
 * Results-only visibility projection. CCHQ's `"invisible"` format is a
 * zero-width column on a short detail, so it safely keeps off-screen sort
 * carriers at their positional indices. The same format does NOT hide a
 * normal long-detail column; Details removal is therefore represented by
 * omitting that column from the long array altogether.
 */
function projectColumnForShortDetail(
	column: Column,
	assets?: AssetManifest,
	caseProperties: readonly CaseProperty[] = [],
	typeContext?: TypeContext,
	lookupNaming?: LookupWireNaming,
): WireDetailColumn {
	const projected = projectColumnToDetail(
		column,
		assets,
		caseProperties,
		typeContext,
		lookupNaming,
	);
	const visible = column.visibleInList ?? true;
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
 * CCHQ's `get_sort_and_sort_only_columns` at
 * `commcare-hq/.../app_manager/util.py` joins a `SortElement` to its
 * display column two ways: exact `SortElement.field` ==
 * `DetailColumn.field` string match, or — for `useXpathExpression`
 * columns — the positional key shape `_cc_calculated_{columnIndex}`
 * (`commcare-hq/.../app_manager/const.py::CALCULATED_SORT_FIELD_RX`
 * = `^_cc_calculated_(\\d+)$`, an index into the short-detail
 * columns array). A sort element that joins neither way falls into
 * the sort-ONLY path: CCHQ regenerates the suite with the sort on a
 * detached hidden column and the visible column loses its sort.
 *
 * The caller therefore passes the actually-projected short columns,
 * and the join shape is decided by the emitted
 * `useXpathExpression` flag rather than by the Nova column kind:
 * any column whose wire `field` carries an inline display
 * expression (calculated columns, select-typed plain columns with
 * an option catalog, interval columns) joins positionally, with the
 * sort source in `sort_calculation` — CCHQ passes that string
 * verbatim as the suite `<sort>` xpath
 * (`detail_screen.py::FormattedDetailColumn.sort_node`). Property-
 * rooted directives carry the raw property reference there, which
 * is exactly the sort source Nova's direct suite emits
 * (`sortKeys.ts::propertySortXpath`): rows sort by raw value, not
 * by the derived display label. Plain-field columns keep the bare
 * property-name join.
 */
function projectSortElements(
	mod: Module,
	doc: BlueprintDoc,
	sourceColumns: readonly Column[],
	wireColumns: readonly WireDetailColumn[],
	lookupNaming?: LookupWireNaming,
): SortElement[] {
	const directives = buildSortDirectives(mod, doc, lookupNaming);
	if (directives.size === 0) return [];

	// uuid → position in the short columns array. CCHQ's
	// `CALCULATED_SORT_FIELD_RX` uses `int(match.group(1))` as a
	// positional lookup into `detail_columns[column_index]`, so the
	// index must be the column's position in the full emitted short
	// sequence (Results order, including invisible sort carriers).
	const columnIndexByUuid = new Map<string, number>();
	for (let i = 0; i < sourceColumns.length; i++) {
		columnIndexByUuid.set(sourceColumns[i].uuid, i);
	}

	// `buildSortDirectives` keys by uuid; the directive `order` is
	// already the 1-based priority + tie-break position. Collect
	// `[uuid, directive]` pairs, sort by `order`, then translate.
	const ordered = [...directives.entries()].sort(
		([, a], [, b]) => a.order - b.order,
	);
	return ordered.map(([uuid, directive]) => {
		const type = SORT_TYPE_WIRE_MAP[directive.type];
		const direction = SORT_DIRECTION_WIRE_MAP[directive.direction];
		const columnIndex = columnIndexByUuid.get(uuid);
		// `buildSortDirectives` only returns directives for columns with a
		// `sort` slot, and `hqShortSourceColumns` keeps every such column,
		// so the lookup never misses at runtime; the throw is a
		// compiler-bug backstop.
		if (columnIndex === undefined) {
			throw new Error(
				"projectSortElements: sort directive references a column UUID that is not in the HQ short-detail source — `buildSortDirectives` should only surface directives for columns in this list.",
			);
		}
		if (directive.kind === "property") {
			const sourceColumn = sourceColumns[columnIndex];
			if (sourceColumn.kind === "calculated") {
				throw new Error(
					"projectSortElements: property sort directive resolved to a calculated column in the HQ short-detail source.",
				);
			}
			if (wireColumns[columnIndex]?.useXpathExpression === true) {
				// The projected column's `field` is an inline display
				// expression, so a property-name sort element can't join it.
				// Join positionally and sort by the raw property.
				return {
					field: `_cc_calculated_${columnIndex}`,
					type,
					direction,
					blanks: "",
					display: {},
					sort_calculation: emitCasePropertyWirePath(sourceColumn.field),
				};
			}
			return {
				// CCHQ joins SortElement.field to DetailColumn.field by exact
				// string. HQ JSON stores the domain/CCHQ field token here (not the
				// direct-suite XPath's `@status` attribute spelling).
				field: canonicalCasePropertyName(sourceColumn.field),
				type,
				direction,
				blanks: "",
				display: {},
				sort_calculation: "",
			};
		}
		return {
			field: `_cc_calculated_${columnIndex}`,
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
 * Compile the always-on list rule and owner exclusion to the wire-form XPath
 * string
 * stored at `case_details.short.filter` (CCHQ's getter
 * `module.case_list_filter` reads through to this slot). Either rule can be
 * present on its own. An absent list filter / `match-all` plus no owner
 * expression collapses to `null` — CCHQ omits the slot when no availability
 * rule is authored.
 *
 * The compiled XPath is identical to the bracketed bodies of the
 * suite-XML nodeset filters at `lib/commcare/suite/case-list/nodesetFilter.ts`;
 * the HQ JSON stores it bare (CCHQ's `EntriesHelper.get_filter_xpath`
 * wraps it in `[...]` at suite-emission time on the CCHQ side too).
 */
function projectCaseListFilter(
	filter: CaseListConfig["filter"],
	excludedOwnerIds: DomainCaseSearchConfig["excludedOwnerIds"],
	typeContext?: TypeContext,
	lookupNaming?: LookupWireNaming,
): string | null {
	// This slot lands in CCHQ's ordinary case-loading datum nodeset
	// (`EntriesHelper.get_filter_xpath`), which evaluates before any
	// Search runs — so Search-input dependencies substitute to their
	// unanswered reading first, exactly like the suite-XML nodeset
	// emitters (see `nodesetFilter.ts::emitNodesetFilter`); referencing
	// `instance('search-input:results')` here would crash the
	// HQ-regenerated entry with `XPathMissingInstanceException`.
	//
	// `effectiveFilterForEmission` returns null-equivalent (`undefined`)
	// for an absent filter OR one that reduces to `match-all` (top-level,
	// nested in an authored `and`, or via the substitution above), so the
	// projection is null rather than a tautological `true() and …`
	// string. Mirrors the suite-XML `nodesetFilter.ts` surface so both
	// case-list-filter wire forms stay identity-clean. See
	// `lib/domain/predicate/simplify.ts`.
	const effective = effectiveFilterForEmission(
		filter === undefined
			? undefined
			: substituteUnansweredSearchInputsInPredicate(filter),
	);
	const authoredFilter =
		effective === undefined
			? undefined
			: emitCaseListFilter(
					effective,
					undefined,
					typeContext ?? {},
					undefined,
					lookupNaming === undefined
						? {}
						: { lookup: { naming: lookupNaming } },
				);
	const ownerFilter = emitExcludedOwnerFilterExpression(
		excludedOwnerIds,
		typeContext ?? {},
		lookupNaming,
	);

	if (authoredFilter === undefined) return ownerFilter ?? null;
	if (ownerFilter === undefined) return authoredFilter;
	return `(${authoredFilter}) and (${ownerFilter})`;
}

// ============================================================
// `search_config` projection
// ============================================================

/**
 * Translate one `SearchInputDef` to a CCHQ
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
 * `exclude` is set for every advanced input and every simple input
 * whose comparison routes through `_xpath_query`. The prompt remains
 * present so CommCare binds the user's typed value, while `exclude`
 * prevents Core from also auto-submitting `name` as a separate case-
 * property query. The suite-XML emitter consults the same gate.
 *
 * `default` (an authored seed expression) compiles to on-device
 * XPath via `emitOnDeviceExpression` and lands on CCHQ's
 * `default_value` attribute — same dialect the suite-XML
 * `<prompt default>` attribute carries.
 */
function projectSearchInput(
	input: SearchInputDef,
	runtimeValidation: RuntimeCsqlPromptValidation | undefined,
	typeContext?: TypeContext,
	lookupNaming?: LookupWireNaming,
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
	// A date-range answer is a paired wire value; the domain's legacy scalar
	// default cannot express it. The validator makes the repair visible, and
	// this omission keeps a bypassed legacy doc from becoming an exact query.
	if (input.type !== "date-range" && input.default !== undefined) {
		property.default_value = emitOnDeviceExpression(
			input.default,
			undefined,
			typeContext ?? {},
			undefined,
			lookupNaming === undefined ? {} : { lookup: { naming: lookupNaming } },
		);
	}
	// Mirrors the suite-XML `<prompt exclude="true()">` decision; one
	// gate decides both surfaces. CCHQ stores the field with
	// `exclude_if_none=True` semantics, so a `true` value persists and
	// a `false` / absent value omits the key entirely (the CCHQ
	// runtime's `BooleanProperty(default=False)` reads the same).
	if (searchInputSuppressesAutoMatch(input)) {
		property.exclude = true;
	}
	if (runtimeValidation !== undefined) {
		property.validations = [
			{
				test: runtimeValidation.test,
				text: { en: runtimeValidation.message },
			},
		];
	}
	return property;
}

/**
 * Translate a `SearchInputDef[]` to the `properties` slot of
 * `search_config`. Both arms surface as `CaseSearchProperty` entries
 * because CommCare only creates prompt bindings from this list.
 * Advanced rows also contribute their predicate to `_xpath_query`
 * and carry `exclude: true` so the binding is not mistaken for an
 * implicit case-property match.
 */
function projectSearchProperties(
	searchInputs: ReadonlyArray<SearchInputDef>,
	runtimeValidations: ReadonlyMap<string, RuntimeCsqlPromptValidation>,
	typeContext?: TypeContext,
	lookupNaming?: LookupWireNaming,
): CaseSearchProperty[] {
	const out: CaseSearchProperty[] = [];
	// DISPLAY order (`sort-by-(order, uuid)`) — the search prompts render in
	// this sequence.
	for (const input of [...searchInputs].sort(bySortKey)) {
		out.push(
			projectSearchInput(
				input,
				runtimeValidations.get(input.name),
				typeContext,
				lookupNaming,
			),
		);
	}
	return out;
}

/**
 * Project the `caseListConfig.filter` + every advanced-arm predicate +
 * every simple-arm input whose semantics need the explicit predicate route
 * into the CCHQ-side `default_properties` array. This includes relations,
 * prompt/target name mismatches, non-exact modes, reserved paths, and exact
 * whole-day date inputs. The single
 * `_xpath_query` slot is the only entry produced — non-grammar
 * value expressions inline as on-device XPath fragments inside the
 * wrapper concat at the CSQL emitter, matching the canonical CCHQ
 * pattern documented at
 * `commcare-hq/docs/case_search_query_language.rst`.
 *
 * `caseType` threads through `composeXPathQueryEmission` so the
 * simple-arm derivation builds correctly-qualified property references and
 * resolves date-vs-datetime boundaries. Modules without a case type skip the
 * simple-arm derivation; the validator surfaces the structural
 * error separately.
 *
 * Empty-list output when there is nothing to AND-compose — the
 * absent `_xpath_query` slot is how CCHQ encodes "no server-side
 * filter."
 */
function projectDefaultProperties(
	emission: ComposedXPathQuery | undefined,
): DefaultCaseSearchProperty[] {
	if (emission === undefined) return [];
	// CCHQ's special `_xpath_query` key routes the value through the
	// CSQL parser at runtime; the wrapper string is the on-device
	// concat expression that builds the CSQL query.
	return [
		{
			property: "_xpath_query",
			defaultValue: emission.wrapper,
		},
	];
}

/**
 * CCHQ decides whether a module offers Search from the presence of at least
 * one prompt or default property (`app_manager/util.py::module_offers_search`).
 * Nova also supports an intentional zero-input, unfiltered manual Search
 * action, so that one shape needs a semantically neutral default property to
 * survive HQ ingestion. `match-all()` is CCHQ's supported CSQL identity
 * function; the outer quotes make the datum's XPath evaluate to that query
 * string at runtime.
 */
const ZERO_INPUT_SEARCH_SENTINEL: DefaultCaseSearchProperty = {
	property: "_xpath_query",
	defaultValue: "'match-all()'",
};

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
 *     compiles to normalized on-device XPath; the suite-XML side uses the
 *     same normalization and wraps it as a
 *     `<data>` slot at search time. The HQ JSON persists the
 *     expression directly — CCHQ regenerates the suite at runtime).
 *   - `caseListConfig.searchInputs` (simple arm) → `properties`.
 *   - `caseListConfig.filter` + advanced-arm predicates →
 *     `default_properties` (the single AND-composed `_xpath_query`
 *     slot).
 *
 * `auto_launch`, `default_search`, and `inline_search` are
 * persistent CCHQ state — the CCHQ runtime regenerates the suite
 * XML from this document, reading these flags directly off the
 * persisted doc (see `commcare-hq/.../suite_xml/sections/details.py::_get_auto_launch_expression`,
 * `commcare-hq/.../suite_xml/post_process/remote_requests.py`, and
 * `commcare-hq/.../app_manager/util.py::module_uses_inline_search`).
 * Nova exposes one canonical authoring surface — no platform toggle
 * — so the projection threads `compileForPlatform`'s web-context
 * output onto these slots. Nova's own suite-XML emitter drives
 * local rendering on every platform; the persisted CCHQ flags
 * apply when CCHQ regenerates the suite for the web entry point.
 */
function buildSearchConfigDocument(
	caseSearchConfig: DomainCaseSearchConfig | undefined,
	caseListConfig: CaseListConfig | undefined,
	_caseType: string | undefined,
	typeContext?: TypeContext,
	lookupNaming?: LookupWireNaming,
): WireCaseSearchConfig {
	// One CCHQ-defaults seed point — `caseSearchConfigShell` in
	// `hqShells.ts`. Mutate the shell with authored overrides so the
	// CCHQ-default baseline lives in one file (any future CCHQ
	// upstream default change is a one-edit fix).
	const config = caseSearchConfigShell();

	if (caseSearchConfig !== undefined) {
		// Use Nova's shared friendly default so a fresh search never inherits
		// CCHQ's blank or case-type-derived chrome on either wire path.
		config.title_label = {
			en: caseSearchConfig.searchScreenTitle ?? DEFAULT_CASE_SEARCH_TITLE,
		};
		if (
			caseSearchConfig.searchScreenSubtitle !== undefined &&
			caseSearchConfig.searchScreenSubtitle !== ""
		) {
			config.description = { en: caseSearchConfig.searchScreenSubtitle };
		}
		config.search_button_label = {
			en:
				caseSearchConfig.searchButtonLabel ?? DEFAULT_CASE_SEARCH_BUTTON_LABEL,
		};
		if (caseSearchConfig.searchButtonDisplayCondition !== undefined) {
			// CCHQ stores the gating predicate as a bare on-device XPath
			// string; the runtime evaluates it before rendering the
			// search button. `simplifyForEmission` strips any redundant
			// boolean identity (e.g. a `match-all` left inside an authored
			// `and`) so the condition doesn't emit a `true() and …`
			// conjunct — same normalize the filter surfaces apply.
			config.search_button_display_condition = emitCaseListFilter(
				simplifyForEmission(caseSearchConfig.searchButtonDisplayCondition),
				undefined,
				typeContext ?? {},
				undefined,
				lookupNaming === undefined ? {} : { lookup: { naming: lookupNaming } },
			);
		}
		if (caseSearchConfig.excludedOwnerIds !== undefined) {
			config.blacklisted_owner_ids_expression =
				emitNormalizedExcludedOwnerIdsExpression(
					caseSearchConfig.excludedOwnerIds,
					typeContext ?? {},
					lookupNaming,
				);
		}
	}

	// Search properties are server-query configuration, not a second copy of
	// the always-on case-list filter. `effectiveCaseSearchConfig` has already
	// folded legacy modules with authored search inputs into `{}`; when it is
	// still undefined this is an ordinary on-device list and must not acquire a
	// dormant `_xpath_query` merely because the list has a filter.
	if (caseSearchConfig !== undefined && caseListConfig !== undefined) {
		const xpathQueryEmission = composeXPathQueryEmission(
			caseListConfig,
			_caseType,
			typeContext,
		);
		config.properties = projectSearchProperties(
			caseListConfig.searchInputs,
			buildRuntimeCsqlPromptValidations(xpathQueryEmission),
			typeContext,
			lookupNaming,
		);
		config.default_properties = projectDefaultProperties(xpathQueryEmission);
		if (
			caseListConfig.searchInputs.length === 0 &&
			config.default_properties.length === 0
		) {
			config.default_properties = [{ ...ZERO_INPUT_SEARCH_SENTINEL }];
		}
	}

	// `compileForPlatform`'s three-flag `WireShape` projects onto the
	// persisted CCHQ slots. Nova exposes one canonical authoring
	// surface — no platform toggle — so the persisted values always
	// take the web-context shape: the HQ JSON ships one form and the
	// web entry point is where CCHQ regenerates the suite from it.
	// Without this projection, `auto_launch` and `default_search`
	// would stay at the shell defaults and CCHQ's runtime would never
	// reach skip-to-results — the entire `compileForPlatform`
	// decision tree would be dead code on the production upload path.
	// Nova's own suite-XML emitter drives local rendering on every
	// platform.
	if (caseSearchConfig !== undefined && caseListConfig !== undefined) {
		const wire = compileForPlatform(caseListConfig, caseSearchConfig, {
			platform: "web",
		});
		config.auto_launch = wire.autoLaunch;
		config.default_search = wire.defaultSearch;
		config.inline_search = wire.inlineSearch;
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
 *     directive list (short only), and the `case_list_filter` XPath (short
 *     only) composed from `caseListConfig.filter` and owner exclusion.
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
	assets?: AssetManifest,
	lookupNaming?: LookupWireNaming,
): CaseListHqProjection {
	const caseListConfig = mod.caseListConfig;
	const caseSearchConfig = effectiveCaseSearchConfig(mod);
	const typeContext = moduleTypeContext(mod, doc);
	const caseProperties =
		effectiveCaseTypes(doc).find((type) => type.name === mod.caseType)
			?.properties ?? [];
	// CCHQ models short (Results) and long (Details) as independent ordered
	// arrays. Preserve that distinction here; calculated-sort positional
	// indices bind only to the short array and therefore use Results order.
	const shortSourceColumns = hqShortSourceColumns(
		caseListConfig?.columns ?? [],
	);
	const longSourceColumns = [...(caseListConfig?.columns ?? [])]
		.filter((column) => column.visibleInDetail !== false)
		.sort(byDetailColumnOrder);

	const shortColumns = shortSourceColumns.map((c) =>
		projectColumnForShortDetail(
			c,
			assets,
			caseProperties,
			typeContext,
			lookupNaming,
		),
	);
	const longColumns = longSourceColumns.map((c) =>
		projectColumnToDetail(c, assets, caseProperties, typeContext, lookupNaming),
	);
	const sortElements = projectSortElements(
		mod,
		doc,
		shortSourceColumns,
		shortColumns,
		lookupNaming,
	);
	const filter = projectCaseListFilter(
		caseListConfig?.filter,
		mod.caseSearchConfig?.excludedOwnerIds,
		typeContext,
		lookupNaming,
	);

	// `detailPair` from `hqShells` seeds the `(short, long)` pair
	// with default DetailBase slots; this projection then writes the
	// short detail's sort + filter overrides. CCHQ stores both
	// `sort_elements` and `filter` on the short detail per CCHQ's
	// `module.case_list_filter` getter (which reads `case_details.
	// short.filter`); the long detail's slots stay at defaults. Owner exclusion
	// comes from the raw config because disabling Search must not widen the
	// ordinary case list.
	const pair = detailPair(shortColumns, longColumns);
	pair.short.sort_elements = sortElements;
	pair.short.filter = filter;

	const searchConfig = buildSearchConfigDocument(
		caseSearchConfig,
		caseListConfig,
		mod.caseType,
		typeContext,
		lookupNaming,
	);

	return { caseDetails: pair, searchConfig };
}

/** Results columns CCHQ must persist: visible fields plus the rare off-screen
 * sort carriers required to retain Default order. Useless hidden definitions
 * stay out of HQ JSON just as they stay out of the direct suite. */
function hqShortSourceColumns(columns: readonly Column[]): Column[] {
	return columns
		.filter(
			(column) => column.visibleInList !== false || column.sort !== undefined,
		)
		.sort(byListColumnOrder);
}

// Re-export the per-column projection so tests can pin per-kind
// shapes without re-deriving a module-level fixture.
export { projectColumnToDetail };
