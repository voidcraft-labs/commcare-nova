// lib/domain/caseListOrder.ts
//
// The one statement of a case list's fields and order: what CommCare HQ's
// build writes for the app Nova sends, derived from the document on every
// read and stored nowhere. Three readers read it and decide nothing of their
// own: the HQ JSON projection (`lib/commcare/hqJson/caseList.ts`), the local
// suite (`lib/commcare/suite/case-list/`), and Preview through the case store
// (`lib/preview/engine/caseListOrder.ts`). The validator's order rules read it
// too, so a refused document still has a plan.
//
// Each rule below states what HQ's build does with the short detail Nova
// sends. Citations are HQ's (`corehq/apps/app_manager`) and commcare-core's.
//
//   1. Fields. Every column of the Results sequence that is on the list is a
//      field of the short detail, a column hidden from Results included: HQ
//      stores it as an `invisible` column, a field at width 0
//      (`detail_screen.py::Invisible`, `HideShortColumn`). In a list with a
//      tile layout a column hidden from Results is no field: its order rule
//      rides as a sort row with no stored column (rule 4, exception iii), so
//      no Case List save can give it a cell. A column that is not on the list
//      (`notOnList`, `modules.ts::columnOnList`) is no field in either layout
//      and has no rule: the case's detail alone holds it, so no device
//      matches it when a worker filters the list.
//
//   2. Wire class and join text. A `property` field's HQ `field` is a
//      property name that `detail_screen.py::PropertyXpathGenerator.xpath`
//      turns into a path, a column read through a relation its indices and
//      property joined by `/` (`modules.ts::columnFieldText`), which that
//      generator walks index by index; an `expression` field's `field` is
//      used verbatim (`detail_screen.py::FormattedDetailColumn.xpath`). HQ
//      joins a sort element to a field by that text alone, so the field's HQ
//      `field` is its join text.
//
//   3. The key a field keeps with no rule. `detail_screen.py::
//      FormattedDetailColumn.sort_node` writes a `<sort>` with a type and no
//      order for every format with a sort expression of its own: `Date`
//      (the raw property), `Enum` and `EnumImage` (the mapping position,
//      `suite_xml/xml_models.py::XPathEnum.build`), `TranslatableEnum` (its own
//      expression, the shown text). `plain`, `phone`, `markdown` and
//      `invisible` have none.
//
//   4. Authored rules become sort elements, in priority order, ties by
//      Results position. A column that is not on the list gives no rule (its
//      `sort` is refused, `CASE_LIST_COLUMN_NOT_ON_LIST_INVALID`). A rule on a property field is a property element; a
//      rule on an expression field is the positional `_cc_calculated_<i>`
//      (`util.py::get_sort_and_sort_only_columns`, which raises for a
//      positional element on a column that is not an expression). Exceptions:
//      (i) a rule on a shown link over any property but `case_id` is a
//      property element over that property; (ii) a shown link over `case_id`
//      stays positional and keeps the `link-text` key, since `case_id` has no
//      sort row (`helpers/validators.py::ModuleDetailValidatorMixin.
//      _validate_detail_screen_field` refuses `@case_id`, and the bare
//      `case_id` reads a child element no case has); (iii) in a tile list a
//      rule on a column hidden from Results is a property element over its
//      property. A hidden calculated column and a hidden column over `case_id`
//      have no element there (`CASE_TILE_HIDDEN_CALCULATED_SORT` refuses them).
//
//   5. Join. Every element lands on the FIRST field whose join text equals
//      its own: `util.py::get_sort_and_sort_only_columns` keeps one element
//      per text, a later one replacing an earlier, and
//      `suite_xml/sections/details.py::get_detail_column_infos` pops it on the
//      first column with that text. A property element no field's text equals
//      becomes a carrier, the temporary `invisible` field
//      `util.py::create_temp_sort_column` appends after the stored ones.
//
//   6. A shown interval column orders by the text it shows: `TranslatableEnum`
//      sorts by its own expression whatever the element says.
//
//   7. No authored rule. One implicit rule, ascending, blanks first, on the
//      first shown field (field 0 where none is shown):
//      `suite_xml/sections/details.py::get_default_sort_elements` writes one
//      element for field 0 with no `blanks`, which Core reads as first. Where
//      that field is field 0 the rule is not written; where a hidden field
//      comes before it, it is written as the element HQ's default would have
//      been for that field.
//
//   8. Comparator. Integer and decimal only for a `property` or `calculated`
//      key over an integer or decimal value; every rule 3 key is text
//      (`sort_node` writes `SORT_TYPE`, `string`, on its first branch).
//
//   9. Blanks. The rule's own, which follows its direction where the author
//      says nothing: first ascending, last descending, HQ's sort rows' own
//      default (`static/app_manager/js/details/bootstrap5/sort_rows.js`). The
//      implicit rule is ascending with blanks first. Core places a blank by
//      `blanks` whatever the direction
//      (commcare-core `cases/entity/EntitySorter.getCmp`).
//
//  10. Name in Sort by. A rule authored with a label on a column hidden from
//      Results (`modules.ts::columnSortLabelShows`) carries it where it lands
//      on a hidden field or a carrier: HQ's build gives that field a header
//      only where its element has display text
//      (`detail_screen.py::Invisible.header`, `util.py::create_temp_sort_column`),
//      and Android's Sort by lists every field whose header is not blank
//      (commcare-android `EntitySelectActivity.getSortOptionsList`). A rule
//      that lands on a shown field shows under that field's own header, so it
//      carries none.
//
//  11. One field alone. A worker who picks a field in the list's Sort by
//      orders the list by that field alone (commcare-core
//      `cases/entity/EntitySorter.compare` over one index, which Android's
//      `EntitySelectActivity.getSortOptionsList` and Formplayer's
//      `EntityScreenHelper.sortEntities` both pass): by its `<sort>` text
//      where it has one, otherwise by the text it shows, in its own `<sort>`
//      direction turned around where the worker reversed it, with its own
//      blanks whatever the direction. A field with no rule and no key has no
//      `<sort>`, which Core reads as ascending text with blanks first
//      (`DetailField`'s defaults); a field with a key and no rule has a
//      `<sort>` with no direction, which Core reads as ascending with blanks
//      last (`DetailFieldParser.parseBlanksPreference`).

