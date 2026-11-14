/**
 * A short detail's `sort_elements` read back into the order rules of its
 * columns: the inverse of `lib/domain/caseListOrder.ts::caseListOrderPlan`,
 * rule by rule. An element no column joins becomes a hidden column, last;
 * in a tile list one that names a column only the detail shows puts that
 * column back on the list, hidden. The rules are accepted when the plan of
 * the read columns writes the stored elements (`caseList/index.ts`).
 */
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { caseListOrderPlan } from "@/lib/domain/caseListOrder";
import { effectiveCaseTypes } from "@/lib/domain/effectiveCaseTypes";
import { columnSort, type SortDirection } from "@/lib/domain/modules";
import { caseListOrderOptions } from "../../suite/case-list/orderPlanOptions";
import { withCandidate } from "../candidate";
import { defineClaims, derived, drop, refuse, take } from "../claims";
import type { DraftModule, ReadContext } from "../context";
import type { JsonCursor } from "../jsonCursor";
import { sameXPathText } from "../syntaxCompare";
import { HQ_PROPERTY_RENAMES, languageMap } from "./columns";
import { type JoinedDetails, sameState } from "./details";

const A = "menus-and-case-lists/";

export const ORDER_CLAIMS = defineClaims("caseList.order", {
	elements: take(
		`${A}sort-order-across-elements`,
		"schema:Detail.sort_elements",
	),
	none: derived(`${A}no-sort-elements`, "schema:Detail.sort_elements"),
	fieldDisplayed: take(
		`${A}field-naming-a-displayed-column`,
		"schema:SortElement.field",
	),
	fieldHidden: take(
		`${A}field-naming-a-property-not-displayed-hq-appends-a-hidden-column`,
		"schema:SortElement.field",
	),
	fieldCalculated: take(
		`${A}field-cc-calculated-n`,
		"schema:SortElement.field",
	),
	fieldCalculatedMissing: refuse(
		`${A}field-cc-calculated-n-naming-a-missing-or-non-calculated-column`,
		"schema:SortElement.field",
	),
	fieldInvalid: refuse(
		`${A}field-failing-details-utils-js-isvalidpropertyname-non`,
		"schema:SortElement.field",
	),
	earlier: drop(
		`${A}sort-elements-sharing-a-join-text`,
		"schema:SortElement.field",
	),
	earlierType: drop(
		`${A}sort-elements-sharing-a-join-text`,
		"schema:SortElement.type",
	),
	earlierDirection: drop(
		`${A}sort-elements-sharing-a-join-text`,
		"schema:SortElement.direction",
	),
	earlierBlanks: drop(
		`${A}sort-elements-sharing-a-join-text`,
		"schema:SortElement.blanks",
	),
	earlierDisplay: drop(
		`${A}sort-elements-sharing-a-join-text`,
		"schema:SortElement.display",
	),
	earlierCalculation: drop(
		`${A}sort-elements-sharing-a-join-text`,
		"schema:SortElement.sort_calculation",
	),
	direction: take(`${A}direction`, "schema:SortElement.direction"),
	blanks: take(`${A}blanks-first-last`, "schema:SortElement.blanks"),
	blanksEmpty: derived(`${A}blanks`, "schema:SortElement.blanks"),
	typeDerived: derived(
		`${A}type-plain-date-int-double-equal-to-the-type-nova-derives`,
		"schema:SortElement.type",
	),
	typeString: derived(
		`${A}type-string-not-a-menu-value`,
		"schema:SortElement.type",
	),
	typeDistance: refuse(`${A}type-distance`, "schema:SortElement.type"),
	typeIndex: refuse(
		`${A}type-index-cache-and-index-order-2`,
		"schema:SortElement.type",
	),
	typeNumeric: refuse(
		`${A}type-int-or-double-differing-from-the-derived-type-on-a-column`,
		"schema:SortElement.type",
	),
	display: derived(`${A}display`, "schema:SortElement.display"),
	displayJoined: drop(
		`${A}display-lang-on-a-sort-joined-to-a-displayed-column`,
		"schema:SortElement.display",
	),
	displaySortOnly: refuse(
		`${A}display-lang-sort-by-label-on-a-sort-only-element`,
		"schema:SortElement.display",
	),
	displayInvisible: refuse(
		`${A}display-lang-on-a-sort-joined-to-an-invisible-column`,
		"schema:SortElement.display",
	),
	calculationEqual: derived(
		`${A}sort-calculation-equal-to-the-referenced-calculated-column`,
		"schema:SortElement.sort_calculation",
	),
	calculationBesideOwnSort: derived(
		`${A}field-and-a-differing-sort-calculation-on-a-column-whose-format`,
		"schema:SortElement.sort_calculation",
	),
	calculationAuthored: refuse(
		`${A}sort-calculation-authored-calculation-row-field`,
		"schema:SortElement.sort_calculation",
	),
	calculationOther: refuse(
		`${A}field-and-a-differing-sort-calculation-on-any-other-column`,
		"schema:SortElement.sort_calculation",
	),
});

