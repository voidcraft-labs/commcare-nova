// lib/preview/engine/caseListFilterFields.ts
//
// What a case list's filter box reads of a row, and which rows the list's own
// order ties, as CommCare reads them.
//
// A device's entity holds, for each field of the short detail, the text its
// template evaluates to (commcare-core `cases/entity/NodeEntityFactory.getEntity`,
// `fieldData[i] = template.evaluate(...)`), and a `Text` of type XPath wraps
// its expression in `string(...)` (`suite/model/Text.java::ensureCacheIsParsed`).
// The filter matches that text (`cases/entity/Entity.getNormalizedField`,
// `util/EntitySortUtil.sortEntities`), not what the cell draws: a link column
// in Web Apps draws its wording and holds `[text](address)`, an image map draws
// an image and holds the image's `jr://file/` path, and a calculated column
// draws Preview's worker-facing value and holds XPath's string of it
// (`xpath/expr/FunctionUtils.toString`: `true`, `false`, a date's ISO day).
//
// The order's ties are read from the same values: two rows tie on a rule where
// the rule's key text compares equal under its comparator, as the case store
// compares it (`lib/case-store/postgres/store.ts::compileSortKey`), which is
// held to Core's `cases/entity/EntitySorter`.

import {
	jrFileRef,
	wirePathFor,
} from "@/lib/commcare/multimedia/assetWirePath";
import type {
	CaseListComparator,
	CaseListOrderPlan,
	CaseListShortField,
	CaseListSortKey,
	CaseProperty,
	Column,
	MediaAssetId,
	Uuid,
} from "@/lib/domain";
import {
	type CalculatedTemporalType,
	type ColumnDisplayContext,
	caseListRawText,
	mappingPositionText,
	projectColumnDisplay,
} from "@/lib/preview/columnDisplay";
import { xpathToString } from "@/lib/preview/xpath/coerce";
import { XPathDate } from "@/lib/preview/xpath/types";
import type {
	CalculatedValue,
	CaseRowWithCalculated,
} from "./caseDataBindingTypes";

/** One field of a row as the filter reads it: the text it matches, and the
 *  sort text fuzzy search reads, `null` for a field that keeps no sort key. */
export interface CaseListFilterField {
	readonly text: string;
	readonly sortText: string | null;
}

/**
 * The `jr://file/` path a device holds for an image a mapping shows, or
 * `undefined` while Preview has not read the image's media row.
 */
export type ImageReference = (assetId: MediaAssetId) => string | undefined;

/** The path every export writes for an uploaded image: `jr://file/commcare/`,
 *  its content hash and its extension (`assetWirePath.ts::requireAssetRef`). */
export function mediaImageReference(row: {
	readonly contentHash: string;
	readonly extension: string;
}): string {
	return jrFileRef(wirePathFor(row.contentHash, row.extension));
}

const MS_PER_DAY = 86_400_000;

/**
 * XPath's string of a calculated value as Preview's case store returns it:
 * `true` or `false` for a yes/no, the ISO day for a date (a `date` value is
 * its UTC day, a date and time the worker's day of its moment, since Core's
 * `toString(Date)` drops the clock), a number as Core prints a `Double`, and
 * text as it is. A value Preview has none for is blank.
 */
export function calculatedDeviceText(
	value: CalculatedValue | undefined,
	temporalType: CalculatedTemporalType | undefined,
): string {
	if (value === undefined || value === null) return "";
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") return xpathToString(value);
	if (typeof value === "string") return value;
	if (value instanceof Date) {
		const ms = value.getTime();
		if (Number.isNaN(ms)) return "";
		return (
			temporalType === "date"
				? XPathDate.fromCalendarDays(Math.floor(ms / MS_PER_DAY))
				: XPathDate.localDateOf(ms)
		).toISOString();
	}
	return JSON.stringify(value);
}

/**
 * The text a device's entity holds for a column shown on the list: the
 * column's display expression as a string. A link column is
 * `[text](address)`, blank for a blank value, on both platforms
 * (`lib/commcare/suite/case-list/columns.ts::linkColumnDisplayXpath`); an
 * image map is the path of the first entry the value holds, blank where it
 * holds none (`imageMapDisplayXpath`); a calculated column is
 * `calculatedDeviceText`; every other kind is the text the cell shows.
 */