import type { CasePropertyDataType } from "./casePropertyTypes";
import type { ScalarType } from "./expression/typeChecker";
import {
	type CalculatedSort,
	type CaseListConfig,
	type Column,
	type ColumnVia,
	columnFieldText,
	columnOnList,
	columnSortLabelShows,
	defaultSortBlanks,
	imageMapShowsImages,
	orderedColumns,
	type SortBlanks,
	type SortComparison,
	type SortDirection,
	sameColumnVia,
	sortBlanks,
} from "./modules";
import { EXPRESSION_ONLY_COLUMN_PROPERTIES } from "./standardCaseProperties";
import type { Uuid } from "./uuid";

/** One property of a case type's catalog, as the plan reads it. */
export interface CaseListOrderProperty {
	readonly name: string;
	readonly data_type?: CasePropertyDataType;
	readonly options?: readonly { readonly value: string }[];
}

/** What a field orders by. A key over a property read through a relation
 *  carries the column's walk (`modules.ts::columnViaSchema`); the property is
 *  then the related case's. */
export type CaseListSortKey =
	| { readonly kind: "independent-calculation"; readonly sort: CalculatedSort }
	| {
			readonly kind: "distance-property";
			readonly column: Uuid;
			readonly property: string;
			readonly via?: ColumnVia;
	  }
	| {
			readonly kind: "distance-calculated";
			readonly column: Uuid;
			readonly unbound?: true;
	  }
	/** The raw value. */
	| {
			readonly kind: "property";
			readonly property: string;
			readonly via?: ColumnVia;
	  }
	/** A select property's shown label. */
	| {
			readonly kind: "option-label";
			readonly property: string;
			readonly via?: ColumnVia;
	  }
	/** The index of the first matching entry, as text; "" where none matches. */
	| { readonly kind: "mapping-position"; readonly column: Uuid }
	/** The interval column's shown text. */
	| { readonly kind: "interval-text"; readonly column: Uuid }
	/** The link column's shown markdown. */
	| { readonly kind: "link-text"; readonly column: Uuid }
	/** The calculated column's value. */
	| { readonly kind: "calculated"; readonly column: Uuid };

/** The query returns the exact distance it used, so filtering and resolving
 * ties on the displayed page use that same location fix. */
export function caseSortDistanceValue(column: Uuid): string {
	return `distance:${column}`;
}

export type CaseListComparator = Exclude<SortComparison, "distance">;

/** The sort element HQ JSON writes for a rule (rule 4). */
export type CaseListOrderElement =
	/** A sort row over a property name. */
	| { readonly kind: "property"; readonly property: string }
	/** `_cc_calculated_<position>` of the field the rule is authored on. */
	| { readonly kind: "positional"; readonly position: number };

export interface CaseListOrderRule {
	/** 1-based. */
	readonly order: number;
	readonly direction: SortDirection;
	/** The rule's own (rule 9). */
	readonly blanks: SortBlanks;
	/** The rule of a list with no authored rule (rule 7). */
	readonly implicit: boolean;
	/** HQ JSON writes it as a sort element. */
	readonly written: boolean;
	readonly element: CaseListOrderElement;
	/** The name the rule's field shows in the list's Sort by menu (rule 10):
	 *  the column whose `sort.label` it is and that label's source text. */
	readonly label?: CaseListSortLabel;
}

