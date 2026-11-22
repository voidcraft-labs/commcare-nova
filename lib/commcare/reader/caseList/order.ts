/**
 * A short detail's `sort_elements` read back into the order rules of its
 * columns: the inverse of `lib/domain/caseListOrder.ts::caseListOrderPlan`,
 * rule by rule. An element no column joins becomes a hidden column, last;
 * in a tile list one that names a column only the detail shows puts that
 * column back on the list, hidden. The rules are accepted when the plan of
 * the read columns writes the stored elements (`caseList/index.ts`).
 */
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import {
	caseListOrderPlan,
	choicePrefixLength,
} from "@/lib/domain/caseListOrder";
import type { CasePropertyDataType } from "@/lib/domain/casePropertyTypes";
import { columnPropertyCaseType } from "@/lib/domain/columnRelation";
import { effectiveCaseTypes } from "@/lib/domain/effectiveCaseTypes";
import { makeTranslationUnitId } from "@/lib/domain/localization";
import {
	type CalculatedSort,
	columnFieldText,
	columnSort,
	defaultSortBlanks,
	type SortComparison,
	type SortDirection,
	sortBlanks,
} from "@/lib/domain/modules";
import { NO_ENTRIES, recordFromEntries } from "@/lib/domain/records";
import { isStandardCaseListProperty } from "@/lib/domain/standardCaseProperties";
import type { LookupWireNaming } from "../../lookup/naming";
import { caseListOrderOptions } from "../../suite/case-list/orderPlanOptions";
import { rethrowWorkStop } from "../../workMeter";
import { withCandidate } from "../candidate";
import {
	type Claim,
	defineClaims,
	derived,
	drop,
	refuse,
	take,
} from "../claims";
import type { DraftModule, ReadContext } from "../context";
import { pythonBlank } from "../heldText";
import { externalKey } from "../identity";
import { isJsonObject, type JsonCursor } from "../jsonCursor";
import { pendingPlaceholder } from "../pendingExpressions";
import { recordSyntaxKey, sameXPathText } from "../syntaxCompare";
import {
	appCodes,
	type ColumnOptions,
	classifyField,
	heldTextsIn,
	noteRespelled,
	readRelationField,
	refuseUnheldKey,
	renamedField,
	shownTexts,
	sourceCode,
	sourceText,
	translatedTexts,
} from "./columns";
import {
	displayNames,
	type JoinedColumn,
	type JoinedDetails,
	sameState,
} from "./details";

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
	/** A field naming a displayed `translatable-enum` column. */
	fieldTranslatableEnum: take(
		`${A}sort-on-a-translatable-enum-column-nova-s-label-projection-of-a`,
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
	typeDistance: take(`${A}type-distance`, "schema:SortElement.type"),
	typeIndex: refuse(
		`${A}type-index-cache-and-index-order-2`,
		"schema:SortElement.type",
	),
	typeNumeric: take(
		`${A}type-int-or-double-differing-from-the-derived-type-on-a-column`,
		"schema:SortElement.type",
	),
	typeText: take(
		`${A}type-plain-date-or-string-or-none-where-nova-derives-int-or-double`,
		"schema:SortElement.type",
	),
	display: derived(`${A}display`, "schema:SortElement.display"),
	displayJoined: drop(
		`${A}display-lang-on-a-sort-joined-to-a-displayed-column`,
		"schema:SortElement.display",
	),
	displaySortOnly: take(
		`${A}display-lang-sort-by-label-on-a-sort-only-element`,
		"schema:SortElement.display",
	),
	displayInvisible: take(
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
	calculationAuthored: take(
		`${A}sort-calculation-authored-calculation-row-field`,
		"schema:SortElement.sort_calculation",
	),
	calculationRowField: take(
		`${A}sort-calculation-authored-calculation-row-field`,
		"schema:SortElement.field",
	),
	translatedDistance: refuse(
		`${A}distance-on-a-translated-calculated-field`,
		"schema:SortElement.type",
	),
	calculationDistanceWithoutProperty: refuse(
		`${A}distance-sort-without-a-location-field`,
		"schema:SortElement.type",
	),
	calculationOther: refuse(
		`${A}field-and-a-differing-sort-calculation-on-any-other-column`,
		"schema:SortElement.sort_calculation",
	),
});

const O = ORDER_CLAIMS;

/** Whether every value of a sort element's stored display is a text, as HQ's build reads each
 *  (`SortElement.has_display_values` strips every one); an absent display is HQ's default. */
function displayHoldsText(display: unknown): boolean {
	return (
		!isJsonObject(display) ||
		Object.values(display).every((text) => typeof text === "string")
	);
}

/** HQ's name for a calculated short column's join text (`util.py::get_sort_and_sort_only_columns`). */
export const CALCULATED_FIELD = /^_cc_calculated_(\d+)$/;

/** What the comparison of the order takes from its reading. */
export interface SortReading {
	readonly ok: boolean;
	/** Each kept element's index in the stored list, in the order HQ keeps them. */
	readonly kept: readonly number[];
	readonly sources: readonly JsonCursor[];
	readonly calculations: readonly CalculatedSort[];
	/** Each kept element's stored `type` where it is `int` or `double`, by element index, on a
	 *  column whose format has no sort of its own. */
	readonly numeric: ReadonlyMap<number, string>;
	/** The index of each kept element whose stored `type` compares as text (every word but `int`,
	 *  `double`, `distance` and `index`, or none) on a column whose format has no sort of its own. */
	readonly textual: ReadonlySet<number>;
	/** The index of each kept element whose stored `type` is `date`. */
	readonly dates: ReadonlySet<number>;
	/** The stored `type` of each kept `int` or `double` element, by the index in the join of the
	 *  column it lands on. */
	readonly numericColumns: ReadonlyMap<number, "int" | "double">;
	/** Whether the source held no element and an `invisible` first column took HQ's default. */
	readonly defaulted: boolean;
}