const O = ORDER_CLAIMS;

/** HQ's name for a calculated short column's join text (`util.py::get_sort_and_sort_only_columns`). */
export const CALCULATED_FIELD = /^_cc_calculated_(\d+)$/;

/** What the comparison of the order takes from its reading. */
export interface SortReading {
	readonly ok: boolean;
	/** Each kept element's index in the stored list, in the order HQ keeps them. */
	readonly kept: readonly number[];
	/** Each kept element's stored `type` where it is `int` or `double`, by element index. */
	readonly numeric: ReadonlyMap<number, string>;
	/** Whether the source held no element and an `invisible` first column took HQ's default. */
	readonly defaulted: boolean;
}

/** The text a short column joins a sort element by: its stored `field`, or `_cc_calculated_<n>`
 *  for an expression column (`util.py::get_sort_and_sort_only_columns`). */
function joinText(column: JsonCursor | undefined): string | undefined {
	const field = column?.peek("field");
	return typeof field === "string" ? field : undefined;
}

const PROPERTY = /^[a-zA-Z][\w_-]*$/;

/**
 * Reads `sort_elements` into each joined column's `sort`, adding a hidden column for an element
 * no column joins, and records the same-state rewrites it applies.
 */
export function readSortElements(
	ctx: ReadContext,
	_module: DraftModule,
	short: JsonCursor,
	joined: JoinedDetails,
	shortColumns: readonly JsonCursor[],
): SortReading {
	const tileList = short.peek("case_tile_template") === "custom";
	const stored = short.peek("sort_elements");
	const elements = Array.isArray(stored) ? stored : [];
	const numeric = new Map<number, string>();
	if (elements.length === 0) {
		short.derived("sort_elements", O.none);
		const first = joined.columns.find((column) => column.short === 0);
		// A Search Only first column joins its detail partner and takes its proposal; it stands
		// on the list hidden.
		if (
			first !== undefined &&
			first.visibleInList === false &&
			first.notOnList !== true
		) {
			first.sort = columnSort("asc", 0);
			sameState(
				ctx,
				O.none.entry,
				`${short.pointer}/sort_elements`,
				"list-settings-respelled",
			);
			return { ok: true, kept: [], numeric, defaulted: true };
		}
		return { ok: true, kept: [], numeric, defaulted: false };
	}
	const cursors = short.list("sort_elements", "SortElement", O.elements);
	// A later element with one `field` replaces an earlier one.
	const lastOf = new Map<string, number>();
	cursors.forEach((cursor, index) => {
		const field = cursor.peek("field");
		if (typeof field === "string") lastOf.set(field, index);
	});
	let ok = true;
	const kept: number[] = [];
	cursors.forEach((cursor, index) => {
		const field = cursor.peek("field");
		const text = typeof field === "string" ? field : "";
		if (lastOf.get(text) !== index) {
			cursor.drop("field", O.earlier);
			cursor.drop("type", O.earlierType);
			cursor.drop("direction", O.earlierDirection);
			cursor.drop("blanks", O.earlierBlanks);
			cursor.drop("display", O.earlierDisplay);
			cursor.drop("sort_calculation", O.earlierCalculation);
			sameState(
				ctx,
				O.earlier.entry,
				cursor.pointer,
				"list-settings-respelled",
			);
			return;
		}
		const priority = kept.length;
		kept.push(index);
		const direction: SortDirection =
			cursor.peek("direction") === "descending" ? "desc" : "asc";
		cursor.take("direction", O.direction, String).value;
		const blanksValue = cursor.peek("blanks");
		let blanks: "first" | "last" | undefined;
		if (blanksValue === "first" || blanksValue === "last") {
			blanks = cursor.take("blanks", O.blanks, String).value as
				| "first"
				| "last";
		} else {
			cursor.derived("blanks", O.blanksEmpty);
			if (blanksValue === "")
				sameState(
					ctx,
					O.blanksEmpty.entry,
					`${cursor.pointer}/blanks`,
					"list-settings-respelled",
				);
		}
		const sort = columnSort(direction, priority, blanks);

		// The column the element lands on; none where the element's `field` is refused.
		let target: number | undefined;
		let sortOnly = false;
		const calculated = CALCULATED_FIELD.exec(text);
		if (calculated !== null) {
			// HQ joins `_cc_calculated_<n>` to stored short column `n` where that column is an
			// expression column, whatever its format, and sorts the first column whose `field` is
			// that column's (`util.py::get_sort_and_sort_only_columns`).
			const stored = shortColumns[Number(calculated[1])];
			const expression =
				stored?.peek("useXpathExpression") === true
					? joinText(stored)
					: undefined;
			const landing =
				expression === undefined
					? undefined
					: joined.listOrder.find((index) => {
							const column = joined.columns[index];
							return (
								column?.short !== undefined &&
								joinText(shortColumns[column.short]) === expression
							);
						});
			if (landing === undefined) {
				cursor.refuse("field", O.fieldCalculatedMissing);
				ok = false;
			} else {
				target = landing;
				cursor.take("field", O.fieldCalculated, String).value;
			}
		} else if (!PROPERTY.test(text)) {
			cursor.refuse(
				"field",
				O.fieldInvalid,
				text === "" ? undefined : { name: text.slice(0, 200) },
			);
			ok = false;
		} else {
			const shortIndex = joined.listOrder.find((index) => {
				const column = joined.columns[index];
				return (
					column?.short !== undefined &&
					joinText(shortColumns[column.short]) === text
				);
			});
			// A rule on a shown link over any property but `case_id` is an element over that
			// property (`caseListOrder.ts`, rule 4, exception i): HQ's build appends the field it
			// sorts by, and the link keeps the rule.
			const linked =
				shortIndex !== undefined
					? undefined
					: joined.listOrder.find((index) => {
							const column = joined.columns[index];
							const body = column?.proposal.column;
							const property = HQ_PROPERTY_RENAMES[text] ?? text;
							return (
								column?.short !== undefined &&
								column.visibleInList !== false &&
								body?.kind === "link" &&
								body.field === property &&
								property !== "case_id"
							);
						});
			if (shortIndex !== undefined || linked !== undefined) {
				target = shortIndex ?? linked;
				cursor.take("field", O.fieldDisplayed, String).value;
			} else {
				sortOnly = true;
				cursor.take("field", O.fieldHidden, String).value;
				// HQ's build reads five words as other properties (`detail_screen.py::CASE_PROPERTY_MAP`),
				// which Nova names by its own names.
				const property = HQ_PROPERTY_RENAMES[text] ?? text;
				sameState(
					ctx,
					O.fieldHidden.entry,
					`${cursor.pointer}/field`,
					"sort-rule-kept-as-hidden-column",
				);
				const detailOnly = tileList
					? joined.columns.findIndex(
							(column) =>
								column.notOnList === true &&
								"field" in column.proposal.column &&
								column.proposal.column.field === property,
						)
					: -1;
				if (detailOnly !== -1) {
					target = detailOnly;
					const column = joined.columns[detailOnly];
					if (column !== undefined) delete column.notOnList;
				} else {
					target = joined.columns.length;
					joined.columns.push({
						proposal: {
							column: { kind: "plain", field: property, header: "" },
							header: {},
							texts: {},
							invisible: false,
							json: cursor,
						},
						visibleInList: false,
						visibleInDetail: false,
						carrier: true,
					});
					joined.listOrder.push(target);
					joined.detailOrder.push(target);
				}
			}
		}
		// Every other key of the element is claimed whether or not it lands on a column.
		const column = target === undefined ? undefined : joined.columns[target];
		if (column !== undefined) column.sort = sort;

		// The comparator: derived, or numeric where the plan derives it (judged in the settle).
		const type = cursor.peek("type");
		if (type === "distance") {
			cursor.refuse("type", O.typeDistance);
			ok = false;
		} else if (type === "index") {
			cursor.refuse("type", O.typeIndex);
			ok = false;
		} else if (type === "string") {
			cursor.derived("type", O.typeString);
			sameState(
				ctx,
				O.typeString.entry,
				`${cursor.pointer}/type`,
				"sort-rule-kept-as-hidden-column",
			);
		} else if (type === "int" || type === "double") {
			cursor.derived("type", O.typeDerived);
			numeric.set(index, type);
		} else {
			cursor.derived("type", O.typeDerived);
			if (type === "date")
				sameState(
					ctx,
					O.typeDerived.entry,
					`${cursor.pointer}/type`,
					"sort-rule-kept-as-hidden-column",
				);
		}

		const display = languageMap(cursor.peek("display"));
		if (Object.values(display).every((one) => one.trim() === ""))
			cursor.derived("display", O.display);
		else if (sortOnly || column === undefined) {
			cursor.refuse("display", O.displaySortOnly);
			ok = false;
		} else if (column.proposal.invisible || column.visibleInList === false) {
			cursor.refuse("display", O.displayInvisible);
			ok = false;
		} else cursor.drop("display", O.displayJoined);

		const calculation = cursor.peek("sort_calculation");
		if (typeof calculation === "string" && calculation.trim() !== "") {
			const own = column?.proposal.expression?.text;
			if (own !== undefined && sameXPathText(own, calculation)) {
				cursor.derived("sort_calculation", O.calculationEqual);
				sameState(
					ctx,
					O.calculationEqual.entry,
					`${cursor.pointer}/sort_calculation`,
					"list-settings-respelled",
				);
			} else if (text === "") {
				cursor.refuse("sort_calculation", O.calculationAuthored);
				ok = false;
			} else if (column?.proposal.column.kind === "date") {
				cursor.derived("sort_calculation", O.calculationBesideOwnSort);
			} else {
				cursor.refuse("sort_calculation", O.calculationOther);
				ok = false;
			}
		}
	});
	return { ok, kept, numeric, defaulted: false };
}