/** A rule's name in the list's Sort by menu. Its translations are the column's
 *  `sort-label` translation unit. */
export interface CaseListSortLabel {
	readonly column: Uuid;
	readonly text: string;
}

export interface CaseListShortField {
	readonly column: Column;
	/** 0-based index in the stored short detail. */
	readonly position: number;
	/** `visibleInList === false`. */
	readonly hidden: boolean;
	readonly wire: "property" | "expression";
	/** The text HQ joins an order rule by: the column's HQ `field`. */
	readonly joinText: string;
	/** The sort key the field keeps; absent where it keeps none. */
	readonly key?: CaseListSortKey;
	readonly comparator: CaseListComparator;
	/** Present when the list orders by this field. */
	readonly rule?: CaseListOrderRule;
}

/** The hidden sort field HQ appends itself for a rule that joins no field. */
export interface CaseListOrderCarrier {
	/** Its HQ `field`, the text of the element it carries
	 *  (`modules.ts::columnFieldText`). */
	readonly property: string;
	/** The column the rule is authored on. */
	readonly column: Uuid;
	/** The property whose raw value is the carrier's text and its sort key,
	 *  of the case `via` reaches. */
	readonly field: string;
	readonly via?: ColumnVia;
	readonly comparator: CaseListComparator;
	readonly key: CaseListSortKey;
	readonly rule: CaseListOrderRule;
}

/** One authored rule, as the ownership rule reads it. */
export interface CaseListAuthoredRule {
	/** The column the rule is authored on. */
	readonly column: Uuid;
	/** The text HQ joins its element by. */
	readonly joinText: string;
	/** The key that column orders by with the rule on itself. */
	readonly ownKey: CaseListSortKey;
	/** The ordinary comparison, where the authored rule can select another one. */
	readonly defaultComparison?: SortComparison;
	/** The field that takes the rule, or a carrier; absent where another rule
	 *  with that text replaced it. */
	readonly landsOn?: number | "carrier";
}

export interface CaseListOrderPlan {
	readonly fields: readonly CaseListShortField[];
	readonly carriers: readonly CaseListOrderCarrier[];
	/** Every authored rule that has an element, in rule order. */
	readonly authored: readonly CaseListAuthoredRule[];
	/** The effective rules that must introduce their choices early, in the
	 * worker's physical menu order, before their final default precedence. */
	readonly introductionOrders: readonly number[];
	readonly calculations: readonly {
		readonly sort: CalculatedSort;
		readonly defaultComparison: CaseListComparator;
		readonly order: number;
		readonly comparator: CaseListComparator;
		readonly blanks: SortBlanks;
	}[];
}

/** A menu without a case list contributes no worker choices or sort elements. */
export const EMPTY_CASE_LIST_ORDER_PLAN: CaseListOrderPlan = {
	fields: [],
	carriers: [],
	authored: [],
	introductionOrders: [],
	calculations: [],
};

export interface CaseListOrderOptions {
	/** Whether the export carries a media manifest; read only through
	 *  `imageMapShowsImages`. */
	readonly mediaOn: boolean;
	/** A calculated column's inferred scalar type; `undefined` where it resolves to
	 *  none. */
	readonly calculatedType: (column: Column) => ScalarType | undefined;
	/** The text HQ JSON writes as an expression column's `field` on Results. */
	readonly expressionText: (column: Column) => string;
	readonly sortType?: (sort: CalculatedSort) => ScalarType | undefined;
	/** The catalog of the case a column's walk reaches; absent or undefined
	 *  where the caller knows none, which reads every such property as
	 *  untyped. */
	readonly relatedProperties?: (
		via: ColumnVia,
	) => readonly CaseListOrderProperty[] | undefined;
}

/** How many choices must be introduced ahead of the default order to keep
 * their physical sequence. The remaining suffix already appears in order. */
export function choicePrefixLength<T>(
	choices: readonly T[],
	priority: (choice: T) => number,
): number {
	let length = 0;
	for (let i = 1; i < choices.length; i++) {
		if (priority(choices[i]) < priority(choices[i - 1])) length = i;
	}
	return length;
}

/** The comparator a property's data type orders by: `int` integer,
 *  `decimal` decimal, everything else text. */
export function comparatorForDataType(
	dataType: CasePropertyDataType | undefined,
): CaseListComparator {
	if (dataType === "int") return "integer";
	if (dataType === "decimal") return "decimal";
	return "text";
}

