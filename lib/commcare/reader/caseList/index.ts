/**
 * The case list stages: every menu's two details read into its case list
 * (`readCaseLists`), and accepted over the bound document by the production
 * projection (`settleCaseLists`): one call of
 * `hqJson/caseList.ts::projectCaseListForHq` per menu, whose short and long
 * details, sort elements, filter and tile keys must equal the stored ones
 * after the inert claims and the same-state rows.
 */
import type { BlueprintDoc, CaseOperation, Module, Uuid } from "@/lib/domain";
import type { HqPlace } from "@/lib/publish/hqFindings";
import { projectCaseListForHq } from "../../hqJson/caseList";
import { HqXPath, hqXPathText } from "../../hqJson/xpath";
import type { DraftApp, DraftForm, DraftModule, ReadContext } from "../context";
import { isJsonObject, sameJson } from "../jsonCursor";
import { readProjectionInputs } from "../projectionInputs";
import { sameXPathText } from "../syntaxCompare";
import {
	appCodes,
	attributeOf,
	HQ_PROPERTY_RENAMES,
	languageMap,
} from "./columns";
import {
	type CaseListReading,
	caseListReadings,
	readCaseDetails,
} from "./details";
import { ORDER_CLAIMS } from "./order";

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

/** Step 6, pass 1: every menu's case list, read from its two details. */
export function readCaseLists(ctx: ReadContext, app: DraftApp): void {
	for (const module of app.modules) {
		const caseType = module.module.caseType;
		const selects =
			caseType === undefined
				? new Set<string>()
				: selectProperties(app, caseType);
		readCaseDetails(ctx, module, (property) => selects.has(property));
	}
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
		const sameKey =
			format === "enum-image" ? sameXPathText(keyA, keyB) : keyA === keyB;
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
): string | undefined {
	const kept = reading.sort.defaulted
		? []
		: reading.sort.kept.map((index) => stored[index] as JsonObject);
	const expected = reading.sort.defaulted ? 1 : kept.length;
	if (ours.length !== expected) return "schema:Detail.sort_elements";
	for (const [position, element] of kept.entries()) {
		const other = ours[position] as JsonObject;
		if (element.field !== other.field) return "schema:SortElement.field";
		if (element.direction !== other.direction)
			return "schema:SortElement.direction";
		const own = element.direction === "descending" ? "first" : "last";
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
	const shortStored = objects(reading.short.peek("columns"));
	const longStored = objects(reading.long.peek("columns"));
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
 * Step 8, pass 2: each menu's case list accepted where the projection writes its stored details
 * back. A difference no row names is `unrecognized` at the list, under its surface key.
 */
export function settleCaseLists(ctx: ReadContext, app: DraftApp): void {
	const doc = ctx.doc;
	if (doc === undefined) return;
	for (const module of app.modules) {
		const reading = caseListReadings(ctx).get(module.uuid);
		const mod = doc.modules[module.uuid];
		if (reading === undefined || mod === undefined || !reading.whole) continue;
		const place = caseListPlace(module);
		let difference: string | undefined;
		try {
			difference = listDifference(ctx, doc, mod, reading);
		} catch {
			difference = "projectCaseListForHq";
		}
		if (difference !== undefined && !ctx.accounting.hasFindingAt(place))
			ctx.accounting.circumstance("unrecognized", place, { name: difference });
	}
}
