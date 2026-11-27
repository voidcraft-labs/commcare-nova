/**
 * The search stages: every menu's `search_config` read into its search
 * (`readSearches`: the workflow, the Search fields, the default filters and
 * the settings), and accepted over the bound document (`settleSearches`):
 * each `_xpath_query` conjunct placed (`rows.ts`), and the whole menu's
 * search written back by the production projection (`settings.ts`).
 */
import { type Draft, produce } from "immer";
import {
	type BlueprintDoc,
	type CaseListConfig,
	makeTranslationUnitId,
	SEARCH_INPUT_TYPE_PROPERTY_TYPES,
	type Uuid,
} from "@/lib/domain";
import { authoredCasePropertyNameSchema } from "@/lib/domain/casePropertyName";
import type { CasePropertyDataType } from "@/lib/domain/casePropertyTypes";
import { effectiveCaseTypes } from "@/lib/domain/effectiveCaseTypes";
import { CASE_TYPE_PATTERN } from "@/lib/domain/expression/types";
import type {
	CaseSearchConfig,
	OrdinaryCaseSearchConfig,
	SearchFilter,
} from "@/lib/domain/modules";
import { recordFromEntries } from "@/lib/domain/records";
import {
	CASE_NODE_ATTRIBUTE_PROPERTIES,
	isDeviceOnlyCaseProperty,
} from "@/lib/domain/standardCaseProperties";
import { USERCASE_CASE_TYPE } from "@/lib/domain/usercase";
import { circumstanceFinding } from "@/lib/publish/hqFindings";
import {
	isProjectSearchId,
	isProjectSearchParameter,
} from "../../hq/projectSearch";
import { searchButtonUndeclaredInstances } from "../../suite/case-search/buttonCondition";
import { readSearchFilterTarget } from "../../suite/case-search/nativeFilters";
import {
	readDedicatedOrder,
	readRequestOrderText,
	requestOrderText,
	requestOrderTextRefusal,
	unmappedSingleOrderComparison,
} from "../../suite/case-search/requestOrder";
import { simpleArmNeedsXPathQueryEmission } from "../../suite/case-search/simpleArmDerivation";
import { rethrowWorkStop } from "../../workMeter";
import { withCandidate } from "../candidate";
import { appCodes, sourceCode, translatedTexts } from "../caseList/columns";
import { caseListReadings, sameState } from "../caseList/details";
import { dateSortDeclarations } from "../caseList/order";
import { noteProperty } from "../caseManagement/catalog";
import {
	type Claim,
	defineClaims,
	derived,
	drop,
	refuse,
	take,
} from "../claims";
import type { DraftApp, DraftModule, ReadContext } from "../context";
import { readExpressions } from "../expressions";
import { readExpression } from "../expressions/readExpression";
import {
	scanReads,
	searchRowHoleReads,
	searchRowProperties,
	searchRowRelations,
} from "../expressions/scanReads";
import { externalKey } from "../identity";
import { isJsonObject, type JsonCursor, objectMembers } from "../jsonCursor";
import { manifestFindingOf } from "../languages";
import { pendingPlaceholder } from "../pendingExpressions";
import { whereText } from "../place";
import { readProjectionInputs } from "../projectionInputs";
import {
	applyExpressionCircumstance,
	applyExpressionClaim,
	provisionalDocument,
	refusalDeferred,
	replaceDeferredRefusal,
	settleDeferredRefusal,
	settleDeferredRefusals,
} from "../provisional";
import { readFormSyntax } from "../syntaxRead";
import { expressionEnvOf } from "../xform";
import { guessKey, noteDateRangeGuesses } from "./dateRangeGuesses";
import { readGuardText } from "./guardSplit";
import {
	PROMPT_CLAIMS,
	type PromptReading,
	readSearchPrompts,
} from "./prompts";
import {
	classifySearchRows,
	dateFieldDeclarations,
	MARKERS_HELD,
	ROWS_HELD,
	rowEarlyReads,
	type SearchRow,
} from "./rows";
import {
	claimUndeclaredSearchKeys,
	holdsText,
	hqAutoSelects,
	ownersWithoutClauseRegistration,
	readSearchResultsName,
	readSearchSettings,
	registerListOwner,
	runtimeGuardEndings,
	SETTING_CLAIMS,
	settleSearchSettings,
	sharedOwnerRuleFits,
	spelledAsShown,
	withoutNormalizeSpace,
} from "./settings";
import { offersSearch, readSearchWorkflow, searchPlace } from "./workflow";

export { classifySearchRows } from "./rows";

const S = "case-search/";
const ROUND_TRIP = `${S}the-generated-search-round-trip-remote-request-query-results`;
const MARKERS = MARKERS_HELD;

export const SEARCH_CLAIMS = defineClaims("search", {
	configShared: take(ROUND_TRIP, "schema:ShadowModule.search_config"),
	parameterRows: take(
		`${S}case-search-endpoint-id`,
		"schema:CaseSearch.default_properties",
	),
	parameter: take(
		`${S}case-search-endpoint-id`,
		"schema:DefaultCaseSearchProperty",
	),
	parameterName: take(
		`${S}case-search-endpoint-id`,
		"schema:DefaultCaseSearchProperty.property",
	),
	configModule: take(ROUND_TRIP, "schema:Module.search_config"),
	configAdvanced: take(ROUND_TRIP, "schema:AdvancedModule.search_config"),
	inactive: derived(ROUND_TRIP, "schema:CaseSearch"),
	rows: take(ROWS_HELD, "schema:CaseSearch.default_properties"),
	rowProperty: take(ROWS_HELD, "schema:DefaultCaseSearchProperty.property"),
	zeroInput: take(`${S}match-all-match-none`, "csql-fn:match-all"),
	markers: take(MARKERS, "schema:CaseSearch.default_properties"),
	markerProperty: take(MARKERS, "schema:DefaultCaseSearchProperty.property"),
	markerValue: take(MARKERS, "schema:DefaultCaseSearchProperty.defaultValue"),
	includeClosedBeside: drop(
		`${S}default-properties-entry-keyed-include-closed-beside-a-prompt-or`,
		"schema:DefaultCaseSearchProperty.property",
	),
	tagBeside: drop(
		`${S}default-properties-entry-keyed-x-commcare-tag-module-name-beside`,
		"schema:DefaultCaseSearchProperty.property",
	),
	noValue: refuse(
		`${S}default-properties-entry-with-no-defaultvalue-hq-stores-an-empty`,
		"schema:DefaultCaseSearchProperty",
	),
	plainKey: take(
		`${S}default-properties-entry-keyed-by-a-plain-property-property-p`,
		"schema:DefaultCaseSearchProperty.property",
	),
	/** A filter keyed `owner_id`, which HQ's search reads as the case's owner. */
	ownerFilterKey: take(`${S}a-search-key-named-owner-id`, "csql-key:owner_id"),
	ancestorKey: take(
		`${S}default-properties-entry-keyed-by-an-ancestor-path-parent-p`,
		"schema:DefaultCaseSearchProperty.property",
	),
	projectKey: take(
		`${S}default-properties-entry-keyed-owner-id-case-id-commcare-project`,
		"schema:DefaultCaseSearchProperty.property",
	),
	defaultOrder: take(
		`${S}default-filter-orders-the-records-the-search-sends`,
		"schema:DefaultCaseSearchProperty.property",
	),
	defaultOrderValue: take(
		`${S}default-filter-orders-the-records-the-search-sends`,
		"schema:DefaultCaseSearchProperty.defaultValue",
	),
	sortReserved: refuse(
		`${S}a-server-order-naming-a-property-nova-reserves`,
		"schema:DefaultCaseSearchProperty.property",
	),
	sortDeviceOnly: refuse(
		`${S}a-server-order-naming-a-property-only-devices-hold`,
		"schema:DefaultCaseSearchProperty.property",
	),
	unmappedOrderComparison: refuse(
		`${S}default-order-with-an-unmapped-comparison`,
		"schema:DefaultCaseSearchProperty.property",
	),
	sortKey: refuse(
		`${S}default-properties-entry-keyed-commcare-sort-x-commcare-custom`,
		"schema:DefaultCaseSearchProperty.property",
	),
	runtimeKey: refuse(
		`${S}a-commcare-sort-x-commcare-custom-related-case-property-or-case`,
		"schema:DefaultCaseSearchProperty.property",
	),
	relatedTwice: refuse(
		`${S}an-x-commcare-custom-related-case-property-entry-together-with`,
		"schema:DefaultCaseSearchProperty.property",
	),
	requestRelatedPropertyDeviceOnly: refuse(
		`${S}a-related-record-property-only-devices-hold`,
		"schema:DefaultCaseSearchProperty.property",
	),
	requestRelatedProperty: take(
		`${S}default-related-record-id-property`,
		"schema:DefaultCaseSearchProperty.property",
	),
	requestRelatedPropertyValue: take(
		`${S}default-related-record-id-property`,
		"schema:DefaultCaseSearchProperty.defaultValue",
	),
	requestRelatedRecords: take(
		`${S}default-related-record-inclusion`,
		"schema:DefaultCaseSearchProperty.property",
	),
	requestTypeValue: take(
		`${S}default-properties-entry-keyed-case-type`,
		"schema:DefaultCaseSearchProperty.defaultValue",
	),
	caseTypeKey: take(
		`${S}default-properties-entry-keyed-case-type`,
		"schema:DefaultCaseSearchProperty.property",
	),
	endpointKey: refuse(
		`${S}default-properties-entry-keyed-x-commcare-endpoint-id`,
		"schema:DefaultCaseSearchProperty.property",
	),
	registryKey: refuse(
		`${S}default-properties-entry-keyed-x-commcare-data-registry`,
		"schema:DefaultCaseSearchProperty.property",
	),
	ownersKey: take(
		`${S}default-properties-entry-keyed-commcare-blacklisted-owner-ids`,
		"schema:DefaultCaseSearchProperty.property",
	),
	/** A prompt named for a property the field's type does not fit, held with the project
	 *  space's matching (`fieldsOverAnotherType`). */
	fieldOfAnotherType: take(
		`${S}search-field-over-a-property-of-another-type`,
		"schema:CaseSearchProperty.name",
	),
	ownersTwice: refuse(
		`${S}that-entry-together-with-blacklisted-owner-ids-expression`,
		"schema:DefaultCaseSearchProperty.property",
	),
});