export function comparatorForResolvedType(
	type: ScalarType | undefined,
): CaseListComparator {
	if (type === "int") return "integer";
	if (type === "decimal") return "decimal";
	return "text";
}

/**
 * Whether a distance comparison can order a value of this type. Core's
 * `XPathDistanceFunc.distance` reads a blank as no distance and casts any
 * other value with `GeoPointData.cast`, which throws on fewer than two
 * space-separated numbers, so a list ordered by distance over a number, a
 * date, a time, a choice or a true/false fails for every case that holds one.
 * A location qualifies, and so do text and a value of no known type: a
 * location saved by a CommCare HQ app reads as text.
 */
export function distanceComparisonAdmits(
	type: ScalarType | undefined,
): boolean {
	return (
		type === undefined ||
		type === "_any" ||
		type === "text" ||
		type === "geopoint"
	);
}

/**
 * The type of the value a column orders by when its rule compares by
 * distance: a calculation's inferred type, a date or interval column's date,
 * and otherwise the type of the property the column reads, of the case its
 * walk reaches. `undefined` where none is known.
 */
export function caseListColumnValueType(
	column: Column,
	caseProperties: readonly CaseListOrderProperty[],
	options: Pick<CaseListOrderOptions, "calculatedType" | "relatedProperties">,
): ScalarType | undefined {
	if (column.kind === "calculated") return options.calculatedType(column);
	if (column.kind === "date" || column.kind === "interval") return "date";
	const properties =
		column.via === undefined
			? caseProperties
			: (options.relatedProperties?.(column.via) ?? []);
	return properties.find((property) => property.name === column.field)
		?.data_type;
}

/**
 * Whether a plain column over this property shows option labels: a single
 * select holding an option, or a multi select holding an option whose value
 * is one token. The same test `columns.ts::plainSelectDisplayXpath` applies
 * before it writes a label expression (rules 2 and 3).
 */
export function casePropertyShowsOptionLabels(
	property: CaseListOrderProperty | undefined,
): boolean {
	const options = property?.options ?? [];
	if (property?.data_type === "single_select") return options.length > 0;
	if (property?.data_type === "multi_select") {
		return options.some(
			(option) => option.value !== "" && !/\s/.test(option.value),
		);
	}
	return false;
}

/** The key over a property column's own value, its walk included. */
function propertyKey<
	K extends "property" | "option-label" | "distance-property",
>(
	kind: K,
	column: Extract<Column, { field: string }>,
): Extract<CaseListSortKey, { kind: K }> {
	return {
		kind,
		property: column.field,
		...(kind === "distance-property" && { column: column.uuid }),
		...(column.via !== undefined && { via: column.via }),
	} as Extract<CaseListSortKey, { kind: K }>;
}

/** Whether the column reads a property no HQ property column can show (`EXPRESSION_ONLY_COLUMN_PROPERTIES`). */
function readsExpressionOnlyProperty(column: Column): boolean {
	return (
		column.kind !== "calculated" &&
		(EXPRESSION_ONLY_COLUMN_PROPERTIES as ReadonlySet<string>).has(column.field)
	);
}

interface FieldDraft {
	readonly column: Column;
	readonly position: number;
	readonly hidden: boolean;
	readonly wire: "property" | "expression";
	readonly joinText: string;
	readonly restingKey?: CaseListSortKey;
	readonly restingComparator: CaseListComparator;
}

interface Pending {
	/** Position in the rule sequence. */
	readonly sequence: number;
	readonly direction: SortDirection;
	readonly blanks: SortBlanks;
	readonly implicit: boolean;
	readonly written: boolean;
	readonly element: CaseListOrderElement;
	/** The text the element joins by. */
	readonly joinText: string;
	/** The column the rule is authored on; absent for the implicit rule. */
	readonly authoredOn?: Column;
	readonly ownKey?: CaseListSortKey;
}

/**
 * The plan of one case list: its short detail's fields in stored order, the
 * carriers HQ appends, and every authored rule with where it lands.
 *
 * Total: every document has a plan, a document the validator refuses
 * included. A tile list's hidden order rule on a calculated column or on a
 * column over `case_id` has no element and takes no part in the order, and
 * neither does a rule on a column that is not on the list.
 */