/** The text a short column joins a sort element by: its stored `field`, or `_cc_calculated_<n>`
 *  for an expression column (`util.py::get_sort_and_sort_only_columns`). */
function joinText(column: JsonCursor | undefined): string | undefined {
	const field = column?.peek("field");
	return typeof field === "string" ? field : undefined;
}

/**
 * The key an expression column orders by under a rule, as `caseListOrder.ts::caseListOrderPlan`
 * keys it (`ruledKeyOf`), spelled so that two columns with one join text have one class exactly
 * where `caseListSortKeysMatch` matches their keys: a calculated column by its value, a shown
 * link by its text, a shown interval by the text it shows, a shown ID mapping or image map by
 * its property and its entries' values in order (an image map shows its images under the media
 * manifest the ownership rule's plan assumes, `sortPropertyOwnership.ts`), a shown plain column
 * Nova prints as its choices' labels by the labels, and every other column by the property's raw
 * value. The join text is one already, so a calculated or link class needs nothing more.
 */
function orderKeyClass(column: JoinedColumn | undefined): string | undefined {
	if (column === undefined) return undefined;
	const body = column.proposal.column;
	const shown = column.visibleInList !== false;
	if (body.kind === "calculated") return "calculated";
	// A property read through a relation is its walk and its property, as HQ stores the field.
	const field = columnFieldText(body);
	if (!shown) return `property ${field}`;
	switch (body.kind) {
		case "link":
			return "link-text";
		case "interval":
			return `interval-text ${JSON.stringify(body.text)}`;
		case "id-mapping":
		case "image-map":
			return `mapping-position ${JSON.stringify([
				field,
				body.mapping.map((entry) => entry.value),
			])}`;
		case "plain":
			return column.proposal.choices !== undefined
				? `option-label ${field}`
				: `property ${field}`;
		default:
			return `property ${field}`;
	}
}

/** Whether a rule on one of two columns with one join text orders by the other's key, so the
 *  ownership rule admits it on the column it is not landing on. */
function sameOrderKey(own: number, landing: number, joined: JoinedDetails) {
	if (own === landing) return true;
	const a = orderKeyClass(joined.columns[own]);
	return a !== undefined && a === orderKeyClass(joined.columns[landing]);
}

/** The formats whose column sorts by its own expression and type, whatever the sort element's
 *  `type` and `sort_calculation` (`detail_screen.py`: `SORT_XPATH_FUNCTION` on `Date`, `TimeAgo`
 *  and `Distance`, `sort_xpath_function` on `Enum` and its subclasses). */
const OWN_SORT_FORMATS: ReadonlySet<string> = new Set([
	"date",
	"time-ago",
	"distance",
	"enum",
	"conditional-enum",
	"enum-image",
	"translatable-enum",
	"clickable-icon",
]);

/** The claim that refuses a sort element's `field` where it is no property Nova reads, by the
 *  row of the column field HQ's build reads it as (`columns.ts::classifyField`), or none. */
function fieldClass(
	text: string,
	relation: Pick<ColumnOptions, "offersSearch" | "relationVia">,
): Claim<"refuse"> | undefined {
	// A field of indices and a property reads the property of the case the indices reach.
	const related = readRelationField(text, relation);
	if (related?.kind === "property") return undefined;
	const classified = related ?? classifyField(text);
	if (classified.kind === "property") return undefined;
	// The editor's own check refuses the field on a sort row as on a column.
	return classified.claim.entry === O.fieldInvalid.entry
		? O.fieldInvalid
		: classified.claim;
}

/** The sort element `type`s the Case List page offers that HQ's build writes as a text
 *  comparison (`FormattedDetailColumn.sort_node` maps `plain` and `date` to `string`), and HQ's
 *  default, none. */
function menuTextType(type: unknown): boolean {
	return (
		type === undefined ||
		type === null ||
		type === "" ||
		type === "plain" ||
		type === "date"
	);
}

/**
 * Reads `sort_elements` into each joined column's `sort`, adding a hidden column for an element
 * no column joins, and records the same-state rewrites it applies.
 */
