import {
	type CasePropertyDataType,
	casePropertyDataTypes,
	TEXT_JOINED_DATA_TYPES,
} from "../casePropertyTypes";
import { unhandledKindMessage } from "./errors";
import type { CheckError, ScalarType } from "./typeChecker";
import {
	type CheckPath,
	type ComparisonKind,
	type Expression,
	isConditionArm,
	type Literal,
	MATCH_MODES,
	type MatchMode,
} from "./types";
export const ANY_TYPE = "_any" as const;

export type ResolvedType = ScalarType;

export const ORDERED_TYPES: ReadonlySet<ResolvedType> = new Set<ResolvedType>([
	"int",
	"decimal",
	"date",
	"datetime",
]);

export const TIME_ORDERING_MESSAGE =
	"A time of day can't be compared with before or after. CommCare compares these as numbers and a time is not one, so the comparison would never be true. A date can be compared this way.";
const MATCH_PROPERTY_TYPES_TEXT_SHAPED: ReadonlySet<ResolvedType> =
	new Set<ResolvedType>(["text", "single_select", "multi_select"]);
const MATCH_PROPERTY_TYPES_FUZZY_DATE: ReadonlySet<ResolvedType> =
	new Set<ResolvedType>([
		"text",
		"single_select",
		"multi_select",
		"date",
		"datetime",
	]);
export const MATCH_PROPERTY_TYPES_BY_MODE: Record<
	MatchMode,
	ReadonlySet<ResolvedType>
> = {
	fuzzy: MATCH_PROPERTY_TYPES_TEXT_SHAPED,
	phonetic: MATCH_PROPERTY_TYPES_TEXT_SHAPED,
	"fuzzy-date": MATCH_PROPERTY_TYPES_FUZZY_DATE,
	"starts-with": MATCH_PROPERTY_TYPES_TEXT_SHAPED,
};

export function describe(t: ScalarType): string {
	return t === ANY_TYPE ? "null" : t;
}
export function isValueStorageAssignable(
	valueType: ResolvedType,
	destinationType: CasePropertyDataType,
): boolean {
	if (valueType === ANY_TYPE) return false;
	if (valueType === destinationType) return true;
	if (valueType === "int" && destinationType === "decimal") return true;
	// One choice is a list of choices holding it alone: a device stores both
	// as the text of their values, space-separated, and a several-choice
	// question reads one choice's value as that one choice
	// (`SelectMultiData.cast` splits the text on spaces).
	if (valueType === "single_select" && destinationType === "multi_select")
		return true;
	return (
		(valueType === "text" || valueType === "single_select") &&
		(destinationType === "text" || destinationType === "single_select")
	);
}

/**
 * The one type a property's writers agree on: the type of theirs that every
 * one of them is storage-assignable to (`isValueStorageAssignable`), so
 * `int` and `decimal` agree on `decimal` (an integer fits decimal storage).
 * `text` and `single_select` are assignable each to the other, since both
 * are stored as the same text, and agree on `text`. `single_select` and
 * `multi_select` agree on `multi_select`, one choice being a list of one.
 * Undefined where no such type exists, as for `multi_select` beside any
 * other type: storage keeps text out of a list of choices, and a list is
 * no one choice or number.
 */
export function agreedStorageType(
	types: Iterable<CasePropertyDataType>,
): CasePropertyDataType | undefined {
	const named = [...new Set(types)];
	const holdsEvery = named.filter((candidate) =>
		named.every((type) => isValueStorageAssignable(type, candidate)),
	);
	if (holdsEvery.length === 1) return holdsEvery[0];
	return holdsEvery.includes("text") ? "text" : undefined;
}

/**
 * Whether writers of `types` that agree on no one type
 * (`agreedStorageType`) can be saved as text: every one of them is a type a
 * text property holds as the text a device submits for it
 * (`casePropertyTypes.ts::TEXT_JOINED_DATA_TYPES`). Whether they are is the
 * property's decision, since a question that opens on the property's value
 * as a number or a date would stop on the others' text
 * (`inference.ts`, the casting readers).
 */