export function caseListOrderPlan(
	config: CaseListConfig,
	caseProperties: readonly CaseListOrderProperty[],
	options: CaseListOrderOptions,
): CaseListOrderPlan {
	/** The property a column shows, from the catalog of the case its walk reaches. */
	const propertyOf = (column: Extract<Column, { field: string }>) =>
		(column.via === undefined
			? caseProperties
			: (options.relatedProperties?.(column.via) ?? [])
		).find((property) => property.name === column.field);
	const dataTypeOf = (column: Extract<Column, { field: string }>) =>
		propertyOf(column)?.data_type;
	const tiled = config.tile !== undefined;
	const results = orderedColumns(config, "list");

	// Rules 1 to 3: the fields, their wire class, join text and resting key.
	const fields: FieldDraft[] = [];
	for (const column of results) {
		if (!columnOnList(column)) continue;
		const hidden = column.visibleInList === false;
		if (tiled && hidden) continue;
		fields.push(fieldDraft(column, fields.length, hidden));
	}

	function fieldDraft(
		column: Column,
		position: number,
		hidden: boolean,
	): FieldDraft {
		const expression = (): FieldDraft => ({
			column,
			position,
			hidden,
			wire: "expression",
			joinText: options.expressionText(column),
			...restingKeyOf(column, hidden),
		});
		const property = (): FieldDraft => ({
			column,
			position,
			hidden,
			wire: "property",
			joinText: column.kind === "calculated" ? "" : columnFieldText(column),
			...restingKeyOf(column, hidden),
		});
		if (column.kind === "calculated") return expression();
		if (readsExpressionOnlyProperty(column)) return expression();
		if (hidden) return property();
		switch (column.kind) {
			case "plain":
				return casePropertyShowsOptionLabels(propertyOf(column))
					? expression()
					: property();
			case "interval":
			case "link":
				return expression();
			case "date":
			case "phone":
			case "id-mapping":
			case "image-map":
				return property();
		}
	}

	function restingKeyOf(
		column: Column,
		hidden: boolean,
	): Pick<FieldDraft, "restingKey" | "restingComparator"> {
		const none = { restingComparator: "text" as const };
		if (hidden) return none;
		switch (column.kind) {
			case "date":
				return {
					restingKey: propertyKey("property", column),
					restingComparator: "text",
				};
			case "id-mapping":
				return {
					restingKey: { kind: "mapping-position", column: column.uuid },
					restingComparator: "text",
				};
			case "image-map":
				return imageMapShowsImages(column, options.mediaOn)
					? {
							restingKey: { kind: "mapping-position", column: column.uuid },
							restingComparator: "text",
						}
					: none;
			case "plain":
				return casePropertyShowsOptionLabels(propertyOf(column))
					? {
							restingKey: propertyKey("option-label", column),
							restingComparator: "text",
						}
					: none;
			case "interval":
				return {
					restingKey: { kind: "interval-text", column: column.uuid },
					restingComparator: "text",
				};
			default:
				return none;
		}
	}

	/** The key and comparator a field orders by when it takes a rule (rule 5);
	 *  an implicit rule compares as text (rule 7). */
	function ruledKeyOf(
		field: FieldDraft,
		implicit: boolean,
		override?: SortComparison,
	): { key: CaseListSortKey; comparator: CaseListComparator } {
		if (override === "distance") {
			return {
				key:
					field.wire === "expression" || field.column.kind === "calculated"
						? {
								kind: "distance-calculated",
								column: field.column.uuid,
								...((field.restingKey?.kind === "option-label" ||
									field.restingKey?.kind === "interval-text") && {
									unbound: true as const,
								}),
							}
						: propertyKey("distance-property", field.column),
				comparator:
					field.restingKey === undefined ? "decimal" : field.restingComparator,
			};
		}
		if (field.restingKey !== undefined) {
			return { key: field.restingKey, comparator: field.restingComparator };
		}
		const { column } = field;
		if (column.kind === "calculated") {
			return {
				key: { kind: "calculated", column: column.uuid },
				comparator: implicit
					? "text"
					: (override ??
						comparatorForResolvedType(options.calculatedType(column))),
			};
		}
		if (column.kind === "link" && !field.hidden) {
			return {
				key: { kind: "link-text", column: column.uuid },
				comparator: override ?? "text",
			};
		}
		return {
			key: propertyKey("property", column),
			comparator: implicit
				? "text"
				: (override ?? comparatorForDataType(dataTypeOf(column))),
		};
	}

	const fieldByUuid = new Map(
		fields.map((field) => [field.column.uuid, field]),
	);

	// Rule 4: authored rules, in priority order, ties by Results position.
	const authoredColumns = results
		.map((column, index) => ({ column, index }))
		.filter(({ column }) => column.sort !== undefined && columnOnList(column))
		.sort((a, b) => {
			const ap = a.column.sort?.priority ?? 0;
			const bp = b.column.sort?.priority ?? 0;
			return ap !== bp ? ap - bp : a.index - b.index;
		});

	const pending: Pending[] = [];
	for (const { column } of authoredColumns) {
		const sort = column.sort;
		if (sort === undefined) continue;
		const field = fieldByUuid.get(column.uuid);
		const base = {
			sequence: pending.length,
			direction: sort.direction,
			blanks: sortBlanks(sort),
			implicit: false,
			written: true,
			authoredOn: column,
		};
		if (field === undefined) {
			// Exception iii: a tile list's column hidden from Results.
			if (column.kind === "calculated" || column.field === "case_id") continue;
			pending.push({
				...base,
				element: { kind: "property", property: columnFieldText(column) },
				joinText: columnFieldText(column),
				ownKey: propertyKey(
					sort.comparator === "distance" ? "distance-property" : "property",
					column,
				),
			});
			continue;
		}
		if (
			field.wire === "expression" &&
			column.kind === "link" &&
			!field.hidden &&
			column.field !== "case_id"
		) {
			// Exception i: a shown link orders by its raw value.
			pending.push({
				...base,
				element: { kind: "property", property: columnFieldText(column) },
				joinText: columnFieldText(column),
				ownKey: propertyKey(
					sort.comparator === "distance" ? "distance-property" : "property",
					column,
				),
			});
			continue;
		}
		pending.push({
			...base,
			element:
				field.wire === "property"
					? { kind: "property", property: field.joinText }
					: { kind: "positional", position: field.position },
			joinText: field.joinText,
			ownKey: ruledKeyOf(field, false, sort.comparator).key,
		});
	}

	// Rule 7: the implicit rule of a list with no authored element.
	if (
		pending.length === 0 &&
		!config.calculatedSorts?.length &&
		fields.length > 0
	) {
		const target = fields.find((field) => !field.hidden) ?? fields[0];
		pending.push({
			sequence: 0,
			direction: "asc",
			blanks: defaultSortBlanks("asc"),
			implicit: true,
			written: target.position !== 0,
			element:
				target.wire === "property"
					? { kind: "property", property: target.joinText }
					: { kind: "positional", position: target.position },
			joinText: target.joinText,
		});
	}

	// Rule 5: the join, as `get_sort_and_sort_only_columns` and
	// `get_detail_column_infos` make it.
	const byPropertyName = new Map<string, Pending>();
	const positional: Pending[] = [];
	for (const rule of pending) {
		if (rule.element.kind === "property") {
			byPropertyName.set(rule.element.property, rule);
		} else {
			positional.push(rule);
		}
	}
	const byJoinText = new Map<string, Pending>();
	for (const field of fields) {
		const rule = byPropertyName.get(field.joinText);
		if (rule === undefined) continue;
		byPropertyName.delete(field.joinText);
		byJoinText.set(field.joinText, rule);
	}
	for (const rule of positional) {
		if (rule.element.kind !== "positional") continue;
		const target = fields[rule.element.position];
		byJoinText.set(target.joinText, rule);
	}
	const landedOn = new Map<Pending, number | "carrier">();
	for (const field of fields) {
		const rule = byJoinText.get(field.joinText);
		if (rule === undefined) continue;
		byJoinText.delete(field.joinText);
		landedOn.set(rule, field.position);
	}
	const carrierMenuPosition = (rule: Pending) =>
		rule.authoredOn?.sort?.menuPosition ?? Number.POSITIVE_INFINITY;
	const carrierRules = [...byPropertyName.values()].sort((a, b) => {
		const aPosition = carrierMenuPosition(a);
		const bPosition = carrierMenuPosition(b);
		return aPosition === bPosition
			? a.sequence - b.sequence
			: aPosition - bPosition;
	});
	for (const rule of carrierRules) landedOn.set(rule, "carrier");

	// Orders are dense over the rules that land, in rule order: a rule another
	// one replaced is written nowhere.
	const orderOf = new Map<Pending | CalculatedSort, number>();
	const sequence = [
		...pending
			.filter((rule) => landedOn.has(rule))
			.map((rule) => ({
				rule,
				priority: rule.authoredOn?.sort?.priority ?? 0,
			})),
		...(config.calculatedSorts ?? []).map((rule) => ({
			rule,
			priority: rule.priority,
		})),
	].sort((a, b) => a.priority - b.priority);
	// HQ's separate property and calculation dictionaries preserve each key's
	// first insertion. Its last occurrence decides the default order. Introduce
	// only the prefix needed for each group's physical worker menu order.
	const calculations = config.calculatedSorts ?? [];
	const introductions = [
		...carrierRules.slice(
			0,
			choicePrefixLength(carrierRules, (rule) => rule.sequence),
		),
		...calculations.slice(
			0,
			choicePrefixLength(calculations, (rule) => rule.priority),
		),
	];
	for (const { rule } of sequence)
		orderOf.set(rule, introductions.length + orderOf.size + 1);
	// Rule 10: the label rides a rule that lands on a hidden field or a carrier.
	const labelOf = (rule: Pending): CaseListSortLabel | undefined => {
		const column = rule.authoredOn;
		const text = column?.sort?.label;
		if (column === undefined || text === undefined) return undefined;
		if (!columnSortLabelShows(column)) return undefined;
		const landing = landedOn.get(rule);
		if (landing === undefined) return undefined;
		if (landing !== "carrier" && fields[landing]?.hidden !== true)
			return undefined;
		return { column: column.uuid, text };
	};
	const finalRule = (rule: Pending): CaseListOrderRule => {
		const label = labelOf(rule);
		return {
			order: orderOf.get(rule) ?? 0,
			direction: rule.direction,
			blanks: rule.blanks,
			implicit: rule.implicit,
			written: rule.written,
			element: rule.element,
			...(label !== undefined && { label }),
		};
	};

	const ruleByPosition = new Map<number, Pending>();
	for (const [rule, landing] of landedOn) {
		if (landing !== "carrier") ruleByPosition.set(landing, rule);
	}

	return {
		introductionOrders: introductions.map(
			(rule) => orderOf.get(rule) as number,
		),
		calculations: calculations.map((sort) => {
			const defaultComparison = comparatorForResolvedType(
				options.sortType?.(sort),
			);
			return {
				sort,
				defaultComparison,
				order: orderOf.get(sort) ?? 0,
				comparator: sort.comparator ?? defaultComparison,
				blanks: sort.blanks ?? defaultSortBlanks(sort.direction),
			};
		}),
		fields: fields.map((field): CaseListShortField => {
			const rule = ruleByPosition.get(field.position);
			const { key, comparator } =
				rule === undefined
					? { key: field.restingKey, comparator: field.restingComparator }
					: ruledKeyOf(field, rule.implicit, rule.authoredOn?.sort?.comparator);
			return {
				column: field.column,
				position: field.position,
				hidden: field.hidden,
				wire: field.wire,
				joinText: field.joinText,
				...(key !== undefined && { key }),
				comparator,
				...(rule !== undefined && { rule: finalRule(rule) }),
			};
		}),
		carriers: carrierRules.flatMap((rule): CaseListOrderCarrier[] => {
			// Only an authored rule on a property column can land on a carrier:
			// the implicit rule always names a field.
			const column = rule.authoredOn;
			if (
				column === undefined ||
				column.kind === "calculated" ||
				rule.element.kind !== "property"
			)
				return [];
			return [
				{
					property: rule.element.property,
					column: column.uuid,
					field: column.field,
					...(column.via !== undefined && { via: column.via }),
					key: propertyKey(
						column.sort?.comparator === "distance"
							? "distance-property"
							: "property",
						column,
					),
					comparator:
						column.sort?.comparator === "distance"
							? "decimal"
							: (column.sort?.comparator ??
								comparatorForDataType(dataTypeOf(column))),
					rule: finalRule(rule),
				},
			];
		}),
		authored: pending.flatMap((rule): CaseListAuthoredRule[] => {
			if (rule.authoredOn === undefined || rule.ownKey === undefined) {
				return [];
			}
			const landsOn = landedOn.get(rule);
			const field = typeof landsOn === "number" ? fields[landsOn] : undefined;
			const defaultComparison =
				field && field.restingKey === undefined
					? ruledKeyOf(field, false).comparator
					: landsOn === "carrier" && rule.authoredOn.kind !== "calculated"
						? comparatorForDataType(dataTypeOf(rule.authoredOn))
						: undefined;
			return [
				{
					column: rule.authoredOn.uuid,
					joinText: rule.joinText,
					ownKey: rule.ownKey,
					...(defaultComparison !== undefined && { defaultComparison }),
					...(landsOn !== undefined && { landsOn }),
				},
			];
		}),
	};
}