const C = SEARCH_CLAIMS;

/**
 * The declared keys of a search a menu does not offer that the generated search's entry names,
 * each read past as inactive at its own key: HQ's build reads a search's settings only for a
 * menu that offers it (`util.py::module_offers_search`, which `RemoteRequestsHelper` and
 * `module_uses_case_search_endpoint` ask), but for `search_on_clear` beside the case list's auto
 * select, which its validator refuses whether or not the menu searches
 * (`helpers/validators.py::ModuleBaseValidator.validate_search_config`, `deriveInactiveSearch`).
 */
const INACTIVE_KEYS = defineClaims(
	"search.inactive",
	recordFromEntries(
		[
			"additional_case_types",
			"additional_registry_cases",
			"auto_launch",
			"blacklisted_owner_ids_expression",
			"case_search_endpoint_id",
			"custom_related_case_property",
			"custom_sort_properties",
			"data_registry",
			"data_registry_workflow",
			"default_properties",
			"default_search",
			"description",
			"include_all_related_cases",
			"inline_search",
			"instance_name",
			"properties",
			"search_button_display_condition",
			"search_button_label",
			"search_on_clear",
			"title_label",
		].map((key) => [key, derived(ROUND_TRIP, `schema:CaseSearch.${key}`)]),
	) as Record<string, Claim<"derived">>,
);

/** What the settle takes from one menu's first pass. */
interface SearchReading {
	readonly module: DraftModule;
	readonly cursor: JsonCursor;
	readonly prompts: readonly PromptReading[];
	readonly rows: readonly SearchRow[];
	readonly formsReadSearch: boolean;
	readonly zeroInput: boolean;
	readonly usesProjectSearch: boolean;
	/** Whether the default filters are only HQ's two markers, on a menu with no prompt. */
	readonly markersOnly: boolean;
	readonly whole: boolean;
}

const READINGS = new WeakMap<ReadContext, Map<Uuid, SearchReading>>();

/** Whether a row's text is Nova's zero-input value, the literal `'match-all()'`. */
function isZeroInputText(text: unknown): boolean {
	if (typeof text !== "string") return false;
	const read = readFormSyntax(text);
	return (
		read.ok && read.node?.kind === "string" && read.node.value === "match-all()"
	);
}

/** Whether a default filter's value is a literal, the one value a request key can be typed by. */
function isLiteralValue(text: string): boolean {
	const read = readFormSyntax(text);
	return (
		read.ok && (read.node?.kind === "string" || read.node?.kind === "number")
	);
}

/** The keys whose value names properties or case types, chosen at runtime where it is computed
 *  (`case_search/models.py::_parse_commcare_sort_properties`, `utils.py::get_expanded_case_results`,
 *  `utils.py::CaseSearchQueryBuilder._get_initial_search_es`). */
const NAMING_KEYS = new Set([
	"commcare_sort",
	"x_commcare_custom_related_case_property",
	"case_type",
]);

/**
 * The finding for a default filter keyed by anything but a row or a zero-input marker. The two
 * refusals of a request key come before the rows that hold the key: a value computed at runtime,
 * and the related-case property arriving beside `custom_related_case_property`, which HQ's request
 * then carries twice (`case_search/models.py::CaseSearchRequestConfig`).
 */
function keyFinding(
	key: string,
	value: string,
	ownersExpression: boolean,
	relatedPropertySet: boolean,
) {
	if (NAMING_KEYS.has(key) && !isLiteralValue(value)) return C.runtimeKey;
	if (key === "x_commcare_custom_related_case_property" && relatedPropertySet)
		return C.relatedTwice;
	if (key === "commcare_blacklisted_owner_ids")
		return ownersExpression ? C.ownersTwice : undefined;
	if (
		key === "case_type" ||
		key === "x_commcare_include_all_related_cases" ||
		key === "x_commcare_custom_related_case_property"
	)
		return undefined;
	if (key === "x_commcare_endpoint_id") return C.endpointKey;
	if (key === "x_commcare_data_registry") return C.registryKey;
	if (key === "commcare_sort" || key.startsWith("x_commcare_"))
		return C.sortKey;
	return undefined;
}

