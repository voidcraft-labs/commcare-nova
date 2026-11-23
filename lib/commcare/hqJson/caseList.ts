import {
	caseTextKeyPadding,
	caseTextWireKey,
} from "../suite/case-list/calculationText";
import { detailBindings } from "../suite/case-list/detailBindings";

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

import {
	type LookupWireNaming,
	lookupTypeIndexFromNaming,
} from "@/lib/commcare/lookup/naming";
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
	CaseType,
	Column,
	ColumnVia,
	CaseSearchConfig as DomainCaseSearchConfig,
	Module,
	SearchInputDef,
	TileCell,
	Uuid,
} from "@/lib/domain";
import {
	caseListOrderPlan,
	caseListWordingUnitId,
	casePropertyOptionOccurrence,
	casePropertyOptionTranslationUnitId,
	casePropertyShowsOptionLabels,
	columnFieldText,
	columnPropertyCaseType,
	DATE_COUNT_DAYS,
	declaresWebApps,
	EMPTY_CASE_LIST_ORDER_PLAN,
	effectiveCaseSearchConfig,
	effectiveCaseTypes,
	imageMapShowsImages,
	makeTranslationUnitId,
	moduleFormsReadSearch,
	type OrdinaryCaseSearchConfig,
	orderedColumns,
	searchScreenTitleText,
	tileCellFor,
	translatedDistanceProperty,
} from "@/lib/domain";
import { caseContextLine } from "@/lib/domain/caseFormContext";
import { caseMappingTextUnit } from "@/lib/domain/caseMappingRows";
import {
	detailTabForColumn,
	detailTabSearchChildType,
	detailTabSpans,
} from "@/lib/domain/detailTabs";
import {
	effectiveFilterForEmission,
	simplifyForEmission,
	substituteUnansweredSearchInputs,
} from "@/lib/domain/expression";
import { detailColumnRowScope } from "@/lib/domain/expression/detailRowScope";
import type { DatumRef, Expression } from "@/lib/domain/expression/types";
import type { CalculatedSort } from "@/lib/domain/modules";
import { type RewriteControl, rewriteWithheld } from "../emissionRewrites";
import {
	type ModuleExpressionContexts,
	moduleExpressionContexts,
} from "../expressionContext";
import { caseListStepDatumId } from "../formLinkProjection";
import { caseSearchConfigShell, detailColumn, detailPair } from "../hqShells";
import { listIconEndpointId } from "../listIconAction";
import {
	type CommCareLocalization,
	commCareLocalization,
	repeatForLanguages,
} from "../localization";
import {
	type AssetManifest,
	requireAssetRef,
} from "../multimedia/assetWirePath";
import { detailTabConditionWire } from "../suite/case-list/detailTabCondition";
import { detailTabOrderField } from "../suite/case-list/detailTabOrder";
import { detailRowExpressionWire } from "../suite/case-list/detailTabRows";
import { fixtureRowFieldName } from "../suite/case-list/fixtureRowField";
import { CASE_MAP_FORMATS } from "../suite/case-list/mapLayers";
import { nativeMappingKeys } from "../suite/case-list/mappingCondition";
import { namedTileWireSlot } from "../suite/case-list/namedTile";
import {
	emitExcludedOwnerFilterExpression,
	emitNormalizedExcludedOwnerIdsExpression,
} from "../suite/case-list/nodesetFilter";
import {
	type ColumnRewrites,
	caseListOrderOptions,
	columnProperty,
	columnStoredAsExpression,
	hqCalculatedSortExpression,
	hqEnumPlaceholder,
	hqExpressionField,
} from "../suite/case-list/orderPlanOptions";
import { SORT_DIRECTION_WIRE_MAP } from "../suite/case-list/sortKeys";
import { TILE_VERTICAL_ALIGN_WIRE } from "../suite/case-list/tileStyle";
import { searchNeedsSupportingCases } from "../suite/case-search/relatedCaseProjection";
import {
	type RuntimeCsqlPromptValidation,
	type SearchPromptSlot,
	searchPromptWire,
} from "../suite/case-search/searchPrompts";
import { searchWireShape } from "../suite/case-search/searchWireShape";
import { searchInputInstanceId } from "../suite/case-search/types";
import {
	buildRuntimeCsqlPromptValidations,
	composeXPathQueryEmission,
	xpathQueryRequestValues,
} from "../suite/case-search/xpathQuery";
import { columnPropertyPath, hqColumnFieldText } from "../suite/wire";
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
import {
	type ColumnFieldWordOf,
	type ColumnScreen,
	DERIVED_WIRE_IDENTITY,
} from "../wireIdentity";
import { w } from "../xpath/wire/builders";
import { toWire } from "../xpath/wire/fromExpression";
import type { WireExpr } from "../xpath/wire/tree";
import { type HqXPath, hqXPath, hqXPathText } from "./xpath";

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
	/** The effective catalog of every case type, where a column read through a
	 *  relation finds the property it shows. */
	readonly caseTypes: readonly CaseType[];
	readonly expressions: ModuleExpressionContexts;
	readonly lookupNaming?: LookupWireNaming;
	/** The reader's control over each calculated column's print (`CaseListRewrites.column`). */
	readonly columnRewrites?: ColumnRewrites;
	readonly mappingRewrites?: CaseListRewrites["mapping"];
	/** The word each column's property is kept under on each screen, where the export's target holds one. */
	readonly columnFieldWord?: ColumnFieldWordOf;
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
 *   - A column over `case_id` is an expression column of its kind's
 *     format, `field: "@case_id"`: HQ reads a property column's `field`
 *     through its `CASE_PROPERTY_MAP`, which has no entry for `case_id`. A
 *     column over `status` or `owner_id` is the property column HQ's Case
 *     List page stores, which the map reads as the case's attribute.
 *   - `plain` over a select with options: `translatable-enum`, the label
 *     expression with one enum variable per option.
 *   - `id-mapping`: CCHQ's `enum` over the property, one entry per mapping
 *     row keyed by its value, so HQ's build shows the `selected` chain the
 *     local suite writes and sorts by the mapping position
 *     (`detail_screen.py::Enum`).
 *   - `image-map`: `enum-image` wherever `imageMapShowsImages` holds, the
 *     plain column otherwise; on Results, an icon that submits a form is
 *     `clickable-icon` naming that form's entry point.
 *   - `link`: `markdown` over the link expression.
 *   - `interval`: `translatable-enum` over the same expression the suite
 *     writes; CCHQ's stock `time-ago` cannot store Nova's threshold text and
 *     its `late-flag` hard-codes `*`.
 */
