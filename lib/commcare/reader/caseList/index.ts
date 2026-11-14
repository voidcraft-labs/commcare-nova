/**
 * The case list stages: every menu's two details read into its case list
 * (`readCaseLists`), and accepted over the bound document by the production
 * projection (`settleCaseLists`): one call of
 * `hqJson/caseList.ts::projectCaseListForHq` per menu, whose short and long
 * details, sort elements, filter and tile keys must equal the stored ones
 * after the inert claims and the same-state rows.
 */
import { produce } from "immer";
import type {
	BlueprintDoc,
	CaseOperation,
	CasePropertyDataType,
	Module,
	Uuid,
} from "@/lib/domain";
import { effectiveCaseTypes } from "@/lib/domain/effectiveCaseTypes";
import { defaultSortBlanks } from "@/lib/domain/modules";
import { isStandardCaseListProperty } from "@/lib/domain/standardCaseProperties";
import type { HqPlace } from "@/lib/publish/hqFindings";
import { projectCaseListForHq } from "../../hqJson/caseList";
import { HqXPath, hqXPathText } from "../../hqJson/xpath";
import { withCandidate } from "../candidate";
import type { DraftApp, DraftForm, DraftModule, ReadContext } from "../context";
import { readerDefect } from "../defects";
import { dotInterpolate } from "../hqInterpolation";
import { isJsonObject, sameJson } from "../jsonCursor";
import { readProjectionInputs } from "../projectionInputs";
import { provisionalDocument } from "../provisional";
import { sameXPathText } from "../syntaxCompare";
import {
	appCodes,
	attributeOf,
	HQ_PROPERTY_RENAMES,
	imageMapPropertyText,
	languageMap,
} from "./columns";
import {
	type CaseListReading,
	caseListReadings,
	readCaseDetails,
	sameState,
} from "./details";
import { CALCULATED_FIELD, ORDER_CLAIMS } from "./order";

export { joinDetailColumns } from "./details";

const SELECT_KINDS = new Set(["single_select", "multi_select"]);

/** The properties of `caseType` a select question of the app's forms writes, by the forms' drafts. */
function selectProperties(app: DraftApp, caseType: string): Set<string> {
	const out = new Set<string>();
	for (const module of app.modules)
		for (const form of module.forms) {
			const selects = selectFieldsOf(form);
			if (selects.size === 0) continue;
			for (const operation of (form.form.caseOperations ??
				[]) as readonly CaseOperation[]) {
				const type =
					operation.action === "own"
						? module.module.caseType
						: operation.caseType;
				if (type !== caseType || !("writes" in operation)) continue;
				for (const write of operation.writes ?? []) {
					const value = write.value;
					if (
						value.kind === "term" &&
						value.term.kind === "field" &&
						selects.has(value.term.uuid)
					)
						out.add(write.property);
				}
			}
		}
	return out;
}

function selectFieldsOf(form: DraftForm): Set<Uuid> {
	const out = new Set<Uuid>();
	const xform = form.xform;
	if (xform === null) return out;
	const walk = (parent: Parameters<typeof xform.childrenOf>[0]) => {
		for (const field of xform.childrenOf(parent)) {
			if (SELECT_KINDS.has(field.kind) && field.uuid !== undefined)
				out.add(field.uuid);
			walk(field);
		}
	};
	walk(null);
	return out;
}

/** Step 6, pass 1: every menu's case list, read from its two details, and the type each numeric
 *  sort declares written into the draft's catalog before any expression binds. */
export function readCaseLists(ctx: ReadContext, app: DraftApp): void {
	for (const module of app.modules) {
		const caseType = module.module.caseType;
		const selects =
			caseType === undefined
				? new Set<string>()
				: selectProperties(app, caseType);
		readCaseDetails(ctx, module, (property) => selects.has(property));
	}
	declareNumericSortsBeforeBinding(ctx, app);
}

/** The numeric sort declarations made before the expression stage, per reading: each case type
 *  and property declared, with the type. */
const EARLY_SORT_DECLARATIONS = new WeakMap<
	ReadContext,
	readonly {
		readonly caseType: string;
		readonly property: string;
		readonly dataType: CasePropertyDataType;
	}[]