/** The default filters: each `_xpath_query` row kept, the markers read, every other key refused. */
function readDefaultFilters(
	ctx: ReadContext,
	module: DraftModule,
	cursor: JsonCursor,
	hasPrompts: boolean,
): {
	ok: boolean;
	rows: SearchRow[];
	filters: SearchFilter[];
	requestTypes: string[];
	coveredSettings: Set<string>;
	relatedIdProperty?: string;
	/** Each key a default filter other than a row names, with the pointer of each such filter's
	 *  `property`. */
	names: Map<string, string[]>;
	zeroInput: boolean;
	markersOnly: boolean;
} {
	const { accounting } = ctx;
	const filters: SearchFilter[] = [];
	const stored = cursor.peek("default_properties");
	const entries = objectMembers(stored) ?? [];
	const dedicatedOrder = cursor.peek("custom_sort_properties");
	const singleBuiltInOrder =
		module.json.peek("doc_type") === "Module" &&
		!cursor.peek("case_search_endpoint_id") &&
		!cursor.peek("data_registry") &&
		(dedicatedOrder === undefined ||
			(Array.isArray(dedicatedOrder) && dedicatedOrder.length === 0)) &&
		entries.filter((entry) => entry.property === "commcare_sort").length ===
			1 &&
		entries.every(
			(entry) =>
				entry.property === "commcare_sort" || entry.property === "_xpath_query",
		);
	const markersOnly =
		!hasPrompts &&
		entries.length > 0 &&
		entries.every(
			(one) =>
				one.property === "include_closed" ||
				one.property === "x_commcare_tag_module_name",
		);
	const zeroInput =
		!hasPrompts &&
		entries.length === 1 &&
		entries[0]?.property === "_xpath_query" &&
		isZeroInputText(entries[0]?.defaultValue);
	const list = cursor.list(
		"default_properties",
		"DefaultCaseSearchProperty",
		markersOnly ? C.markers : C.rows,
	);
	const ownersExpression = holdsText(
		cursor,
		"blacklisted_owner_ids_expression",
	);
	const relatedPropertySet = holdsText(cursor, "custom_related_case_property");
	const rows: SearchRow[] = [];
	const requestTypes: string[] = [];
	let relatedIdProperty: string | undefined;
	const coveredSettings = new Set<string>();
	const names = new Map<string, string[]>();
	const addName = (property: string, row: JsonCursor) =>
		names.set(property, [
			...(names.get(property) ?? []),
			`${row.pointer}/property`,
		]);
	let ok = true;
	list.forEach((row, index) => {
		const key = row.peek("property");
		const property = typeof key === "string" ? key : "";
		const value = row.peek("defaultValue");
		if (
			property === "include_closed" ||
			property === "x_commcare_tag_module_name"
		) {
			if (markersOnly) {
				row.take("property", C.markerProperty, String).value;
				row.take("defaultValue", C.markerValue, String).value;
			} else {
				row.drop(
					"property",
					property === "include_closed" ? C.includeClosedBeside : C.tagBeside,
				);
				row.drop(
					"defaultValue",
					property === "include_closed" ? C.includeClosedBeside : C.tagBeside,
				);
			}
			return;
		}
		// A filter with no value is refused whole, one finding at the search, whether HQ stores the
		// key blank or leaves it out (`DefaultCaseSearchProperty.defaultValue` keeps no `None`): its
		// key belongs to it.
		if (typeof value !== "string" || value.trim() === "") {
			row.refuseWhole(
				C.noValue,
				property === "" ? undefined : { name: property },
			);
			if (property !== "" && property !== "_xpath_query")
				addName(property, row);
			ok = false;
			return;
		}
		if (property !== "_xpath_query") {
			// A literal order is held among the filters, where it arrived; one
			// naming a property Nova reserves is refused under its own entry.
			let sortRefusal: ReturnType<typeof requestOrderTextRefusal>;
			let unmappedComparison = false;
			if (property === "commcare_sort") {
				const syntax = readFormSyntax(value);
				const text =
					syntax.ok && syntax.node?.kind === "string"
						? syntax.node.value
						: undefined;
				const parsedOrder =
					text === undefined ? undefined : readRequestOrderText(text);
				sortRefusal =
					text === undefined ? undefined : requestOrderTextRefusal(text);
				unmappedComparison =
					text !== undefined &&
					singleBuiltInOrder &&
					unmappedSingleOrderComparison(text);
				if (parsedOrder !== undefined) {
					const { order, removedSuffix } = parsedOrder;
					const occurrence = names.get(property)?.length ?? 0;
					addName(property, row);
					const uuid = accounting.identity(
						ctx.identities.claim(
							externalKey.searchFilter(module.uniqueId, property, occurrence),
							`${module.uniqueId}/search/filter/${index}`,
						),
						row.place,
						"schema:DefaultCaseSearchProperty.property",
					);
					if (!uuid) {
						ok = false;
						return;
					}
					row.take("property", C.defaultOrder, String).value;
					row.take("defaultValue", C.defaultOrderValue, String).value;
					if (text !== requestOrderText(order))
						sameState(
							ctx,
							C.defaultOrderValue.entry,
							`${row.pointer}/defaultValue`,
							removedSuffix
								? "search-order-unused-suffix-removed"
								: "search-order-direction-signs-respelled",
						);
					filters.push({ uuid, kind: "order", order });
					return;
				}
			}
			// The row's value is the filter the refusal names, and stands under its finding.
			const claim =
				sortRefusal === "reserved"
					? C.sortReserved
					: sortRefusal === "device-only"
						? C.sortDeviceOnly
						: unmappedComparison
							? C.unmappedOrderComparison
							: keyFinding(
									property,
									value,
									ownersExpression,
									relatedPropertySet,
								);
			if (claim === undefined) {
				if (
					property === "case_type" ||
					property === "x_commcare_custom_related_case_property"
				) {
					const parsed = readFormSyntax(value);
					const name =
						parsed.ok && parsed.node?.kind === "string"
							? parsed.node.value
							: undefined;
					if (
						property === "x_commcare_custom_related_case_property" &&
						name !== undefined &&
						isDeviceOnlyCaseProperty(name)
					) {
						const claim = C.requestRelatedPropertyDeviceOnly;
						const detail = { name };
						row.refuse("property", claim, detail);
						accounting.cover(
							{ json: row, key: "defaultValue" },
							manifestFindingOf(claim, row.place, detail),
						);
						ok = false;
						return;
					}
					const match =
						property === "case_type" ? C.caseTypeKey : C.requestRelatedProperty;
					const valid =
						name !== undefined &&
						(property === "case_type"
							? CASE_TYPE_PATTERN.test(name)
							: authoredCasePropertyNameSchema.safeParse(name).success &&
								relatedIdProperty === undefined);
					if (!valid || name === undefined) {
						accounting.circumstance("unrecognized", row.place, {
							name: "schema:DefaultCaseSearchProperty.defaultValue",
						});
						ok = false;
						return;
					}
					row.take("property", match, String).value;
					row.take(
						"defaultValue",
						property === "case_type"
							? C.requestTypeValue
							: C.requestRelatedPropertyValue,
						String,
					).value;
					const occurrence = names.get(property)?.length ?? 0;
					addName(property, row);
					const uuid = accounting.identity(
						ctx.identities.claim(
							externalKey.searchFilter(module.uniqueId, property, occurrence),
							`${module.uniqueId}/search/filter/${index}`,
						),
						row.place,
						"schema:DefaultCaseSearchProperty.property",
					);
					if (uuid === undefined) {
						ok = false;
						return;
					}
					if (property === "case_type") {
						requestTypes.push(name);
						filters.push({ uuid, kind: "request-record-type", caseType: name });
					} else {
						relatedIdProperty = name;
						filters.push({ uuid, kind: "related-record-id", property: name });
					}
					return;
				}
				const target = readSearchFilterTarget(property);
				const occurrence = names.get(property)?.length ?? 0;
				addName(property, row);
				if (target === undefined) {
					const detail = { name: "schema:DefaultCaseSearchProperty.property" };
					accounting.circumstance("unrecognized", row.place, detail);
					const finding = circumstanceFinding(
						"unrecognized",
						row.place,
						detail,
					);
					accounting.cover({ json: row, key: "property" }, finding);
					accounting.cover({ json: row, key: "defaultValue" }, finding);
					ok = false;
					return;
				}
				const claim =
					target.kind === "excluded-owners"
						? C.ownersKey
						: target.kind === "include-related-records"
							? C.requestRelatedRecords
							: "ancestors" in target && target.ancestors
								? C.ancestorKey
								: target.kind === "record-name" ||
										target.kind === "attribute" ||
										target.kind === "property"
									? C.plainKey
									: C.projectKey;
				row.take("property", claim, String).value;
				if (property === "owner_id")
					accounting.claimEntry(
						{ json: row, key: "property" },
						C.ownerFilterKey.entry,
						"csql-key:owner_id",
						row.place,
					);
				const uuid = accounting.identity(
					ctx.identities.claim(
						externalKey.searchFilter(module.uniqueId, property, occurrence),
						`${module.uniqueId}/search/filter/${index}`,
					),
					row.place,
					"schema:DefaultCaseSearchProperty.property",
				);
				if (uuid === undefined) {
					ok = false;
					return;
				}
				filters.push({ uuid, target, value: pendingPlaceholder("value") });
				ctx.pending.register(
					{
						ref: {
							entity: "module",
							uuid: module.uuid,
							slot: "search_filter_value",
							member: { filterUuid: uuid },
						},
						text: value,
						mode: { target: "hq-json", interpolation: "none" },
						place: row.place,
						key: "schema:DefaultCaseSearchProperty.defaultValue",
					},
					{ json: row, key: "defaultValue" },
				);
				return;
			}
			const detail = { name: property };
			row.refuse("property", claim, detail);
			// A key HQ's request carries twice is a class of the row and of the search's own key
			// beside it, so the refusal stands at that key too.
			const beside =
				claim === C.ownersTwice
					? "blacklisted_owner_ids_expression"
					: claim === C.relatedTwice
						? "custom_related_case_property"
						: undefined;

			const finding = manifestFindingOf(claim, row.place, detail);
			if (claim === C.relatedTwice && beside !== undefined) {
				if (!coveredSettings.has(beside))
					accounting.cover({ json: cursor, key: beside }, finding);
				coveredSettings.add(beside);
			} else if (beside !== undefined) {
				accounting.findingAt(
					claim,
					row.place,
					`${cursor.pointer}/${beside}`,
					detail,
				);
			}
			accounting.cover({ json: row, key: "defaultValue" }, finding);
			addName(property, row);
			ok = false;
			return;
		}
		row.take("property", C.rowProperty, String).value;
		// The key the row's value is sent under is the `csql-key` item HQ's search reads it as,
		// where it sits.
		accounting.claimEntry(
			{ json: row, key: "property" },
			ROWS_HELD,
			"csql-key:_xpath_query",
			row.place,
		);
		// Nova's zero-input row: a search with no fields and no filter.
		if (zeroInput)
			accounting.claimEntry(
				{ json: row, key: "defaultValue" },
				C.zeroInput.entry,
				"csql-fn:match-all",
				row.place,
			);
		rows.push({ index, text: value, cursor: row });
	});
	return {
		ok,
		rows,
		filters,
		requestTypes,
		relatedIdProperty,
		coveredSettings,
		names,
		zeroInput,
		markersOnly,
	};
}

