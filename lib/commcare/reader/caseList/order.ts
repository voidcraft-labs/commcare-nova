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
import type { CasePropertyDataType } from "@/lib/domain/casePropertyTypes";
import { effectiveCaseTypes } from "@/lib/domain/effectiveCaseTypes";
import {
	columnSort,
	defaultSortBlanks,
	type SortDirection,
	sortBlanks,
} from "@/lib/domain/modules";
import { isStandardCaseListProperty } from "@/lib/domain/standardCaseProperties";
import { caseListOrderOptions } from "../../suite/case-list/orderPlanOptions";
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
import { isJsonObject, type JsonCursor } from "../jsonCursor";
import { sameXPathText } from "../syntaxCompare";
import {
	appCodes,
	classifyField,
	HQ_PROPERTY_RENAMES,
	shownTexts,
} from "./columns";
import { type JoinedColumn, type JoinedDetails, sameState } from "./details";

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
	typeText: refuse(
		`${A}type-plain-date-or-string-or-none-where-nova-derives-int-or-double`,
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
	/** Each kept element's stored `type` where it is `int` or `double`, by element index, on a
	 *  column whose format has no sort of its own. */
	readonly numeric: ReadonlyMap<number, string>;
	/** The index of each kept element whose stored `type` compares as text (every word but `int`,
	 *  `double`, `distance` and `index`, or none) on a column whose format has no sort of its own. */
	readonly textual: ReadonlySet<number>;
	/** The index of each kept element whose stored `type` is `date`. */
	readonly dates: ReadonlySet<number>;
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
	if (!shown) return `property ${body.field}`;
	switch (body.kind) {
		case "link":
			return "link-text";
		case "interval":
			return `interval-text ${JSON.stringify(body.text)}`;
		case "id-mapping":
		case "image-map":
			return `mapping-position ${JSON.stringify([
				body.field,
				body.mapping.map((entry) => entry.value),
			])}`;
		case "plain":
			return column.proposal.choices !== undefined
				? `option-label ${body.field}`
				: `property ${body.field}`;
		default:
			return `property ${body.field}`;
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
function fieldClass(text: string): Claim<"refuse"> | undefined {
	const classified = classifyField(text);
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
	_module: DraftModule,
	short: JsonCursor,
	joined: JoinedDetails,
	shortColumns: readonly JsonCursor[],
): SortReading {
	const tileList = short.peek("case_tile_template") === "custom";
	const stored = short.peek("sort_elements");
	const elements = Array.isArray(stored) ? stored : [];
	const numeric = new Map<number, string>();
	const textual = new Set<number>();
	const dates = new Set<number>();
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
			return { ok: true, kept: [], numeric, textual, dates, defaulted: true };
		}
		return { ok: true, kept: [], numeric, textual, dates, defaulted: false };
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
		const calculated = CALCULATED_FIELD.exec(text);
		if (calculated !== null) {
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
				cursor.take("field", O.fieldCalculated, String).value;
			}
		} else if (fieldClass(text) !== undefined) {
			// HQ's build reads the field as it reads a column's (the column it joins, or the one
			// it appends), so a field that is no property Nova reads is refused by the column
			// field's own row: a relation path, a worker's property, the owner's name, a prefix.
			cursor.refuse(
				"field",
				fieldClass(text) ?? O.fieldInvalid,
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
				if (shortIndex !== undefined) landingFormat = storedFormat(shortIndex);
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

		// The comparator: derived, numeric where the plan derives it, or a date where the property
		// is of the date class (each judged in the settle; `dateSortDeclarations` names the
		// property a date element types where nothing else types it). A column whose format sorts
		// by its own type reads none of it, so the settle judges the type only where it does not.
		const type = cursor.peek("type");
		const ownSort =
			typeof landingFormat === "string" && OWN_SORT_FORMATS.has(landingFormat);
		if (type === "distance") {
			cursor.refuse("type", O.typeDistance);
			ok = false;
		} else if (type === "index") {
			cursor.refuse("type", O.typeIndex);
			ok = false;
		} else if (type === "int" || type === "double") {
			cursor.derived("type", O.typeDerived);
			if (!ownSort) numeric.set(index, type);
			else
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
			// (`DetailFieldParser`: `string` and any other word leave the field's `DATATYPE_TEXT`).
			cursor.derived("type", O.typeString);
			sameState(
				ctx,
				O.typeString.entry,
				`${cursor.pointer}/type`,
				"sort-rule-kept-as-hidden-column",
			);
			if (!ownSort) textual.add(index);
		}
		// A `type` that is no text at all is no `StringProperty` HQ holds: it is left for the
		// close to name.

		// The label as HQ's build shows it in each language (`create_temp_sort_column` makes it
		// the appended column's header); one the reader cannot know (a number, an object) is
		// left unclaimed, for the close to name at its key.
		// HQ's build writes it only where some stored value is not blank to Python
		// (`SortElement.has_display_values`: `s.strip() != ''`).
		const storedDisplay = cursor.peek("display");
		const display = shownTexts(storedDisplay, codes);
		if (display === undefined) ok = false;
		else if (
			isJsonObject(storedDisplay) &&
			Object.values(storedDisplay).every(
				(one) => typeof one === "string" && pythonBlank(one),
			)
		)
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
	return { ok, kept, numeric, textual, dates, defaulted: false };
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
			caseListOrderOptions(mod, doc, mediaOn),
		);
	} catch {
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
							key: { kind: "property", property: carrier.property } as const,
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
		const key = written.find((one) => one.order === position + 1)?.key;
		if (key?.kind !== "property" || isStandardCaseListProperty(key.property))
			return;
		const property = properties.find((one) => one.name === key.property);
		if (
			property === undefined ||
			property.data_type !== undefined ||
			out.some((one) => one.property === key.property)
		)
			return;
		out.push({
			caseType,
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
		} catch {
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
		} catch {
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
		const sorted = config.columns
			.map((column, index) => ({ column, index }))
			.filter(({ column }) => column.sort !== undefined)
			.sort(
				(a, b) =>
					(a.column.sort?.priority ?? 0) - (b.column.sort?.priority ?? 0) ||
					(listed.get(a.column.uuid) ?? Number.POSITIVE_INFINITY) -
						(listed.get(b.column.uuid) ?? Number.POSITIVE_INFINITY) ||
					a.index - b.index,
			);
		if (sorted.every(({ column }, rank) => column.sort?.priority === rank))
			return [];
		return [
			{
				moduleUuid,
				ranks: new Map(sorted.map(({ column }, rank) => [column.uuid, rank])),
			},
		];
	});
	if (renumbered.length === 0) return doc;
	return withCandidate(doc, (draft) => {
		for (const { moduleUuid, ranks } of renumbered)
			for (const column of draft.modules[moduleUuid]?.caseListConfig?.columns ??
				[]) {
				const rank = ranks.get(column.uuid);
				if (rank !== undefined && column.sort !== undefined)
					column.sort.priority = rank;
			}
	});
}