/** How a list orders by one of its fields alone (rule 11). */
export interface CaseListSingleFieldOrder {
	readonly key: CaseListSortKey;
	readonly comparator: CaseListComparator;
	readonly direction: SortDirection;
	readonly blanks: SortBlanks;
}

/**
 * The order of the list by the field or carrier of `column` alone, the
 * worker's pick in its Sort by menu (rule 11), reversed where `reversed`;
 * `undefined` where the plan holds no such field.
 */
export function caseListSingleFieldOrder(
	plan: CaseListOrderPlan,
	column: string,
	reversed: boolean,
): CaseListSingleFieldOrder | undefined {
	const turn = (direction: SortDirection): SortDirection =>
		reversed ? (direction === "asc" ? "desc" : "asc") : direction;
	const calc = plan.calculations.find((rule) => rule.sort.uuid === column);
	if (calc)
		return {
			key: { kind: "independent-calculation", sort: calc.sort },
			comparator: calc.comparator,
			direction: turn(calc.sort.direction),
			blanks: calc.blanks,
		};
	const carrier = plan.carriers.find(
		(candidate) => candidate.column === column,
	);
	if (carrier !== undefined) {
		return {
			key: carrier.key,
			comparator: carrier.comparator,
			direction: turn(carrier.rule.direction),
			blanks: carrier.rule.blanks,
		};
	}
	const field = plan.fields.find(
		(candidate) => candidate.column.uuid === column,
	);
	if (field === undefined) return undefined;
	if (field.rule !== undefined && field.key !== undefined) {
		return {
			key: field.key,
			comparator: field.comparator,
			direction: turn(field.rule.direction),
			blanks: field.rule.blanks,
		};
	}
	if (field.key !== undefined) {
		return {
			key: field.key,
			comparator: field.comparator,
			direction: turn("asc"),
			blanks: "last",
		};
	}
	// No `<sort>`: the text the field shows, which is its calculation, a
	// shown link's markdown, or the raw value.
	const { column: shown } = field;
	const key: CaseListSortKey =
		shown.kind === "calculated"
			? { kind: "calculated", column: shown.uuid }
			: shown.kind === "link" && !field.hidden
				? { kind: "link-text", column: shown.uuid }
				: propertyKey("property", shown);
	return {
		key,
		comparator: "text",
		direction: turn("asc"),
		blanks: "first",
	};
}