export function readSortElements(
	ctx: ReadContext,
	module: DraftModule,
	short: JsonCursor,
	joined: JoinedDetails,
	shortColumns: readonly JsonCursor[],
	relation: Pick<ColumnOptions, "offersSearch" | "relationVia">,
): SortReading {
	const tileList = short.peek("case_tile_template") === "custom";
	const stored = short.peek("sort_elements");
	const elements = Array.isArray(stored) ? stored : [];
	const numeric = new Map<number, string>();
	const numericColumns = new Map<number, "int" | "double">();
	const textual = new Set<number>();
	const dates = new Set<number>();
	const calculations: CalculatedSort[] = [];
	const codes = appCodes(ctx);
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
			return {
				ok: true,
				kept: [],
				sources: [],
				calculations,
				numeric,
				textual,
				dates,
				numericColumns,
				defaulted: true,
			};
		}
		return {
			ok: true,
			kept: [],
			sources: [],
			calculations,
			numeric,
			textual,
			dates,
			numericColumns,
			defaulted: false,
		};
	}
	const cursors = short.list("sort_elements", "SortElement", O.elements);
	// HQ has separate last-value maps for named fields and calculation text.
	// Malformed empty rows have no join key and receive their own finding.
	const joinKey = (cursor: JsonCursor) => {
		const field = cursor.peek("field");
		if (typeof field !== "string") return undefined;
		if (field) return JSON.stringify(["field", field]);
		const value = cursor.peek("sort_calculation");
		return typeof value === "string" && value.trim()
			? JSON.stringify(["calculation", value])
			: undefined;
	};
	const firstOf = new Map<string, number>();
	const lastOf = new Map<string, number>();
	cursors.forEach((cursor, index) => {
		const key = joinKey(cursor);
		if (key !== undefined) {
			lastOf.set(key, index);
			if (!firstOf.has(key)) firstOf.set(key, index);
		}
	});
	let ok = true;
	const kept: number[] = [];
	// Assign equal expressions their ordinal in first-insertion order too.
	const calculationCounts = new Map<string, number>();
	const expressionKeys = new Map<string, { key: string; ordinal: number }>();
	for (const cursor of cursors) {
		const formula = cursor.peek("sort_calculation");
		if (
			cursor.peek("field") !== "" ||
			typeof formula !== "string" ||
			!formula.trim() ||
			expressionKeys.has(formula)
		)
			continue;
		const key = recordSyntaxKey(formula);
		const ordinal = calculationCounts.get(key) ?? 0;
		expressionKeys.set(formula, { key, ordinal });
		calculationCounts.set(key, ordinal + 1);
	}
	const firstCalculationPosition = new Map<Uuid, number>();
	const firstHiddenPropertyPosition = new Map<number, number>();
	const firstCarrierPosition = new Map<number, number>();
	cursors.forEach((cursor, index) => {
		const field = cursor.peek("field");
		const text = typeof field === "string" ? field : "";
		const key = joinKey(cursor);
		if (key !== undefined && lastOf.get(key) !== index) {
			cursor.drop("field", O.earlier);
			cursor.drop("type", O.earlierType);
			cursor.drop("direction", O.earlierDirection);
			cursor.drop("blanks", O.earlierBlanks);
			cursor.drop("display", O.earlierDisplay);
			cursor.drop("sort_calculation", O.earlierCalculation);
			// The settled projection identifies earlier rows needed to keep a worker choice in position.
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
		const comparison =
			cursor.peek("type") === "distance" ? "distance" : undefined;
		const sort = columnSort(direction, priority, blanks, undefined, comparison);
		// Whether HQ's build lists the element's field in Sort by: some display text is not blank
		// to Python (`SortElement.has_display_values`).
		const storedDisplay = cursor.peek("display");
		const named = displayNames(storedDisplay);

		// The column the element lands on; none where the element's `field` is refused.
		let target: number | undefined;
		let sortOnly = false;
		// The stored format of the short column HQ's build gives the element: the first column
		// with its join text, or the `invisible` column it appends for an element none joins
		// (`util.py::create_temp_sort_column`).
		let landingFormat: unknown = "invisible";
		const storedFormat = (index: number | undefined) => {
			const short =
				index === undefined ? undefined : joined.columns[index]?.short;
			return short === undefined
				? "invisible"
				: (shortColumns[short]?.peek("format") ?? "plain");
		};
		const calculation = cursor.peek("sort_calculation");
		const authoredCalculation =
			typeof calculation === "string" && calculation.trim() !== "";
		const calculated = CALCULATED_FIELD.exec(text);
		let independent: CalculatedSort | undefined;
		if (field === "" && authoredCalculation) {
			cursor.take("field", O.calculationRowField, String).value;
			const identity = expressionKeys.get(calculation);
			if (!identity)
				throw new Error(
					"Missing identity for an independent order calculation.",
				);
			const uuid = ctx.accounting.identity(
				ctx.identities.claim(
					externalKey.caseListSort(
						module.uniqueId,
						identity.key,
						identity.ordinal,
					),
					cursor.pointer,
				),
				cursor.place,
				"schema:SortElement.sort_calculation",
			);
			if (uuid === undefined) {
				ok = false;
			} else {
				const type = cursor.peek("type");
				independent = {
					uuid,
					expression: pendingPlaceholder("value"),
					direction,
					priority,
					...(sort.blanks !== undefined && { blanks: sort.blanks }),
					comparator:
						type === "int" ? "integer" : type === "double" ? "decimal" : "text",
				};
				calculations.push(independent);
				firstCalculationPosition.set(
					uuid,
					key === undefined ? index : (firstOf.get(key) ?? index),
				);
				ctx.pending.register(
					{
						ref: {
							entity: "module",
							uuid: module.uuid,
							slot: "case_list_sort_expression",
							member: { sortUuid: uuid },
						},
						text: calculation,
						mode: { target: "hq-json", interpolation: "none" },
						place: cursor.place,
						key: "schema:SortElement.sort_calculation",
					},
					{ json: cursor, key: "sort_calculation" },
				);
			}
		} else if (calculated !== null) {
			// HQ joins `_cc_calculated_<n>` to stored short column `n` where that column is an
			// expression column, whatever its format, and raises for any other `n`; it sorts the
			// first column whose `field` is that column's (`util.py::get_sort_and_sort_only_columns`).
			// Nova prints the position of the column a rule is authored on (`caseListOrder.ts`,
			// rule 4), so the rule is read on column `n` itself wherever its key there is the key
			// of the column it lands on, which is where `sortPropertyOwnership.ts` admits it there
			// (`sameOrderKey` compares the keys as that rule does). Where they differ, which no
			// document Nova admits holds, it is read on the column it lands on, whose own position
			// the first publish writes (`caseList/index.ts`).
			const named = Number(calculated[1]);
			const stored = shortColumns[named];
			const expression =
				stored?.peek("useXpathExpression") === true
					? joinText(stored)
					: undefined;
			const own =
				expression === undefined
					? -1
					: joined.columns.findIndex((column) => column.short === named);
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
			if (own === -1 || landing === undefined) {
				cursor.refuse("field", O.fieldCalculatedMissing);
				ok = false;
			} else {
				target = sameOrderKey(own, landing, joined) ? own : landing;
				landingFormat = storedFormat(landing);
				// A rule on a `translatable-enum` column (Nova's label projection of a select
				// property, or its interval) sorts by the label the column shows, as Nova's own
				// print of such a rule does.
				cursor.take(
					"field",
					landingFormat === "translatable-enum"
						? O.fieldTranslatableEnum
						: O.fieldCalculated,
					String,
				).value;
			}
		} else if (fieldClass(text, relation) !== undefined) {
			// HQ's build reads the field as it reads a column's (the column it joins, or the one
			// it appends), so a field that is no property Nova reads is refused by the column
			// field's own row: a relation path, a worker's property, the owner's name, a prefix.
			cursor.refuse(
				"field",
				fieldClass(text, relation) ?? O.fieldInvalid,
				text === "" ? undefined : { name: text },
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
							const property = renamedField(text);
							return (
								column?.short !== undefined &&
								column.visibleInList !== false &&
								body?.kind === "link" &&
								columnFieldText(body) === property &&
								body.field !== "case_id"
							);
						});
			if (linked !== undefined)
				firstCarrierPosition.set(
					linked,
					key === undefined ? index : (firstOf.get(key) ?? index),
				);
			if (shortIndex !== undefined || linked !== undefined) {
				target = shortIndex ?? linked;
				if (shortIndex !== undefined) landingFormat = storedFormat(shortIndex);
				cursor.take(
					"field",
					shortIndex !== undefined &&
						storedFormat(shortIndex) === "translatable-enum"
						? O.fieldTranslatableEnum
						: O.fieldDisplayed,
					String,
				).value;
			} else {
				sortOnly = true;
				cursor.take("field", O.fieldHidden, String).value;
				// HQ's build reads five words as other properties (`detail_screen.py::CASE_PROPERTY_MAP`),
				// which Nova names by its own names.
				const related = readRelationField(text, relation);
				const read =
					related?.kind === "property"
						? { field: related.name, via: related.via }
						: { field: renamedField(text) };
				const property = renamedField(text);
				sameState(
					ctx,
					O.fieldHidden.entry,
					`${cursor.pointer}/field`,
					"sort-rule-kept-as-hidden-column",
				);
				// A sort-only element HQ's build lists in Sort by shows its field there under its display
				// and nowhere else, which Nova writes from the rule's name, so its rule is read on the
				// column only Details shows over that property where there is one, as a tile list's is.
				const detailOnly =
					tileList || named
						? joined.columns.findIndex(
								(column) =>
									column.notOnList === true &&
									column.proposal.column.kind !== "calculated" &&
									columnFieldText(column.proposal.column) === property,
							)
						: -1;
				if (detailOnly !== -1) {
					target = detailOnly;
					const column = joined.columns[detailOnly];
					if (column !== undefined) {
						delete column.notOnList;
						if (!tileList) {
							// Now a field of the list, it stands among the list's fields, ahead of the
							// columns only Details shows, as the reader returns a list
							// (`details.ts::columnsOffAScreenLast`).
							column.sortField = true;
							joined.listOrder.splice(joined.listOrder.indexOf(detailOnly), 1);
							const offList = joined.listOrder.findIndex(
								(index) => joined.columns[index]?.notOnList === true,
							);
							joined.listOrder.splice(
								offList < 0 ? joined.listOrder.length : offList,
								0,
								detailOnly,
							);
						}
					}
				} else {
					target = joined.columns.length;
					joined.columns.push({
						proposal: {
							column: { kind: "plain", ...read, header: "" },
							header: NO_ENTRIES,
							texts: NO_ENTRIES,
							invisible: false,
							json: cursor,
						},
						// A column hidden from both screens whose rule names it in Sort by holds that name
						// as its header too (`sortNamedHiddenColumnHeader`), set where the name is read.
						visibleInList: false,
						visibleInDetail: false,
						carrier: true,
					});
					// Among the list's fields, ahead of the columns only Details shows, as the
					// reader returns a list (`details.ts::columnsOffAScreenLast`).
					const offList = joined.listOrder.findIndex(
						(index) => joined.columns[index]?.notOnList === true,
					);
					joined.listOrder.splice(
						offList < 0 ? joined.listOrder.length : offList,
						0,
						target,
					);
					joined.detailOrder.push(target);
				}
			}
		}
		if (sortOnly && target !== undefined) {
			const positions = tileList
				? firstCarrierPosition
				: firstHiddenPropertyPosition;
			positions.set(
				target,
				key === undefined ? index : (firstOf.get(key) ?? index),
			);
		}
		// Every other key of the element is claimed whether or not it lands on a column.
		const column = target === undefined ? undefined : joined.columns[target];
		if (column !== undefined) column.sort = sort;
		// A hidden column's rule that HQ's build lists in Sort by keeps the name it shows there: the
		// display of a sort-only element, whose appended column HQ makes with that header
		// (`util.py::create_temp_sort_column`), and the header of an `invisible` column the element
		// lands on, which HQ's build writes under the column's own locale id
		// (`detail_screen.py::Invisible.header`).
		const nameIn = (shown: Readonly<Record<string, string>>) => {
			if (column === undefined && independent === undefined) return;
			const text = sourceText(ctx, shown);
			if (pythonBlank(text)) return false;
			// A name is never blank in a language: HQ's build fills a blank one from another
			// language's (`clean_trans`), and the name's translation takes the source's there.
			const texts = recordFromEntries(
				Object.entries(shown).map(([code, one]) => [
					code,
					pythonBlank(one) ? text : one,
				]),
			);
			if (independent !== undefined) {
				independent.label = text;
				ctx.translations.set(
					makeTranslationUnitId("case-sort", independent.uuid, "label"),
					"text",
					translatedTexts(ctx, texts),
				);
				return true;
			}
			if (column === undefined) return;
			column.sort = columnSort(direction, priority, blanks, text, comparison);
			column.sortName = texts;
			if (column.carrier === true && column.visibleInDetail === false) {
				column.proposal = {
					...column.proposal,
					column: { ...column.proposal.column, header: text },
					header: texts,
				};
			}
			return true;
		};

		// The comparator: derived, numeric where the plan derives it, or a date where the property
		// is of the date class (each judged in the settle; `dateSortDeclarations` names the
		// property a date element types where nothing else types it). A column whose format sorts
		// by its own type reads none of it, so the settle judges the type only where it does not.
		const type = cursor.peek("type");
		const ownSort =
			typeof landingFormat === "string" && OWN_SORT_FORMATS.has(landingFormat);
		if (type === "distance" && independent !== undefined) {
			// FormattedDetailColumn replaces the calculation with Distance's
			// template over the temporary column's empty property.
			cursor.refuse("type", O.calculationDistanceWithoutProperty);
			ok = false;
		} else if (
			type === "distance" &&
			landingFormat === "translatable-enum" &&
			target !== undefined &&
			shortColumns[joined.columns[target]?.short ?? -1]?.peek(
				"useXpathExpression",
			) === true
		) {
			cursor.refuse("type", O.translatedDistance);
			ok = false;
		} else if (type === "distance") {
			cursor.take("type", O.typeDistance, String).value;
		} else if (type === "index") {
			cursor.refuse("type", O.typeIndex);
			ok = false;
		} else if (type === "int" || type === "double") {
			cursor.derived("type", O.typeDerived);
			if (!ownSort) {
				numeric.set(index, type);
				if (target !== undefined) numericColumns.set(target, type);
			} else
				sameState(
					ctx,
					O.typeDerived.entry,
					`${cursor.pointer}/type`,
					"list-settings-respelled",
				);
		} else if (menuTextType(type)) {
			cursor.derived("type", O.typeDerived);
			if (type === "date") dates.add(index);
			if (!ownSort) textual.add(index);
		} else if (typeof type === "string") {
			// Any other word, `string` among them, HQ writes through as it is (`sort_node`:
			// `.get(type, type)`), and Core compares every word but `int` and `double` as text
			// (`DetailFieldParser`: `string` and any other word leave the field's `DATATYPE_TEXT`),
			// as it does `plain`, which the first publish writes: the stored word alone is new.
			cursor.derived("type", O.typeString);
			sameState(
				ctx,
				O.typeString.entry,
				`${cursor.pointer}/type`,
				"list-settings-respelled",
			);
			if (!ownSort) textual.add(index);
		}
		// A `type` that is no text at all is no `StringProperty` HQ holds: it is left for the
		// close to name.

		// The label as HQ's build shows it in each language (`create_temp_sort_column` makes it
		// the appended column's header); one the reader cannot know (a number, an object) is
		// left unclaimed, for the close to name at its key.
		// HQ's build writes it only where some stored value is not blank to Python
		// (`SortElement.has_display_values`: `s.strip() != ''`), which it asks of every value, so
		// a value that is no text (a null among them) leaves HQ no build, and is left unclaimed too.
		const display = shownTexts(storedDisplay, codes);
		if (display === undefined || !displayHoldsText(storedDisplay)) ok = false;
		else if (!named) cursor.derived("display", O.display);
		else if (sortOnly || column === undefined) {
			// The appended column's header is the display, an app string held as every app string is.
			const held = heldTextsIn(
				storedDisplay,
				codes,
				sourceCode(ctx),
				"case-list-sort-label",
			);
			if (held === undefined) {
				refuseUnheldKey(
					cursor,
					"display",
					codes,
					sourceCode(ctx),
					"case-list-sort-label",
				);
				ok = false;
			} else {
				cursor.take("display", O.displaySortOnly, () => held.texts).value;
				noteRespelled(
					ctx,
					O.displaySortOnly.entry,
					`${cursor.pointer}/display`,
					storedDisplay,
					held,
				);
				nameIn(held.texts);
			}
		} else if (column.proposal.invisible || column.visibleInList === false) {
			// The column's own header is the text Sort by shows, which the column's reading holds;
			// the display only switches it on. Where HQ's build lists the column under a header
			// blank in every language, it writes that header as a no-break space
			// (`commcare_translations.py::dumps`), which Android's Sort by lists as an entry that
			// shows blank (`EntitySelectActivity.getSortOptionsList`); Nova holds no name there, so
			// the first publish drops the entry. Where HQ's build lists none under this column's
			// header (`sortName` is unset), nothing a worker sees moves.
			cursor.take("display", O.displayInvisible, () => display).value;
			if (column.sortName === undefined)
				sameState(
					ctx,
					O.displayInvisible.entry,
					`${cursor.pointer}/display`,
					"list-settings-respelled",
				);
			else if (nameIn(column.sortName) !== true)
				sameState(
					ctx,
					O.displayInvisible.entry,
					`${cursor.pointer}/display`,
					"sort-by-entry-with-a-blank-name-dropped",
				);
		} else cursor.drop("display", O.displayJoined);

		if (authoredCalculation) {
			const own = column?.proposal.expression?.text;
			if (own !== undefined && sameXPathText(own, calculation)) {
				cursor.derived("sort_calculation", O.calculationEqual);
				sameState(
					ctx,
					O.calculationEqual.entry,
					`${cursor.pointer}/sort_calculation`,
					"list-settings-respelled",
				);
			} else if (field === "") {
				// The expression stage claims the actual text after binding its case, tables and session.
			} else if (ownSort) {
				// HQ's build reads the stored short column's format, not the joined proposal's: a
				// list column hidden from Results is `invisible`, which sorts by the calculation.
				cursor.derived("sort_calculation", O.calculationBesideOwnSort);
			} else {
				cursor.refuse("sort_calculation", O.calculationOther);
				ok = false;
			}
		}
	});
	// HQ appends unmatched property fields in first-insertion order. Their
	// final rules still decide the list's priorities and the names of choices.
	const hidden = [...firstHiddenPropertyPosition.entries()]
		.sort((a, b) => a[1] - b[1])
		.map(([column]) => column);
	const carriers = [...firstCarrierPosition.entries()].sort(
		(a, b) => a[1] - b[1],
	);
	const carrierPrefix = choicePrefixLength(
		carriers,
		([index]) => joined.columns[index]?.sort?.priority ?? 0,
	);
	carriers.slice(0, carrierPrefix).forEach(([index], menuPosition) => {
		const sort = joined.columns[index]?.sort;
		if (sort) sort.menuPosition = menuPosition;
	});
	let nextHidden = 0;
	for (const [position, column] of joined.listOrder.entries()) {
		if (firstHiddenPropertyPosition.has(column))
			joined.listOrder[position] = hidden[nextHidden++];
	}

	return {
		ok,
		kept,
		sources: cursors,
		calculations: calculations.sort(
			(a, b) =>
				(firstCalculationPosition.get(a.uuid) ?? 0) -
				(firstCalculationPosition.get(b.uuid) ?? 0),
		),
		numeric,
		textual,
		dates,
		numericColumns,
		defaulted: false,
	};
}