/** A row's `parent` link in the catalog, where the child has no parent there: both types named,
 *  the child given the parent by a `child` link, as the expression stage's scan declares a walk
 *  it reads (`expressions/index.ts::readExpressions`). */
function declareParent(
	catalog: Draft<NonNullable<BlueprintDoc["caseTypes"]>>,
	link: { readonly child: string; readonly parent: string },
): void {
	const named = (name: string) =>
		CASE_TYPE_PATTERN.test(name) && name !== USERCASE_CASE_TYPE;
	if (!named(link.child) || !named(link.parent)) return;
	if (
		catalog.find((type) => type.name === link.child)?.parent_type !== undefined
	)
		return;
	for (const name of [link.child, link.parent])
		if (!catalog.some((type) => type.name === name))
			catalog.push({ name, properties: [] });
	const child = catalog.find((type) => type.name === link.child);
	if (child === undefined) return;
	child.parent_type = link.parent;
	child.relationship = "child";
}

/** A search the menu does not offer: each key `CaseSearch` declares that `claimed` leaves is the
 *  shell's, read past as inactive where it holds a value other than HQ's default (a key at its
 *  default declares no search, so it names no entry), and a key it does not declare is claimed as
 *  on a search the menu offers, since the shell holds no such key. */
function deriveInactiveSearch(
	module: DraftModule,
	cursor: JsonCursor,
	claimed: ReadonlySet<string>,
): void {
	const stored = module.json.peek("search_config");
	const undeclared = new Set(cursor.undeclared());
	for (const key of Object.keys(isJsonObject(stored) ? stored : {}))
		if (!claimed.has(key) && !undeclared.has(key) && cursor.used(key)) {
			if (key === "search_on_clear" && hqAutoSelects(module))
				cursor.refuse(key, SETTING_CLAIMS.searchOnClearAuto);
			else cursor.derived(key, INACTIVE_KEYS[key] ?? C.inactive);
		}
	claimUndeclaredSearchKeys(cursor);
}

/**
 * The title and the subtitle of a search the menu does not offer, where the first publish writes
 * them another way. Nova writes such a search as its shell (`hqShells.ts::caseSearchConfigShell`,
 * as HQ's Case List page saves every menu, `views/modules.py::_gather_and_update_search_properties`):
 * both blank under every app language. HQ reads neither where the menu offers no search
 * (`util.py::module_offers_search` guards every read in its build), so a stored map that is not
 * blank under exactly the app's languages is recorded under `list-settings-respelled`. The shell's
 * `auto_launch` follows where the app runs, which a reading does not know, so the first publish's
 * list compares it with the stored one itself (`lib/deployment/reading/firstPublishChanges.ts`).
 */
function recordInactiveSearchRespellings(
	ctx: ReadContext,
	cursor: JsonCursor,
): void {
	const codes = appCodes(ctx);
	const blank = recordFromEntries(codes.map((code) => [code, ""] as const));
	for (const key of ["title_label", "description"] as const)
		if (!spelledAsShown(cursor.peek(key), blank, codes))
			sameState(
				ctx,
				INACTIVE_KEYS[key]?.entry ?? C.inactive.entry,
				`${cursor.pointer}/${key}`,
				"list-settings-respelled",
			);
}

/** A repeated key is a second value in the request. Its ordinal distinguishes its
 * expression from the first value, while the service identity is shared across menus. */
function readProjectSearch(
	ctx: ReadContext,
	module: DraftModule,
	cursor: JsonCursor,
	endpointId: number,
	config: Partial<OrdinaryCaseSearchConfig>,
): ReturnType<typeof readDefaultFilters> {
	const place = searchPlace(module);
	let searchUuid = ctx.draft.projectSearches.get(endpointId);
	if (searchUuid === undefined) {
		searchUuid = ctx.accounting.identity(
			ctx.identities.claim(
				externalKey.projectSearch(endpointId),
				module.uniqueId,
			),
			place,
			"schema:CaseSearch.case_search_endpoint_id",
		);
		if (searchUuid !== undefined) {
			const uuid = searchUuid;
			const name =
				ctx.input.knownProjectSearchNames?.[uuid]?.name ??
				`${module.module.name || "Project"} search`;
			ctx.writeDraft(() => {
				ctx.draft.projectSearches.set(endpointId, uuid);
				ctx.draft.appSettings.projectSearches ??= recordFromEntries([]);
				ctx.draft.appSettings.projectSearches[uuid] = { name };
			});
		}
	}
	cursor.take("case_search_endpoint_id", SETTING_CLAIMS.endpoint, Number).value;
	const defaults: NonNullable<
		OrdinaryCaseSearchConfig["projectSearch"]
	>["defaults"] = [];
	const names = new Map<string, string[]>();
	let ok = searchUuid !== undefined;
	for (const row of cursor.list(
		"default_properties",
		"DefaultCaseSearchProperty",
		C.parameterRows,
	)) {
		const name = row.peek("property");
		const value = row.peek("defaultValue");
		if (
			typeof name !== "string" ||
			!isProjectSearchParameter(name) ||
			typeof value !== "string" ||
			!value.trim()
		) {
			// Leave the exact unread key for accounting. A malformed service request cannot be adopted.
			ok = false;
			continue;
		}
		const sites = names.get(name) ?? [];
		const ordinal = sites.length;
		sites.push(`${row.pointer}/property`);
		names.set(name, sites);
		const uuid = ctx.accounting.identity(
			ctx.identities.claim(
				externalKey.projectSearchParameter(module.uniqueId, name, ordinal),
				row.pointer,
			),
			place,
			"schema:DefaultCaseSearchProperty.property",
		);
		if (!uuid) {
			ok = false;
			continue;
		}
		row.takeClass(C.parameter).value;
		row.take("property", C.parameterName, String).value;
		ctx.pending.register(
			{
				ref: {
					entity: "module",
					uuid: module.uuid,
					slot: "project_search_parameter",
					member: { parameterUuid: uuid },
				},
				text: value,
				mode: { target: "hq-json", interpolation: "none" },
				place,
				key: "schema:DefaultCaseSearchProperty.defaultValue",
			},
			{ json: row, key: "defaultValue" },
		);
		defaults.push({ uuid, name, value: pendingPlaceholder("value") });
	}
	if (searchUuid !== undefined) config.projectSearch = { searchUuid, defaults };
	return {
		ok,
		rows: [],
		names,
		filters: [],
		requestTypes: [],
		coveredSettings: new Set(),
		zeroInput: false,
		markersOnly: false,
	};
}

/** Before any expression binds: every menu's search, read from its `search_config`, and the type each date
 *  Search field declares written into the draft's catalog before any expression binds. */