export function columnDeviceText(
	column: Column,
	row: CaseRowWithCalculated,
	context: ColumnDisplayContext,
	imageReference: ImageReference,
): string {
	switch (column.kind) {
		case "link":
			return projectColumnDisplay(column, row, {
				...context,
				linkColumnInList: "raw-text",
			}).text;
		case "image-map": {
			const position = mappingPositionText(column, row, context.reading);
			if (position === "") return "";
			const entry = column.mapping[Number(position)];
			return entry === undefined ? "" : (imageReference(entry.assetId) ?? "");
		}
		case "calculated":
			return calculatedDeviceText(
				row.calculated[column.uuid],
				context.calculatedTemporalTypes.get(column.uuid),
			);
		default:
			return projectColumnDisplay(column, row, context).text;
	}
}

/**
 * A row's fields as the device's filter reads them, in the short detail's
 * order (commcare-core `util/EntitySortUtil.sortEntities`): each shown
 * column's `columnDeviceText`, and with the list's order plan each hidden
 * field's text (the raw value, or a hidden calculated column's value) and
 * each carrier's raw value, a hidden field's template and HQ's appended
 * carrier both holding the raw value. A field's sort text, which fuzzy search
 * reads, is the value its plan key orders by; a field that keeps no key has
 * none, and a carrier's raw value is its own.
 */
export function caseListFilterFields(
	columns: readonly Column[],
	row: CaseRowWithCalculated,
	context: ColumnDisplayContext,
	plan: CaseListOrderPlan | undefined,
	imageReference: ImageReference,
): CaseListFilterField[] {
	const shownText = (column: Column) =>
		columnDeviceText(column, row, context, imageReference);
	if (plan === undefined)
		return columns.map((column) => ({
			text: shownText(column),
			sortText: null,
		}));
	const shown = new Set<Uuid>(columns.map((column) => column.uuid));
	const named = new Set<Uuid>();
	const fields: CaseListFilterField[] = [];
	for (const field of plan.fields) {
		const { column } = field;
		named.add(column.uuid);
		if (!field.hidden && !shown.has(column.uuid)) continue;
		const text =
			!field.hidden || column.kind === "calculated"
				? shownText(column)
				: caseListRawText(row, column.field, context.reading);
		fields.push({
			text,
			sortText:
				field.key === undefined
					? null
					: sortKeyText(field.key, field, row, context),
		});
	}
	for (const column of columns)
		if (!named.has(column.uuid))
			fields.push({ text: shownText(column), sortText: null });
	for (const carrier of plan.carriers) {
		const raw = caseListRawText(row, carrier.property, context.reading);
		fields.push({ text: raw, sortText: raw });
	}
	return fields;
}

/**
 * The text a field's plan key orders by, which fuzzy search reads and the
 * order compares: the raw value for `property`; the column's shown text for
 * `option-label` and `interval-text`; the calculated value's device text for
 * `calculated`; the markdown a link writes for `link-text` (`[text](value)`,
 * blank for a blank value, as the case store's key and the device's sort
 * expression read it); the position text for `mapping-position`.
 */
function sortKeyText(
	key: CaseListSortKey,
	field: CaseListShortField,
	row: CaseRowWithCalculated,
	context: ColumnDisplayContext,
): string {
	const { column } = field;
	switch (key.kind) {
		case "property":
			return caseListRawText(row, key.property, context.reading);
		case "option-label":
		case "interval-text":
			return projectColumnDisplay(column, row, context).text;
		case "calculated":
			return column.kind === "calculated"
				? calculatedDeviceText(
						row.calculated[column.uuid],
						context.calculatedTemporalTypes.get(column.uuid),
					)
				: "";
		case "link-text":
			return column.kind === "link"
				? projectColumnDisplay(column, row, {
						...context,
						linkColumnInList: "raw-text",
					}).text
				: "";
		case "mapping-position":
			return column.kind === "id-mapping" || column.kind === "image-map"
				? mappingPositionText(column, row, context.reading)
				: "";
	}
}

/** One term of a row's order: the text a rule compares and how it compares it. */
interface OrderTerm {
	readonly text: string;
	readonly comparator: CaseListComparator;
}

/**
 * The terms a row's order compares, rule by rule in the plan's order, as the
 * case store builds its keys (`caseDataBindingHelpers.ts::buildCaseStoreSortKeys`):
 * a rule over a multi select's option labels is two terms, its known labels in
 * catalog order each followed by a space, then the raw value. The case id the
 * store orders by last is no rule and no term of it.
 */
