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
	Expression,
	Module,
	Uuid,
} from "@/lib/domain";
import { effectiveCaseTypes } from "@/lib/domain/effectiveCaseTypes";
import { resolveRelationDestination } from "@/lib/domain/expression/relationDestination";
import { defaultSortBlanks } from "@/lib/domain/modules";
import { isStandardCaseListProperty } from "@/lib/domain/standardCaseProperties";
import type { HqPlace } from "@/lib/publish/hqFindings";
import {
	type CaseListRewrites,
	projectCaseListForHq,
} from "../../hqJson/caseList";
import { HqXPath, hqXPathText } from "../../hqJson/xpath";
import { withCandidate } from "../candidate";
import type { DraftApp, DraftForm, DraftModule, ReadContext } from "../context";
import { readerDefect } from "../defects";
import { levelControl, type PrintLevel } from "../expressions/printLevel";
import { dotInterpolate } from "../hqInterpolation";
import { isJsonObject, sameJson } from "../jsonCursor";
import type { PendingExpression } from "../pendingExpressions";
import { keptMediaPaths, readProjectionInputs } from "../projectionInputs";
import { provisionalDocument } from "../provisional";
import { sameXPathText } from "../syntaxCompare";
import {
	appCodes,
	attributeOf,
	columnFormatAsRead,
	formatReadsMapping,
	HQ_PROPERTY_RENAMES,
	imageMapPropertyText,
	labelShownProperty,
	sameHeldTexts,
	sameShownTexts,
	sourceCode,
} from "./columns";
import {
	type CaseListReading,
	caseListReadings,
	readCaseDetails,
	sameState,
} from "./details";
import { CALCULATED_FIELD, implicitRuleColumn, ORDER_CLAIMS } from "./order";
import { withReadTexts } from "./readTexts";

export { joinDetailColumns } from "./details";

const SELECT_KINDS = new Set(["single_select", "multi_select"]);

/** Each case type's properties a select question of the app's forms writes, by the forms'
 *  drafts: one walk of every form, so a stage asking for each menu's type asks once. */