export function readSearches(ctx: ReadContext, app: DraftApp): void {
	const readings = READINGS.get(ctx) ?? new Map<Uuid, SearchReading>();
	READINGS.set(ctx, readings);
	for (const module of app.modules) {
		const cursor = module.json.object(
			"search_config",
			"CaseSearch",
			module.docType === "ShadowModule"
				? C.configShared
				: module.docType === "AdvancedModule"
					? C.configAdvanced
					: C.configModule,
			searchPlace(module),
		);
		const offers = offersSearch(cursor);
		// A menu with no case type lists no cases: a search it does not offer is its shell's,
		// claimed as inactive, and one it offers is left unclaimed, which the accounting names.
		if (module.module.caseType === undefined) {
			if (!offers) {
				const name = readSearchResultsName(
					ctx,
					module,
					cursor,
					searchPlace(module),
				);
				deriveInactiveSearch(
					module,
					cursor,
					name.claimed ? new Set(["instance_name"]) : new Set(),
				);
				recordInactiveSearchRespellings(ctx, cursor);
			}
			continue;
		}
		const config: Partial<OrdinaryCaseSearchConfig> = {};
		if (!offers) {
			const settings = readSearchSettings(ctx, module, cursor, false, config);
			deriveInactiveSearch(module, cursor, settings.claimed);
			recordInactiveSearchRespellings(ctx, cursor);
			if (
				settings.owners !== undefined &&
				config.excludedOwnerIds !== undefined
			) {
				const owners = config.excludedOwnerIds;
				ctx.writeDraft(() => {
					(
						module.module as { caseSearchConfig?: CaseSearchConfig }
					).caseSearchConfig = {
						searchActionEnabled: false,
						excludedOwnerIds: owners,
					};
				});
			}
			continue;
		}
		const hasPrompts =
			Array.isArray(cursor.peek("properties")) &&
			(cursor.peek("properties") as unknown[]).length > 0;
		const endpoint = cursor.peek("case_search_endpoint_id");
		const usesProjectSearch = isProjectSearchId(endpoint);
		const filters = usesProjectSearch
			? readProjectSearch(ctx, module, cursor, endpoint, config)
			: readDefaultFilters(ctx, module, cursor, hasPrompts);
		const caseType = module.module.caseType;
		const { prompts, groups, groupRefused } = readSearchPrompts(
			ctx,
			module,
			cursor,
			filters.names,
			usesProjectSearch,
		);
		// A property the search's rows read, and a simple Search field's, is a property of the
		// catalog, as every expression's is. A record attribute an order names (`@case_type`,
		// `@status`) is the record's own, never a property (`requestOrder.ts::ATTRIBUTE_KEYS`).
		const propertySource =
			filters.relatedIdProperty ?? cursor.peek("custom_related_case_property");
		const orderedProperties = [
			...filters.filters.flatMap((row) => ("order" in row ? row.order : [])),
			...(readDedicatedOrder(cursor.peek("custom_sort_properties")) ?? []),
		]
			.map((term) => term.property)
			.filter((property) => !CASE_NODE_ATTRIBUTE_PROPERTIES.has(property));
		const properties = [
			...filters.filters.flatMap((row) =>
				"target" in row &&
				row.target.kind === "property" &&
				!row.target.ancestors
					? [row.target.property]
					: [],
			),
			...filters.rows.flatMap((row) => searchRowProperties(row.text)),
			...prompts.flatMap((prompt) =>
				!usesProjectSearch &&
				!prompt.refused &&
				prompt.input.kind === "simple" &&
				prompt.input.via === undefined
					? [prompt.input.property]
					: [],
			),
		].filter((property) => !CASE_NODE_ATTRIBUTE_PROPERTIES.has(property));
		// A row's relation functions name the related cases' types: a `parent` hop is a parent link
		// the catalog gives the child where it gives none, and each property a relation's filter
		// reads is a property of the related type. Rows bind at the settle, outside the expression
		// stage's scan, so they are declared here.
		const relations = filters.rows.map((row) =>
			searchRowRelations(row.text, caseType),
		);
		// A value the device works out in a row reads the cases the menu's own slot reads (the case
		// a menu above chose, a case of a type its read tests), declared as an expression's are.
		const holeReads = filters.rows.flatMap((row) =>
			searchRowHoleReads(
				row.text,
				module.uuid,
				() => provisionalDocument(ctx),
				expressionEnvOf(ctx),
			),
		);
		const related =
			relations.some(
				(one) => one.links.length > 0 || one.properties.length > 0,
			) ||
			properties.length > 0 ||
			orderedProperties.length > 0 ||
			(typeof propertySource === "string" && propertySource !== "") ||
			holeReads.length > 0 ||
			filters.requestTypes.length > 0;
		if (related && app.caseTypes != null)
			ctx.writeDraft(() => {
				app.caseTypes = produce(app.caseTypes ?? [], (draft) => {
					const told = ctx.input.knownCaseTypes;
					for (const name of filters.requestTypes) {
						if (
							!draft.some((type) => type.name === name) &&
							name !== USERCASE_CASE_TYPE
						)
							draft.push({ name, properties: [] });
					}
					const extras = cursor.peek("additional_case_types");
					const requested = new Set([
						caseType,
						...filters.requestTypes,
						...(Array.isArray(extras) ? extras : []),
					]);
					if (
						typeof propertySource === "string" &&
						authoredCasePropertyNameSchema.safeParse(propertySource).success &&
						!isDeviceOnlyCaseProperty(propertySource)
					) {
						if (
							!draft.some(
								(type) =>
									requested.has(type.name) &&
									type.properties.some(
										(property) => property.name === propertySource,
									),
							)
						) {
							noteProperty(draft, caseType, propertySource, told);
						}
					}
					for (const property of properties)
						noteProperty(draft, caseType, property, told);
					for (const property of orderedProperties) {
						const owners = [...requested].filter(
							(name): name is string =>
								typeof name === "string" &&
								(draft.some(
									(type) =>
										type.name === name &&
										type.properties.some((one) => one.name === property),
								) ||
									told?.declaredTypeOf(name, property) !== undefined),
						);
						for (const owner of owners.length ? owners : [caseType])
							noteProperty(draft, owner, property, told);
					}
					for (const { links, properties: reads } of relations) {
						for (const link of links) declareParent(draft, link);
						for (const read of reads)
							noteProperty(draft, read.caseType, read.property, told);
					}
					for (const read of holeReads)
						noteProperty(draft, read.caseType, read.property, told);
				});
			});
		const workflow = readSearchWorkflow(ctx, module, cursor);
		const settings = readSearchSettings(
			ctx,
			module,
			cursor,
			true,
			config,
			filters.coveredSettings,
		);
		const search: OrdinaryCaseSearchConfig = { ...config, ...(workflow ?? {}) };
		// Search fields turn the search on with Nova's own settings, as a settings object that holds
		// none does (`effectiveCaseSearchConfig`), so a search with fields and no setting is read
		// with no settings object (`emptySearchSettingsBesideFieldsAreAbsent`).
		const settled =
			prompts.length > 0 &&
			module.module.caseListConfig !== undefined &&
			Object.values(search).every((value) => value === undefined)
				? undefined
				: search;
		ctx.writeDraft(() => {
			const list = module.module.caseListConfig as CaseListConfig | undefined;
			if (list !== undefined) {
				list.searchInputs = prompts.map(({ input }) => {
					if (!groupRefused || input.group === undefined) return input;
					const { group: _group, ...ungrouped } = input;
					return ungrouped;
				});
				if (groups.length > 0 && !groupRefused) list.searchInputGroups = groups;
				if (filters.filters.length) list.searchFilters = filters.filters;
			}
			const target = module.module as { caseSearchConfig?: CaseSearchConfig };
			if (settled === undefined) delete target.caseSearchConfig;
			else target.caseSearchConfig = settled;
		});
		const ownersHeld =
			settings.ownersWithoutClause !== true ||
			readOwnersWithoutClause(ctx, module, cursor);
		const declared = Array.isArray(cursor.peek("properties"))
			? (cursor.peek("properties") as unknown[]).length
			: 0;
		readings.set(module.uuid, {
			module,
			cursor,
			prompts,
			rows: filters.rows,
			formsReadSearch: workflow?.formsReadSearch === true,
			zeroInput: filters.zeroInput,
			usesProjectSearch,
			markersOnly: filters.markersOnly,
			whole:
				filters.ok &&
				settings.ok &&
				ownersHeld &&
				workflow !== undefined &&
				!groupRefused &&
				prompts.length + groups.length === declared &&
				prompts.every((prompt) => !prompt.refused),
		});
	}
	declareDateFieldsBeforeBinding(ctx, app, readings);
}

