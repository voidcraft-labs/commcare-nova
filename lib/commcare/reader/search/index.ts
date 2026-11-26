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
	SEARCH_INPUT_TYPE_PROPERTY_TYPES,
	type Uuid,
} from "@/lib/domain";
import type { CasePropertyDataType } from "@/lib/domain/casePropertyTypes";
import { effectiveCaseTypes } from "@/lib/domain/effectiveCaseTypes";
import { CASE_TYPE_PATTERN } from "@/lib/domain/expression/types";
import type {
	CaseSearchConfig,
	OrdinaryCaseSearchConfig,
	SearchFilter,
} from "@/lib/domain/modules";
import { recordFromEntries } from "@/lib/domain/records";
import { USERCASE_CASE_TYPE } from "@/lib/domain/usercase";
import { circumstanceFinding } from "@/lib/publish/hqFindings";
import { searchButtonUndeclaredInstances } from "../../suite/case-search/buttonCondition";
import { readSearchFilterTarget } from "../../suite/case-search/nativeFilters";
import { simpleArmNeedsXPathQueryEmission } from "../../suite/case-search/simpleArmDerivation";
import { rethrowWorkStop } from "../../workMeter";
import { withCandidate } from "../candidate";
import { appCodes } from "../caseList/columns";
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
	settleDeferredRefusal,
	settleDeferredRefusals,
} from "../provisional";
import { readFormSyntax } from "../syntaxRead";
import { expressionEnvOf } from "../xform";
import { guessKey, noteDateRangeGuesses } from "./dateRangeGuesses";
import { type PromptReading, readSearchPrompts } from "./prompts";
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
	holdsOwnersWithoutClause,
	holdsText,
	hqAutoSelects,
	ownersWithoutClauseRegistration,
	readSearchSettings,
	runtimeGuardEndings,
	SETTING_CLAIMS,
	settleSearchSettings,
	spelledAsShown,
} from "./settings";
import { offersSearch, readSearchWorkflow, searchPlace } from "./workflow";

export { classifySearchRows } from "./rows";

const S = "case-search/";
const ROUND_TRIP = `${S}the-generated-search-round-trip-remote-request-query-results`;
const MARKERS = MARKERS_HELD;

