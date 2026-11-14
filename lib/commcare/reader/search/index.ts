/**
 * The search stages: every menu's `search_config` read into its search
 * (`readSearches`: the workflow, the Search fields, the default filters and
 * the settings), and accepted over the bound document (`settleSearches`):
 * each `_xpath_query` conjunct placed (`rows.ts`), and the whole menu's
 * search written back by the production projection (`settings.ts`).
 */
import { produce } from "immer";
import {
	type BlueprintDoc,
	type CaseListConfig,
	SEARCH_INPUT_TYPE_PROPERTY_TYPES,
	type Uuid,
} from "@/lib/domain";
import { effectiveCaseTypes } from "@/lib/domain/effectiveCaseTypes";
import type {
	CaseSearchConfig,
	OrdinaryCaseSearchConfig,
} from "@/lib/domain/modules";
import { withCandidate } from "../candidate";
import { noteProperty } from "../caseManagement/catalog";
import { defineClaims, derived, drop, refuse, take } from "../claims";
import type { DraftApp, DraftModule, ReadContext } from "../context";
import { searchRowProperties } from "../expressions/scanReads";
import { isJsonObject, type JsonCursor } from "../jsonCursor";
import { provisionalDocument } from "../provisional";
import { readFormSyntax } from "../syntaxRead";
import { type PromptReading, readSearchPrompts } from "./prompts";
import {
	classifySearchRows,
	dateFieldDeclarations,
	MARKERS_HELD,
	ROWS_HELD,
	type SearchRow,
} from "./rows";
import { readSearchSettings, settleSearchSettings } from "./settings";
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
): {
	ok: boolean;
	rows: SearchRow[];
	names: Set<string>;
	zeroInput: boolean;
	markersOnly: boolean;
} {
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
	const relatedPropertySet = cursor.used("custom_related_case_property");
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
			row.refuse(
				"property",
				keyFinding(property, value, ownersExpression, relatedPropertySet),
				{ name: property.slice(0, 200) },
			);
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
	return { ok, rows, names, zeroInput, markersOnly };
}

/** Step 6, pass 1: every menu's search, read from its `search_config`, and the type each date
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
		const caseType = module.module.caseType;
		const prompts = readSearchPrompts(ctx, module, cursor, filters.names);
		// A property the search's rows read, and a simple Search field's, is a property of the
		// catalog, as every expression's is.
		const properties = [
			...filters.rows.flatMap((row) => searchRowProperties(row.text)),
			...prompts.flatMap((prompt) =>
				prompt.input.kind === "simple" && prompt.input.via === undefined
					? [prompt.input.property]
					: [],
			),
		];
		if (properties.length > 0 && app.caseTypes != null)
			ctx.writeDraft(() => {
				app.caseTypes = produce(app.caseTypes ?? [], (draft) => {
					for (const property of properties)
						noteProperty(draft, caseType, property);
				});
			});
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
			markersOnly: filters.markersOnly,
			whole:
				filters.ok &&
				settings.ok &&
				workflow !== undefined &&
				prompts.length === declared,
		});
	}
	declareDateFieldsBeforeBinding(ctx, app, readings);
}

/** The types the catalog gives a menu's case type's properties: declared, else its writers'. */
function propertyTypes(doc: BlueprintDoc, caseType: string | undefined) {
	return (
		effectiveCaseTypes(doc).find((type) => type.name === caseType)
			?.properties ?? []
	);
}

/** The date types declared before the expression stage, per reading: each case type and
 *  property declared, with the type. */
const EARLY_DATE_DECLARATIONS = new WeakMap<
	ReadContext,
	readonly {
		readonly caseType: string;
		readonly property: string;
		readonly dataType: "date" | "datetime";
	}[]
>();

/**
 * The types the Search fields give properties no writer types, written into the draft's catalog
 * before the expression stage, so every slot that reads such a property (a search's own rows, a
 * filter comparing it with a date) binds against the type the field declares. A date range field
 * over such a property declares it `date`, since the gate asks a date range field for a date
 * property (`SEARCH_INPUT_TYPE_PROPERTY_TYPE_MISMATCH`); a field whose row is its derivation
 * declares the type under which the row reads as that derivation (`rows.ts::dateFieldDeclarations`).
 * A Hidden Value writer is typed only once its expression is bound, so the settle takes back each
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
		dataType: "date" | "datetime";
	}[] = [];
	const declare = (
		caseType: string,
		property: string,
		dataType: "date" | "datetime",
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
			)
				declare(caseType, input.property, "date");
		for (const { property, dataType } of dateFieldDeclarations(
			ctx,
			doc,
			module,
			reading,
		))
			declare(caseType, property, dataType);
	}
	EARLY_DATE_DECLARATIONS.set(ctx, declarations);
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

/** `doc` without each early declaration a writer of the bound document types: the writer's type
 *  is the property's, as it is in the document the reading's source was emitted from. */
function takeBackWriterTypedDeclarations(
	ctx: ReadContext,
	doc: BlueprintDoc,
): BlueprintDoc {
	const early = EARLY_DATE_DECLARATIONS.get(ctx) ?? [];
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

/** A simple field whose property the app's writers type as something its type does not admit
 *  (`SEARCH_INPUT_TYPE_PROPERTY_TYPES`, the table the gate refuses by). */
function fieldOverAnotherType(ctx: ReadContext, reading: SearchReading): void {
	const doc = ctx.doc;
	const mod = doc?.modules[reading.module.uuid];
	if (doc === undefined || mod === undefined) return;
	const properties = propertyTypes(doc, mod.caseType);
	for (const input of mod.caseListConfig?.searchInputs ?? []) {
		if (input.kind !== "simple" || input.via !== undefined) continue;
		const allowed = SEARCH_INPUT_TYPE_PROPERTY_TYPES[input.type];
		const type = properties.find(
			(property) => property.name === input.property,
		)?.data_type;
		if (allowed !== undefined && type !== undefined && !allowed.includes(type))
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
	ctx.doc = takeBackWriterTypedDeclarations(ctx, ctx.doc);
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
			markersOnly: reading.markersOnly,
		});
		fieldOverAnotherType(ctx, reading);
		settleSearchSettings(ctx, module, reading.cursor, reading.prompts);
	}
}