/**
 * A search's owner exclusion stored with no clause in the list filter, decided once the menu's
 * fields are in the draft: the stored list is bound as a proposal over the provisional document
 * (`expressions/readExpression.ts::readExpression`), and where Nova's list writes no clause for
 * the tree (`settings.ts::holdsOwnersWithoutClause`) the list is registered for the expression
 * stage and the search holds it; the settle's projection then holds the whole search. Returns
 * whether the exclusion is held.
 */
function readOwnersWithoutClause(
	ctx: ReadContext,
	module: DraftModule,
	cursor: JsonCursor,
): boolean {
	const registration = ownersWithoutClauseRegistration(module, cursor);
	if (registration === undefined) return true;
	const placeholder = pendingPlaceholder("value");
	const trial = withCandidate(provisionalDocument(ctx), (draft) => {
		const mod = draft.modules[module.uuid];
		if (mod === undefined) return;
		mod.caseSearchConfig = {
			...(mod.caseSearchConfig ?? {}),
			excludedOwnerIds: placeholder,
		} as CaseSearchConfig;
	});
	const inner = withoutNormalizeSpace(registration.text);
	if (inner !== registration.text) {
		const legacy = { ...registration, text: inner };
		const judged = readExpression(trial, legacy, expressionEnvOf(ctx));
		if (
			judged.kind !== "refused" &&
			sharedOwnerRuleFits(ctx, module, trial, judged.candidate)
		) {
			ctx.pending.register(legacy, {
				json: cursor,
				key: "blacklisted_owner_ids_expression",
			});
			ctx.writeDraft(() => {
				const target = module.module as { caseSearchConfig?: CaseSearchConfig };
				target.caseSearchConfig = {
					...target.caseSearchConfig,
					excludedOwnerIds: placeholder,
				} as CaseSearchConfig;
			});
			return true;
		}
	}
	const assigned = registerListOwner(ctx, module);
	const uuid = ctx.accounting.identity(
		ctx.identities.claim(
			externalKey.searchFilter(
				module.uniqueId,
				"search-setting:excluded-owners",
				0,
			),
			`${module.uniqueId}/search/excluded-owners`,
		),
		cursor.place,
		registration.key,
	);
	if (!uuid) return false;
	ctx.writeDraft(() => {
		const list = module.module.caseListConfig as CaseListConfig;
		if (assigned !== undefined) {
			const target = module.module as { caseSearchConfig?: CaseSearchConfig };
			target.caseSearchConfig = {
				...target.caseSearchConfig,
				excludedOwnerIds: placeholder,
			} as CaseSearchConfig;
		}
		list.searchFilters = [
			...(list.searchFilters ?? []),
			{
				uuid,
				target: { kind: "excluded-owners", placement: "search-setting" },
				value: placeholder,
			},
		];
	});
	ctx.pending.register(
		{
			...registration,
			ref: {
				entity: "module",
				uuid: module.uuid,
				slot: "search_filter_value",
				member: { filterUuid: uuid },
			},
		},
		{ json: cursor, key: "blacklisted_owner_ids_expression" },
	);
	return true;
}

/** The types the catalog gives a menu's case type's properties: declared, else its writers'. */
function propertyTypes(doc: BlueprintDoc, caseType: string | undefined) {
	return (
		effectiveCaseTypes(doc).find((type) => type.name === caseType)
			?.properties ?? []
	);
}

/** The types declared before the expression stage, per reading: each case type and property
 *  declared, with the type. */
const EARLY_DECLARATIONS = new WeakMap<
	ReadContext,
	readonly {
		readonly caseType: string;
		readonly property: string;
		readonly dataType: CasePropertyDataType;
	}[]
>();

/**
 * The types the Search fields give properties no writer types, written into the draft's catalog
 * before the expression stage, so every slot that reads such a property (a search's own rows, a
 * filter comparing it with a date) binds against the type the field declares. A date range field
 * over such a property declares it `date`, one of the two types the gate takes for a date range
 * field (`SEARCH_INPUT_TYPE_PROPERTY_TYPES`), which the field's print, HQ's prompt alone, does
 * not tell apart, so a record slot's comparison types it instead where one compares it
 * (`dateRangeGuesses.ts`); a field whose row is its derivation
 * declares the type under which the row reads as that derivation (`rows.ts::dateFieldDeclarations`);
 * and a property a row compares with a value of a known type takes that type, under which the row
 * reads back (`rows.ts::rowEarlyReads`). The same reading of the rows names the worker's own data
 * they read (`searchRowUserFields`). Last, a case list's `date` order element declares the date
 * class for a property nothing else types and no expression reads (`declareDateSorts`). A Hidden
 * Value writer is typed only once its expression is bound, so the settle takes back each
 * declaration a writer then types (`settleSearches`). The first menu to declare a property decides
 * its type.
 */
function declareDateFieldsBeforeBinding(
	ctx: ReadContext,
	app: DraftApp,
	readings: ReadonlyMap<Uuid, SearchReading>,
): void {
	const doc = provisionalDocument(ctx);
	const declarations: {
		caseType: string;
		property: string;
		dataType: CasePropertyDataType;
	}[] = [];
	const guesses = new Set<string>();
	const userFields: string[] = [];
	const sessionUserFields: string[] = [];
	const declare = (
		caseType: string,
		property: string,
		dataType: CasePropertyDataType,
	) => {
		if (
			!declarations.some(
				(one) => one.caseType === caseType && one.property === property,
			)
		)
			declarations.push({ caseType, property, dataType });
	};
	for (const module of app.modules) {
		const reading = readings.get(module.uuid);
		const mod = doc.modules[module.uuid];
		const caseType = mod?.caseType;
		if (reading === undefined || !reading.whole || caseType === undefined)
			continue;
		const properties = propertyTypes(doc, caseType);
		for (const input of mod?.caseListConfig?.searchInputs ?? [])
			if (
				input.kind === "simple" &&
				input.type === "date-range" &&
				input.via === undefined &&
				properties.find((property) => property.name === input.property)
					?.data_type === undefined
			) {
				const before = declarations.length;
				declare(caseType, input.property, "date");
				if (declarations.length > before)
					guesses.add(guessKey(caseType, input.property));
			}
		for (const { property, dataType } of dateFieldDeclarations(
			ctx,
			doc,
			module,
			reading,
		))
			declare(caseType, property, dataType);
		const early = rowEarlyReads(ctx, doc, module, reading);
		for (const one of early.types)
			declare(one.caseType, one.property, one.dataType);
		for (const field of early.userFields)
			if (!userFields.includes(field)) userFields.push(field);
		for (const field of early.sessionUserFields)
			if (!sessionUserFields.includes(field)) sessionUserFields.push(field);
	}
	declareDateSorts(ctx, app, doc, declare);
	EARLY_DECLARATIONS.set(ctx, declarations);
	noteDateRangeGuesses(ctx, guesses);
	ROW_USER_FIELDS.set(ctx, { userFields, sessionUserFields });
	const catalog = app.caseTypes;
	if (declarations.length === 0 || catalog === undefined || catalog === null)
		return;
	const next = produce(catalog, (draft) => {
		for (const { caseType, property, dataType } of declarations) {
			const declared = draft
				.find((one) => one.name === caseType)
				?.properties.find((one) => one.name === property);
			if (declared !== undefined) declared.data_type = dataType;
		}
	});
	ctx.writeDraft(() => {
		app.caseTypes = next;
	});
}