/** Keep a native comparison which the final writer types do not imply.
 * Both a hidden carrier and a displayed field can receive a rule. The
 * order plan identifies its landing, while priority identifies its author.
 * Format-owned comparisons were already settled when reading the column. */
export function retainSortComparisons(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	reading: SortReading,
	mediaOn: boolean,
	lookupNaming?: LookupWireNaming,
): BlueprintDoc {
	if (
		!reading.calculations.length &&
		!reading.defaulted &&
		reading.numeric.size === 0 &&
		reading.textual.size === 0
	)
		return doc;
	const mod = doc.modules[moduleUuid];
	const config = mod?.caseListConfig;
	if (!mod || !config) return doc;
	const properties =
		effectiveCaseTypes(doc).find((type) => type.name === mod.caseType)
			?.properties ?? [];
	const plan = caseListOrderPlan(
		config,
		properties,
		caseListOrderOptions(mod, doc, mediaOn, lookupNaming),
	);
	const byOrder = new Map(
		[...plan.fields, ...plan.carriers].flatMap((field) =>
			field.rule ? [[field.rule.order, field.comparator] as const] : [],
		),
	);
	const overrides = new Map<number, SortComparison>();
	for (const column of config.columns) {
		const rule = column.sort;
		if (!rule) continue;
		const index = reading.kept[rule.priority];
		const numeric =
			index === undefined ? undefined : reading.numeric.get(index);
		const comparison =
			numeric === "int"
				? "integer"
				: numeric === "double"
					? "decimal"
					: reading.defaulted ||
							(index !== undefined && reading.textual.has(index))
						? "text"
						: undefined;
		const derived = byOrder.get(
			plan.introductionOrders.length + rule.priority + 1,
		);
		if (
			comparison === undefined ||
			derived === undefined ||
			comparison === derived
		)
			continue;
		overrides.set(rule.priority, comparison);
		if (index !== undefined) {
			const source = reading.sources[index];
			const claim = comparison === "text" ? O.typeText : O.typeNumeric;
			if (source?.used("type")) source.takePart("type", "comparison", claim);
			else source?.takeDefault("type", claim);
		}
	}
	const derivedCalculations = new Set(
		plan.calculations
			.filter((one) => one.sort.comparator === one.defaultComparison)
			.map((one) => one.sort.uuid),
	);
	if (!overrides.size && !derivedCalculations.size) return doc;
	return withCandidate(doc, (draft) => {
		for (const rule of draft.modules[moduleUuid]?.caseListConfig
			?.calculatedSorts ?? [])
			if (derivedCalculations.has(rule.uuid)) delete rule.comparator;
		for (const column of draft.modules[moduleUuid]?.caseListConfig?.columns ??
			[]) {
			const comparison = column.sort && overrides.get(column.sort.priority);
			if (column.sort && comparison !== undefined)
				column.sort.comparator = comparison;
		}
	});
}