>();

/**
 * The numeric sort declarations, written into the draft's catalog before the expression stage, so
 * a slot that reads such a property (a filter comparing it with a number) binds against the type
 * the list declares. A Hidden Value writer is typed only once its expression is bound, so the
 * settle takes these back and declares again over the bound document (`settleCaseLists`). The
 * first menu to declare a property decides its type, as in the settle.
 */
function declareNumericSortsBeforeBinding(
	ctx: ReadContext,
	app: DraftApp,
): void {
	const doc = provisionalDocument(ctx);
	const declarations: {
		caseType: string;
		property: string;
		dataType: CasePropertyDataType;
	}[] = [];
	for (const module of app.modules) {
		const reading = caseListReadings(ctx).get(module.uuid);
		const caseType = module.module.caseType;
		if (reading === undefined || caseType === undefined || !reading.whole)
			continue;
		for (const [property, dataType] of numericSortDeclarations(
			doc,
			caseType,
			reading,
		))
			if (
				!declarations.some(
					(one) => one.caseType === caseType && one.property === property,
				)
			)
				declarations.push({ caseType, property, dataType });
	}
	EARLY_SORT_DECLARATIONS.set(ctx, declarations);
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

// ── Acceptance by re-emission ───────────────────────────────────────────

type JsonObject = Readonly<Record<string, unknown>>;

/** A projection's tree as HQ JSON holds it: every expression printed. */
function printed(value: unknown): unknown {
	if (value instanceof HqXPath) return hqXPathText(value);
	if (Array.isArray(value)) return value.map(printed);
	if (isJsonObject(value))
		return Object.fromEntries(
			Object.entries(value).map(([key, one]) => [key, printed(one)]),
		);
	return value;
}

function objects(value: unknown): JsonObject[] {
	return Array.isArray(value) ? value.filter(isJsonObject) : [];
}

/** A column's `field` as the property it reads, or its expression text. */
function fieldRead(column: JsonObject): { property?: string; text?: string } {
	const field = typeof column.field === "string" ? column.field : "";
	if (column.useXpathExpression !== true) {
		const renamed = HQ_PROPERTY_RENAMES[field] ?? field;
		return { property: renamed };
	}
	const attribute = attributeOf(field);
	return attribute === undefined ? { text: field } : { property: attribute };
}

/** Two `{lang: text}` maps alike over the app's languages, a language a map lacks read as `""`. */
function sameTexts(codes: readonly string[], a: unknown, b: unknown): boolean {
	const left = languageMap(a);
	const right = languageMap(b);
	return codes.every((code) => (left[code] ?? "") === (right[code] ?? ""));
}

const CELL_KEYS = [
	"grid_x",
	"grid_y",
	"width",
	"height",
	"horizontal_align",
	"vertical_align",
	"font_size",
	"show_border",
	"show_shading",
] as const;

/** The surface key of the first difference between a stored column and the projection's. */
function columnDifference(
	codes: readonly string[],
	stored: JsonObject,
	ours: JsonObject,
	tile: boolean,
): string | undefined {
	const format = stored.format ?? "plain";
	if (format !== (ours.format ?? "plain")) return "schema:DetailColumn.format";
	const a = fieldRead(stored);
	const b = fieldRead(ours);
	if (a.property !== undefined || b.property !== undefined) {
		if (a.property !== b.property) return "schema:DetailColumn.field";
	} else if (!sameXPathText(a.text ?? "", b.text ?? ""))
		return "schema:DetailColumn.field";
	// HQ's build reads no header of a Search Only column (`detail_screen.py::Invisible`).
	if (format !== "invisible" && !sameTexts(codes, stored.header, ours.header))
		return "schema:DetailColumn.header";
	if (format === "date" && stored.date_format !== ours.date_format)
		return "schema:DetailColumn.date_format";
	const enumA = objects(stored.enum);
	const enumB = objects(ours.enum);
	if (enumA.length !== enumB.length) return "schema:DetailColumn.enum";
	for (const [index, item] of enumA.entries()) {
		const other = enumB[index] as JsonObject;
		const keyA = typeof item.key === "string" ? item.key : "";
		const keyB = typeof other.key === "string" ? other.key : "";
		// HQ's build puts an image map key's dots to the column's property before it reads it
		// (`models/case_list.py::MappingItem.key_as_condition`), so the two keys are compared so.
		const property =
			a.property === undefined ? undefined : imageMapPropertyText(a.property);
		const sameKey =
			format !== "enum-image"
				? keyA === keyB
				: property === undefined
					? sameXPathText(keyA, keyB)
					: sameXPathText(
							dotInterpolate(keyA, property),
							dotInterpolate(keyB, property),
						);
		if (!sameKey) return "schema:MappingItem.key";
		if (!sameTexts(codes, item.value, other.value))
			return "schema:MappingItem.value";
	}
	if (tile)
		for (const key of CELL_KEYS)
			if (!sameJson(stored[key] ?? null, ours[key] ?? null))
				return `schema:DetailColumn.${key}`;
	return undefined;
}

/** The surface key of the first difference between the stored sort elements and the projection's. */
function sortDifference(
	ctx: ReadContext,
	place: HqPlace,
	reading: CaseListReading,
	stored: readonly JsonObject[],
	ours: readonly JsonObject[],
	columns: { readonly stored: unknown; readonly ours: unknown },
): string | undefined {
	// The text a positional element joins by: the `field` of the short column it names
	// (`util.py::get_sort_and_sort_only_columns`).
	const positionalText = (field: unknown, detail: unknown) => {
		const match =
			typeof field === "string" ? CALCULATED_FIELD.exec(field) : null;
		const column =
			match === null || !Array.isArray(detail)
				? undefined
				: detail[Number(match[1])];
		return isJsonObject(column) && typeof column.field === "string"
			? column.field
			: undefined;
	};
	const kept = reading.sort.defaulted
		? []
		: reading.sort.kept.map((index) => stored[index] as JsonObject);
	const expected = reading.sort.defaulted ? 1 : kept.length;
	if (ours.length !== expected) return "schema:Detail.sort_elements";
	for (const [position, element] of kept.entries()) {
		const other = ours[position] as JsonObject;
		const storedText = positionalText(element.field, columns.stored);
		const ourText = positionalText(other.field, columns.ours);
		if (
			element.field !== other.field &&
			storedText !== undefined &&
			ourText !== undefined
		) {
			// Two positional elements over one expression text land on the first column holding
			// it, so the two sort one way.
			if (!sameXPathText(storedText, ourText))
				return "schema:SortElement.field";
			const index = reading.sort.kept[position] as number;
			sameState(
				ctx,
				ORDER_CLAIMS.fieldCalculated.entry,
				`${reading.short.pointer}/sort_elements/${index}/field`,
				"list-settings-respelled",
			);
		} else if (element.field !== other.field) {
			// HQ's build reads its five renamed words as the properties Nova names
			// (`detail_screen.py::CASE_PROPERTY_MAP`), so the two spellings sort one way.
			const renamed = (field: unknown) =>
				typeof field === "string"
					? (HQ_PROPERTY_RENAMES[field] ?? field)
					: field;
			if (renamed(element.field) !== renamed(other.field))
				return "schema:SortElement.field";
			const index = reading.sort.kept[position] as number;
			sameState(
				ctx,
				ORDER_CLAIMS.fieldHidden.entry,
				`${reading.short.pointer}/sort_elements/${index}/field`,
				"list-settings-respelled",
			);
		}
		if (element.direction !== other.direction)
			return "schema:SortElement.direction";
		// A stored `""` is the direction's own: blanks first ascending, last descending.
		const own = defaultSortBlanks(
			element.direction === "descending" ? "desc" : "asc",
		);
		const blanksA =
			element.blanks === "" || element.blanks === undefined
				? own
				: element.blanks;
		const blanksB =
			other.blanks === "" || other.blanks === undefined ? own : other.blanks;
		if (blanksA !== blanksB) return "schema:SortElement.blanks";
		const index = reading.sort.kept[position] as number;
		const numeric = reading.sort.numeric.get(index);
		if (numeric !== undefined && other.type !== numeric)
			ctx.accounting.finding(ORDER_CLAIMS.typeNumeric, place);
	}
	return undefined;
}

function caseListPlace(module: DraftModule): HqPlace {
	return {
		kind: "case-list",
		menu: module.index,
		name: module.place.kind === "menu" ? module.place.name : "",
	};
}

/** The difference between one menu's stored details and the projection's, as a surface key. */
function listDifference(
	ctx: ReadContext,
	doc: BlueprintDoc,
	mod: Module,
	reading: CaseListReading,
): string | undefined {
	const inputs = readProjectionInputs(ctx);
	const projected = projectCaseListForHq(
		mod,
		doc,
		inputs.assets,
		inputs.lookupNaming,
	);
	const pair = printed(projected.caseDetails) as {
		short: JsonObject;
		long: JsonObject;
	};
	const codes = appCodes(ctx);
	// A column an inert row dropped is written by no build.
	const kept = (detail: unknown, dropped: ReadonlySet<number>) =>
		(Array.isArray(detail) ? detail : []).flatMap((column, index) =>
			isJsonObject(column) && !dropped.has(index) ? [column] : [],
		);
	const shortStored = kept(
		reading.short.peek("columns"),
		reading.dropped.short,
	);
	const longStored = kept(reading.long.peek("columns"), reading.dropped.long);
	const shortOurs = objects(pair.short.columns);
	const longOurs = objects(pair.long.columns);
	const tile = mod.caseListConfig?.tile !== undefined;
	if (longStored.length !== longOurs.length) return "schema:Detail.columns";
	for (const [index, column] of longStored.entries()) {
		const key = columnDifference(
			codes,
			column,
			longOurs[index] as JsonObject,
			false,
		);
		if (key !== undefined) return key;
	}
	// The short detail: the stored columns, then the hidden columns a sort element added.
	const carriers = reading.joined.columns.filter(
		(column) => column.carrier === true,
	).length;
	const written = tile ? shortStored.length : shortStored.length + carriers;
	if (
		shortOurs.length !== written &&
		!(shortStored.length === 0 && shortOurs.length <= 1)
	)
		return "schema:Detail.columns";
	for (const [index, column] of shortStored.entries()) {
		const key = columnDifference(
			codes,
			column,
			shortOurs[index] as JsonObject,
			tile,
		);
		if (key !== undefined) return key;
	}
	const sortKey = sortDifference(
		ctx,
		caseListPlace(reading.module),
		reading,
		objects(reading.short.peek("sort_elements")),
		objects(pair.short.sort_elements),
		{ stored: reading.short.peek("columns"), ours: pair.short.columns },
	);
	if (sortKey !== undefined) return sortKey;
	const storedFilter = reading.short.peek("filter");
	const ourFilter = pair.short.filter;
	const blank = (value: unknown) =>
		value === null || value === undefined || value === "";
	if (blank(storedFilter) !== blank(ourFilter)) return "schema:Detail.filter";
	if (
		!blank(storedFilter) &&
		!sameXPathText(String(storedFilter), String(ourFilter))
	)
		return "schema:Detail.filter";
	for (const key of ["case_tile_template", "persist_tile_on_forms"] as const) {
		const a = reading.short.peek(key);
		const b = pair.short[key];
		if ((a ?? null) !== (b ?? null) && !(blank(a) && blank(b)))
			return `schema:Detail.${key}`;
	}
	const groupA = reading.short.peek("case_tile_group");
	const groupB = pair.short.case_tile_group;
	const identifier = (group: unknown) =>
		isJsonObject(group) &&
		typeof group.index_identifier === "string" &&
		group.index_identifier !== ""
			? [group.index_identifier, group.header_rows]
			: null;
	if (!sameJson(identifier(groupA), identifier(groupB)))
		return "schema:Detail.case_tile_group";
	if (mod.caseListConfig?.selection !== undefined) {
		if (pair.short.multi_select !== true) return "schema:Detail.multi_select";
		const stored = reading.short.peek("max_select_value");
		const ours = pair.short.max_select_value;
		if ((stored === -1 ? 100 : stored) !== ours)
			return "schema:Detail.max_select_value";
	}
	return undefined;
}

/**
 * The catalog's type for each property an `int` or `double` sort element orders by where no writer
 * types it: Nova derives the comparator from the property's type (`caseListOrder.ts`), so the
 * property is declared `int` or `decimal`. A property the writers type keeps their type, and the
 * comparison judges the element.
 */
function declareNumericSorts(
	doc: BlueprintDoc,
	caseType: string,
	reading: CaseListReading,
): BlueprintDoc {
	const untyped = numericSortDeclarations(doc, caseType, reading);
	if (untyped.length === 0) return doc;
	return withCandidate(doc, (draft) => {
		const type = draft.caseTypes?.find((one) => one.name === caseType);
		for (const [property, dataType] of untyped) {
			const declared = type?.properties.find((one) => one.name === property);
			if (declared !== undefined) declared.data_type = dataType;
		}
	});
}

/** Each property a menu's `int` or `double` sort element orders by that `doc`'s writers give no
 *  type, with the type the element declares. */
function numericSortDeclarations(
	doc: BlueprintDoc,
	caseType: string,
	reading: CaseListReading,
): [string, CasePropertyDataType][] {
	const stored = objects(reading.short.peek("sort_elements"));
	const wanted = new Map<string, CasePropertyDataType>();
	for (const [index, type] of reading.sort.numeric) {
		const field = stored[index]?.field;
		if (typeof field !== "string" || CALCULATED_FIELD.test(field)) continue;
		const property = HQ_PROPERTY_RENAMES[field] ?? field;
		if (isStandardCaseListProperty(property)) continue;
		wanted.set(property, type === "int" ? "int" : "decimal");
	}
	if (wanted.size === 0) return [];
	const typed = effectiveCaseTypes(doc).find((one) => one.name === caseType);
	return [...wanted].filter(
		([property]) =>
			typed?.properties.find((one) => one.name === property)?.data_type ===
			undefined,
	);
}

/**
 * Step 8, pass 2: each menu's case list accepted where the projection writes its stored details
 * back. A difference no row names is `unrecognized` at the list, under its surface key. The
 * declarations made before binding are taken back first, so each is made again only where the
 * bound document's writers, a Hidden Value's among them, still give the property no type.
 */
export function settleCaseLists(ctx: ReadContext, app: DraftApp): void {
	// A calculated column shown on both screens is registered from one detail; the other
	// detail's `field` holds the same tree (the join's equality), so the expression stage's
	// claim of the registration holds it too.
	for (const reading of caseListReadings(ctx).values())
		for (const twin of reading.twins) {
			const claim = ctx.pending.outcome(twin.registration).claim;
			if (claim !== undefined)
				ctx.accounting.claimEntry(
					twin.site,
					claim.entryId,
					claim.key,
					twin.place,
					claim.detail,
				);
		}
	if (ctx.doc === undefined) return;
	const early = EARLY_SORT_DECLARATIONS.get(ctx) ?? [];
	if (early.length > 0)
		ctx.doc = withCandidate(ctx.doc, (draft) => {
			for (const { caseType, property, dataType } of early) {
				const declared = draft.caseTypes
					?.find((one) => one.name === caseType)
					?.properties.find((one) => one.name === property);
				if (declared?.data_type === dataType) delete declared.data_type;
			}
		});
	for (const module of app.modules) {
		const reading = caseListReadings(ctx).get(module.uuid);
		const caseType = ctx.doc.modules[module.uuid]?.caseType;
		if (reading === undefined || caseType === undefined || !reading.whole)
			continue;
		ctx.doc = declareNumericSorts(ctx.doc, caseType, reading);
		const doc = ctx.doc;
		const mod = doc.modules[module.uuid];
		if (mod === undefined) continue;
		const place = caseListPlace(module);
		let difference: string | undefined;
		try {
			difference = listDifference(ctx, doc, mod, reading);
		} catch {
			ctx.accounting.defect(
				place,
				"schema:Module.case_details",
				readerDefect.emissionThrew(place, "projectCaseListForHq"),
			);
			continue;
		}
		if (difference !== undefined && !ctx.accounting.hasFindingAt(place))
			ctx.accounting.circumstance("unrecognized", place, { name: difference });
	}
}