export const SEARCH_CLAIMS = defineClaims("search", {
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
	caseTypeKey: refuse(
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
	ownersKey: refuse(
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
		return ownersExpression ? C.ownersTwice : C.ownersKey;
	if (key === "case_type") return C.caseTypeKey;
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
			// The row's value is the filter the refusal names, and stands under its finding.
			const claim = keyFinding(
				property,
				value,
				ownersExpression,
				relatedPropertySet,
			);
			if (claim === undefined) {
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
					"ancestors" in target && target.ancestors
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
			if (beside !== undefined)
				accounting.findingAt(
					claim,
					row.place,
					`${cursor.pointer}/${beside}`,
					detail,
				);
			accounting.cover(
				{ json: row, key: "defaultValue" },
				manifestFindingOf(claim, row.place, detail),
			);
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
	return { ok, rows, filters, names, zeroInput, markersOnly };
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

/** Before any expression binds: every menu's search, read from its `search_config`, and the type each date
 *  Search field declares written into the draft's catalog before any expression binds. */
export function readSearches(ctx: ReadContext, app: DraftApp): void {
	const readings = READINGS.get(ctx) ?? new Map<Uuid, SearchReading>();
	READINGS.set(ctx, readings);
	for (const module of app.modules) {
		const cursor = module.json.object(
			"search_config",
			"CaseSearch",
			module.docType === "AdvancedModule" ? C.configAdvanced : C.configModule,
			searchPlace(module),
		);
		const offers = offersSearch(cursor);
		// A menu with no case type lists no cases: a search it does not offer is its shell's,
		// claimed as inactive, and one it offers is left unclaimed, which the accounting names.
		if (module.module.caseType === undefined) {
			if (!offers) {
				deriveInactiveSearch(module, cursor, new Set());
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
		const filters = readDefaultFilters(ctx, module, cursor, hasPrompts);
		const caseType = module.module.caseType;
		const prompts = readSearchPrompts(ctx, module, cursor, filters.names);
		// A property the search's rows read, and a simple Search field's, is a property of the
		// catalog, as every expression's is.
		const properties = [
			...filters.filters.flatMap(({ target }) =>
				target.kind === "property" && !target.ancestors
					? [target.property]
					: [],
			),
			...filters.rows.flatMap((row) => searchRowProperties(row.text)),
			...prompts.flatMap((prompt) =>
				!prompt.refused &&
				prompt.input.kind === "simple" &&
				prompt.input.via === undefined
					? [prompt.input.property]
					: [],
			),
		];
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
			holeReads.length > 0;
		if (related && app.caseTypes != null)
			ctx.writeDraft(() => {
				app.caseTypes = produce(app.caseTypes ?? [], (draft) => {
					const told = ctx.input.knownCaseTypes;
					for (const property of properties)
						noteProperty(draft, caseType, property, told);
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
		const settings = readSearchSettings(ctx, module, cursor, true, config);
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
				list.searchInputs = prompts.map((prompt) => prompt.input);
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
			markersOnly: filters.markersOnly,
			whole:
				filters.ok &&
				settings.ok &&
				ownersHeld &&
				workflow !== undefined &&
				prompts.length === declared &&
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
	const judged = readExpression(trial, registration, expressionEnvOf(ctx));
	if (
		!holdsOwnersWithoutClause(
			cursor,
			judged.kind === "refused" ? undefined : judged.candidate,
		)
	)
		return false;
	ctx.pending.register(registration, {
		json: cursor,
		key: "blacklisted_owner_ids_expression",
	});
	ctx.writeDraft(() => {
		const target = module.module as { caseSearchConfig?: CaseSearchConfig };
		target.caseSearchConfig = {
			...(target.caseSearchConfig ?? {}),
			excludedOwnerIds: placeholder,
		} as CaseSearchConfig;
	});
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
	const mediaOn = readProjectionInputs(ctx).assets !== undefined;
	const found = app.modules.flatMap((module) => {
		const list = caseListReadings(ctx).get(module.uuid);
		return list === undefined || !list.whole
			? []
			: dateSortDeclarations(doc, module.uuid, list.sort, mediaOn);
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
		classifySearchRows(ctx, module, {
			rows: reading.rows,
			prompts: reading.prompts,
			formsReadSearch: reading.formsReadSearch,
			zeroInput: reading.zeroInput,
			markersOnly: reading.markersOnly,
		});
		fieldsOverAnotherType(ctx, reading);
		settleUntoldChecks(ctx, reading);
		settleSearchSettings(ctx, module, reading.cursor, reading.prompts);
	}
}

/**
 * Each Search field's check whose message told nothing of Nova's runtime guard and whose rule the
 * expression stage refused (`prompts.ts::ValidationReading.untold`, `PendingExpression.deferRefusal`),
 * settled over the menu's placed rows. Where the stored test ends with the guard Nova's projection
 * joins to the field's check (`settings.ts::runtimeGuardEndings`), the guard is Nova's and what
 * keeps the field out is its message: Nova prints the guard's sentence after the field's own in
 * the source language and no language's message ends with it, so the field is `unrecognized` at
 * `schema:Assertion.text` and the expression stage's refusal of the guard's reads is dropped. The
 * field's own rule, the conjuncts before the guard, is then read on its own
 * (`untoldRuleRefusal`), and where Nova cannot hold it either, its refusal stands beside the
 * message's, so the reading names both. Elsewhere the rule is the whole test, and its refusal
 * stands.
 */
function settleUntoldChecks(ctx: ReadContext, reading: SearchReading): void {
	const doc = ctx.doc;
	const mod = doc?.modules[reading.module.uuid];
	const untold = reading.prompts.filter((prompt) => {
		const index = prompt.validationRule;
		return index !== undefined && refusalDeferred(ctx, index);
	});
	// One projection of the menu for every untold field, never one a field.
	const endings =
		doc === undefined || mod === undefined || untold.length === 0
			? new Map<PromptReading, { readonly rule?: string } | undefined>()
			: runtimeGuardEndings(ctx, doc, mod, untold);
	for (const prompt of untold) {
		const index = prompt.validationRule;
		if (index === undefined) continue;
		const ending = endings.get(prompt);
		if (doc === undefined || ending === undefined) {
			settleDeferredRefusal(ctx, index);
			continue;
		}
		const place = searchPlace(reading.module);
		// A check whose text is blank in every language has no message for Nova's guard's
		// sentence to follow, which Nova's gate holds no check of
		// (`validator/rules/case-list/searchCheckMessage.ts`): its own finding.
		const blank =
			prompt.validationText !== undefined &&
			Object.values(prompt.validationText).every((text) => text === "");
		if (blank) {
			ctx.accounting.findingAt(
				SETTING_CLAIMS.checkWithoutMessageGuarded,
				place,
				`${prompt.cursor.pointer}/validations`,
				{ name: prompt.name },
			);
			settleDeferredRefusal(
				ctx,
				index,
				manifestFindingOf(SETTING_CLAIMS.checkWithoutMessageGuarded, place, {
					name: prompt.name,
				}),
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
		if (ending.rule !== undefined)
			untoldRuleRefusal(ctx, doc, index, ending.rule);
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