function projectColumnToDetail(
	column: Column,
	ctx: ColumnProjectionContext,
	screen: "results" | "details",
): WireDetailColumn<HqXPath> {
	const { doc, localization, mod } = ctx;
	const mappingKeys = (rows: Parameters<typeof nativeMappingKeys>[1]) =>
		nativeMappingKeys(
			column.uuid,
			rows,
			{
				expressions: ctx.expressions,
				lookupNaming: ctx.lookupNaming,
				inline: moduleFormsReadSearch(mod),
			},
			(rowUuid) => ctx.mappingRewrites?.(column.uuid, rowUuid),
		).map((key) => (typeof key === "string" ? key : hqXPath(key, "enum-key")));
	const headerRecord = localization.textMap(
		makeTranslationUnitId("column", column.uuid, "header"),
	);
	const expressionWire = () =>
		hqExpressionField(
			column,
			mod,
			doc,
			screen,
			ctx.lookupNaming,
			ctx.expressions,
			ctx.columnRewrites?.(column.uuid),
		);
	const expressionField = () => hqXPath(expressionWire());
	if (column.kind === "calculated") {
		const wire = expressionWire();
		const field = hqXPath(wire);
		const direct =
			screen === "details"
				? fixtureRowFieldName(
						column,
						wire,
						ctx.columnFieldWord?.(column.uuid, "long"),
					)
				: undefined;
		const source = translatedDistanceProperty(column);
		const base = detailColumn(
			direct ??
				(source
					? hqColumnFieldText(
							columnFieldText(source),
							ctx.columnFieldWord?.(
								column.uuid,
								screen === "results" ? "short" : "long",
							),
						)
					: field),
			headerRecord,
		);
		if (column.texts !== undefined) {
			const padding = caseTextKeyPadding(field.expression, column.texts);
			return {
				...base,
				format: "translatable-enum",
				enum: column.texts.map((piece) => ({
					key: caseTextWireKey(piece.uuid, padding.get(piece.uuid)),
					value: localization.textMap(
						makeTranslationUnitId(
							"column",
							column.uuid,
							"calculation-text",
							piece.uuid,
						),
					),
				})),
			};
		}
		return column.showAs === "formatted-text"
			? { ...base, format: "markdown" }
			: base;
	}

	// A column over `case_id` is the expression reading it, through the
	// column's walk where it has one; any other property column is the field
	// HQ's page stores, the walk's indices and the property joined by `/`, the
	// property in HQ's word on this screen (`hqColumnFieldText`).
	const attribute = columnStoredAsExpression(column);
	const base = attribute
		? detailColumn(hqXPath(columnPropertyPath(column)), headerRecord)
		: detailColumn(
				hqColumnFieldText(
					columnFieldText(column),
					ctx.columnFieldWord?.(
						column.uuid,
						screen === "results" ? "short" : "long",
					),
				),
				headerRecord,
			);
	const propertyCaseType = columnPropertyCaseType(
		column,
		mod.caseType,
		ctx.caseTypes,
	);

	switch (column.kind) {
		case "plain": {
			const property = columnProperty(column, mod, ctx.caseTypes);
			if (
				propertyCaseType === undefined ||
				column.showChoice === "saved-value" ||
				property === undefined ||
				!casePropertyShowsOptionLabels(property)
			) {
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
							propertyCaseType,
							property.name,
							option.value,
							casePropertyOptionOccurrence(options, index),
						),
					),
				})),
			};
		}
		case "worker-distance":
			return { ...base, format: "distance" };
		case "map-location":
			return { ...base, format: "address" };
		case "map-layer":
			return { ...base, format: CASE_MAP_FORMATS[column.layer].hq };
		case "formatted-text":
			return { ...base, format: "markdown" };
		case "overdue-marker":
			return { ...base, format: "late-flag", late_flag: column.afterDays };
		case "date-count":
			return {
				...base,
				format: "time-ago",
				time_ago_interval: DATE_COUNT_DAYS[column.period],
			};
		case "date":
			return { ...base, format: "date", date_format: column.pattern };
		case "phone":
			return { ...base, format: "phone" };
		case "id-mapping": {
			const value = (entry: (typeof column.mapping)[number]) =>
				localization.textMap(
					caseMappingTextUnit(column.uuid, entry, "mapping"),
				);
			// HQ keys each entry by its value and builds the display
			// `replace(join(' ', if(selected(<xpath>, '<key>'), $k<key>, ''), …),
			// '\s+', ' ')` and the sort `if(selected(<xpath>, '<key>'), 0, …'')`
			// itself (`suite_xml/xml_models.py::XPathEnum.build`). A first-match
			// mapping is HQ's ordered conditions (`detail_screen.py::ConditionalEnum`).
			if (column.behavior === "first-match") {
				const keys = mappingKeys(
					column.mapping.map((entry) => ({ ...entry, match: "exact" })),
				);
				return {
					...base,
					format: "conditional-enum",
					enum: column.mapping.map((entry, index) => ({
						key: keys[index],
						value: value(entry),
					})),
				};
			}
			return {
				...base,
				format: "enum",
				enum: column.mapping.map((entry) => ({
					key: entry.value ?? "",
					value: value(entry),
				})),
			};
		}
		case "image-map": {
			// `enum-image` shares the id-mapping `enum` shape, but each
			// entry's value is the IMAGE path (`{lang: jr://...}`), not a
			// text label (`detail_screen.py::EnumImage`, `template_form =
			// 'image'`). A map with no entries names no path, so it is the
			// image column with a manifest and without one.
			if (!imageMapShowsImages(column, ctx.mediaOn)) return base;
			const keys = mappingKeys(column.mapping);
			// Only the case list runs an icon's action, so the case detail
			// keeps the image (`menus-and-case-lists/16pp-…`).
			const action =
				screen === "results" && column.entryPointUuid !== undefined
					? {
							format: "clickable-icon" as const,
							endpoint_action_id: listIconEndpointId(
								ctx.doc,
								column.entryPointUuid,
							),
						}
					: { format: "enum-image" as const };
			return {
				...base,
				...action,
				enum: column.mapping.map((entry, index) => ({
					key: keys[index],
					...(entry.altText !== undefined && {
						alt_text: localization.textMap(
							caseMappingTextUnit(column.uuid, entry, "image-description"),
						),
					}),
					value: repeatForLanguages(
						localization.languages,
						entry.assetId === undefined
							? ""
							: requireAssetRef(
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
 * the raw property for a column that is not calculated, `@case_id` for one
 * over the case's id, the expression for a calculated one. Every other
 * slot is the shell's own, `date_format` among them, which no reader of an
 * `invisible` column reads.
 *
 * A hidden field's header is read by HQ's build only where the joined sort
 * element has display text (`detail_screen.py::Invisible.header`,
 * `models/case_list.py::SortElement.has_display_values`), which Nova writes
 * where the plan's rule on the field carries a name in Sort by: the header is
 * then that name in every language, the app string Android's Sort by shows.
 * Otherwise no build reads it: where the column is shown on Details it is the
 * header's text map; where it is hidden from both screens it has no header
 * unit, and the stored header stands under every wire code. The Case List
 * save keeps both spellings.
 *
 * Throws where the stored `field` is not the plan's join text, a property's
 * in HQ's word (`hqColumnFieldText`): HQ joins an order rule by that text
 * alone, so the two must be one string.
 */
function projectColumnForShortDetail(
	field: CaseListShortField,
	ctx: ColumnProjectionContext,
): WireDetailColumn<HqXPath> {
	const { column } = field;
	const joinText = hqJoinText(field, ctx.columnFieldWord);
	const projected: WireDetailColumn<HqXPath> = field.hidden
		? {
				...detailColumn(
					column.kind === "calculated" || columnStoredAsExpression(column)
						? hqXPath(
								hqExpressionField(
									column,
									ctx.mod,
									ctx.doc,
									"results",
									ctx.lookupNaming,
									ctx.expressions,
									ctx.columnRewrites?.(column.uuid),
								),
							)
						: joinText,
					field.rule?.label !== undefined
						? ctx.localization.textMap(
								makeTranslationUnitId(
									"column",
									field.rule.label.column,
									"sort-label",
								),
							)
						: column.visibleInDetail !== false
							? ctx.localization.textMap(
									makeTranslationUnitId("column", column.uuid, "header"),
								)
							: repeatForLanguages(ctx.localization.languages, column.header),
				),
				format: "invisible" satisfies DetailColumnFormat,
			}
		: projectColumnToDetail(column, ctx, "results");
	const printedField =
		typeof projected.field === "string"
			? projected.field
			: hqXPathText(projected.field);
	if (printedField !== joinText) {
		throw new Error(
			`projectColumnForShortDetail: the short column ${column.uuid} writes the field ${JSON.stringify(printedField)}, but the order plan joins it by ${JSON.stringify(joinText)}. HQ joins an order rule by that text alone, so the projection and caseListOrderPlan must print one string.`,
		);
	}
	return projected;
}

/** A short field's join text as HQ stores it: a property column's in HQ's word
 *  on the list (`hqColumnFieldText`), any other as the order plan prints it. */
function hqJoinText(
	field: CaseListShortField,
	columnFieldWord: ColumnFieldWordOf | undefined,
): string {
	const { column } = field;
	return column.kind === "calculated" || columnStoredAsExpression(column)
		? field.joinText
		: hqColumnFieldText(
				field.joinText,
				columnFieldWord?.(column.uuid, "short"),
			);
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
 *   - `field`: the property of a property element, in HQ's word
 *     (`hqColumnFieldText`), as the field it joins stores it, or
 *     `_cc_calculated_<position>` of the field the rule is AUTHORED on, which
 *     HQ then gives to the first field with that field's text
 *     (`util.py::get_sort_and_sort_only_columns`).
 *   - `type`: the page's word. `plain` for the implicit rule; `int` or
 *     `double` for an integer or decimal comparator; `date` for a raw value
 *     compared as text over a date, datetime or time property; `plain`
 *     otherwise. HQ's build writes `string` for `date` and `plain` alike
 *     (`detail_screen.py::FormattedDetailColumn.sort_node`).
 *   - `blanks`: the rule's own, which follows its direction (`first`
 *     ascending, `last` descending) where the author says nothing.
 *   - `display`: the rule's name in Sort by in every language where the plan
 *     carries one (`caseListOrder.ts`, rule 10), the text HQ's build tests for
 *     before it gives the field a header (`detail_screen.py::Invisible.header`)
 *     and makes the header of a carrier (`util.py::create_temp_sort_column`);
 *     otherwise the first language's wire code with empty text, which the
 *     save adds where it is missing.
 *   - `sort_calculation`: the independent rule's expression beside an empty
 *     field. HQ saves it under `SORT_CALCULATION_IN_CASE_LIST`. A column rule
 *     leaves it empty.
 *
 * An unsorted list whose first field is shown writes `[]`, and HQ's build
 * adds its default element for field 0
 * (`suite_xml/sections/details.py::get_default_sort_elements`).
 */
function projectSortElements(
	plan: CaseListOrderPlan,
	localization: CommCareLocalization,
	dataTypeOf: (
		property: string,
		via: ColumnVia | undefined,
	) => CaseProperty["data_type"],
	columnFieldWord: ColumnFieldWordOf | undefined,
	calculation: (sort: CalculatedSort) => HqXPath,
): SortElement<HqXPath>[] {
	const written: {
		readonly rule: CaseListOrderRule;
		readonly key?: CaseListSortKey;
		readonly comparator: CaseListComparator;
		/** The word the field the rule lands on keeps its property under. */
		readonly word?: string;
	}[] = [
		...plan.fields.flatMap((field) =>
			field.rule === undefined
				? []
				: [
						{
							rule: field.rule,
							key: field.key,
							comparator: field.comparator,
							word: columnFieldWord?.(field.column.uuid, "short"),
						},
					],
		),
		...plan.carriers.map((carrier) => ({
			rule: carrier.rule,
			key: carrier.key,
			comparator: carrier.comparator,
		})),
	].filter((entry) => entry.rule.written);
	const ordinary = written.map(({ rule, key, comparator, word }) => ({
		order: rule.order,
		value: {
			field:
				rule.element.kind === "property"
					? hqColumnFieldText(rule.element.property, word)
					: `_cc_calculated_${rule.element.position}`,
			type: sortElementType(rule, key, comparator, dataTypeOf),
			direction: SORT_DIRECTION_WIRE_MAP[rule.direction],
			blanks: rule.blanks,
			display: sortDisplay(rule, localization),
			sort_calculation: "" as const,
		},
	}));
	// HQ keys independent rules by their literal calculation text. Give
	// distinct choices over the same typed value distinct, equivalent texts.
	const used = new Set<string>();
	const calculated = plan.calculations.map(
		({ order, sort, comparator, blanks }) => {
			let wire = calculation(sort);
			let text = hqXPathText(wire);
			while (used.has(text)) {
				wire = hqXPath(w.paren(wire.expression), wire.interpolation);
				text = hqXPathText(wire);
			}
			used.add(text);
			return {
				order,
				value: {
					field: "",
					type:
						comparator === "integer"
							? "int"
							: comparator === "decimal"
								? "double"
								: "plain",
					direction: SORT_DIRECTION_WIRE_MAP[sort.direction],
					blanks,
					display:
						sort.label === undefined
							? { [localization.languages[0] ?? "en"]: "" }
							: localization.textMap(
									makeTranslationUnitId("case-sort", sort.uuid, "label"),
								),
					sort_calculation: wire,
				},
			};
		},
	);
	const effective = [...ordinary, ...calculated].sort(
		(a, b) => a.order - b.order,
	);
	const byOrder = new Map(effective.map((row) => [row.order, row.value]));
	return [
		...plan.introductionOrders.flatMap((order) => {
			const value = byOrder.get(order);
			return value === undefined ? [] : [value];
		}),
		...effective.map((row) => row.value),
	];
}

/** A written rule's `display`: its name in Sort by, or none. */
function sortDisplay(
	rule: CaseListOrderRule,
	localization: CommCareLocalization,
): Record<string, string> {
	return rule.label === undefined
		? { [localization.languages[0] ?? "en"]: "" }
		: localization.textMap(
				makeTranslationUnitId("column", rule.label.column, "sort-label"),
			);
}

/** The Case List page's `type` word for one written rule. */
function sortElementType(
	rule: CaseListOrderRule,
	key: CaseListSortKey | undefined,
	comparator: CaseListComparator,
	dataTypeOf: (
		property: string,
		via: ColumnVia | undefined,
	) => CaseProperty["data_type"],
): "plain" | "date" | "int" | "double" | "distance" {
	if (rule.implicit) return "plain";
	if (key?.kind === "distance-property" || key?.kind === "distance-calculated")
		return "distance";
	if (comparator === "integer") return "int";
	if (comparator === "decimal") return "double";
	if (key?.kind === "property") {
		const dataType = dataTypeOf(key.property, key.via);
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
 *
 * Where `rewrites` withholds `filter-identities-dropped`, the filter prints as
 * stored, boolean identities included.
 */
export function projectCaseListFilter(
	filter: CaseListConfig["filter"],
	excludedOwnerIds: DomainCaseSearchConfig["excludedOwnerIds"],
	expressions: ModuleExpressionContexts,
	lookupNaming: LookupWireNaming | undefined,
	datumId: (ref: DatumRef) => string | undefined,
	rewrites?: RewriteControl,
): HqXPath | null {
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
	// `lib/domain/expression/simplify.ts`.
	const substituted =
		filter === undefined ? undefined : substituteUnansweredSearchInputs(filter);
	const effective =
		substituted !== undefined &&
		rewriteWithheld(rewrites, "filter-identities-dropped")
			? substituted
			: effectiveFilterForEmission(substituted);
	const authoredFilter =
		effective === undefined
			? undefined
			: toWire(effective, {
					target: "hq-json",
					types: expressions({ slot: "case_list_filter" }),
					bindings: {
						datumId,
						...(lookupNaming && {
							lookup: { naming: lookupNaming, instanceScope: "suite" },
						}),
					},
					...(rewrites === undefined ? {} : { rewrites }),
				});
	const ownerFilter =
		excludedOwnerIds === undefined
			? undefined
			: emitExcludedOwnerFilterExpression(
					excludedOwnerIds,
					expressions({ slot: "excluded_owner_ids" }),
					lookupNaming,
				);

	if (authoredFilter === undefined)
		return ownerFilter === undefined ? null : hqXPath(ownerFilter, "case");
	if (ownerFilter === undefined) return hqXPath(authoredFilter, "case");
	return hqXPath(w.and(authoredFilter, ownerFilter), "case");
}

/**
 * The search button's condition as CommCare HQ stores it
 * (`search_config.search_button_display_condition`): a bare on-device XPath
 * the runtime evaluates before it draws the button. `simplifyForEmission`
 * strips any redundant boolean identity (a `match-all` left inside an
 * authored `and`) so the condition carries no `true() and …` conjunct, the
 * same normalization the filter surfaces apply; where `rewrites` withholds
 * `filter-identities-dropped`, it prints as stored.
 */
export function projectSearchButtonCondition(
	condition: Expression,
	expressions: ModuleExpressionContexts,
	lookupNaming: LookupWireNaming | undefined,
	rewrites?: RewriteControl,
): HqXPath {
	return hqXPath(
		toWire(
			rewriteWithheld(rewrites, "filter-identities-dropped")
				? condition
				: simplifyForEmission(condition),
			{
				target: "hq-json",
				types: expressions({ slot: "search_button_display_condition" }),
				...(lookupNaming && {
					bindings: {
						lookup: { naming: lookupNaming, instanceScope: "suite" },
					},
				}),
				...(rewrites === undefined ? {} : { rewrites }),
			},
		),
	);
}

/**
 * The reader's control over the rewrites the `caseDetails`' expression slots print
 * (`emissionRewrites.ts`), each asked once per print of its slot; undefined where the slot
 * prints as an export does. The search's owner exclusion, which the list's filter writes as a
 * clause of its own (`nodesetFilter.ts::emitExcludedOwnerFilterExpression`), is no slot of the
 * list and prints as an export prints it. An export passes none.
 */
export interface CaseListRewrites {
	readonly mapping?: (column: Uuid, row: Uuid) => RewriteControl | undefined;
	readonly column?: ColumnRewrites;
	readonly sort?: (uuid: Uuid) => RewriteControl | undefined;
	readonly filter?: () => RewriteControl | undefined;
}

// ============================================================
// `search_config` projection
// ============================================================

/**
 * The reader's control over the rewrites one expression slot of a search's settings prints
 * (`emissionRewrites.ts`), by slot, asked once per print of the slot; undefined where the slot
 * prints as an export does. An export passes none.
 */
export type SearchConfigRewrites = (
	ref:
		| {
				readonly slot: "search_button_display_condition" | "excluded_owner_ids";
		  }
		| { readonly slot: SearchPromptSlot; readonly searchInputUuid: string },
) => RewriteControl | undefined;

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
	expressions: ModuleExpressionContexts,
	lookupNaming?: LookupWireNaming,
	inputInstanceId?: `search-input:${string}`,
	rewrites?: SearchConfigRewrites,
): CaseSearchProperty<HqXPath> {
	const wire = searchPromptWire(
		input,
		runtimeValidation,
		expressions,
		lookupNaming,
		inputInstanceId,
		rewrites === undefined
			? undefined
			: (slot) => rewrites({ slot, searchInputUuid: input.uuid }),
	);
	const property: CaseSearchProperty<HqXPath> = {
		name: wire.key,
		label: localization.textMapFor(wire.label.source),
	};
	if (wire.hint !== undefined) {
		property.hint = localization.textMapFor(wire.hint.source);
	}
	if (wire.input !== undefined) property.input_ = wire.input;
	if (wire.appearance !== undefined) property.appearance = wire.appearance;
	if (wire.defaultValue !== undefined) {
		property.default_value = hqXPath(wire.defaultValue);
	}
	// CCHQ stores `hidden` and `exclude` with `BooleanProperty(default=False)`
	// semantics, so a `true` value persists and an absent key reads false.
	if (wire.hidden) property.hidden = true;
	if (wire.exclude) property.exclude = true;
	if (wire.itemset !== undefined) {
		property.itemset = {
			instance_id: wire.itemset.instanceId,
			nodeset: hqXPath(wire.itemset.nodeset),
			label: hqXPath(wire.itemset.label),
			value: hqXPath(wire.itemset.value),
			sort: hqXPath(wire.itemset.sort),
		};
	}
	if (wire.required !== undefined) {
		property.required = {
			test: hqXPath(wire.required.test, "no-case"),
			text: localization.textMapFor(wire.required.message.source),
		};
	}
	if (wire.validation !== undefined) {
		property.validations = [
			{
				test: hqXPath(wire.validation.test, "no-dots"),
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
	expressions: ModuleExpressionContexts,
	lookupNaming?: LookupWireNaming,
	inputInstanceId?: `search-input:${string}`,
	rewrites?: SearchConfigRewrites,
): CaseSearchProperty<HqXPath>[] {
	const out: CaseSearchProperty<HqXPath>[] = [];

	// Search prompts render in searchInputs array order.
	for (const input of searchInputs) {
		out.push(
			projectSearchInput(
				input,
				runtimeValidations.get(input.name),
				localization,
				expressions,
				lookupNaming,
				inputInstanceId,
				rewrites,
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
	values: readonly WireExpr[],
): DefaultCaseSearchProperty<HqXPath>[] {
	// CCHQ's special `_xpath_query` key routes each value through the
	// CSQL parser at search time; every value is one on-device
	// expression that builds one CSQL query.
	return values.map((value) => ({
		property: "_xpath_query",
		defaultValue: hqXPath(value),
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
 *   - `caseSearchConfig.searchScreenTitle` → `title_label`, blank in every
 *     language for a search with no title.
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
 *     `default_properties` (one `_xpath_query` row per composed clause).
 *   - Emitted parent-property information →
 *     `include_all_related_cases: true`.
 *
 * `auto_launch`, `default_search`, and `inline_search` are
 * persistent CCHQ state — the CCHQ runtime regenerates the suite
 * XML from this document, reading these flags directly off the
 * persisted doc (see `commcare-hq/.../suite_xml/sections/details.py::_get_auto_launch_expression`,
 * `commcare-hq/.../suite_xml/post_process/remote_requests.py`, and
 * `commcare-hq/.../app_manager/util.py::module_uses_inline_search`).
 * The search's wire shape is one for every platform the app
 * declares, so the projection threads `searchWireShape`'s output
 * onto these slots. Nova's own suite-XML emitter drives
 * local rendering on every platform; the persisted CCHQ flags
 * apply when CCHQ regenerates the suite for the web entry point.
 */
function buildSearchConfigDocument(
	caseSearchConfig: OrdinaryCaseSearchConfig | undefined,
	caseListConfig: CaseListConfig | undefined,
	_caseType: string | undefined,
	moduleUuid: string,
	localization: CommCareLocalization,
	expressions: ModuleExpressionContexts,
	lookupNaming: LookupWireNaming | undefined,
	datumId: (ref: DatumRef) => string | undefined,
	runsInWebApps: boolean,
	rewrites?: SearchConfigRewrites,
): WireCaseSearchConfig<HqXPath> {
	// One CCHQ-defaults seed point — `caseSearchConfigShell` in
	// `hqShells.ts`. Mutate the shell with authored overrides so the
	// CCHQ-default baseline lives in one file (any future CCHQ
	// upstream default change is a one-edit fix).
	const config = caseSearchConfigShell(localization.languages, runsInWebApps);
	const wire =
		caseSearchConfig === undefined
			? undefined
			: searchWireShape(caseSearchConfig);
	// Core's answer instance is named after the query's storage instance.
	// Keep the HQ prompt rules, query operands and owner exclusion on the
	// same instance that the local suite's Search session supplies.
	const inputInstanceId =
		wire === undefined ? undefined : searchInputInstanceId(wire);

	if (caseSearchConfig !== undefined) {
		// Use Nova's shared friendly default so a fresh search never inherits
		// CCHQ's blank or case-type-derived chrome on either wire path. A
		// search with no title keeps the shell's blank in every language, the
		// map HQ's Case List page leaves where nothing was typed.
		if (searchScreenTitleText(caseSearchConfig) !== null) {
			config.title_label = localization.textMap(
				makeTranslationUnitId("module", moduleUuid, "search-title"),
			);
		}
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
			config.search_button_display_condition = projectSearchButtonCondition(
				caseSearchConfig.searchButtonDisplayCondition,
				expressions,
				lookupNaming,
				rewrites?.({ slot: "search_button_display_condition" }),
			);
		}
		if (caseSearchConfig.excludedOwnerIds !== undefined) {
			config.blacklisted_owner_ids_expression = hqXPath(
				emitNormalizedExcludedOwnerIdsExpression(
					caseSearchConfig.excludedOwnerIds,
					expressions({ slot: "excluded_owner_ids" }),
					lookupNaming,
					inputInstanceId,
					rewrites?.({ slot: "excluded_owner_ids" }),
				),
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
			expressions,
			lookupNaming,
			inputInstanceId,
			datumId,
		);
		config.properties = projectSearchProperties(
			caseListConfig.searchInputs,
			buildRuntimeCsqlPromptValidations(xpathQueryEmission),
			localization,
			expressions,
			lookupNaming,
			inputInstanceId,
			rewrites,
		);
		// A search with no input and no clause carries the zero-input
		// sentinel, as the local suite's query does.
		config.default_properties = projectDefaultProperties(
			xpathQueryRequestValues(caseListConfig, xpathQueryEmission),
		);
	}

	// `searchWireShape`'s three-flag `WireShape` projects onto the
	// persisted CCHQ slots: the authored workflow's spelling, one for
	// every platform the app declares. The HQ JSON ships one form and the
	// web entry point is where CCHQ regenerates the suite from it, so
	// without this projection `auto_launch` and `default_search` would
	// stay at the shell defaults and HQ's build would list first whatever
	// the author chose. The local suite spells the same workflow from the
	// same config (`remoteRequest.ts`, `inlineSearch.ts`).
	if (wire !== undefined) {
		config.auto_launch = wire.autoLaunch;
		config.default_search = wire.defaultSearch;
		config.inline_search = wire.inlineSearch;
	}
	if (wire !== undefined && caseListConfig !== undefined) {
		config.include_all_related_cases = searchNeedsSupportingCases(
			caseListConfig,
			expressions,
		);
	}

	return config;
}

// ============================================================
// Public surface
// ============================================================

/** The case's name, in the domain's word, which `hqColumnFieldText` writes in HQ's. */
const EMPTY_SHORT_LIST_FIELD = "case_name";
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
	word?: string,
): WireDetailColumn<HqXPath>[] {
	return [
		detailColumn(
			hqColumnFieldText(EMPTY_SHORT_LIST_FIELD, word),
			repeatForLanguages(languages, EMPTY_SHORT_LIST_HEADER),
		),
	];
}

/**
 * The details of a menu that lists no cases (`expander.ts`, `hasCases`): the
 * pair every new menu holds in CommCare HQ, the one `name` column on the list
 * and on the detail (`models/modules.py::Module.new_module`). HQ's build
 * writes a detail for each screen that holds a column
 * (`suite_xml/sections/details.py::DetailContributor`), which no entry of
 * such a menu names, so a menu made in HQ keeps its built details through a
 * publish. `columnFieldWord` answers for `nameColumn`, the menu's own name
 * column, which the reader of HQ's apps returns this pair as.
 */
export function emptyListDetailPair(
	languages: readonly string[],
	nameColumn?: Uuid,
	columnFieldWord?: ColumnFieldWordOf,
): DetailPair<HqXPath> {
	const word = (screen: ColumnScreen) =>
		nameColumn === undefined
			? undefined
			: columnFieldWord?.(nameColumn, screen);
	return detailPair(
		emptyShortListColumns(languages, word("short")),
		emptyShortListColumns(languages, word("long")),
	);
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
 * `searchRewrites` is the reader's control over the `searchConfig`'s
 * expression slots (`SearchConfigRewrites`), and `listRewrites` over the
 * `caseDetails`' (`CaseListRewrites`); an export passes neither.
 * `columnFieldWord` is the word the export's target keeps each column's
 * property under (`WireIdentity.columnFieldWord`), absent where it holds none.
 */
export interface CaseListHqProjection {
	readonly caseDetails: DetailPair<HqXPath>;
	readonly searchConfig: WireCaseSearchConfig<HqXPath>;
}

export function projectCaseListForHq(
	mod: Module,
	doc: BlueprintDoc,
	assets?: AssetManifest,
	lookupNaming?: LookupWireNaming,
	searchRewrites?: SearchConfigRewrites,
	listRewrites?: CaseListRewrites,
	columnFieldWord?: ColumnFieldWordOf,
	moduleUniqueId: (uuid: Uuid) => string = DERIVED_WIRE_IDENTITY.moduleUniqueId,
): CaseListHqProjection {
	const localization = commCareLocalization(doc);
	const caseListConfig = mod.caseListConfig;
	const caseSearchConfig = effectiveCaseSearchConfig(mod);
	const expressions = moduleExpressionContexts(doc, mod.uuid, lookupNaming);
	const caseTypes = effectiveCaseTypes(doc);
	const caseProperties =
		caseTypes.find((type) => type.name === mod.caseType)?.properties ?? [];
	const ctx: ColumnProjectionContext = {
		mod,
		doc,
		localization,
		...(assets !== undefined && { assets }),
		mediaOn: assets !== undefined,
		caseProperties,
		caseTypes,
		expressions,
		...(lookupNaming !== undefined && { lookupNaming }),
		...(listRewrites?.column !== undefined && {
			columnRewrites: listRewrites.column,
			mappingRewrites: listRewrites.mapping,
		}),
		...(columnFieldWord !== undefined && { columnFieldWord }),
	};
	// The short detail's fields and order are the order plan's
	// (`lib/domain/caseListOrder.ts`); the long detail reads its own Details
	// sequence. CCHQ models the two as independent ordered arrays, and a
	// positional sort element indexes the short one.
	const plan =
		caseListConfig === undefined
			? EMPTY_CASE_LIST_ORDER_PLAN
			: caseListOrderPlan(
					caseListConfig,
					caseProperties,
					caseListOrderOptions(
						mod,
						doc,
						ctx.mediaOn,
						lookupNaming,
						listRewrites?.column,
					),
				);
	const longSourceColumns = (
		caseListConfig === undefined ? [] : orderedColumns(caseListConfig, "detail")
	).filter((column) => column.visibleInDetail !== false);

	const shortColumns =
		plan.fields.length > 0
			? plan.fields.map((field) => projectColumnForShortDetail(field, ctx))
			: emptyShortListColumns(localization.languages);
	const lookupTypes = lookupTypeIndexFromNaming(lookupNaming);
	const longColumns = longSourceColumns.map(
		(column): WireDetailColumn<HqXPath> => {
			const owner = detailTabForColumn(caseListConfig, column.uuid);
			const row = detailColumnRowScope(doc, mod, column, lookupTypes);
			const child = row?.kind === "case" ? row.caseType : undefined;
			if (owner?.orderFields?.includes(column.uuid)) {
				const field = detailTabOrderField(
					column,
					mod,
					doc,
					lookupNaming,
					columnFieldWord,
				);
				const header = localization.textMap(
					makeTranslationUnitId("column", column.uuid, "header"),
				);
				return {
					...detailColumn(
						typeof field === "string" ? field : hqXPath(field),
						header,
					),
					format: "invisible" satisfies DetailColumnFormat,
				};
			}
			return projectColumnToDetail(
				column,
				child
					? {
							...ctx,
							mod: { ...mod, caseType: child },
							caseProperties:
								ctx.caseTypes.find((type) => type.name === child)?.properties ??
								[],
						}
					: ctx,
				"details",
			);
		},
	);
	// HQ's build writes this filter into each chain datum's nodeset before
	// it aligns a child entry with its root menu, then renames session
	// variables (`suite_xml/sections/entries.py::EntriesHelper.get_case_datums_basic_module`,
	// `add_parent_datums`), so a chosen case prints under its id from before
	// root alignment here, and under the aligned id everywhere else.
	const filter = projectCaseListFilter(
		caseListConfig?.filter,
		mod.caseSearchConfig?.excludedOwnerIds,
		expressions,
		lookupNaming,
		caseListStepDatumId(doc, mod.uuid, "chainId"),
		listRewrites?.filter?.(),
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
	const context = caseListConfig?.contextAboveForm;
	if (context?.kind === "menu-tile")
		pair.short.persistent_case_tile_from_module = moduleUniqueId(
			context.moduleUuid,
		);
	if (context && context.kind !== "line" && context.expandDetails)
		pair.short.pull_down_tile = true;
	const expression = caseContextLine(context);
	if (expression) {
		pair.short.persist_case_context = true;
		pair.short.persistent_case_context_xml = hqXPath(
			toWire(expression, {
				target: "hq-json",
				root: "casedb",
				types: expressions({ slot: "case_form_context_line" }),
				bindings: {
					...detailBindings(doc, mod),
					...(lookupNaming && {
						lookup: { naming: lookupNaming, instanceScope: "suite" },
					}),
				},
			}),
		);
	}
	if (caseListConfig?.detailTabs) {
		const spans = detailTabSpans(caseListConfig.detailTabs, longSourceColumns);
		if (!spans)
			throw new Error("The detail tabs do not cover the fields shown.");
		pair.long.tabs = spans.map(({ tab, start }) => ({
			doc_type: "DetailTab",
			isTab: true,
			header: localization.textMap(
				makeTranslationUnitId("detail-tab", tab.uuid, "title"),
			),
			starting_index: start,
			has_nodeset: tab.rowSource !== undefined,
			...(detailTabSearchChildType(tab) && {
				nodeset_case_type: detailTabSearchChildType(tab),
			}),
			...(tab.rowSource?.kind === "children" && {
				...(tab.rowSource.condition && {
					nodeset_filter: hqXPath(
						detailRowExpressionWire(
							tab.rowSource.condition,
							tab.uuid,
							"case_detail_tab_filter",
							"hq-json",
							"casedb",
							expressions,
							lookupNaming,
							detailBindings(doc, mod),
						),
					),
				}),
			}),
			...(tab.rowSource?.kind === "records" && {
				nodeset: hqXPath(
					detailRowExpressionWire(
						tab.rowSource.rows,
						tab.uuid,
						"case_detail_tab_rows",
						"hq-json",
						"casedb",
						expressions,
						lookupNaming,
						detailBindings(doc, mod),
					),
				),
			}),
			...(tab.displayCondition && {
				relevant: hqXPath(
					detailTabConditionWire(
						tab.displayCondition,
						tab.uuid,
						expressions,
						"hq-json",
						"casedb",
						lookupNaming,
						detailBindings(doc, mod),
					),
				),
			}),
		}));
	}
	pair.short.sort_elements = projectSortElements(
		plan,
		localization,
		(property, via) =>
			columnProperty(
				{ kind: "plain", field: property, via } as Exclude<
					Column,
					{ kind: "calculated" }
				>,
				mod,
				caseTypes,
			)?.data_type,
		columnFieldWord,
		(sort) =>
			hqXPath(
				hqCalculatedSortExpression(
					sort,
					mod,
					doc,
					expressions,
					lookupNaming,
					listRewrites?.sort?.(sort.uuid),
				),
			),
	);
	pair.short.filter = filter;
	if (caseListConfig?.selection?.kind === "multiple") {
		pair.short.multi_select = true;
		pair.short.max_select_value = caseListConfig.selection.maximum;
	}
	// The list's own texts, which HQ's build writes as `m<N>_no_items_text`
	// (under `USH_EMPTY_CASE_LIST_TEXT`) and `m<N>_select_text` in every
	// language (`app_strings.py::_create_module_details_app_strings`).
	if (caseListConfig?.emptyText !== undefined)
		pair.short.no_items_text = localization.textMap(
			caseListWordingUnitId(mod.uuid, "empty"),
		);
	if (caseListConfig?.selectButtonText !== undefined)
		pair.short.select_text = localization.textMap(
			caseListWordingUnitId(mod.uuid, "select"),
		);
	applyTileLayoutToShortDetail(pair.short, caseListConfig?.tile, plan.fields);
	if (caseListConfig?.detailTile) {
		pair.long.case_tile_template = "custom";
		for (const [i, column] of longSourceColumns.entries()) {
			const cell = caseListConfig.detailTile.cells[column.uuid];
			if (cell) writeTileCell(pair.long.columns[i], cell);
		}
	}

	const searchConfig = buildSearchConfigDocument(
		caseSearchConfig,
		caseListConfig,
		mod.caseType,
		mod.uuid,
		localization,
		expressions,
		lookupNaming,
		caseListStepDatumId(doc, mod.uuid, "id"),
		declaresWebApps(doc),
		searchRewrites,
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
	shortDetail: Detail<HqXPath>,
	tile: CaseTileLayout | undefined,
	fields: readonly CaseListShortField[],
): void {
	if (tile === undefined) return;
	shortDetail.case_tile_template = tile.namedSlots
		? "icon_text_grid"
		: "custom";
	if (tile.persistOnForms === true) shortDetail.persist_tile_on_forms = true;
	if (tile.grouping !== undefined) {
		shortDetail.case_tile_group = {
			doc_type: "CaseTileGroupConfig",
			index_identifier: tile.grouping.identifier,
			header_rows: tile.grouping.headerRows,
		};
	}
	for (const [index, field] of fields.entries()) {
		const target = shortDetail.columns[index];
		if (tile.namedSlots && target) {
			target.case_tile_field =
				namedTileWireSlot(tile.namedSlots, field.column.uuid) ?? null;
			continue;
		}
		const cell = tileCellFor(field.column, tile);
		if (cell === undefined || target === undefined) continue;
		writeTileCell(target, cell);
	}
}

function writeTileCell(
	target: WireDetailColumn<HqXPath>,
	cell: TileCell,
): void {
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

// Re-export the per-column projection so tests can pin per-kind
// shapes without re-deriving a module-level fixture.
export { projectColumnToDetail };