export function joinsAsText(types: Iterable<CasePropertyDataType>): boolean {
	const named = [...new Set(types)];
	return (
		named.length > 1 &&
		named.every((type) => TEXT_JOINED_DATA_TYPES.has(type)) &&
		agreedStorageType(named) === undefined
	);
}

/**
 * Whether a writer's result can be saved to a destination: storage
 * assignability, plus two allowances a writer's verdict alone reads.
 *
 * - An ISO date text (`isoDateText`: a `format-date` with the fixed pattern
 *   `%Y-%m-%d`, `datePattern.ts::isIsoDateText`) into a `date` property. A
 *   follow-up question reads such text back through `DateData.cast` →
 *   `DateUtils.parseDate`, which takes exactly `YYYY-MM-DD`. The value's
 *   type stays `text`, so a comparison or ordering never treats it as a
 *   date. A `datetime` property stays strict, since a day text there saves
 *   midnight, as a `date` value would.
 * - A whole number, a decimal number or a date into a `text` property, which
 *   holds the text a device submits for it
 *   (`casePropertyTypes.ts::TEXT_JOINED_DATA_TYPES`). The value's type stays
 *   its own, and a single choice property stays strict, since a number is no
 *   choice of it.
 */
export function isWriteAssignable(
	valueType: ResolvedType,
	destinationType: CasePropertyDataType,
	isoDateText: boolean,
): boolean {
	return (
		isValueStorageAssignable(valueType, destinationType) ||
		(isoDateText && valueType === "text" && destinationType === "date") ||
		(destinationType === "text" &&
			valueType !== ANY_TYPE &&
			valueType !== "boolean" &&
			TEXT_JOINED_DATA_TYPES.has(valueType))
	);
}

export function isNumeric(t: ResolvedType): boolean {
	return t === "int" || t === "decimal";
}

export function isDateOrDatetime(t: ResolvedType): boolean {
	return t === "date" || t === "datetime";
}

export const TEXT_SHAPED_TYPES: ReadonlySet<ResolvedType> =
	new Set<ResolvedType>(["text", "single_select", "multi_select"]);

export function accumulateBranchType(
	agreed: ResolvedType | undefined,
	candidate: ResolvedType | undefined,
	errors: CheckError[],
	errorPath: CheckPath,
	errorPrefix: string,
): ResolvedType | undefined {
	if (candidate === undefined) return agreed;
	if (candidate === ANY_TYPE) return agreed ?? ANY_TYPE;
	if (agreed === undefined || agreed === ANY_TYPE) return candidate;
	if (typesCompatible(agreed, candidate)) return agreed;
	errors.push({
		path: errorPath,
		code: "branch-values",
		message: `${errorPrefix}; '${describe(candidate)}' is not comparable with the established '${describe(agreed)}'.`,
	});
	return agreed;
}

const ISO_DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME_SHAPE =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.(\d+))?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/;
const TIME_SHAPE = /^\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;

/**
 * The type a string literal's text spells: an ISO date, an ISO date and time
 * (with how many fraction digits its seconds carry), or a time of day. This
 * reads a literal's value, never expression text.
 */
export function literalShape(
	text: string,
):
	| { readonly type: "date" | "time"; readonly fractionDigits: 0 }
	| { readonly type: "datetime"; readonly fractionDigits: number }
	| undefined {
	if (ISO_DATE_SHAPE.test(text)) return { type: "date", fractionDigits: 0 };
	const datetime = ISO_DATETIME_SHAPE.exec(text);
	if (datetime !== null)
		return { type: "datetime", fractionDigits: datetime[1]?.length ?? 0 };
	if (TIME_SHAPE.test(text)) return { type: "time", fractionDigits: 0 };
	return undefined;
}