function selectPropertiesByType(app: DraftApp): Map<string, Set<string>> {
	const out = new Map<string, Set<string>>();
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
				if (typeof type !== "string" || !("writes" in operation)) continue;
				for (const write of operation.writes ?? []) {
					const value = write.value;
					if (
						value.kind === "term" &&
						value.term.kind === "field" &&
						selects.has(value.term.uuid)
					) {
						let properties = out.get(type);
						if (properties === undefined) {
							properties = new Set();
							out.set(type, properties);
						}
						properties.add(write.property);
					}
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

/** Each case type's properties a column of any menu of that type shows by its choices' labels,
 *  read from the stored details (`columns.ts::labelShownProperty`): one walk of every menu. */
function labelShownPropertiesByType(app: DraftApp): Map<string, Set<string>> {
	const byType = new Map<string, Set<string>>();
	for (const module of app.modules) {
		const caseType = module.module.caseType;
		if (caseType === undefined) continue;
		let out = byType.get(caseType);
		if (out === undefined) {
			out = new Set();
			byType.set(caseType, out);
		}
		const pair = module.json.peek("case_details");
		for (const screen of ["short", "long"] as const) {
			const detail = isJsonObject(pair) ? pair[screen] : undefined;
			const columns = isJsonObject(detail) ? detail.columns : undefined;
			for (const column of Array.isArray(columns) ? columns : []) {
				const property = labelShownProperty(column);
				if (property !== undefined) out.add(property);
			}
		}
	}
	return byType;
}

/** Step 6, pass 1: every menu's case list, read from its two details, and the type each numeric
 *  sort declares written into the draft's catalog before any expression binds. */
export function readCaseLists(ctx: ReadContext, app: DraftApp): void {
	const steps = readCaseListsSteps(ctx, app);
	while (!steps.next().done);
}

/** The menus `readCaseListsSteps` reads between two stops. */
const MENUS_READ_PER_STEP = 100;

/** `readCaseLists`, stopping after every `MENUS_READ_PER_STEP` menus and before the numeric
 *  sort declarations until it is resumed. */
export function* readCaseListsSteps(
	ctx: ReadContext,
	app: DraftApp,
): Generator<void, void, void> {
	/* Each read from the drafts before any detail is read, which writes neither a form's case
	 * changes, a menu's case type nor its stored details. */
	const selectsByType = selectPropertiesByType(app);
	const shownByType = labelShownPropertiesByType(app);
	const none: ReadonlySet<string> = new Set();
	for (const [at, module] of app.modules.entries()) {
		if (at > 0 && at % MENUS_READ_PER_STEP === 0) yield;
		const caseType = module.module.caseType;
		const selects =
			caseType === undefined ? none : (selectsByType.get(caseType) ?? none);
		const shown =
			caseType === undefined ? none : (shownByType.get(caseType) ?? none);
		readCaseDetails(ctx, module, {
			selectProperty: (property) =>
				selects.has(property) && shown.has(property),
			labelShown: (property) => shown.has(property),
		});
	}
	yield;
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
		for (const [owner, property, dataType] of numericSortDeclarations(
			doc,
			caseType,
			reading,
		))
			if (
				!declarations.some(
					(one) => one.caseType === owner && one.property === property,
				)
			)
				declarations.push({ caseType: owner, property, dataType });
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

/** A column's `field` as what HQ's build reads: the property it names, the child element it
 *  names where that is no property Nova reads, or its expression text. */
function fieldRead(column: JsonObject): {
	property?: string;
	element?: string;
	text?: string;
} {
	const field = typeof column.field === "string" ? column.field : "";
	if (column.useXpathExpression !== true) {
		const renamed = HQ_PROPERTY_RENAMES[field] ?? field;
		// `CASE_PROPERTY_MAP` maps no `case_id`, so HQ reads the child element of that name, which
		// no case holds, where Nova's `@case_id` reads the case's id.
		return renamed === "case_id" ? { element: renamed } : { property: renamed };
	}
	const attribute = attributeOf(field);
	return attribute === undefined ? { text: field } : { property: attribute };
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

/**
 * The surface key of the first difference between a stored column and the projection's, each
 * read as HQ's build reads it on `screen`: the format as the reading reads it
 * (`columns.ts::columnFormatAsRead`), every text as the build shows it in each language, and the
 * mapping only where the format reads one.
 */
function columnDifference(
	codes: readonly string[],
	source: string | undefined,
	stored: JsonObject,
	ours: JsonObject,
	tile: boolean,
	screen: "short" | "long",
): string | undefined {
	const format = columnFormatAsRead(stored.format, screen);
	if (format !== columnFormatAsRead(ours.format, screen))
		return "schema:DetailColumn.format";
	const a = fieldRead(stored);
	const b = fieldRead(ours);
	if (a.element !== undefined || b.element !== undefined) {
		if (a.element !== b.element) return "schema:DetailColumn.field";
	} else if (a.property !== undefined || b.property !== undefined) {
		if (a.property !== b.property) return "schema:DetailColumn.field";
	} else if (!sameXPathText(a.text ?? "", b.text ?? ""))
		return "schema:DetailColumn.field";
	// HQ's build reads no header of a Search Only column (`detail_screen.py::Invisible`).
	if (
		format !== "invisible" &&
		!sameHeldTexts(
			codes,
			source,
			"case-list-header",
			stored.header,
			ours.header,
		)
	)
		return "schema:DetailColumn.header";
	if (format === "date" && stored.date_format !== ours.date_format)
		return "schema:DetailColumn.date_format";
	const enumA = formatReadsMapping(format) ? objects(stored.enum) : [];
	const enumB = formatReadsMapping(format) ? objects(ours.enum) : [];
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
		// An image map's value is a path, compared as shown; any other mapping's is a text, compared
		// as the reading holds it (`heldTextsIn`).
		if (
			format === "enum-image"
				? !sameShownTexts(codes, item.value, other.value)
				: !sameHeldTexts(
						codes,
						source,
						"case-list-mapping-label",
						item.value,
						other.value,
					)
		)
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
	// A whole-number or decimal comparison where HQ's build compares text orders the list
	// another way (`1, 10, 2` against `1, 2, 10`): HQ's default element is `string`
	// (`details.py::get_default_sort_elements`), and on a column whose format has no sort of its
	// own every stored `type` but `int` and `double` compares as text (`FormattedDetailColumn.sort_node`
	// writes it as `string` or as it is, and Core's `DetailFieldParser` reads any other word so).
	const numericWord = (type: unknown) => type === "int" || type === "double";
	if (reading.sort.defaulted && numericWord(ours[0]?.type))
		ctx.accounting.finding(ORDER_CLAIMS.typeText, place);
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
			// it, so the two sort one way. The reading names another position only where a rule
			// on the column the stored element names orders by another key than the column it
			// lands on, which no document Nova admits holds, and is read on the column it lands
			// on (`order.ts::readSortElements`): the first publish writes that column's position.
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
		if (reading.sort.textual.has(index) && numericWord(other.type))
			ctx.accounting.finding(ORDER_CLAIMS.typeText, place);
		// A date comparison over a property whose type is not of the date class HQ's build writes as
		// it writes a text one (`detail_screen.py::FormattedDetailColumn.sort_node` maps `date` and
		// `plain` to `string`), and the first publish writes Nova's word for it: the stored word
		// alone is new.
		if (element.type === "date" && other.type === "plain")
			sameState(
				ctx,
				ORDER_CLAIMS.typeDerived.entry,
				`${reading.short.pointer}/sort_elements/${index}/type`,
				"list-settings-respelled",
			);
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

/** The registrations of each menu's own slots, in registration order, worked out once per
 *  registry and again only once it holds more: each menu's settle reads its own. */
const registrationsByMenu = new WeakMap<
	readonly PendingExpression[],
	{ readonly length: number; readonly byMenu: Map<string, number[]> }
>();

function moduleRegistrations(
	registrations: readonly PendingExpression[],
): ReadonlyMap<string, readonly number[]> {
	const known = registrationsByMenu.get(registrations);
	if (known !== undefined && known.length === registrations.length)
		return known.byMenu;
	const byMenu = new Map<string, number[]>();
	registrations.forEach((registration, index) => {
		const ref = registration.ref;
		if (ref.entity !== "module") return;
		const indices = byMenu.get(ref.uuid);
		if (indices === undefined) byMenu.set(ref.uuid, [index]);
		else indices.push(index);
	});
	registrationsByMenu.set(registrations, {
		length: registrations.length,
		byMenu,
	});
	return byMenu;
}

/**
 * The control that prints each expression slot of a menu's details at the level the reading
 * held it (`expressions/printLevel.ts`): a calculated column's expression and the list's filter,
 * each only while the document holds the tree the expression stage stored for it. The search's
 * owner exclusion, which the filter writes as a clause of its own, is the search's slot, held in
 * `search_config`; its clause in the filter prints as an export prints it, since nothing reads
 * that clause as a slot of its own.
 */
function heldListLevels(ctx: ReadContext, mod: Module): CaseListRewrites {
	const held = new Map<string, { tree: Expression; level: PrintLevel }>();
	const registrations = ctx.pending.list();
	for (const index of moduleRegistrations(registrations).get(mod.uuid) ?? []) {
		const ref = (registrations[index] as PendingExpression).ref;
		const { expression, level } = ctx.pending.outcome(index);
		if (expression === undefined || level === undefined) continue;
		const member = (ref as { readonly member?: { columnUuid?: string } })
			.member;
		held.set(
			member?.columnUuid === undefined
				? ref.slot
				: `${ref.slot}/${member.columnUuid}`,
			{ tree: expression, level },
		);
	}
	if (held.size === 0) return {};
	const at = (key: string, tree: Expression | undefined) => {
		const one = held.get(key);
		return one !== undefined && tree !== undefined && sameJson(tree, one.tree)
			? one.level
			: undefined;
	};
	return {
		column: (columnUuid) => {
			const column = mod.caseListConfig?.columns.find(
				(one) => one.uuid === columnUuid,
			);
			return column?.kind === "calculated"
				? levelControl(
						at(`case_list_column_expression/${columnUuid}`, column.expression),
					)
				: undefined;
		},
		filter: () =>
			levelControl(at("case_list_filter", mod.caseListConfig?.filter)),
	};
}

/** The difference between one menu's stored details and the projection's, as a surface key.
 *  Each expression slot prints at the level the reading held it (`heldListLevels`), so a slot
 *  held with a rewrite withheld is compared as its source spells it, and the reading records
 *  the rewrite. */
function listDifference(
	ctx: ReadContext,
	doc: BlueprintDoc,
	mod: Module,
	reading: CaseListReading,
): string | undefined {
	const inputs = readProjectionInputs(ctx);
	const projected = projectCaseListForHq(
		mod,
		withReadTexts(doc, ctx.translations),
		inputs.assets,
		inputs.lookupNaming,
		undefined,
		heldListLevels(ctx, mod),
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
	// An image map's paths compare as the files they name (`keptMediaPaths`).
	const asPrinted = (column: JsonObject): JsonObject =>
		column.format !== "enum-image" || !Array.isArray(column.enum)
			? column
			: {
					...column,
					enum: column.enum.map((item: unknown) =>
						isJsonObject(item)
							? { ...item, value: keptMediaPaths(ctx, item.value) }
							: item,
					),
				};
	const shortStored = kept(
		reading.short.peek("columns"),
		reading.dropped.short,
	).map(asPrinted);
	const longStored = kept(
		reading.long.peek("columns"),
		reading.dropped.long,
	).map(asPrinted);
	const shortOurs = objects(pair.short.columns);
	const longOurs = objects(pair.long.columns);
	const tile = mod.caseListConfig?.tile !== undefined;
	if (longStored.length !== longOurs.length) return "schema:Detail.columns";
	for (const [index, column] of longStored.entries()) {
		const key = columnDifference(
			codes,
			sourceCode(ctx),
			column,
			longOurs[index] as JsonObject,
			false,
			"long",
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
			sourceCode(ctx),
			column,
			shortOurs[index] as JsonObject,
			tile,
			"short",
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
		for (const [owner, property, dataType] of untyped) {
			const declared = draft.caseTypes
				?.find((one) => one.name === owner)
				?.properties.find((one) => one.name === property);
			if (declared !== undefined) declared.data_type = dataType;
		}
	});
}

/** The case type and property a calculated column's expression reads where it is that one read
 *  alone, on the menu's case or on a case a relation reaches. */
function calculatedRead(
	doc: BlueprintDoc,
	caseType: string,
	expression: Expression,
): [string, string] | undefined {
	if (expression.kind !== "term" || expression.term.kind !== "prop")
		return undefined;
	const { property, via } = expression.term;
	const destination = resolveRelationDestination(
		via,
		caseType,
		effectiveCaseTypes(doc),
	);
	return destination.ok ? [destination.caseType, property] : undefined;
}

/** Each property a menu's `int` or `double` sort element orders by that `doc`'s writers give no
 *  type, with its case type and the type the element declares: a property element's own, or the
 *  one property a calculated column the element lands on reads alone, since Nova derives the
 *  comparator from the property's type (`caseListOrder.ts`, rule 8). */
function numericSortDeclarations(
	doc: BlueprintDoc,
	caseType: string,
	reading: CaseListReading,
): [string, string, CasePropertyDataType][] {
	const stored = objects(reading.short.peek("sort_elements"));
	const columns = doc.modules[reading.module.uuid]?.caseListConfig?.columns;
	const wanted = new Map<string, [string, string, CasePropertyDataType]>();
	for (const [index, type] of reading.sort.numeric) {
		const field = stored[index]?.field;
		if (typeof field !== "string") continue;
		const dataType = type === "int" ? "int" : "decimal";
		let read: [string, string] | undefined;
		if (CALCULATED_FIELD.test(field)) {
			const priority = reading.sort.kept.indexOf(index);
			const column = columns?.find(
				(one) => one.kind === "calculated" && one.sort?.priority === priority,
			);
			read =
				column?.kind === "calculated"
					? calculatedRead(doc, caseType, column.expression)
					: undefined;
		} else read = [caseType, HQ_PROPERTY_RENAMES[field] ?? field];
		if (read === undefined || isStandardCaseListProperty(read[1])) continue;
		wanted.set(`${read[0]}\u0000${read[1]}`, [read[0], read[1], dataType]);
	}
	if (wanted.size === 0) return [];
	const typed = effectiveCaseTypes(doc);
	return [...wanted.values()].filter(
		([owner, property]) =>
			typed
				.find((one) => one.name === owner)
				?.properties.find((one) => one.name === property)?.data_type ===
			undefined,
	);
}

/**
 * `doc` without the one rule its menu's list read, where that rule is the one a list with no rule
 * writes (`order.ts::implicitRuleColumn`) and the stored element compares no number and no date:
 * the list with no rule prints the stored element, and the reader returns it
 * (`implicit-order-rule-is-absent`). A stored `date` element is the rule's own, which the list
 * with no rule never writes.
 */
function withoutImplicitRule(
	ctx: ReadContext,
	doc: BlueprintDoc,
	reading: CaseListReading,
): BlueprintDoc {
	if (reading.sort.defaulted || reading.sort.kept.length !== 1) return doc;
	const index = reading.sort.kept[0] as number;
	const type = objects(reading.short.peek("sort_elements"))[index]?.type;
	if (type === "int" || type === "double" || type === "date") return doc;
	const moduleUuid = reading.module.uuid;
	const rule = implicitRuleColumn(
		doc,
		moduleUuid,
		readProjectionInputs(ctx).assets !== undefined,
	);
	if (rule === undefined) return doc;
	return withCandidate(doc, (draft) => {
		const one = draft.modules[moduleUuid]?.caseListConfig?.columns.find(
			(candidate) => candidate.uuid === rule.column,
		);
		if (one !== undefined) delete one.sort;
	});
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
		ctx.doc = withoutImplicitRule(ctx, ctx.doc, reading);
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