export function caseListOrderTerms(
	row: CaseRowWithCalculated,
	context: ColumnDisplayContext,
	plan: CaseListOrderPlan | undefined,
): readonly OrderTerm[] {
	if (plan === undefined) return [];
	const rules: { order: number; terms: OrderTerm[] }[] = [];
	for (const field of plan.fields) {
		if (field.rule === undefined || field.key === undefined) continue;
		rules.push({
			order: field.rule.order,
			terms: fieldOrderTerms(field.key, field, row, context),
		});
	}
	for (const carrier of plan.carriers)
		rules.push({
			order: carrier.rule.order,
			terms: [
				{
					text: caseListRawText(row, carrier.property, context.reading),
					comparator: carrier.comparator,
				},
			],
		});
	return rules.sort((a, b) => a.order - b.order).flatMap((rule) => rule.terms);
}

function fieldOrderTerms(
	key: CaseListSortKey,
	field: CaseListShortField,
	row: CaseRowWithCalculated,
	context: ColumnDisplayContext,
): OrderTerm[] {
	if (key.kind !== "option-label")
		return [
			{
				text: sortKeyText(key, field, row, context),
				comparator:
					key.kind === "property" || key.kind === "calculated"
						? field.comparator
						: "text",
			},
		];
	const raw = caseListRawText(row, key.property, context.reading);
	const property = context.caseProperties.find(
		(candidate) => candidate.name === key.property,
	);
	const options = property?.options ?? [];
	if (property === undefined || options.length === 0)
		return [{ text: raw, comparator: "text" }];
	if (property.data_type !== "multi_select")
		return [
			{ text: singleSelectLabel(property, raw, context), comparator: "text" },
		];
	const tokens = new Set(raw.split(" ").filter((token) => token !== ""));
	const labels = options
		.filter(
			(option) =>
				option.value !== "" &&
				!/\s/.test(option.value) &&
				tokens.has(option.value),
		)
		.map((option) => `${context.projectProse(option.label)} `)
		.join("");
	if (
		!options.some((option) => option.value !== "" && !/\s/.test(option.value))
	)
		return [{ text: raw, comparator: "text" }];
	return [
		{ text: labels, comparator: "text" },
		{ text: raw, comparator: "text" },
	];
}

/** A single select's label in the worker's language, the raw value where no
 *  option holds it, the first option holding it winning. */
function singleSelectLabel(
	property: CaseProperty,
	raw: string,
	context: ColumnDisplayContext,
): string {
	const option = property.options?.find((candidate) => candidate.value === raw);
	return option === undefined ? raw : context.projectProse(option.label);
}

/** A whole number or decimal, as the numeric comparators read one. */
const SORT_NUMBER = /^-?[0-9]+(\.[0-9]+)?$/;

/**
 * Whether two rows' order terms compare equal on every term, as the case
 * store compares them (`store.ts::compileSortKey`): a blank only with a blank;
 * `text` by the lower-cased text; `integer` and `decimal` with every text that
 * is no number alike, and numbers by their value, truncated toward zero for
 * `integer`, which also tells a negative fraction from zero.
 */
export function orderTermsTie(
	a: readonly OrderTerm[],
	b: readonly OrderTerm[],
): boolean {
	if (a.length !== b.length) return false;
	return a.every((term, index) => {
		const other = b[index];
		return (
			other !== undefined &&
			termClass(term.text, term.comparator) ===
				termClass(other.text, term.comparator)
		);
	});
}

/** The class of values a term's text compares equal to. */
function termClass(text: string, comparator: CaseListComparator): string {
	if (text === "") return "blank";
	if (comparator === "text") return `text:${text.toLowerCase()}`;
	const trimmed = text.replace(/^ +| +$/g, "");
	if (!SORT_NUMBER.test(trimmed)) return "no-number";
	const negative = trimmed.startsWith("-");
	const [whole = "", fraction = ""] = (
		negative ? trimmed.slice(1) : trimmed
	).split(".");
	const integer = whole.replace(/^0+/, "");
	const decimals = fraction.replace(/0+$/, "");
	const zero = integer === "" && decimals === "";
	if (comparator === "integer") {
		const truncated = integer === "" ? "0" : `${negative ? "-" : ""}${integer}`;
		return `integer:${truncated}:${negative && !zero ? "negative" : "not-negative"}`;
	}
	if (zero) return "decimal:0";
	return `decimal:${negative ? "-" : ""}${integer === "" ? "0" : integer}${decimals === "" ? "" : `.${decimals}`}`;
}
