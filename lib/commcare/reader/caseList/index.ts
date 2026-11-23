import { produce } from "immer";
import type {
	BlueprintDoc,
	CasePropertyDataType,
	Expression,
	Module,
	Uuid,
} from "@/lib/domain";
/**
 * The case list stages: every menu's two details read into its case list
 * (`readCaseLists`), and accepted over the bound document by the production
 * projection (`settleCaseLists`): one call of
 * `hqJson/caseList.ts::projectCaseListForHq` per menu, whose short and long
 * details, sort elements, filter and tile keys must equal the stored ones
 * after the inert claims and the same-state rows.
 */
import { caseContextLine } from "@/lib/domain/caseFormContext";
import { columnPropertyCaseType } from "@/lib/domain/columnRelation";
import { effectiveCaseTypes } from "@/lib/domain/effectiveCaseTypes";
import { resolveRelationDestination } from "@/lib/domain/expression/relationDestination";
import { columnFieldText, defaultSortBlanks } from "@/lib/domain/modules";
import { NO_ENTRIES, recordFromEntries } from "@/lib/domain/records";
import { isStandardCaseListProperty } from "@/lib/domain/standardCaseProperties";
import type { HqPlace } from "@/lib/publish/hqFindings";
import {
	type CaseListRewrites,
	projectCaseListForHq,
} from "../../hqJson/caseList";
import { HqXPath, hqXPathText } from "../../hqJson/xpath";
import { hqMappingKeyIsExpression } from "../../suite/case-list/keyVariable";
import { rethrowWorkStop } from "../../workMeter";
import { withCandidate } from "../candidate";
import type { DraftApp, DraftModule, ReadContext } from "../context";
import { readerDefect } from "../defects";
import { levelControl, type PrintLevel } from "../expressions/printLevel";
import { sameSlotText } from "../expressions/readExpression";
import { detailSourceSpans } from "../fixtureRows";
import { hqDeviceText } from "../heldText";
import { dotInterpolate } from "../hqInterpolation";
import { isJsonObject, objectMembers, sameJson } from "../jsonCursor";
import { handedOff, type PendingExpression } from "../pendingExpressions";
import { keptMediaPaths, readProjectionInputs } from "../projectionInputs";
import { applyExpressionClaim, provisionalDocument } from "../provisional";
import { listFilterWithoutOwnerClause } from "../search/settings";
import { sameXPathText } from "../syntaxCompare";
import { ATTRIBUTE_PROPERTIES } from "./attributeColumns";
import { nativeCalculationText } from "./calculationText";
import {
	appCodes,
	attributeOf,
	columnFormatAsRead,
	formatReadsMapping,
	imageMapFieldText,
	labelShownProperty,
	renamedField,
	sameHeldTexts,
	sameShownTexts,
	shownTexts,
	sourceCode,
} from "./columns";
import {
	type CaseListReading,
	caseListReadings,
	displayNames,
	dormantFormContextSource,
	readCaseDetails,
	readColumnVia,
	sameState,
} from "./details";
import {
	CALCULATED_FIELD,
	implicitRuleColumn,
	ORDER_CLAIMS,
	retainSortComparisons,
} from "./order";
import { withReadTexts } from "./readTexts";

export { joinDetailColumns } from "./details";

/** The sources that can give a column choice labels. Read every detail before choosing a
 * format for any raw column, since a label column in another menu can be its sole witness. */
function choiceProperties(ctx: ReadContext, app: DraftApp): Set<string> {
	const choices = new Set<string>();
	for (const type of ctx.draft.caseTypes ?? [])
		for (const property of type.properties)
			if (
				property.data_type === "single_select" ||
				property.data_type === "multi_select"
			)
				choices.add(JSON.stringify([type.name, property.name]));
	for (const module of app.modules) {
		const caseType = module.module.caseType;
		if (!caseType) continue;
		const pair = module.json.peek("case_details");
		for (const screen of ["short", "long"] as const) {
			const detail = isJsonObject(pair) ? pair[screen] : undefined;
			const columns = isJsonObject(detail) ? detail.columns : undefined;
			if (!Array.isArray(columns)) continue;
			// A field of a Details tab over other records shows a property of
			// that tab's rows: a child case type's, or none for a table's rows.
			const rows =
				screen === "long" && isJsonObject(detail)
					? detailSourceSpans(objectMembers(detail.tabs) ?? [], columns.length)
					: [];
			for (const [i, column] of columns.entries()) {
				if (rows[i]?.fixture) continue;
				const origin = rows[i]?.caseType ?? caseType;
				const read = labelShownProperty(column, (steps) =>
					readColumnVia(ctx, origin, steps),
				);
				if (read === undefined) continue;
				const owner = columnPropertyCaseType(
					read,
					origin,
					ctx.draft.caseTypes ?? [],
				);
				if (owner !== undefined)
					choices.add(JSON.stringify([owner, read.field]));
			}
		}
	}
	return choices;
}