export function literalType(lit: Literal): ResolvedType {
	if (lit.data_type) return lit.data_type;
	if (lit.value === null) return ANY_TYPE;
	switch (typeof lit.value) {
		case "string":
			return "text";
		case "number":
			return Number.isInteger(lit.value) ? "int" : "decimal";
		case "boolean":
			return "text";
		default: {
			const _exhaustive: never = lit.value;
			throw new Error(
				unhandledKindMessage({
					where: "literalType",
					family: "literal value type (`typeof`)",
					received: typeof _exhaustive,
					knownKinds: ["string", "number", "boolean", "null"],
				}),
			);
		}
	}
}

export function typesCompatible(a: ResolvedType, b: ResolvedType): boolean {
	if (a === ANY_TYPE || b === ANY_TYPE) return true;
	if (a === b) return true;
	if ((a === "int" || a === "decimal") && (b === "int" || b === "decimal"))
		return true;
	if (a === "single_select" && b === "text") return true;
	if (a === "text" && b === "single_select") return true;
	if (a === "multi_select" && b === "text") return true;
	if (a === "text" && b === "multi_select") return true;
	return false;
}

/**
 * The text of a whole number exactly as CommCare writes one: no sign but a
 * leading minus, no leading zero, and inside Java's `int` range, the text
 * `IntegerData.uncast` gives (`Integer.toString`) and the text Nova stores
 * for a whole number.
 */
export function canonicalIntegerText(text: string): number | undefined {
	if (!/^(?:0|-?[1-9][0-9]{0,9})$/.test(text)) return undefined;
	const value = Number(text);
	return value >= -2147483648 && value <= 2147483647 ? value : undefined;
}

/** One operand of an `=`, `!=` or `in` member: its type, and the literal it
 *  is where it is one. */
export interface EqualityOperand {
	readonly type: ResolvedType;
	readonly literal?: Literal;
}

/**
 * A comparison by `=` or `!=` of two types `typesCompatible` keeps apart that
 * every CommCare runtime still answers as its author means, and how.
 * `XPathEqExpr.java::testEquality` compares two values as numbers when either
 * is a number, reading the other through `FunctionUtils.java::toNumeric`, and
 * as text otherwise; a case's property is text on every device.
 *
 * - `integer-text`: a whole number opposite a text literal spelling a whole
 *   number as CommCare writes one (`canonicalIntegerText`). A property holds
 *   that same text, so the text comparison a device makes of a property, and
 *   the number comparison it makes of a calculated whole number, both agree
 *   with comparing the two numbers. `'01'` or `'1.0'` stays refused: a device
 *   compares a property's text `1` with it and finds them different.
 * - `text-number`: a text or single choice value opposite a number literal.
 *   A device reads the text as the number `toNumeric` gives (digits with an
 *   optional minus and point once trimmed, else a `year-month-day` date as
 *   its day number, else no number), so `cut_water = 1` holds where the
 *   choice's value is `1`. A list of choices stays refused, since its text
 *   holds several values.
 */
export function coercedEquality(
	a: EqualityOperand,
	b: EqualityOperand,
): "integer-text" | "text-number" | undefined {
	for (const [value, literal] of [
		[a, b],
		[b, a],
	] as const) {
		const text = literal.literal;
		if (
			value.type === "int" &&
			text !== undefined &&
			text.data_type === undefined &&
			typeof text.value === "string" &&
			canonicalIntegerText(text.value) !== undefined
		)
			return "integer-text";
		if (
			(value.type === "text" || value.type === "single_select") &&
			literal.literal !== undefined &&
			typeof literal.literal.value === "number" &&
			isNumeric(literal.type)
		)
			return "text-number";
	}
	return undefined;
}

export const ALL_RESOLVED_TYPES: readonly ResolvedType[] = [
	...casePropertyDataTypes,
	"boolean",
	ANY_TYPE,
] satisfies ResolvedType[];