/** The property types whose raw value Nova's sort element names a `date` comparison
 *  (`hqJson/caseList.ts::sortElementType`). */
const DATE_CLASS: ReadonlySet<CasePropertyDataType | undefined> = new Set<
	CasePropertyDataType | undefined
>(["date", "datetime", "time"]);

/** The type a `date` sort element declares for a property nothing else types: the element is
 *  the one print of every type of the date class, so the reader returns the first of them. */
export const DATE_SORT_DECLARED_TYPE: CasePropertyDataType = "date";

/**
 * Each property of the menu's case type a stored `date` sort element orders by raw value and
 * nothing in `doc` types, with the type the element declares. The element is joined to its rule
 * through the order plan of the list as read: the plan's rule at the element's place keys by the
 * raw value of a property, which `hqJson/caseList.ts::sortElementType` writes as a `date`
 * comparison only where that property is of the date class, so the declaration is what makes the
 * projection write the stored element back.
 */
export function dateSortDeclarations(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	sort: SortReading,
	mediaOn: boolean,
	lookupNaming?: LookupWireNaming,
): {
	readonly caseType: string;
	readonly property: string;
	readonly dataType: CasePropertyDataType;
}[] {
	if (sort.dates.size === 0) return [];
	const mod = doc.modules[moduleUuid];
	const config = mod?.caseListConfig;
	const caseType = mod?.caseType;
	if (mod === undefined || config === undefined || caseType === undefined)
		return [];
	const properties =
		effectiveCaseTypes(doc).find((type) => type.name === caseType)
			?.properties ?? [];
	let plan: ReturnType<typeof caseListOrderPlan>;
	try {
		plan = caseListOrderPlan(
			config,
			properties,
			caseListOrderOptions(mod, doc, mediaOn, lookupNaming),
		);
	} catch (error) {
		rethrowWorkStop(error);
		return [];
	}
	// The written rules in their elements' order, with what each orders by.
	const written = [
		...plan.fields.flatMap((field) =>
			field.rule?.written === true && !field.rule.implicit
				? [{ order: field.rule.order, key: field.key }]
				: [],
		),
		...plan.carriers.flatMap((carrier) =>
			carrier.rule.written && !carrier.rule.implicit
				? [
						{
							order: carrier.rule.order,
							key: {
								kind: "property",
								property: carrier.field,
								...(carrier.via !== undefined && { via: carrier.via }),
							} as const,
						},
					]
				: [],
		),
	];
	const out: {
		caseType: string;
		property: string;
		dataType: CasePropertyDataType;
	}[] = [];
	sort.kept.forEach((index, position) => {
		if (!sort.dates.has(index)) return;
		const key = written.find(
			(one) => one.order === plan.introductionOrders.length + position + 1,
		)?.key;
		if (key?.kind !== "property" || isStandardCaseListProperty(key.property))
			return;
		// A key read through a relation orders by the property of the type its walk reaches.
		const owner =
			key.via === undefined
				? caseType
				: columnPropertyCaseType(
						{ via: key.via },
						caseType,
						doc.caseTypes ?? [],
					);
		if (owner === undefined) return;
		const property = (
			owner === caseType
				? properties
				: (effectiveCaseTypes(doc).find((type) => type.name === owner)
						?.properties ?? [])
		).find((one) => one.name === key.property);
		if (
			property === undefined ||
			property.data_type !== undefined ||
			out.some((one) => one.caseType === owner && one.property === key.property)
		)
			return;
		out.push({
			caseType: owner,
			property: key.property,
			dataType: DATE_SORT_DECLARED_TYPE,
		});
	});
	return out;
}