/**
 * The type a case list's `date` order element declares for a property nothing else types and no
 * expression reads (`caseList/order.ts::dateSortDeclarations`), after every Search field's and
 * row's own. The element is one print of the date class's three types, so the declaration is the
 * first of them; an expression that reads the property binds under the member the source was
 * written for, a date compared with a day, a date and time with a moment, so a property any
 * pending expression reads (`expressions/scanReads.ts::scanReads`) takes no declaration here.
 */
function declareDateSorts(
	ctx: ReadContext,
	app: DraftApp,
	doc: BlueprintDoc,
	declare: (
		caseType: string,
		property: string,
		dataType: CasePropertyDataType,
	) => void,
): void {
	const inputs = readProjectionInputs(ctx);
	const found = app.modules.flatMap((module) => {
		const list = caseListReadings(ctx).get(module.uuid);
		return list === undefined || !list.whole
			? []
			: dateSortDeclarations(
					doc,
					module.uuid,
					list.sort,
					inputs.assets !== undefined,
					inputs.lookupNaming,
				);
	});
	if (found.length === 0) return;
	const read = new Set(
		scanReads(ctx.pending.list(), doc, expressionEnvOf(ctx)).caseProperties.map(
			(one) => JSON.stringify([one.caseType, one.property]),
		),
	);
	for (const one of found)
		if (!read.has(JSON.stringify([one.caseType, one.property])))
			declare(one.caseType, one.property, one.dataType);
}

/** The names of the worker's own data each reading's search rows read, per reading. */
const ROW_USER_FIELDS = new WeakMap<
	ReadContext,
	{
		readonly userFields: readonly string[];
		readonly sessionUserFields: readonly string[];
	}
>();

/**
 * The names of the worker's own data the reading's search filter rows read, in the order first
 * read (`rows.ts::rowEarlyReads`), known once the searches' first pass has run. A row binds at the
 * settle, outside the expression stage's slots, so the worker properties minted from that stage's
 * reads must take these too, or the row would read the name back as no property of the app.
 * `sessionUserFields` are those a row reads from the session and not the worker's own case.
 */
export function searchRowUserFields(ctx: ReadContext): {
	readonly userFields: readonly string[];
	readonly sessionUserFields: readonly string[];
} {
	return ROW_USER_FIELDS.get(ctx) ?? { userFields: [], sessionUserFields: [] };
}

/** `doc` without each early declaration a writer of the bound document types: the writer's type
 *  is the property's, as it is in the document the reading's source was emitted from. */
function takeBackWriterTypedDeclarations(
	ctx: ReadContext,
	doc: BlueprintDoc,
): BlueprintDoc {
	const early = EARLY_DECLARATIONS.get(ctx) ?? [];
	if (early.length === 0) return doc;
	const removing = (
		draft: BlueprintDoc,
		keep: (one: (typeof early)[number]) => boolean,
	) => {
		for (const one of early) {
			if (keep(one)) continue;
			const declared = draft.caseTypes
				?.find((type) => type.name === one.caseType)
				?.properties.find((property) => property.name === one.property);
			if (declared?.data_type === one.dataType) delete declared.data_type;
		}
	};
	const without = withCandidate(doc, (draft) =>
		removing(draft as BlueprintDoc, () => false),
	);
	return withCandidate(doc, (draft) =>
		removing(
			draft as BlueprintDoc,
			(one) =>
				propertyTypes(without, one.caseType).find(
					(property) => property.name === one.property,
				)?.data_type === undefined,
		),
	);
}

/**
 * Each simple field that rides its bare prompt key (`simpleArmNeedsXPathQueryEmission`) whose
 * property the app's writers type as something its type does not admit
 * (`SEARCH_INPUT_TYPE_PROPERTY_TYPES`, the table the gate refuses Nova's own matching by), held
 * with the project space's matching. The project space matches a bare key by its own rule
 * whatever Nova names the field's matching, a date range over text by the date HQ's index reads
 * from the stored text (`case_search.py::case_property_date_range`, the `.date` multifield), and
 * the gate admits that matching over any type, which the projection writes alike. A field its
 * search matches through a condition is derived only where its type fits
 * (`rows.ts::typeFitsProperty`), and keeps its condition elsewhere.
 */
function fieldsOverAnotherType(ctx: ReadContext, reading: SearchReading): void {
	const doc = ctx.doc;
	const mod = doc?.modules[reading.module.uuid];
	if (doc === undefined || mod === undefined) return;
	const properties = propertyTypes(doc, mod.caseType);
	const native = new Set<Uuid>();
	for (const input of mod.caseListConfig?.searchInputs ?? []) {
		if (
			input.kind !== "simple" ||
			input.matching === "project-space" ||
			simpleArmNeedsXPathQueryEmission(input)
		)
			continue;
		const allowed = SEARCH_INPUT_TYPE_PROPERTY_TYPES[input.type];
		const type = properties.find(
			(property) => property.name === input.property,
		)?.data_type;
		if (allowed === undefined || type === undefined || allowed.includes(type))
			continue;
		native.add(input.uuid);
		// The prompt's name is a use of this class too: it names a property the field's type does
		// not fit.
		const prompt = reading.prompts.find((one) => one.uuid === input.uuid);
		if (prompt !== undefined)
			ctx.accounting.claimEntryClass(
				{ json: prompt.cursor, key: "name" },
				C.fieldOfAnotherType.entry,
				"schema:CaseSearchProperty.name",
				searchPlace(reading.module),
			);
	}
	if (native.size === 0) return;
	ctx.doc = withCandidate(doc, (draft) => {
		for (const input of draft.modules[reading.module.uuid]?.caseListConfig
			?.searchInputs ?? [])
			if (input.kind === "simple" && native.has(input.uuid))
				input.matching = "project-space";
	});
}

/**
 * A menu whose search a finding keeps from the settle places none of its rows: each row's value
 * stands under that finding, the first at the search or at its menu, so the close names no row
 * the reading never reached as unrecognized beside the finding that kept it out. Where no finding
 * stands there and a Search field's choices come from a lookup table the reading was not told of
 * (`prompts.ts::PromptReading.unreadTable`), each row waits on project data's read of that table,
 * as the field does, and is handed to it.
 */
function coverUnsettledRows(ctx: ReadContext, reading: SearchReading): void {
	const search = searchPlace(reading.module);
	if (search.kind !== "search") return;
	const menu = whereText({
		kind: "menu",
		menu: search.menu,
		name: search.name,
	});
	const findings = ctx.accounting.findings();
	const finding =
		findings.find((one) => whereText(one.place) === whereText(search)) ??
		findings.find((one) => whereText(one.place) === menu);
	if (finding === undefined) {
		const table = reading.prompts.find(
			(prompt) => prompt.unreadTable !== undefined,
		)?.unreadTable;
		if (table !== undefined)
			for (const row of reading.rows)
				ctx.accounting.handOffAt(
					{ json: row.cursor, key: "defaultValue" },
					"lookup-table-read",
					table,
				);
		return;
	}
	for (const row of reading.rows)
		ctx.accounting.cover({ json: row.cursor, key: "defaultValue" }, finding);
}

/**
 * After the binding: each searching menu's rows placed, its fields' arms decided, and its whole
 * search accepted by the projection.
 */
export function settleSearches(ctx: ReadContext, app: DraftApp): void {
	try {
		settleEachSearch(ctx, app);
	} finally {
		// A check's refusal no settle reached stands as the expression stage made it.
		settleDeferredRefusals(ctx);
	}
}

/**
 * Each held Search button condition, over the document its menus settled: one that reads an
 * instance the menu's case list does not load is refused, since HQ's build declares no instance
 * for what only the Search action's `relevant` reads and the list then stops on the device
 * (`suite/case-search/buttonCondition.ts::searchButtonUndeclaredInstances`, the gate's
 * `CASE_SEARCH_BUTTON_DISPLAY_CONDITION_NOT_ON_THE_LIST`). It runs after the menus settle, since
 * a menu's parent selection is among what the list loads.
 */
