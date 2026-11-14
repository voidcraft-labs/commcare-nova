/**
 * The search stages: every menu's `search_config` read into its search
 * (`readSearches`: the workflow, the Search fields, the default filters and
 * the settings), and accepted over the bound document (`settleSearches`):
 * each `_xpath_query` conjunct placed (`rows.ts`), and the whole menu's
 * search written back by the production projection (`settings.ts`).
 */
import { produce } from "immer";
import type { CaseListConfig, Uuid } from "@/lib/domain";
import { effectiveCaseTypes } from "@/lib/domain/effectiveCaseTypes";
import type {
	CaseSearchConfig,
	OrdinaryCaseSearchConfig,
} from "@/lib/domain/modules";
import { readFormSyntax } from "../../xpath/formSyntax";
import { noteProperty } from "../caseManagement/catalog";
import { defineClaims, derived, drop, refuse, take } from "../claims";
import type { DraftApp, DraftModule, ReadContext } from "../context";
import { searchRowProperties } from "../expressions/scanReads";
import { isJsonObject, type JsonCursor } from "../jsonCursor";
import { type PromptReading, readSearchPrompts } from "./prompts";
import { classifySearchRows, ROWS_HELD, type SearchRow } from "./rows";
import { readSearchSettings, settleSearchSettings } from "./settings";
import { offersSearch, readSearchWorkflow, searchPlace } from "./workflow";

export { classifySearchRows } from "./rows";

const S = "case-search/";
const ROUND_TRIP = `${S}the-generated-search-round-trip-remote-request-query-results`;
const MARKERS = `${S}default-properties-entries-keyed-include-closed-or-x-commcare`;

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
		"schema:DefaultCaseSearchProperty.defaultValue",
	),
	plainKey: refuse(
		`${S}default-properties-entry-keyed-by-a-plain-property-property-p`,
		"schema:DefaultCaseSearchProperty.property",
	),
	ancestorKey: refuse(
		`${S}default-properties-entry-keyed-by-an-ancestor-path-parent-p`,
		"schema:DefaultCaseSearchProperty.property",
	),
	projectKey: refuse(
		`${S}default-properties-entry-keyed-owner-id-case-id-commcare-project`,
		"schema:DefaultCaseSearchProperty.property",
	),
	sortKey: refuse(
		`${S}default-properties-entry-keyed-commcare-sort-x-commcare-custom`,
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
	ownersTwice: refuse(
		`${S}that-entry-together-with-blacklisted-owner-ids-expression`,
		"schema:DefaultCaseSearchProperty.property",
	),
	fieldOfAnotherType: refuse(
		`${S}search-field-over-a-property-of-another-type`,
		"schema:CaseSearchProperty.input_",
	),
});

const C = SEARCH_CLAIMS;