/** Before any expression binds: every menu's case list, read from its two details, and the type each numeric
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
	const choices = choiceProperties(ctx, app);
	for (const [at, module] of app.modules.entries()) {
		if (at > 0 && at % MENUS_READ_PER_STEP === 0) yield;
		readCaseDetails(ctx, module, (property, type) =>
			choices.has(JSON.stringify([type ?? module.module.caseType, property])),
		);
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
		return recordFromEntries(
			Object.entries(value).map(([key, one]) => [key, printed(one)]),
		);
	return value;
}

function objects(value: unknown): JsonObject[] {
	return [...(objectMembers(value) ?? [])];
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
		const renamed = renamedField(field);
		// `CASE_PROPERTY_MAP` maps no `case_id`, so HQ reads the child element of that name, which
		// no case holds, where Nova's `@case_id` reads the case's id.
		return renamed.split("/").at(-1) === "case_id"
			? { element: renamed }
			: { property: renamed };
	}
	// The one attribute Nova writes as an expression column (`@case_id`) reads as the property
	// column over it; any other expression, `@status` among them, is its text: HQ's build names a
	// column stored as an expression otherwise than the property field it reads alike
	// (`id_strings.py::detail_column_header_locale`).
	const attribute = attributeOf(field);
	return attribute === undefined || !ATTRIBUTE_PROPERTIES.has(attribute)
		? { text: field }
		: { property: attribute };
}

/** HQ's formats that keep a load behavior (`const.py::FORMATS_SUPPORTING_CASE_LIST_OPTIMIZATIONS`). */
const OPTIMIZED: ReadonlySet<string> = new Set([
	"address",
	"date",
	"markdown",
	"phone",
	"plain",
	"enum",
]);

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