export function settleSearchButtonConditions(
	ctx: ReadContext,
	app: DraftApp,
): void {
	const doc = ctx.doc;
	const readings = READINGS.get(ctx);
	if (doc === undefined || readings === undefined) return;
	for (const module of app.modules) {
		const reading = readings.get(module.uuid);
		if (reading === undefined || !reading.whole) continue;
		let undeclared: readonly string[];
		try {
			undeclared = searchButtonUndeclaredInstances(doc, module.uuid);
		} catch (error) {
			rethrowWorkStop(error);
			continue;
		}
		if (undeclared.length === 0) continue;
		ctx.accounting.findingAt(
			SETTING_CLAIMS.buttonNotOnTheList,
			searchPlace(module),
			`${reading.cursor.pointer}/search_button_display_condition`,
			{ name: "search_button_display_condition" },
		);
	}
}

function settleEachSearch(ctx: ReadContext, app: DraftApp): void {
	if (ctx.doc === undefined) return;
	const readings = READINGS.get(ctx);
	if (readings === undefined) return;
	ctx.doc = takeBackWriterTypedDeclarations(ctx, ctx.doc);
	const placed: SearchReading[] = [];
	for (const module of app.modules) {
		const reading = readings.get(module.uuid);
		if (reading === undefined) continue;
		if (!reading.whole || ctx.doc.modules[module.uuid] === undefined) {
			for (const prompt of reading.prompts)
				if (prompt.validationRule !== undefined)
					settleDeferredRefusal(ctx, prompt.validationRule);
			coverUnsettledRows(ctx, reading);
			continue;
		}
		if (!reading.usesProjectSearch)
			classifySearchRows(ctx, module, {
				rows: reading.rows,
				prompts: reading.prompts,
				formsReadSearch: reading.formsReadSearch,
				zeroInput: reading.zeroInput,
				markersOnly: reading.markersOnly,
			});
		if (!reading.usesProjectSearch) fieldsOverAnotherType(ctx, reading);
		placed.push(reading);
	}
	settleUntoldChecks(ctx, placed);
	for (const reading of placed)
		settleSearchSettings(ctx, reading.module, reading.cursor, reading.prompts);
}

/** Match a customized guard by its actual generated test after all search rows are placed.
 * A guard carried alone supplies its text in every language. Where only joins were printed,
 * all occurrences of the same guard must agree on a split that leaves every authored rule
 * its own message. The full-menu projection checks the recovered rule and wording. */
function settleUntoldChecks(
	ctx: ReadContext,
	readings: readonly SearchReading[],
): void {
	const doc = ctx.doc;
	if (!doc) return;
	const fields = readings.flatMap((reading) => {
		const mod = doc.modules[reading.module.uuid];
		const asked = reading.prompts.filter(
			(prompt) =>
				prompt.validationRule !== undefined &&
				refusalDeferred(ctx, prompt.validationRule),
		);
		if (!mod || !asked.length) return [];
		const endings = runtimeGuardEndings(ctx, doc, mod, asked);
		return asked.flatMap((prompt) => {
			const index = prompt.validationRule;
			if (index === undefined) return [];
			const ending = endings.get(prompt);
			if (!ending || !prompt.validationText) {
				settleDeferredRefusal(ctx, index);
				return [];
			}
			return [
				{
					prompt,
					index,
					ending,
					texts: prompt.validationText,
					module: reading.module,
				},
			];
		});
	});
	const groups = Map.groupBy(fields, (field) => field.ending.message.key);
	const codes = appCodes(ctx);
	const source = sourceCode(ctx);
	if (!source) return;
	for (const [key, group] of groups) {
		const sentence = group[0].ending.message.message;
		const texts = recordFromEntries(
			codes.flatMap((code) => {
				const alone = group.find(
					(field) => field.ending.whole && field.texts[code],
				)?.texts[code];
				const joined = group.flatMap((field) =>
					!field.ending.whole && field.texts[code] ? [field.texts[code]] : [],
				);
				if (alone === undefined && joined.length === 0) return [];
				const text = readGuardText(sentence, alone, joined);
				return text ? [[code, text] as const] : [];
			}),
		);
		if (Object.keys(texts).length > 0)
			ctx.translations.set(
				makeTranslationUnitId("system", "search-validation", key),
				"text",
				translatedTexts(ctx, texts, true),
			);
		for (const { prompt, index, ending, module, texts: stored } of group) {
			const point = ctx.pending.site(index).at;
			const held = ctx.doc;
			if (!held || !("json" in point)) continue;
			const rule = ending.rule;
			const ownMessages = recordFromEntries(
				codes.flatMap((code) => {
					const suffix = ` ${texts[code]}`;
					const whole = stored[code] ?? "";
					return whole.endsWith(suffix)
						? [[code, whole.slice(0, -suffix.length)] as const]
						: [];
				}),
			);
			const usesNativeMessage =
				rule !== undefined && codes.every((code) => stored[code] === "");
			let kept =
				usesNativeMessage ||
				(ending.whole
					? codes.every(
							(code) => stored[code] !== "" && stored[code] === texts[code],
						)
					: !!rule && codes.every((code) => ownMessages[code]?.trim()));
			if (kept && rule) {
				const registration = ctx.pending.list()[index];
				const { deferRefusal: _defer, ...own } = registration;
				const result = readExpressions(
					held,
					[{ ...own, text: rule }],
					expressionEnvOf(ctx),
				);
				if (!result.bound[0]) kept = false;
				else {
					ctx.doc = result.doc;
					for (const claim of result.claims)
						if (claim.source === 0) applyExpressionClaim(ctx, claim, point);
				}
			}
			if (!kept) {
				const place = searchPlace(module);
				if (Object.values(stored).every((text) => text === "")) {
					const claim = SETTING_CLAIMS.checkWithoutMessageGuarded;
					const detail = { name: prompt.name };
					ctx.accounting.findingAt(
						claim,
						place,
						`${prompt.cursor.pointer}/validations`,
						detail,
					);
					settleDeferredRefusal(
						ctx,
						index,
						manifestFindingOf(claim, place, detail),
					);
				} else {
					const detail = { name: "schema:Assertion.text" };
					ctx.accounting.circumstance("unrecognized", place, detail);
					settleDeferredRefusal(
						ctx,
						index,
						circumstanceFinding("unrecognized", place, detail),
					);
				}
				if (rule) untoldRuleRefusal(ctx, held, index, rule);
				continue;
			}
			ctx.doc = withCandidate(ctx.doc ?? held, (draft) => {
				const input = draft.modules[
					module.uuid
				]?.caseListConfig?.searchInputs.find((one) => one.uuid === prompt.uuid);
				if (!input || input.kind === "hidden") return;
				if (ending.whole) delete input.validation;
				else if (input.validation) {
					if (usesNativeMessage) delete input.validation.message;
					else input.validation.message = ownMessages[source];
				}
			});
			if (!ending.whole && !usesNativeMessage)
				ctx.translations.set(
					makeTranslationUnitId(
						"search-input",
						prompt.uuid,
						"validation-message",
					),
					"text",
					translatedTexts(ctx, ownMessages),
				);
			replaceDeferredRefusal(ctx, index);
			if (ending.whole)
				point.json.derived(point.key, PROMPT_CLAIMS.validationGuard);
		}
	}
}

/**
 * The field's own rule of an untold check, `rule` the source's text of the conjuncts before
 * Nova's guard, read by the expression stage on its own over the settled document
 * (`expressions/index.ts::readExpressions`, under the check's registration with `rule` as its
 * text): where it is held, the message alone keeps the field out; where it is refused, each of the
 * reading's claims and `unrecognized` rows is applied to the check's node, as the expression stage
 * applies a refusal (`provisional.ts::applyExpressionClaim`, `applyExpressionCircumstance`).
 */
function untoldRuleRefusal(
	ctx: ReadContext,
	doc: BlueprintDoc,
	index: number,
	rule: string,
): void {
	const registration = ctx.pending.list()[index];
	if (registration === undefined) return;
	const { deferRefusal: _deferred, ...own } = registration;
	const judged = readExpressions(
		doc,
		[{ ...own, text: rule }],
		expressionEnvOf(ctx),
	);
	if (judged.bound[0] !== undefined) return;
	const at = ctx.pending.site(index).at;
	for (const claim of judged.claims)
		if (claim.source === 0) applyExpressionClaim(ctx, claim, at);
	for (const row of judged.circumstances)
		if (row.source === 0) applyExpressionCircumstance(ctx, row, at);
}