/** What the settle takes from one menu's first pass. */
interface SearchReading {
	readonly module: DraftModule;
	readonly cursor: JsonCursor;
	readonly prompts: readonly PromptReading[];
	readonly rows: readonly SearchRow[];
	readonly formsReadSearch: boolean;
	readonly zeroInput: boolean;
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

/** The finding for a default filter keyed by anything but a row or a zero-input marker. */
function keyFinding(key: string, ownersExpression: boolean) {
	if (key === "commcare_blacklisted_owner_ids")
		return ownersExpression ? C.ownersTwice : C.ownersKey;
	if (key === "case_type") return C.caseTypeKey;
	if (key === "x_commcare_endpoint_id") return C.endpointKey;
	if (key === "x_commcare_data_registry") return C.registryKey;
	if (key === "commcare_sort" || key.startsWith("x_commcare_"))
		return C.sortKey;
	if (
		key === "owner_id" ||
		key === "case_id" ||
		key === "commcare_project" ||
		key.startsWith("indices.")
	)
		return C.projectKey;
	if (key.includes("/")) return C.ancestorKey;
	return C.plainKey;
}

/** The default filters: each `_xpath_query` row kept, the markers read, every other key refused. */
function readDefaultFilters(
	accounting: ReadContext["accounting"],
	cursor: JsonCursor,
	hasPrompts: boolean,
): { ok: boolean; rows: SearchRow[]; names: Set<string>; zeroInput: boolean } {
	const stored = cursor.peek("default_properties");
	const entries = Array.isArray(stored) ? stored.filter(isJsonObject) : [];
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
	const ownersExpression = cursor.used("blacklisted_owner_ids_expression");
	const rows: SearchRow[] = [];
	const names = new Set<string>();
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
		if (typeof value !== "string" || value.trim() === "") {
			row.refuse(
				"defaultValue",
				C.noValue,
				property === "" ? undefined : { name: property.slice(0, 200) },
			);
			ok = false;
			return;
		}
		if (property !== "_xpath_query") {
			row.refuse("property", keyFinding(property, ownersExpression), {
				name: property.slice(0, 200),
			});
			names.add(property);
			ok = false;
			return;
		}
		row.take("property", C.rowProperty, String).value;
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
	return { ok, rows, names, zeroInput };
}

/** Step 6, pass 1: every menu's search, read from its `search_config`. */
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
			if (!offers)
				for (const key of Object.keys(
					isJsonObject(module.json.peek("search_config"))
						? (module.json.peek("search_config") as object)
						: {},
				))
					cursor.derived(key, C.inactive);
			continue;
		}
		const config: Partial<OrdinaryCaseSearchConfig> = {};
		if (!offers) {
			const settings = readSearchSettings(ctx, module, cursor, false, config);
			for (const key of Object.keys(
				isJsonObject(module.json.peek("search_config"))
					? (module.json.peek("search_config") as object)
					: {},
			))
				if (key !== "blacklisted_owner_ids_expression")
					cursor.derived(key, C.inactive);
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
		const filters = readDefaultFilters(ctx.accounting, cursor, hasPrompts);
		// A property the search's rows read is a property of the catalog, as every expression's is.
		const caseType = module.module.caseType;
		const rowProperties = filters.rows.flatMap((row) =>
			searchRowProperties(row.text),
		);
		if (rowProperties.length > 0 && app.caseTypes != null)
			ctx.writeDraft(() => {
				app.caseTypes = produce(app.caseTypes ?? [], (draft) => {
					for (const property of rowProperties)
						noteProperty(draft, caseType, property);
				});
			});
		const prompts = readSearchPrompts(ctx, module, cursor, filters.names);
		const workflow = readSearchWorkflow(ctx, module, cursor);
		const settings = readSearchSettings(ctx, module, cursor, true, config);
		const search: OrdinaryCaseSearchConfig = { ...config, ...(workflow ?? {}) };
		ctx.writeDraft(() => {
			const list = module.module.caseListConfig as CaseListConfig | undefined;
			if (list !== undefined)
				list.searchInputs = prompts.map((prompt) => prompt.input);
			(
				module.module as { caseSearchConfig?: CaseSearchConfig }
			).caseSearchConfig = search;
		});
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
			whole:
				filters.ok &&
				settings.ok &&
				workflow !== undefined &&
				prompts.length === declared,
		});
	}
}

/** A date or date range field whose property the app's writers type as something else. */
function fieldOverAnotherType(ctx: ReadContext, reading: SearchReading): void {
	const doc = ctx.doc;
	const mod = doc?.modules[reading.module.uuid];
	if (doc === undefined || mod === undefined) return;
	const properties =
		effectiveCaseTypes(doc).find((type) => type.name === mod.caseType)
			?.properties ?? [];
	for (const input of mod.caseListConfig?.searchInputs ?? []) {
		if (
			input.kind !== "simple" ||
			(input.type !== "date" && input.type !== "date-range") ||
			input.via !== undefined
		)
			continue;
		const type = properties.find(
			(property) => property.name === input.property,
		)?.data_type;
		if (type !== undefined && type !== "date" && type !== "datetime")
			ctx.accounting.finding(
				C.fieldOfAnotherType,
				searchPlace(reading.module),
				{ name: input.name },
			);
	}
}

/**
 * Step 8, pass 2: each searching menu's rows placed, its fields' arms decided, and its whole
 * search accepted by the projection.
 */
export function settleSearches(ctx: ReadContext, app: DraftApp): void {
	if (ctx.doc === undefined) return;
	const readings = READINGS.get(ctx);
	if (readings === undefined) return;
	for (const module of app.modules) {
		const reading = readings.get(module.uuid);
		if (
			reading === undefined ||
			!reading.whole ||
			ctx.doc.modules[module.uuid] === undefined
		)
			continue;
		classifySearchRows(ctx, module, {
			rows: reading.rows,
			prompts: reading.prompts,
			formsReadSearch: reading.formsReadSearch,
			zeroInput: reading.zeroInput,
		});
		fieldOverAnotherType(ctx, reading);
		settleSearchSettings(ctx, module, reading.cursor, reading.prompts);
	}
}