/**
 * The column whose rule is the one a list with no rule takes, where `mod`'s list holds one rule
 * and it is that one: an unsorted list whose first field is hidden from Results orders by its
 * first shown field, ascending with blanks first, and writes that element
 * (`caseListOrder.ts`, rule 7). A list whose one rule is that rule on that field writes the same
 * element, its `type` aside, which HQ's build reads one way for a text and a date comparison
 * alike (`detail_screen.py::FormattedDetailColumn.sort_node`); a whole-number or decimal
 * comparison is no such rule. `dated` says the rule's element names a date comparison, the
 * raw value of a property of the date class, where the implicit rule's names a text one.
 */
export function implicitRuleColumn(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	mediaOn: boolean,
): { readonly column: Uuid; readonly dated: boolean } | undefined {
	const mod = doc.modules[moduleUuid];
	const config = mod?.caseListConfig;
	if (mod === undefined || config === undefined) return undefined;
	const sorted = config.columns.filter((column) => column.sort !== undefined);
	const only = sorted[0];
	if (
		(config.calculatedSorts?.length ?? 0) > 0 ||
		sorted.length !== 1 ||
		only?.sort === undefined ||
		only.sort.direction !== "asc" ||
		sortBlanks(only.sort) !== defaultSortBlanks("asc")
	)
		return undefined;
	const properties =
		effectiveCaseTypes(doc).find((type) => type.name === mod.caseType)
			?.properties ?? [];
	const planOf = (list: typeof config) => {
		try {
			return caseListOrderPlan(
				list,
				properties,
				caseListOrderOptions(mod, doc, mediaOn),
			);
		} catch (error) {
			rethrowWorkStop(error);
			return undefined;
		}
	};
	const authored = planOf(config);
	const unsorted = planOf({
		...config,
		columns: config.columns.map((column) => {
			if (column.uuid !== only.uuid) return column;
			const { sort: _sort, ...rest } = column;
			return rest as typeof column;
		}),
	});
	const ruled = authored?.fields.find((field) => field.rule !== undefined);
	const implicit = unsorted?.fields.find(
		(field) => field.rule?.implicit === true && field.rule.written,
	);
	if (
		authored === undefined ||
		unsorted === undefined ||
		authored.carriers.length > 0 ||
		ruled?.column.uuid !== only.uuid ||
		ruled.comparator !== "text" ||
		implicit?.column.uuid !== only.uuid
	)
		return undefined;
	const key = ruled.key;
	const dated =
		key?.kind === "property" &&
		DATE_CLASS.has(
			properties.find((property) => property.name === key.property)?.data_type,
		);
	return { column: only.uuid, dated };
}