/** Whether `b` is of `a`'s kind. */
function sameSortKeyKind<K extends CaseListSortKey>(
	a: K,
	b: CaseListSortKey,
): b is K {
	return a.kind === b.kind;
}

/**
 * Whether the list orders by an ID mapping's or an image map's table: the
 * column's field carries a rule and keeps the mapping position as its key,
 * which it does on Results, and for an image map where it shows its images
 * (`imageMapShowsImages`).
 */
export function caseListOrdersByMapping(
	plan: CaseListOrderPlan,
	column: Uuid,
): boolean {
	return plan.fields.some(
		(field) =>
			field.column.uuid === column &&
			field.rule !== undefined &&
			field.key?.kind === "mapping-position",
	);
}

/**
 * Whether two keys are the same key, as `CASE_LIST_SORT_PROPERTY_AMBIGUOUS`
 * defines it: one kind, and for `property` and `option-label` one property
 * through one walk;
 * for `mapping-position` one property and the same entry values in the same
 * order; for `interval-text`, `link-text` and `calculated` equal join text,
 * and for `interval-text` the same text as well.
 */
export function caseListSortKeysMatch(
	plan: CaseListOrderPlan,
	columns: readonly Column[],
	a: CaseListSortKey,
	b: CaseListSortKey,
	expressionText: (column: Column) => string,
): boolean {
	if (
		a.kind === "independent-calculation" ||
		b.kind === "independent-calculation"
	)
		return (
			a.kind === "independent-calculation" &&
			b.kind === "independent-calculation" &&
			a.sort.uuid === b.sort.uuid
		);
	if (
		a.kind === "property" ||
		a.kind === "option-label" ||
		a.kind === "distance-property"
	) {
		return (
			sameSortKeyKind(a, b) &&
			a.property === b.property &&
			sameColumnVia(a.via, b.via)
		);
	}
	if (!sameSortKeyKind(a, b)) return false;
	const columnA = columns.find((column) => column.uuid === a.column);
	const columnB = columns.find((column) => column.uuid === b.column);
	if (columnA === undefined || columnB === undefined) return false;
	if (a.kind === "mapping-position") {
		if (
			(columnA.kind !== "id-mapping" && columnA.kind !== "image-map") ||
			(columnB.kind !== "id-mapping" && columnB.kind !== "image-map") ||
			columnA.field !== columnB.field ||
			!sameColumnVia(columnA.via, columnB.via)
		) {
			return false;
		}
		const valuesA = columnA.mapping.map((entry) => entry.value);
		const valuesB = columnB.mapping.map((entry) => entry.value);
		return (
			valuesA.length === valuesB.length &&
			valuesA.every((value, index) => value === valuesB[index])
		);
	}
	const joinTextOf = (column: Column) =>
		plan.fields.find((field) => field.column.uuid === column.uuid)?.joinText ??
		expressionText(column);
	if (joinTextOf(columnA) !== joinTextOf(columnB)) return false;
	if (a.kind === "interval-text") {
		return (
			columnA.kind === "interval" &&
			columnB.kind === "interval" &&
			columnA.text === columnB.text
		);
	}
	return true;
}