/**
 * The reader's canonical choice `order-rules-on-the-columns-they-land-on`. HQ joins an order
 * rule's element to the first field with its text (`caseListOrder.ts`, rule 5), and the reader
 * reads the element there. A rule the validator admits on another column (a later column over
 * the same text, or a column hidden from Results over the property a shown field orders by)
 * orders by the same key (`sortPropertyOwnership.ts`) and prints the element the landing field's
 * own rule prints, so the document returned holds each rule on the column it lands on. In a tile
 * list a column hidden from Results that this leaves with no rule is read off the list
 * (`unsorted-hidden-tile-columns-are-off-the-list`, which follows this choice).
 */
export function rulesOnTheColumnsTheyLandOn(doc: BlueprintDoc): BlueprintDoc {
	const moves: { module: Uuid; from: Uuid; to: Uuid }[] = [];
	const types = effectiveCaseTypes(doc);
	for (const moduleUuid of doc.moduleOrder) {
		const mod = doc.modules[moduleUuid];
		const config = mod?.caseListConfig;
		if (
			mod === undefined ||
			config === undefined ||
			!config.columns.some((column) => column.sort !== undefined)
		)
			continue;
		const properties =
			types.find((type) => type.name === mod.caseType)?.properties ?? [];
		let plan: ReturnType<typeof caseListOrderPlan>;
		try {
			plan = caseListOrderPlan(
				config,
				properties,
				caseListOrderOptions(mod, doc, true),
			);
		} catch {
			continue;
		}
		for (const rule of plan.authored) {
			if (typeof rule.landsOn !== "number") continue;
			const to = plan.fields[rule.landsOn]?.column;
			if (to !== undefined && to.uuid !== rule.column)
				moves.push({ module: moduleUuid, from: rule.column, to: to.uuid });
		}
	}
	if (moves.length === 0) return doc;
	return withCandidate(doc, (draft) => {
		for (const move of moves) {
			const config = draft.modules[move.module]?.caseListConfig;
			const from = config?.columns.find((column) => column.uuid === move.from);
			const to = config?.columns.find((column) => column.uuid === move.to);
			if (config === undefined || from === undefined || to === undefined)
				continue;
			to.sort = from.sort;
			delete from.sort;
		}
	});
}