/** Whether two columns' fields read one value: one element, one property, or one expression. */
function sameField(
	a: ReturnType<typeof fieldRead>,
	b: ReturnType<typeof fieldRead>,
): boolean {
	if (a.element !== undefined || b.element !== undefined)
		return a.element === b.element;
	if (a.property !== undefined || b.property !== undefined)
		return a.property === b.property;
	return sameXPathText(a.text ?? "", b.text ?? "");
}

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
	fieldHandedOff: boolean,
	optimizationsOn: boolean,
): string | undefined {
	// A load behavior as HQ keeps it (`columns.ts::storedLoadBehavior`).
	const behavior = (column: JsonObject) =>
		column.useXpathExpression === true &&
		OPTIMIZED.has(typeof column.format === "string" ? column.format : "plain")
			? (column.optimization ?? null)
			: null;
	if (optimizationsOn && behavior(stored) !== behavior(ours))
		return "schema:DetailColumn.optimization";
	const format = columnFormatAsRead(stored.format, screen);
	if (format !== columnFormatAsRead(ours.format, screen))
		return "schema:DetailColumn.format";
	const a = fieldRead(stored);
	const b = fieldRead(ours);
	// A column whose expression was handed to project data prints no tree of the source's, so its
	// field is project data's finding, never the list's.
	if (!fieldHandedOff) {
		const translated = (
			column: JsonObject,
			source: ReturnType<typeof fieldRead>,
		) => {
			const keys = objects(column.enum).map((row) =>
				typeof row.key === "string" ? row.key : "",
			);
			const value =
				column.useXpathExpression === true && typeof column.field === "string"
					? column.field
					: source.property === undefined
						? (source.element ?? "")
						: imageMapFieldText(source.property);
			return nativeCalculationText(
				value,
				keys,
				(_key, index) => `translated_row_${index}`,
			);
		};
		if (
			format === "translatable-enum"
				? !sameXPathText(translated(stored, a), translated(ours, b))
				: !sameField(a, b)
		)
			return "schema:DetailColumn.field";
	}
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
	if (format === "late-flag" && (stored.late_flag ?? 30) !== ours.late_flag)
		return "schema:DetailColumn.late_flag";
	if (
		format === "time-ago" &&
		(stored.time_ago_interval ?? 365.25) !== ours.time_ago_interval
	)
		return "schema:DetailColumn.time_ago_interval";
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
			a.property === undefined ? undefined : imageMapFieldText(a.property);
		// HQ expands a literal into equality and interpolates dots only in an
		// expression. A literal key cannot itself contain a quote (HQ would
		// classify it as an expression).
		const effectiveCondition = (key: string) =>
			hqMappingKeyIsExpression(key)
				? dotInterpolate(key, property ?? "$calculated_property")
				: `${property ?? "$calculated_property"} = '${key}'`;
		if (
			keyA !== keyB &&
			format !== "translatable-enum" &&
			((format !== "enum-image" && format !== "conditional-enum") ||
				!sameXPathText(effectiveCondition(keyA), effectiveCondition(keyB)))
		)
			return "schema:MappingItem.key";
		if (format === "enum-image") {
			const empty = (raw: unknown) => {
				const texts = shownTexts(raw ?? NO_ENTRIES, codes);
				return (
					texts !== undefined &&
					Object.values(texts).every((value) => hqDeviceText(value) === "")
				);
			};
			if (
				!(empty(item.alt_text) && empty(other.alt_text)) &&
				!sameHeldTexts(
					codes,
					source,
					"case-list-image-description",
					item.alt_text ?? NO_ENTRIES,
					other.alt_text ?? NO_ENTRIES,
				)
			)
				return "schema:MappingItem.alt_text";
		}
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
/**
 * The name HQ's build lists a sort element's field under in Sort by, where it gives one: an
 * element whose display holds text Python does not read as blank names the `invisible` column it
 * lands on by that column's header (`detail_screen.py::Invisible.header`), and the column it
 * appends where it lands on none by the display itself (`util.py::create_temp_sort_column`), each
 * only where some language holds text. A field shown on Results is listed under its own header,
 * which the columns' comparison holds.
 */
function sortMenuName(element: JsonObject, detail: unknown): unknown {
	if (!displayNames(element.display)) return undefined;
	const columns = Array.isArray(detail) ? detail : [];
	const calculated =
		typeof element.field === "string"
			? CALCULATED_FIELD.exec(element.field)
			: null;
	const named =
		calculated === null ? undefined : columns[Number(calculated[1])];
	const text =
		calculated === null
			? element.field
			: isJsonObject(named)
				? named.field
				: undefined;
	const landing = columns.find(
		(column) => isJsonObject(column) && column.field === text,
	);
	const name = !isJsonObject(landing)
		? element.display
		: landing.format === "invisible"
			? landing.header
			: undefined;
	// A header blank in every language lists the field nowhere, as no name does.
	return displayNames(name) ? name : undefined;
}

function sortDifference(
	ctx: ReadContext,
	reading: CaseListReading,
	stored: readonly JsonObject[],
	ours: readonly JsonObject[],
	columns: { readonly stored: unknown; readonly ours: unknown },
	handedOff: ReadonlySet<number>,
	handedOffSorts: ReadonlySet<Uuid>,
): string | undefined {
	// The text a positional element joins by: the `field` of the short column it names
	// (`util.py::get_sort_and_sort_only_columns`).
	const positionOf = (field: unknown) => {
		const match =
			typeof field === "string" ? CALCULATED_FIELD.exec(field) : null;
		return match === null ? undefined : Number(match[1]);
	};
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
	// A property or calculation introduced earlier for its worker menu
	// position has one effective row in its own last-value map.
	const keptIndices = new Set(reading.sort.kept);
	const sortKeys = [
		"field",
		"sort_calculation",
		"type",
		"direction",
		"blanks",
		"display",
	] as const;
	stored.forEach((row, index) => {
		if (keptIndices.has(index)) return;
		const emitted = ours[index];
		if (emitted && sortKeys.every((key) => sameJson(row[key], emitted[key])))
			return;
		sameState(
			ctx,
			ORDER_CLAIMS.earlier.entry,
			`${reading.short.pointer}/sort_elements/${index}`,
			"list-settings-respelled",
		);
	});
	const keyOf = (element: JsonObject) =>
		element.field === "" ? element.sort_calculation : element.field;
	const lastField = new Map<unknown, number>();
	const lastCalculation = new Map<unknown, number>();
	const mapOf = (element: JsonObject) =>
		element.field === "" ? lastCalculation : lastField;
	ours.forEach((element, index) => {
		mapOf(element).set(keyOf(element), index);
	});
	ours = ours.filter(
		(element, index) => mapOf(element).get(keyOf(element)) === index,
	);
	const expected = reading.sort.defaulted ? 1 : kept.length;
	if (ours.length !== expected) return "schema:Detail.sort_elements";
	// A whole-number or decimal comparison where HQ's build compares text orders the list
	// another way (`1, 10, 2` against `1, 2, 10`): HQ's default element is `string`
	// (`details.py::get_default_sort_elements`), and on a column whose format has no sort of its
	// own every stored `type` but `int` and `double` compares as text (`FormattedDetailColumn.sort_node`
	// writes it as `string` or as it is, and Core's `DetailFieldParser` reads any other word so).
	const numericWord = (type: unknown) => type === "int" || type === "double";
	if (reading.sort.defaulted && numericWord(ours[0]?.type))
		return "schema:SortElement.type";
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
			// A stored element over a column whose expression was handed to project data names a
			// text Nova's print holds no tree of: project data's finding, never the list's.
			const stored = positionOf(element.field);
			if (stored !== undefined && handedOff.has(stored)) continue;
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
				typeof field === "string" ? renamedField(field) : field;
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
		if (element.field === "" && typeof element.sort_calculation === "string") {
			const rule = reading.sort.calculations.find(
				(one) => one.priority === position,
			);
			if (
				rule === undefined ||
				(!handedOffSorts.has(rule.uuid) &&
					(typeof other.sort_calculation !== "string" ||
						!sameXPathText(element.sort_calculation, other.sort_calculation)))
			)
				return "schema:SortElement.sort_calculation";
		}
		if (element.type === "distance" && other.type !== "distance")
			return "schema:SortElement.type";
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
		// The name each lists the field under in Sort by, where it lists it there.
		const nameA = sortMenuName(element, columns.stored);
		const nameB = sortMenuName(other, columns.ours);
		if (
			(nameA === undefined) !== (nameB === undefined) ||
			(nameA !== undefined &&
				!sameHeldTexts(
					appCodes(ctx),
					sourceCode(ctx),
					"case-list-sort-label",
					nameA,
					nameB,
				))
		)
			return "schema:SortElement.display";
		const index = reading.sort.kept[position] as number;
		const numeric = reading.sort.numeric.get(index);
		if (numeric !== undefined && other.type !== numeric)
			return "schema:SortElement.type";
		if (reading.sort.textual.has(index) && numericWord(other.type))
			return "schema:SortElement.type";
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

function caseListPlace(
	module: DraftModule,
	kind: "case-list" | "case-detail" = "case-list",
): HqPlace {
	return {
		kind,
		menu: module.index,
		name: module.place.kind === "menu" ? module.place.name : "",
	};
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
	for (const index of ctx.pending.of("module", mod.uuid)) {
		const ref = (registrations[index] as PendingExpression).ref;
		const { expression, level } = ctx.pending.outcome(index);
		if (expression === undefined || level === undefined) continue;
		const member =
			"member" in ref && "rowUuid" in ref.member
				? `${ref.member.columnUuid}/${ref.member.rowUuid}`
				: "member" in ref && "columnUuid" in ref.member
					? ref.member.columnUuid
					: "member" in ref && "sortUuid" in ref.member
						? ref.member.sortUuid
						: undefined;
		held.set(member === undefined ? ref.slot : `${ref.slot}/${member}`, {
			tree: expression,
			level,
		});
	}
	if (held.size === 0) return {};
	const at = (key: string, tree: Expression | undefined) => {
		const one = held.get(key);
		return one !== undefined && tree !== undefined && sameJson(tree, one.tree)
			? one.level
			: undefined;
	};
	return {
		mapping: (uuid, rowUuid) => {
			const column = mod.caseListConfig?.columns.find((c) => c.uuid === uuid);
			const when =
				column && (column.kind === "id-mapping" || column.kind === "image-map")
					? column.mapping.find((row) => row.uuid === rowUuid)?.when
					: undefined;
			return levelControl(
				at(`case_list_mapping_condition/${uuid}/${rowUuid}`, when),
			);
		},
		sort: (uuid) => {
			const rule = mod.caseListConfig?.calculatedSorts?.find(
				(one) => one.uuid === uuid,
			);
			return levelControl(
				at(`case_list_sort_expression/${uuid}`, rule?.expression),
			);
		},
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
	ownerRefused: DraftModule | undefined,
): string | undefined {
	const inputs = readProjectionInputs(ctx);
	const projected = projectCaseListForHq(
		mod,
		withReadTexts(doc, ctx.translations),
		inputs.assets,
		inputs.lookupNaming,
		undefined,
		heldListLevels(ctx, mod),
		undefined,
		(uuid) =>
			ctx.draft.modules.find((menu) => menu.uuid === uuid)?.uniqueId ??
			String(uuid),
	);
	const pair = printed(projected.caseDetails) as {
		short: JsonObject;
		long: JsonObject;
	};
	const codes = appCodes(ctx);
	const handed = handedOffListSlots(ctx, reading);
	// A column an inert row dropped is written by no build.
	const kept = (detail: unknown, dropped: ReadonlySet<number>) =>
		(Array.isArray(detail) ? detail : []).flatMap((column, index) =>
			isJsonObject(column) && !dropped.has(index) ? [{ column, index }] : [],
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
	).map(({ column, index }) => ({ column: asPrinted(column), index }));
	const longStored = kept(
		reading.long.peek("columns"),
		reading.dropped.long,
	).map(({ column, index }) => ({ column: asPrinted(column), index }));
	const storedTabs = objects(reading.long.peek("tabs"));
	const projectedTabs = objects(pair.long.tabs);
	if (storedTabs.length !== projectedTabs.length) return "schema:Detail.tabs";
	for (const [i, tab] of storedTabs.entries()) {
		const projected = projectedTabs[i];
		if (
			!projected ||
			!sameHeldTexts(
				codes,
				sourceCode(ctx),
				"case-detail-tab-title",
				tab.header,
				projected.header,
			)
		)
			return "schema:DetailTab.header";
		if (
			longStored[Number(projected.starting_index)]?.index !== tab.starting_index
		)
			return "schema:DetailTab.starting_index";
		if (Boolean(tab.has_nodeset) !== Boolean(projected.has_nodeset))
			return "schema:DetailTab.has_nodeset";
		if (tab.has_nodeset) {
			const custom = typeof tab.nodeset === "string" && tab.nodeset !== "";
			if (!custom && tab.nodeset_case_type !== projected.nodeset_case_type)
				return "schema:DetailTab.nodeset_case_type";
			const key = custom ? "nodeset" : "nodeset_filter";
			const original = tab[key],
				next = projected[key],
				owner = mod.caseListConfig?.detailTabs?.[i];
			if (
				(original || next) &&
				(!owner ||
					typeof original !== "string" ||
					typeof next !== "string" ||
					!sameSlotText(
						doc,
						{
							entity: "module",
							uuid: mod.uuid,
							slot: custom ? "case_detail_tab_rows" : "case_detail_tab_filter",
							member: { tabUuid: owner.uuid },
						},
						original,
						next,
					))
			)
				return `schema:DetailTab.${key}`;
		}
		const stored = typeof tab.relevant === "string" ? tab.relevant : "";
		const printed =
			typeof projected.relevant === "string" ? projected.relevant : "";
		if ((stored || printed) && !sameXPathText(stored, printed))
			return "schema:DetailTab.relevant";
	}
	const shortOurs = objects(pair.short.columns);
	const longOurs = objects(pair.long.columns);
	const tile = mod.caseListConfig?.tile !== undefined;
	if (longStored.length !== longOurs.length) return "schema:Detail.columns";
	for (const [position, { column, index }] of longStored.entries()) {
		const key = columnDifference(
			codes,
			sourceCode(ctx),
			column,
			longOurs[position] as JsonObject,
			mod.caseListConfig?.detailTile !== undefined,
			"long",
			handed.long.has(index),
			mod.caseListConfig?.optimizations === true,
		);
		if (key !== undefined) return key;
	}
	// The short detail: the stored columns, then the hidden columns a sort element added.
	const carriers = reading.joined.columns.filter(
		(column) => column.carrier === true || column.sortField === true,
	).length;
	const written = tile ? shortStored.length : shortStored.length + carriers;
	if (
		shortOurs.length !== written &&
		!(shortStored.length === 0 && shortOurs.length <= 1)
	)
		return "schema:Detail.columns";
	for (const [position, { column, index }] of shortStored.entries()) {
		const key = columnDifference(
			codes,
			sourceCode(ctx),
			column,
			shortOurs[position] as JsonObject,
			tile && !mod.caseListConfig?.tile?.namedSlots,
			"short",
			handed.short.has(index),
			mod.caseListConfig?.optimizations === true,
		);
		if (key !== undefined) return key;
	}
	if (mod.caseListConfig?.tile?.namedSlots) {
		for (const [i, stored] of shortStored.entries()) {
			const slot = shortOurs[i]?.case_tile_field;
			if (slot && slot !== stored.column.case_tile_field)
				return "schema:DetailColumn.case_tile_field";
		}
	}
	const sortKey = sortDifference(
		ctx,
		reading,
		objects(reading.short.peek("sort_elements")),
		objects(pair.short.sort_elements),
		{ stored: reading.short.peek("columns"), ours: pair.short.columns },
		handed.short,
		handed.sorts,
	);
	if (sortKey !== undefined) return sortKey;
	// The owner clause of an exclusion the reading refused is that refusal's: Nova's print writes
	// no clause for it, so the rest of the stored filter is what the list compares.
	const filterAsStored = reading.short.peek("filter");
	const storedFilter =
		ownerRefused !== undefined && typeof filterAsStored === "string"
			? listFilterWithoutOwnerClause(ownerRefused, filterAsStored)
			: filterAsStored;
	const ourFilter = pair.short.filter;
	const blank = (value: unknown) =>
		value === null || value === undefined || value === "";
	// A filter whose expression was handed to project data prints no tree of the source's, so the
	// filter is project data's finding, never the list's.
	if (!handed.filter) {
		if (blank(storedFilter) !== blank(ourFilter)) return "schema:Detail.filter";
		if (
			!blank(storedFilter) &&
			!sameXPathText(String(storedFilter), String(ourFilter))
		)
			return "schema:Detail.filter";
	}
	// `false` is the off switch HQ's Case List page writes on every save of a short detail, which
	// every reader tests by truth (`details.ts`, `detail-persistence-switches-false`).
	const off = (value: unknown) => blank(value) || value === false;
	if (
		!sameJson(
			reading.long.peek("case_tile_template") || null,
			pair.long.case_tile_template || null,
		)
	)
		return "schema:Detail.case_tile_template";
	for (const key of [
		"case_tile_template",
		"persist_tile_on_forms",
		"persistent_case_tile_from_module",
		"pull_down_tile",
	] as const) {
		const stored = reading.short.peek(key);
		// A source menu with no tile is a setting no build reads, dropped as inert.
		const a =
			key === "persistent_case_tile_from_module" &&
			dormantFormContextSource(ctx, stored)
				? null
				: stored;
		const b = pair.short[key];
		if ((a ?? null) !== (b ?? null) && !(off(a) && off(b)))
			return `schema:Detail.${key}`;
	}
	if (caseContextLine(mod.caseListConfig?.contextAboveForm)) {
		if (pair.short.persist_case_context !== true)
			return "schema:Detail.persist_case_context";
		const source =
			reading.short.peek("persistent_case_context_xml") ?? "case_name";
		if (
			typeof source !== "string" ||
			typeof pair.short.persistent_case_context_xml !== "string" ||
			!sameXPathText(source, pair.short.persistent_case_context_xml)
		)
			return "schema:Detail.persistent_case_context_xml";
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

/** The case type and property a property field reads: the menu's own, or, for a field of
 *  indices and a property, the type the walk of a column of the menu over that field reaches. */
function fieldOwnerRead(
	doc: BlueprintDoc,
	caseType: string,
	field: string,
): [string, string] | undefined {
	if (!field.includes("/")) return [caseType, field];
	for (const mod of Object.values(doc.modules))
		for (const column of mod.caseListConfig?.columns ?? []) {
			if (column.kind === "calculated" || mod.caseType !== caseType) continue;
			if (columnFieldText(column) !== field) continue;
			const owner = columnPropertyCaseType(
				column,
				caseType,
				doc.caseTypes ?? [],
			);
			return owner === undefined ? undefined : [owner, column.field];
		}
	return undefined;
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
		} else read = fieldOwnerRead(doc, caseType, renamedField(field));
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
 * After the binding: each menu's case list accepted where the projection writes its stored details
 * back. A difference no row names is `unrecognized` at the list, under its surface key. The
 * declarations made before binding are taken back first, so each is made again only where the
 * bound document's writers, a Hidden Value's among them, still give the property no type.
 */
export function settleCaseLists(ctx: ReadContext, app: DraftApp): void {
	// A calculated column shown on both screens is registered from one detail; the other
	// detail's `field` holds the same tree (the join's equality), so the expression stage's
	// claim of the registration holds it too, handed off as the registration's is (a table the
	// catalog lacks is project data's one finding).
	for (const reading of caseListReadings(ctx).values())
		for (const twin of reading.twins) {
			if (ctx.pending.list()[twin.registration]?.readerClaimed === true)
				continue;
			const claim = ctx.pending.outcome(twin.registration).claim;
			if (claim !== undefined)
				applyExpressionClaim(ctx, { ...claim, place: twin.place }, twin.site);
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
		const inputs = readProjectionInputs(ctx);
		ctx.doc = retainSortComparisons(
			ctx.doc,
			module.uuid,
			reading.sort,
			inputs.assets !== undefined,
			inputs.lookupNaming,
		);
		ctx.doc = withoutImplicitRule(ctx, ctx.doc, reading);
		const doc = ctx.doc;
		const mod = doc.modules[module.uuid];
		if (mod === undefined) continue;
		const place = caseListPlace(module);
		let difference: string | undefined;
		try {
			difference = listDifference(
				ctx,
				doc,
				mod,
				reading,
				ownerExclusionRefused(ctx, module.uuid) ? module : undefined,
			);
		} catch (error) {
			rethrowWorkStop(error);
			ctx.accounting.defect(
				place,
				"schema:Module.case_details",
				readerDefect.emissionThrew(place, "projectCaseListForHq"),
			);
			continue;
		}
		// A finding at the menu's list or case detail is the difference's cause: what it refused
		// the document does not hold, so the projection writes it back otherwise.
		if (
			difference !== undefined &&
			!ctx.accounting.hasFindingAt(place) &&
			!ctx.accounting.hasFindingAt(caseListPlace(module, "case-detail"))
		)
			ctx.accounting.circumstance("unrecognized", place, { name: difference });
	}
}

/**
 * Whether a menu's owner exclusion was registered and the expression stage held no tree for it:
 * the refusal is the exclusion's finding, and the list filter's owner clause, which Nova writes
 * only for an exclusion it holds, belongs to that refusal.
 */
function ownerExclusionRefused(ctx: ReadContext, moduleUuid: Uuid): boolean {
	const registrations = ctx.pending.list();
	return ctx.pending
		.of("module", moduleUuid)
		.some(
			(index) =>
				registrations[index]?.ref.slot === "excluded_owner_ids" &&
				ctx.pending.outcome(index).expression === undefined,
		);
}

/**
 * The slots of a menu's details whose expression the expression stage handed to project data (a
 * read of a table the catalog lacks): each calculated column's, by its index in each stored
 * detail, a column on both screens at both, and the list filter's. That read is project data's
 * one finding, at the table, and the list holds no tree for the slot, so the slot's own print is
 * no difference of the list's; every other part of the list is compared as it stands.
 */
function handedOffListSlots(
	ctx: ReadContext,
	reading: CaseListReading,
): {
	readonly short: ReadonlySet<number>;
	readonly long: ReadonlySet<number>;
	readonly sorts: ReadonlySet<Uuid>;
	readonly filter: boolean;
} {
	const columns = new Set<Uuid>();
	const sorts = new Set<Uuid>();
	let filter = false;
	const registrations = ctx.pending.list();
	for (const index of ctx.pending.of("module", reading.module.uuid)) {
		const ref = (registrations[index] as PendingExpression).ref;
		if (ref.entity !== "module" || !handedOff(ctx.pending.outcome(index)))
			continue;
		if (ref.slot === "case_list_filter") filter = true;
		else if (ref.slot === "case_list_sort_expression")
			sorts.add(ref.member.sortUuid);
		else if (
			ref.slot === "case_list_column_expression" ||
			ref.slot === "case_list_mapping_condition"
		)
			columns.add(ref.member.columnUuid);
	}
	const short = new Set<number>();
	const long = new Set<number>();
	reading.joined.columns.forEach((column, index) => {
		const uuid = reading.uuids[index];
		if (uuid === undefined || !columns.has(uuid)) return;
		if (column.short !== undefined) short.add(column.short);
		if (column.long !== undefined) long.add(column.long);
	});
	return { short, long, sorts, filter };
}