/**
 * The reader's canonical choice `implicit-order-rule-is-absent`: a list whose one rule is the rule
 * a list with no rule writes (`implicitRuleColumn`), and whose element names the text comparison
 * the implicit rule's names, prints what that list prints, and the reader returns the list with no
 * rule. A rule whose element names a date comparison prints another `type`, and stays. It reads
 * the rules where `order-rules-on-the-columns-they-land-on` puts them.
 */
export function implicitOrderRuleIsAbsent(doc: BlueprintDoc): BlueprintDoc {
	const drops = doc.moduleOrder.flatMap((moduleUuid) => {
		const rule = implicitRuleColumn(doc, moduleUuid, true);
		return rule === undefined || rule.dated
			? []
			: [{ moduleUuid, column: rule.column }];
	});
	if (drops.length === 0) return doc;
	return withCandidate(doc, (draft) => {
		for (const { moduleUuid, column } of drops) {
			const one = draft.modules[moduleUuid]?.caseListConfig?.columns.find(
				(candidate) => candidate.uuid === column,
			);
			if (one !== undefined) delete one.sort;
		}
	});
}

/**
 * The reader's canonical choice `order-rules-on-the-columns-they-land-on`. HQ joins an order
 * rule's element to the first field with its text (`caseListOrder.ts`, rule 5), and the reader
 * reads a property element there. A rule whose element is a property element that the validator
 * admits on another column (a later column over the same property, or a column hidden from
 * Results over the property a shown field orders by) orders by the same key
 * (`sortPropertyOwnership.ts`) and prints the element the landing field's own rule prints, so the
 * document returned holds each such rule on the column it lands on. A positional element,
 * `_cc_calculated_<n>`, names the position of the column its rule is authored on (rule 4), so
 * the two placements print two exports: the row leaves that rule where it is, and the reader
 * reads it on column `n` (`readSortElements`). In a tile list a column hidden from Results that
 * this leaves with no rule is read off the list (`unsorted-hidden-tile-columns-are-off-the-list`,
 * which follows this choice).
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
		} catch (error) {
			rethrowWorkStop(error);
			continue;
		}
		for (const rule of plan.authored) {
			if (typeof rule.landsOn !== "number") continue;
			// The landing field's rule is this rule: its element is this rule's element.
			const landing = plan.fields[rule.landsOn];
			const to = landing?.column;
			if (
				to !== undefined &&
				to.uuid !== rule.column &&
				landing?.rule?.element.kind === "property"
			)
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

/**
 * The reader's canonical choice `order-priorities-as-read`. The emitter writes a list's rules as
 * sort elements in priority order, ties by Results position (`caseListOrder.ts`, rule 4), and
 * writes no priority, so only the order of the priorities reaches an export, and the reader numbers
 * the rules it reads from 0 in the order of their elements. A list whose rules hold any other
 * numbers in that order prints what the list numbered from 0 prints, and the reader returns the
 * list numbered from 0, in priority order, ties by Results position, then by the order of the
 * columns.
 */
