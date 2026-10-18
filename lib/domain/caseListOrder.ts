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
//   1. Fields. Every column of the Results sequence is a field of the short
//      detail, a column hidden from Results included: HQ stores it as an
//      `invisible` column, a field at width 0 (`detail_screen.py::Invisible`,
//      `HideShortColumn`). In a list with a tile layout a column hidden from
//      Results is no field: its order rule rides as a sort row with no stored
//      column (rule 4, exception iii), so no Case List save can give it a cell.
//
//   2. Wire class and join text. A `property` field's HQ `field` is a
//      property name that `detail_screen.py::PropertyXpathGenerator.xpath`
//      turns into a path; an `expression` field's `field` is used verbatim
//      (`detail_screen.py::FormattedDetailColumn.xpath`). HQ joins a sort
//      element to a field by that text alone, so the field's HQ `field` is its
//      join text.
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
//      Results position. A rule on a property field is a property element; a
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
//   9. Blanks. First for ascending, last for descending, on every rule
//      (`static/app_manager/js/details/bootstrap5/sort_rows.js`); Core places a
//      blank by `blanks` whatever the direction
//      (commcare-core `cases/entity/EntitySorter.getCmp`).

import type { CasePropertyDataType } from "./casePropertyTypes";
import type { ScalarType } from "./expression/typeChecker";
import {
	type CaseListConfig,
	type Column,
	imageMapShowsImages,
	orderedColumns,
	type SortDirection,
} from "./modules";
import { ATTRIBUTE_BACKED_COLUMN_PROPERTIES } from "./standardCaseProperties";
import type { Uuid } from "./uuid";

/** One property of a case type's catalog, as the plan reads it. */
export interface CaseListOrderProperty {
	readonly name: string;
	readonly data_type?: CasePropertyDataType;
	readonly options?: readonly { readonly value: string }[];
}

/** What a field orders by. */
export type CaseListSortKey =
	/** The raw value. */
	| { readonly kind: "property"; readonly property: string }
	/** A select property's shown label. */
	| { readonly kind: "option-label"; readonly property: string }
	/** The index of the first matching entry, as text; "" where none matches. */
	| { readonly kind: "mapping-position"; readonly column: Uuid }
	/** The interval column's shown text. */
	| { readonly kind: "interval-text"; readonly column: Uuid }
	/** The link column's shown markdown. */
	| { readonly kind: "link-text"; readonly column: Uuid }
	/** The calculated column's value. */
	| { readonly kind: "calculated"; readonly column: Uuid };

export type CaseListComparator = "text" | "integer" | "decimal";

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
	/** First when ascending, last when descending. */
	readonly blanks: "first" | "last";
	/** The rule of a list with no authored rule (rule 7). */
	readonly implicit: boolean;
	/** HQ JSON writes it as a sort element. */
	readonly written: boolean;
	readonly element: CaseListOrderElement;
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
	/** Its raw value is the carrier's text and its sort key. */
	readonly property: string;
	readonly comparator: CaseListComparator;
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
	/** The field that takes the rule, or a carrier; absent where another rule
	 *  with that text replaced it. */
	readonly landsOn?: number | "carrier";
}

export interface CaseListOrderPlan {
	readonly fields: readonly CaseListShortField[];
	readonly carriers: readonly CaseListOrderCarrier[];
	/** Every authored rule that has an element, in rule order. */
	readonly authored: readonly CaseListAuthoredRule[];
}

