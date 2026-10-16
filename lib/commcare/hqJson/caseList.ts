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
//   - `case_details.short.columns` and `sort_elements` — the fields and
//     order rules of the case list order plan
//     (`lib/domain/caseListOrder.ts::caseListOrderPlan`), which the local
//     suite and Preview read too, so no reader decides a list's order on
//     its own. Every column of a list with no tile layout is a field; a
//     column hidden from Results is HQ's `invisible` column, which the
//     list's search still matches.
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
import type {
	BlueprintDoc,
	CaseListComparator,
	CaseListConfig,
	CaseListOrderPlan,
	CaseListOrderRule,
	CaseListShortField,
	CaseListSortKey,
	CaseProperty,
	CaseTileLayout,
	Column,
	CaseSearchConfig as DomainCaseSearchConfig,
	Module,
	SearchInputDef,
} from "@/lib/domain";
import {
	caseListOrderPlan,
	casePropertyOptionOccurrence,
	casePropertyOptionTranslationUnitId,
	casePropertyShowsOptionLabels,
	effectiveCaseSearchConfig,
	effectiveCaseTypes,
	imageMapShowsImages,
	makeTranslationUnitId,
	type OrdinaryCaseSearchConfig,
	orderedColumns,
	tileCellFor,
} from "@/lib/domain";
import {
	effectiveFilterForEmission,
	simplifyForEmission,
	substituteUnansweredSearchInputsInPredicate,
} from "@/lib/domain/predicate";
import type { RelationEvaluationScopeContext } from "@/lib/domain/predicate/normalizeRelationEvaluationScopes";
import type { TypeContext } from "@/lib/domain/predicate/typeChecker";
import { emitCasePropertyWirePath } from "../casePropertyWire";
import { caseSearchConfigShell, detailColumn, detailPair } from "../hqShells";
import {
	type CommCareLocalization,
	commCareLocalization,
	repeatForLanguages,
} from "../localization";
import {
	type AssetManifest,
	requireAssetRef,
} from "../multimedia/assetWirePath";
import { emitCaseListFilter } from "../predicate/caseListFilterEmitter";
import { imageMapEnumKey } from "../suite/case-list/columns";
import {
	emitExcludedOwnerFilterExpression,
	emitNormalizedExcludedOwnerIdsExpression,
} from "../suite/case-list/nodesetFilter";
import {
	caseListOrderOptions,
	columnReadsCaseAttribute,
	hqEnumPlaceholder,
	hqExpressionFieldText,
} from "../suite/case-list/orderPlanOptions";
import { SORT_DIRECTION_WIRE_MAP } from "../suite/case-list/sortKeys";
import { TILE_VERTICAL_ALIGN_WIRE } from "../suite/case-list/tileStyle";
import { compileForPlatform } from "../suite/case-search/compileForPlatform";
import { searchNeedsSupportingCases } from "../suite/case-search/relatedCaseProjection";
import {
	type RuntimeCsqlPromptValidation,
	searchPromptRelationContext,
	searchPromptWire,
} from "../suite/case-search/searchPrompts";
import {
	buildRuntimeCsqlPromptValidations,
	composeXPathQueryEmission,
	xpathQueryRequestValues,
} from "../suite/case-search/xpathQuery";
import type {
	CaseSearchProperty,
	DefaultCaseSearchProperty,
	Detail,
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

/** What every column projection of one module reads. */
interface ColumnProjectionContext {
	readonly mod: Module;
	readonly doc: BlueprintDoc;
	readonly localization: CommCareLocalization;
	readonly assets?: AssetManifest;
	/** Whether the export carries a media manifest
	 *  (`imageMapShowsImages`). */
	readonly mediaOn: boolean;
	readonly caseProperties: readonly CaseProperty[];
	readonly typeContext: TypeContext;
	readonly lookupNaming?: LookupWireNaming;
}

/**
 * Per-kind dispatch — translates a Nova `Column` to its CCHQ `DetailColumn`
 * on one screen. Each arm overrides only the slots that differ from
 * `detailColumn()`'s plain baseline.
 *
 * Every expression arm takes its `field` from
 * `orderPlanOptions.ts::hqExpressionFieldText`, the function the order
 * plan's join text comes from, with the screen it is writing, so a stored
 * short column's `field` is the plan's join text itself. CCHQ uses an
 * expression column's `field` verbatim as the XPath
 * (`detail_screen.py::FormattedDetailColumn.xpath`).
 *
 *   - `calculated`: `format: "plain"` over its expression, as HQ's Case
 *     List page writes a calculated column. Effective Search writes a
 *     whole-expression parent property as a context-relative calculated
 *     XPath that CCHQ copies into its Search detail.
 *   - A column over `case_id`, `owner_id` or `status` is an expression
 *     column of its kind's format, `field: "@<name>"` (finding 57): HQ reads
 *     a property column's `field` as a child element, and its
 *     `CASE_PROPERTY_MAP` has no entry for `case_id`.
 *   - `plain` over a select with options: `translatable-enum`, the label
 *     expression with one enum variable per option.
 *   - `id-mapping`: CCHQ's `enum` over the property, one entry per mapping
 *     row keyed by its value, so HQ's build shows the `selected` chain the
 *     local suite writes and sorts by the mapping position
 *     (`detail_screen.py::Enum`).
 *   - `image-map`: `enum-image` wherever `imageMapShowsImages` holds, the
 *     plain column otherwise.
 *   - `link`: `markdown` over the link expression.
 *   - `interval`: `translatable-enum` over the same expression the suite
 *     writes; CCHQ's stock `time-ago` cannot store Nova's threshold text and
 *     its `late-flag` hard-codes `*`.
 */
function projectColumnToDetail(
	column: Column,
	ctx: ColumnProjectionContext,
	screen: "results" | "details",
): WireDetailColumn {
	const { doc, localization, mod } = ctx;
	const headerRecord = localization.textMap(
		makeTranslationUnitId("column", column.uuid, "header"),
	);
	const expressionField = () =>
		hqExpressionFieldText(
			column,
			mod,
			doc,
			screen,
			ctx.lookupNaming,
			ctx.typeContext,
		);

	if (column.kind === "calculated") {
		return {
			...detailColumn(expressionField(), headerRecord),
			useXpathExpression: true,
		};
	}

	const attribute = columnReadsCaseAttribute(column);
	const base: WireDetailColumn = attribute
		? {
				...detailColumn(emitCasePropertyWirePath(column.field), headerRecord),
				useXpathExpression: true,
			}
		: detailColumn(column.field, headerRecord);

	switch (column.kind) {
		case "plain": {
			const property = ctx.caseProperties.find(
				(candidate) => candidate.name === column.field,
			);
			if (property === undefined || !casePropertyShowsOptionLabels(property)) {
				return base;
			}
			const options = property.options ?? [];
			return {
				...base,
				field: expressionField(),
				format: "translatable-enum",
				useXpathExpression: true,
				enum: options.map((option, index) => ({
					key: hqEnumPlaceholder(index),
					value: localization.proseTextMap(
						casePropertyOptionTranslationUnitId(
							mod.caseType ?? "",
							property.name,
							option.value,
							casePropertyOptionOccurrence(options, index),
						),
					),
				})),
			};
		}
		case "date":
			return { ...base, format: "date", date_format: column.pattern };
		case "phone":
			return { ...base, format: "phone" };
		case "id-mapping":
			// HQ keys each entry by its value and builds the display
			// `replace(join(' ', if(selected(<xpath>, '<key>'), $k<key>, ''), …),
			// '\s+', ' ')` and the sort `if(selected(<xpath>, '<key>'), 0, …'')`
			// itself (`suite_xml/xml_models.py::XPathEnum.build`).
			return {
				...base,
				format: "enum",
				enum: column.mapping.map((entry) => ({
					key: entry.value,
					value: localization.textMap(
						makeTranslationUnitId(
							"column",
							column.uuid,
							"mapping",
							entry.value,
						),
					),
				})),
			};
		case "image-map": {
			// `enum-image` shares the id-mapping `enum` shape, but each
			// entry's value is the IMAGE path (`{lang: jr://...}`), not a
			// text label (`detail_screen.py::EnumImage`, `template_form =
			// 'image'`). A map with no entries names no path, so it is the
			// image column with a manifest and without one.
			if (!imageMapShowsImages(column, ctx.mediaOn)) return base;
			return {
				...base,
				format: "enum-image",
				enum: column.mapping.map((entry) => ({
					key: imageMapEnumKey(entry.value),
					value: repeatForLanguages(
						localization.languages,
						requireAssetRef(
							entry.assetId,
							ctx.assets ?? new Map(),
							"projectColumnToDetail image-map",
						),
					),
				})),
			};
		}
		case "link":
			// `markdown` + `useXpathExpression`: HQ wraps the expression as
			// `$calculated_property` and renders the result through
			// `Markdown.template_form`. The label rides inside the expression;
			// see `linkColumnSchema` for why the wire has nowhere else for it.
			return {
				...base,
				field: expressionField(),
				format: "markdown",
				useXpathExpression: true,
			};
		case "interval":
			return {
				...base,
				field: expressionField(),
				format: "translatable-enum",
				useXpathExpression: true,
				enum: [
					{
						key: hqEnumPlaceholder(0),
						value: localization.textMap(
							makeTranslationUnitId("column", column.uuid, "text"),
						),
					},
				],
			};
	}
}

/**
 * One field of the short detail, from the order plan. A shown field is its
 * kind's projection on Results. A hidden field is HQ's `invisible` column,
 * built from the `detailColumn` shell and never from the shown projection:
 * the raw property for a column that is not calculated, `@<name>` for an
 * attribute-backed one, the expression for a calculated one. Every other
 * slot is the shell's own, `date_format` among them, which no reader of an
 * `invisible` column reads.
 *
 * A hidden field's header is never read by HQ's build
 * (`detail_screen.py::Invisible.header` writes an empty text unless the
 * joined sort element has display text, `models/case_list.py::SortElement.
 * has_display_values`, and Nova's never has). Where the column is shown on
 * Details it is the header's text map; where it is hidden from both screens
 * it has no header unit, and the stored header stands under every wire code.
 * The Case List save keeps both spellings.
 *
 * Throws where the stored `field` is not the plan's join text: HQ joins an
 * order rule by that text alone, so the two must be one string.
 */
function projectColumnForShortDetail(
	field: CaseListShortField,
	ctx: ColumnProjectionContext,
): WireDetailColumn {
	const { column } = field;
	const projected: WireDetailColumn = field.hidden
		? {
				...detailColumn(
					field.joinText,
					column.visibleInDetail !== false
						? ctx.localization.textMap(
								makeTranslationUnitId("column", column.uuid, "header"),
							)
						: repeatForLanguages(ctx.localization.languages, column.header),
				),
				format: "invisible" satisfies DetailColumnFormat,
				useXpathExpression:
					column.kind === "calculated" || columnReadsCaseAttribute(column),
			}
		: projectColumnToDetail(column, ctx, "results");
	if (projected.field !== field.joinText) {
		throw new Error(
			`projectColumnForShortDetail: the short column ${column.uuid} writes the field ${JSON.stringify(projected.field)}, but the order plan joins it by ${JSON.stringify(field.joinText)}. HQ joins an order rule by that text alone, so the projection and caseListOrderPlan must print one string.`,
		);
	}
	return projected;
}

// ============================================================
// `SortElement` projection
// ============================================================

/**
 * The short detail's `sort_elements`, from the order plan: one element per
 * rule the plan marks `written`, in `order`, fields and carriers together,
 * in the Case List page's own spelling, so the page's save changes none
 * (`static/app_manager/js/details/bootstrap5/sort_rows.js`,
 * `views/modules.py::_update_sort_elements`).
 *
 *   - `field`: the property name of a property element, or
 *     `_cc_calculated_<position>` of the field the rule is AUTHORED on, which
 *     HQ then gives to the first field with that field's text
 *     (`util.py::get_sort_and_sort_only_columns`).
 *   - `type`: the page's word. `plain` for the implicit rule; `int` or
 *     `double` for an integer or decimal comparator; `date` for a raw value
 *     compared as text over a date, datetime or time property; `plain`
 *     otherwise. HQ's build writes `string` for `date` and `plain` alike
 *     (`detail_screen.py::FormattedDetailColumn.sort_node`).
 *   - `blanks`: `first` ascending, `last` descending.
 *   - `display`: the first language's wire code with empty text, which the
 *     save adds where it is missing.
 *   - `sort_calculation`: always empty; the save empties it unless the
 *     project has `SORT_CALCULATION_IN_CASE_LIST`.
 *
 * An unsorted list whose first field is shown writes `[]`, and HQ's build
 * adds its default element for field 0
 * (`suite_xml/sections/details.py::get_default_sort_elements`).
 */
function projectSortElements(
	plan: CaseListOrderPlan,
	firstLanguage: string,
	caseProperties: readonly CaseProperty[],
): SortElement[] {
	const dataTypeOf = (name: string) =>
		caseProperties.find((property) => property.name === name)?.data_type;
	const written: {
		readonly rule: CaseListOrderRule;
		readonly key?: CaseListSortKey;
		readonly comparator: CaseListComparator;
	}[] = [
		...plan.fields.flatMap((field) =>
			field.rule === undefined
				? []
				: [{ rule: field.rule, key: field.key, comparator: field.comparator }],
		),
		...plan.carriers.map((carrier) => ({
			rule: carrier.rule,
			key: {
				kind: "property" as const,
				property: carrier.property,
			},
			comparator: carrier.comparator,
		})),
	].filter((entry) => entry.rule.written);
	return written
		.sort((a, b) => a.rule.order - b.rule.order)
		.map(({ rule, key, comparator }) => ({
			field:
				rule.element.kind === "property"
					? rule.element.property
					: `_cc_calculated_${rule.element.position}`,
			type: sortElementType(rule, key, comparator, dataTypeOf),
			direction: SORT_DIRECTION_WIRE_MAP[rule.direction],
			blanks: rule.blanks,
			display: { [firstLanguage]: "" },
			sort_calculation: "",
		}));
}

/** The Case List page's `type` word for one written rule. */
function sortElementType(
	rule: CaseListOrderRule,
	key: CaseListSortKey | undefined,
	comparator: CaseListComparator,
	dataTypeOf: (name: string) => CaseProperty["data_type"],
): "plain" | "date" | "int" | "double" {
	if (rule.implicit) return "plain";
	if (comparator === "integer") return "int";
	if (comparator === "decimal") return "double";
	if (key?.kind === "property") {
		const dataType = dataTypeOf(key.property);
		if (dataType === "date" || dataType === "datetime" || dataType === "time") {
			return "date";
		}
	}
	return "plain";
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
						: {
								lookup: {
									naming: lookupNaming,
									instanceScope: "suite",
								},
							},
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
 * Translate one `SearchInputDef` to a CCHQ `CaseSearchProperty`. The
 * runtime renders one prompt per entry on the search screen, keyed by
 * `name`.
 *
 * Every wire slot comes from `searchPromptWire`, the same projection the
 * suite-XML `<prompt>` emitter consumes: widget kind (`input_` /
 * `appearance`), `hidden`, `default_value`, `exclude`, the lookup-backed
 * `itemset`, `required`, and the single composed `validations[0]`. Only
 * the carrier differs: suite XML writes locale ids, HQ JSON writes the
 * per-language text map the same translation units resolve to.
 *
 * CCHQ has no per-property matcher-strategy flag on `CaseSearchProperty`
 * — fuzzy / phonetic / starts-with / fuzzy-date matching is expressed as
 * explicit XPath function calls inside `_xpath_query`, composed by
 * `composeXPathQueryEmission` via `simpleArmDerivation.ts`. `exclude`
 * keeps Core from also auto-submitting the prompt key as a separate
 * case-property filter on every input whose comparison lives there.
 */
function projectSearchInput(
	input: SearchInputDef,
	runtimeValidation: RuntimeCsqlPromptValidation | undefined,
	localization: CommCareLocalization,
	relationContext: RelationEvaluationScopeContext,
	lookupNaming?: LookupWireNaming,
): CaseSearchProperty {
	const wire = searchPromptWire(
		input,
		runtimeValidation,
		relationContext,
		lookupNaming,
	);
	const property: CaseSearchProperty = {
		name: wire.key,
		label: localization.textMapFor(wire.label.source),
	};
	if (wire.hint !== undefined) {
		property.hint = localization.textMapFor(wire.hint.source);
	}
	if (wire.input !== undefined) property.input_ = wire.input;
	if (wire.appearance !== undefined) property.appearance = wire.appearance;
	if (wire.defaultValue !== undefined) {
		property.default_value = wire.defaultValue;
	}
	// CCHQ stores `hidden` and `exclude` with `BooleanProperty(default=False)`
	// semantics, so a `true` value persists and an absent key reads false.
	if (wire.hidden) property.hidden = true;
	if (wire.exclude) property.exclude = true;
	if (wire.itemset !== undefined) {
		property.itemset = {
			instance_id: wire.itemset.instanceId,
			nodeset: wire.itemset.nodeset,
			label: wire.itemset.label,
			value: wire.itemset.value,
			sort: wire.itemset.sort,
		};
	}
	if (wire.required !== undefined) {
		property.required = {
			test: wire.required.test,
			text: localization.textMapFor(wire.required.message.source),
		};
	}
	if (wire.validation !== undefined) {
		property.validations = [
			{
				test: wire.validation.test,
				text: localization.textMapFor(wire.validation.message.source),
			},
		];
	}
	return property;
}

/**
 * Translate a `SearchInputDef[]` to the `properties` slot of
 * `search_config`. Every arm surfaces as a `CaseSearchProperty` entry
 * because CommCare only creates prompt bindings from this list.
 * Advanced rows also contribute their predicate to `_xpath_query`
 * and carry `exclude: true` so the binding is not mistaken for an
 * implicit case-property match.
 */
function projectSearchProperties(
	searchInputs: ReadonlyArray<SearchInputDef>,
	runtimeValidations: ReadonlyMap<string, RuntimeCsqlPromptValidation>,
	localization: CommCareLocalization,
	typeContext?: TypeContext,
	lookupNaming?: LookupWireNaming,
): CaseSearchProperty[] {
	const out: CaseSearchProperty[] = [];
	const relationContext = searchPromptRelationContext(
		searchInputs,
		typeContext ?? {},
	);
	// Search prompts render in searchInputs array order.
	for (const input of searchInputs) {
		out.push(
			projectSearchInput(
				input,
				runtimeValidations.get(input.name),
				localization,
				relationContext,
				lookupNaming,
			),
		);
	}
	return out;
}

/**
 * Project the `caseListConfig.filter` + every advanced-arm predicate +
 * every simple-arm input whose semantics need the explicit predicate route
 * into the CCHQ-side `default_properties` array — ONE `_xpath_query` row
 * per composed clause. This includes relations, prompt/target name
 * mismatches, non-exact modes, reserved paths, and exact whole-day date
 * inputs. CCHQ's suite generator loops every row into its own `<data>`
 * element (`remote_requests.py::_remote_request_query_datums` —
 * `QueryData(key=c.property, ref=c.defaultValue)` per entry) and the
 * search endpoint ANDs every `_xpath_query` value it receives
 * (`case_search/utils.py::_apply_filter`), so the per-clause rows filter
 * identically to one fused expression while each stays readable in HQ's
 * app manager. Non-grammar value expressions inline as on-device XPath
 * fragments inside their clause's wrapper at the CSQL emitter, matching
 * the canonical CCHQ pattern documented at
 * `commcare-hq/docs/case_search_query_language.rst`.
 *
 * `caseType` threads through `composeXPathQueryEmission` so the
 * simple-arm derivation builds correctly-qualified property references and
 * resolves date-vs-datetime boundaries. Modules without a case type skip the
 * simple-arm derivation; the validator surfaces the structural
 * error separately.
 *
 * `values` are `xpathQueryRequestValues`: empty when inputs exist and
 * nothing composes (absent `_xpath_query` rows are how CCHQ encodes "no
 * server-side filter"), and the zero-input sentinel alone for a search with
 * no input and no clause.
 */
function projectDefaultProperties(
	values: readonly string[],
): DefaultCaseSearchProperty[] {
	// CCHQ's special `_xpath_query` key routes each value through the
	// CSQL parser at search time; every value is one on-device
	// expression that builds one CSQL query.
	return values.map((value) => ({
		property: "_xpath_query",
		defaultValue: value,
	}));
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
 *   - Emitted parent-property information →
 *     `include_all_related_cases: true`.
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
	caseSearchConfig: OrdinaryCaseSearchConfig | undefined,
	caseListConfig: CaseListConfig | undefined,
	_caseType: string | undefined,
	moduleUuid: string,
	localization: CommCareLocalization,
	typeContext?: TypeContext,
	lookupNaming?: LookupWireNaming,
): WireCaseSearchConfig {
	// One CCHQ-defaults seed point — `caseSearchConfigShell` in
	// `hqShells.ts`. Mutate the shell with authored overrides so the
	// CCHQ-default baseline lives in one file (any future CCHQ
	// upstream default change is a one-edit fix).
	const config = caseSearchConfigShell(localization.languages);

	if (caseSearchConfig !== undefined) {
		// Use Nova's shared friendly default so a fresh search never inherits
		// CCHQ's blank or case-type-derived chrome on either wire path.
		config.title_label = localization.textMap(
			makeTranslationUnitId("module", moduleUuid, "search-title"),
		);
		if (
			caseSearchConfig.searchScreenSubtitle !== undefined &&
			caseSearchConfig.searchScreenSubtitle !== ""
		) {
			config.description = localization.textMap(
				makeTranslationUnitId("module", moduleUuid, "search-subtitle"),
			);
		}
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
				lookupNaming === undefined
					? {}
					: { lookup: { naming: lookupNaming, instanceScope: "suite" } },
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
	// projected authored search inputs without separate display settings to
	// `{}`; when it is still undefined this is an ordinary on-device list and
	// must not acquire a dormant `_xpath_query` merely because the list has a
	// filter.
	if (caseSearchConfig !== undefined && caseListConfig !== undefined) {
		const xpathQueryEmission = composeXPathQueryEmission(
			caseListConfig,
			_caseType,
			typeContext,
			lookupNaming,
		);
		config.properties = projectSearchProperties(
			caseListConfig.searchInputs,
			buildRuntimeCsqlPromptValidations(xpathQueryEmission),
			localization,
			typeContext,
			lookupNaming,
		);
		// A search with no input and no clause carries the zero-input
		// sentinel, as the local suite's query does.
		config.default_properties = projectDefaultProperties(
			xpathQueryRequestValues(caseListConfig, xpathQueryEmission),
		);
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
		config.include_all_related_cases = searchNeedsSupportingCases(
			caseListConfig,
			{
				...(typeContext ?? {}),
				...(_caseType === undefined ? {} : { currentCaseType: _caseType }),
			},
		);
	}

	return config;
}

// ============================================================
// Public surface
// ============================================================

const EMPTY_SHORT_LIST_FIELD = "name";
const EMPTY_SHORT_LIST_HEADER = "Name";

/**
 * The short detail of a menu whose list shows no column: the one `name`
 * column HQ's editors give every new menu (`models/modules.py::Module.new_module`),
 * headed "Name" in every app language so a Case List save changes nothing.
 * HQ's page has no column to save from in an empty list. The local suite
 * writes no detail for such a menu, since no session reaches it.
 */
export function emptyShortListColumns(
	languages: readonly string[],
): WireDetailColumn[] {
	return [
		detailColumn(
			EMPTY_SHORT_LIST_FIELD,
			repeatForLanguages(languages, EMPTY_SHORT_LIST_HEADER),
		),
	];
}

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
	const localization = commCareLocalization(doc);
	const caseListConfig = mod.caseListConfig;
	const caseSearchConfig = effectiveCaseSearchConfig(mod);
	const typeContext = moduleTypeContext(mod, doc);
	const caseProperties =
		effectiveCaseTypes(doc).find((type) => type.name === mod.caseType)
			?.properties ?? [];
	const ctx: ColumnProjectionContext = {
		mod,
		doc,
		localization,
		...(assets !== undefined && { assets }),
		mediaOn: assets !== undefined,
		caseProperties,
		typeContext,
		...(lookupNaming !== undefined && { lookupNaming }),
	};
	// The short detail's fields and order are the order plan's
	// (`lib/domain/caseListOrder.ts`); the long detail reads its own Details
	// sequence. CCHQ models the two as independent ordered arrays, and a
	// positional sort element indexes the short one.
	const plan =
		caseListConfig === undefined
			? { fields: [], carriers: [], authored: [] }
			: caseListOrderPlan(
					caseListConfig,
					caseProperties,
					caseListOrderOptions(mod, doc, ctx.mediaOn, lookupNaming),
				);
	const longSourceColumns = (
		caseListConfig === undefined ? [] : orderedColumns(caseListConfig, "detail")
	).filter((column) => column.visibleInDetail !== false);

	const shortColumns =
		plan.fields.length > 0
			? plan.fields.map((field) => projectColumnForShortDetail(field, ctx))
			: emptyShortListColumns(localization.languages);
	const longColumns = longSourceColumns.map((column) =>
		projectColumnToDetail(column, ctx, "details"),
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
	pair.short.sort_elements = projectSortElements(
		plan,
		localization.languages[0] ?? "en",
		caseProperties,
	);
	pair.short.filter = filter;
	if (caseListConfig?.selection?.kind === "multiple") {
		pair.short.multi_select = true;
		pair.short.max_select_value = caseListConfig.selection.maximum;
	}
	applyTileLayoutToShortDetail(pair.short, caseListConfig?.tile, plan.fields);

	const searchConfig = buildSearchConfigDocument(
		caseSearchConfig,
		caseListConfig,
		mod.caseType,
		mod.uuid,
		localization,
		typeContext,
		lookupNaming,
	);

	return { caseDetails: pair, searchConfig };
}

/**
 * Write the tile layout onto the SHORT detail only.
 *
 * `case_tile_template` is what makes CCHQ regenerate the detail through
 * `suite_xml/features/case_tiles.py::CaseTileHelper` — a bare truthiness
 * check in `suite_xml/sections/details.py::DetailContributor.build_detail`
 * with no feature toggle in front of it, so an uploaded Nova tile emits
 * on any domain with nothing to set up first. Nova always writes
 * `"custom"`, the arm where each column carries its own placement.
 *
 * Only the short detail is written, and that is enough to cover all three
 * tile surfaces: `models/modules.py::Module.search_detail` DEEP-COPIES the
 * short detail for the search-results screen, and `persist_tile_on_forms`
 * turns the same detail into the persistent tile. The long detail stays a
 * plain field list — the one CCHQ arm where `custom` would be legal but
 * Nova's contract keeps case-detail tiles out of scope.
 *
 * The per-column grid slots are written on the SAME column objects the
 * detail already carries. Nova writes all four coordinates together or
 * none: CCHQ's own emitter builds a `<style>` when ANY of the four is
 * non-null, so a partial set produces a `<grid>` missing an attribute,
 * and `GridParser::parse` reads each through an unguarded
 * `Integer.parseInt`. Every placed cell also states `horizontal_align`,
 * `vertical_align` and `font_size`, because HQ's Case List save writes all
 * three into a cell that holds none (`column.js`, defaults `left`, `start`,
 * `medium`), so a cell without them changes on the first save.
 *
 * `fields` are the order plan's short fields, in the exact order the caller
 * projected `detail.columns`, so the two zip positionally. In a tile list a
 * column hidden from Results is no field (`caseListOrder.ts`, rule 1): its
 * order rule is a sort row with no stored column, so no save can give it a
 * cell, and every stored column of a tile's short detail is placed.
 *
 * Grouping rides the same short detail and reaches the search-results
 * screen through the same deep copy. CCHQ emits the `<group>` for every
 * detail type ending in `short` — `build_case_tile_detail`'s own gate —
 * and `ModuleDetailsMixin.get_details` supplies `search_short` from
 * `Module.search_detail("short")`, so one written slot covers both
 * screens exactly as the per-column placements do.
 */
function applyTileLayoutToShortDetail(
	shortDetail: Detail,
	tile: CaseTileLayout | undefined,
	fields: readonly CaseListShortField[],
): void {
	if (tile === undefined) return;
	shortDetail.case_tile_template = "custom";
	if (tile.persistOnForms === true) shortDetail.persist_tile_on_forms = true;
	if (tile.grouping !== undefined) {
		shortDetail.case_tile_group = {
			doc_type: "CaseTileGroupConfig",
			index_identifier: tile.grouping.identifier,
			header_rows: tile.grouping.headerRows,
		};
	}
	for (const [index, field] of fields.entries()) {
		const cell = tileCellFor(field.column, tile);
		const target = shortDetail.columns[index];
		if (cell === undefined || target === undefined) continue;
		target.grid_x = cell.x;
		target.grid_y = cell.y;
		target.width = cell.width;
		target.height = cell.height;
		target.horizontal_align = cell.horizontalAlign;
		target.vertical_align = TILE_VERTICAL_ALIGN_WIRE[cell.verticalAlign];
		target.font_size = cell.fontSize;
		if (cell.showBorder !== undefined) target.show_border = cell.showBorder;
		if (cell.showShading !== undefined) target.show_shading = cell.showShading;
	}
}

// Re-export the per-column projection so tests can pin per-kind
// shapes without re-deriving a module-level fixture.
export { projectColumnToDetail };