export function compatibleTypesFor(
	t: ResolvedType | undefined,
): ReadonlySet<ResolvedType> {
	if (t === undefined) return new Set(ALL_RESOLVED_TYPES);
	return new Set(ALL_RESOLVED_TYPES.filter((u) => typesCompatible(t, u)));
}

export function comparisonObjectTypesFor(
	kind: ComparisonKind,
	t: ResolvedType | undefined,
): ReadonlySet<ResolvedType> {
	const compatible = compatibleTypesFor(t);
	if (kind === "eq" || kind === "neq") return compatible;
	return new Set(
		[...compatible].filter(
			(type) => type === ANY_TYPE || ORDERED_TYPES.has(type),
		),
	);
}

export function comparisonOperatorsFor(
	t: ResolvedType | undefined,
): ReadonlySet<ComparisonKind> {
	const all: ComparisonKind[] = ["eq", "neq", "gt", "gte", "lt", "lte"];
	if (t === undefined || t === ANY_TYPE || ORDERED_TYPES.has(t)) {
		return new Set(all);
	}
	return new Set<ComparisonKind>(["eq", "neq"]);
}

export function matchModesFor(
	t: ResolvedType | undefined,
): ReadonlySet<MatchMode> {
	if (t === undefined || t === ANY_TYPE) return new Set(MATCH_MODES);
	return new Set(
		MATCH_MODES.filter((m) => MATCH_PROPERTY_TYPES_BY_MODE[m].has(t)),
	);
}

export type ValueExpressionResultClass =
	| "numeric"
	| "text"
	| "date"
	| "datetime"
	| "date-or-datetime"
	| "int"
	| "depends";

export function valueExpressionKindResultClass(
	kind: Expression["kind"],
): ValueExpressionResultClass {
	switch (kind) {
		case "arith":
		case "negate":
		case "double":
			return "numeric";
		case "concat":
		case "format-date":
		case "id-of":
		case "acting-user":
		case "unowned":
			return "text";
		case "today":
			return "date";
		case "now":
			return "datetime";
		case "date-add":
			return "date-or-datetime";
		case "date-coerce":
			return "date";
		case "datetime-coerce":
			return "datetime";
		case "count":
			return "int";
		case "term":
		case "if":
		case "switch":
		case "coalesce":
		case "table-lookup":
			return "depends";
		default:
			// General expressions are resolved from their children and slot context.
			return "depends";
	}
}

export type RecordPosition = "condition" | "value";
/**
 * Whether an expression of `kind` stands in a record `position`. A condition
 * stands where a condition belongs and a value where a value belongs; `if`
 * and `switch` stand in either. One read stands as a condition too: a read
 * of a single node whose value CommCare holds as a yes or no (`heldYesNo`),
 * such as a Hidden Value calculated by a condition. Core holds a calculated
 * `Boolean` as `BooleanData` whatever the node's bind
 * (`Recalculate.java::wrapData`) and reads it back as that `Boolean`
 * (`XPathPathExpr.java::unpackValue`), so its truth is the calculation's. A
 * read of text never stands as one: Core reads text as true when it is not
 * empty (`FunctionUtils.java::toBoolean`), so a stored `0` would hold.
 */
export function recordPositionVerdict(
	kind: Expression["kind"],
	position: RecordPosition,
	heldYesNo = false,
):
	| { readonly ok: true }
	| {
			readonly ok: false;
			readonly reason: "value-expected" | "condition-expected";
	  } {
	if (kind === "if" || kind === "switch") return { ok: true };
	if (kind === "term" && position === "condition" && heldYesNo)
		return { ok: true };
	const condition = isConditionArm({ kind } as Expression);
	return condition === (position === "condition")
		? { ok: true }
		: {
				ok: false,
				reason:
					position === "condition" ? "condition-expected" : "value-expected",
			};
}

export type ExpressionResultClass = ValueExpressionResultClass;