export interface CaseListOrderOptions {
	/** Whether the export carries a media manifest; read only through
	 *  `imageMapShowsImages`. */
	readonly mediaOn: boolean;
	/** A calculated column's inferred scalar type; `undefined` where it resolves to
	 *  none. */
	readonly calculatedType: (column: Column) => ScalarType | undefined;
	/** The text HQ JSON writes as an expression column's `field` on Results. */
	readonly expressionText: (column: Column) => string;
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

function comparatorForResolvedType(
	type: ScalarType | undefined,
): CaseListComparator {
	if (type === "int") return "integer";
	if (type === "decimal") return "decimal";
	return "text";
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

/** Whether the column reads an attribute-backed property (finding 57). */
function readsAttribute(column: Column): boolean {
	return (
		column.kind !== "calculated" &&
		(ATTRIBUTE_BACKED_COLUMN_PROPERTIES as ReadonlySet<string>).has(
			column.field,
		)
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
 * column over `case_id` has no element and takes no part in the order.
 */
export function caseListOrderPlan(
	config: CaseListConfig,
	caseProperties: readonly CaseListOrderProperty[],
	options: CaseListOrderOptions,
): CaseListOrderPlan {
	const propertyNamed = (name: string) =>
		caseProperties.find((property) => property.name === name);
	const dataTypeOf = (name: string) => propertyNamed(name)?.data_type;
	const tiled = config.tile !== undefined;
	const results = orderedColumns(config, "list");

	// Rules 1 to 3: the fields, their wire class, join text and resting key.
	const fields: FieldDraft[] = [];
	for (const column of results) {
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
		const property = (name: string): FieldDraft => ({
			column,
			position,
			hidden,
			wire: "property",
			joinText: name,
			...restingKeyOf(column, hidden),
		});
		if (column.kind === "calculated") return expression();
		if (readsAttribute(column)) return expression();
		if (hidden) return property(column.field);
		switch (column.kind) {
			case "plain":
				return casePropertyShowsOptionLabels(propertyNamed(column.field))
					? expression()
					: property(column.field);
			case "interval":
			case "link":
				return expression();
			case "date":
			case "phone":
			case "id-mapping":
			case "image-map":
				return property(column.field);
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
					restingKey: { kind: "property", property: column.field },
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
				return casePropertyShowsOptionLabels(propertyNamed(column.field))
					? {
							restingKey: { kind: "option-label", property: column.field },
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
	): { key: CaseListSortKey; comparator: CaseListComparator } {
		if (field.restingKey !== undefined) {
			return { key: field.restingKey, comparator: field.restingComparator };
		}
		const { column } = field;
		if (column.kind === "calculated") {
			return {
				key: { kind: "calculated", column: column.uuid },
				comparator: implicit
					? "text"
					: comparatorForResolvedType(options.calculatedType(column)),
			};
		}
		if (column.kind === "link" && !field.hidden) {
			return {
				key: { kind: "link-text", column: column.uuid },
				comparator: "text",
			};
		}
		return {
			key: { kind: "property", property: column.field },
			comparator: implicit
				? "text"
				: comparatorForDataType(dataTypeOf(column.field)),
		};
	}

	const fieldByUuid = new Map(
		fields.map((field) => [field.column.uuid, field]),
	);

	// Rule 4: authored rules, in priority order, ties by Results position.
	const authoredColumns = results
		.map((column, index) => ({ column, index }))
		.filter(({ column }) => column.sort !== undefined)
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
			implicit: false,
			written: true,
			authoredOn: column,
		};
		if (field === undefined) {
			// Exception iii: a tile list's column hidden from Results.
			if (column.kind === "calculated" || column.field === "case_id") continue;
			pending.push({
				...base,
				element: { kind: "property", property: column.field },
				joinText: column.field,
				ownKey: { kind: "property", property: column.field },
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
				element: { kind: "property", property: column.field },
				joinText: column.field,
				ownKey: { kind: "property", property: column.field },
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
			ownKey: ruledKeyOf(field, false).key,
		});
	}

	// Rule 7: the implicit rule of a list with no authored element.
	if (pending.length === 0 && fields.length > 0) {
		const target = fields.find((field) => !field.hidden) ?? fields[0];
		pending.push({
			sequence: 0,
			direction: "asc",
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
	const carrierRules = [...byPropertyName.values()];
	for (const rule of carrierRules) landedOn.set(rule, "carrier");

	// Orders are dense over the rules that land, in rule order: a rule another
	// one replaced is written nowhere.
	const orderOf = new Map<Pending, number>();
	for (const rule of pending.filter((candidate) => landedOn.has(candidate))) {
		orderOf.set(rule, orderOf.size + 1);
	}
	const finalRule = (rule: Pending): CaseListOrderRule => ({
		order: orderOf.get(rule) ?? 0,
		direction: rule.direction,
		blanks: rule.direction === "asc" ? "first" : "last",
		implicit: rule.implicit,
		written: rule.written,
		element: rule.element,
	});

	const ruleByPosition = new Map<number, Pending>();
	for (const [rule, landing] of landedOn) {
		if (landing !== "carrier") ruleByPosition.set(landing, rule);
	}

	return {
		fields: fields.map((field): CaseListShortField => {
			const rule = ruleByPosition.get(field.position);
			const { key, comparator } =
				rule === undefined
					? { key: field.restingKey, comparator: field.restingComparator }
					: ruledKeyOf(field, rule.implicit);
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
		carriers: carrierRules
			.sort((a, b) => a.sequence - b.sequence)
			.map((rule): CaseListOrderCarrier => {
				const property =
					rule.element.kind === "property" ? rule.element.property : "";
				return {
					property,
					comparator: rule.implicit
						? "text"
						: comparatorForDataType(dataTypeOf(property)),
					rule: finalRule(rule),
				};
			}),
		authored: pending.flatMap((rule): CaseListAuthoredRule[] => {
			if (rule.authoredOn === undefined || rule.ownKey === undefined) {
				return [];
			}
			const landsOn = landedOn.get(rule);
			return [
				{
					column: rule.authoredOn.uuid,
					joinText: rule.joinText,
					ownKey: rule.ownKey,
					...(landsOn !== undefined && { landsOn }),
				},
			];
		}),
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
 * defines it: one kind, and for `property` and `option-label` one property;
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
	if (a.kind === "property" || a.kind === "option-label") {
		return sameSortKeyKind(a, b) && a.property === b.property;
	}
	if (!sameSortKeyKind(a, b)) return false;
	const columnA = columns.find((column) => column.uuid === a.column);
	const columnB = columns.find((column) => column.uuid === b.column);
	if (columnA === undefined || columnB === undefined) return false;
	if (a.kind === "mapping-position") {
		if (
			(columnA.kind !== "id-mapping" && columnA.kind !== "image-map") ||
			(columnB.kind !== "id-mapping" && columnB.kind !== "image-map") ||
			columnA.field !== columnB.field
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