export function orderPrioritiesAsRead(doc: BlueprintDoc): BlueprintDoc {
	const renumbered = doc.moduleOrder.flatMap((moduleUuid) => {
		const config = doc.modules[moduleUuid]?.caseListConfig;
		if (config === undefined) return [];
		const listed = new Map(
			config.listColumnOrder.map((uuid, index) => [uuid, index]),
		);
		const columns = config.columns.flatMap((column, index) =>
			column.sort === undefined
				? []
				: [
						{
							uuid: column.uuid,
							priority: column.sort.priority,
							position: listed.get(column.uuid) ?? Number.POSITIVE_INFINITY,
							index,
						},
					],
		);
		const calculations = (config.calculatedSorts ?? []).map((sort, index) => ({
			uuid: sort.uuid,
			priority: sort.priority,
			position: Number.POSITIVE_INFINITY,
			index: config.columns.length + index,
		}));
		const sorted = [...columns, ...calculations].sort(
			(a, b) =>
				a.priority - b.priority || a.position - b.position || a.index - b.index,
		);
		const menuRanks = new Map<Uuid, number>();
		const mod = doc.modules[moduleUuid];
		if (
			mod &&
			config.columns.some((column) => column.sort?.menuPosition !== undefined)
		) {
			const properties =
				effectiveCaseTypes(doc).find((type) => type.name === mod.caseType)
					?.properties ?? [];
			const plan = caseListOrderPlan(
				config,
				properties,
				caseListOrderOptions(mod, doc, true),
			);
			const introductions = new Set(plan.introductionOrders);
			for (const carrier of plan.carriers) {
				if (introductions.has(carrier.rule.order))
					menuRanks.set(carrier.column, menuRanks.size);
			}
		}
		if (
			sorted.every((rule, rank) => rule.priority === rank) &&
			config.columns.every(
				(column) => column.sort?.menuPosition === menuRanks.get(column.uuid),
			)
		)
			return [];
		return [
			{
				moduleUuid,
				ranks: new Map(sorted.map((rule, rank) => [rule.uuid, rank])),
				menuRanks,
			},
		];
	});
	if (renumbered.length === 0) return doc;
	return withCandidate(doc, (draft) => {
		for (const { moduleUuid, ranks, menuRanks } of renumbered) {
			const config = draft.modules[moduleUuid]?.caseListConfig;
			if (config === undefined) continue;
			for (const column of config.columns) {
				const rank = ranks.get(column.uuid);
				if (rank !== undefined && column.sort !== undefined) {
					column.sort.priority = rank;
					const menuPosition = menuRanks.get(column.uuid);
					if (menuPosition === undefined) delete column.sort.menuPosition;
					else column.sort.menuPosition = menuPosition;
				}
			}
			for (const rule of config.calculatedSorts ?? []) {
				const rank = ranks.get(rule.uuid);
				if (rank !== undefined) rule.priority = rank;
			}
		}
	});
}
