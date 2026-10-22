/**
 * How each side of a comparison holds a date and time on a device, and
 * whether the comparison is an instant comparison. The checker reads it to
 * refuse a comparison no device can answer as one between moments; the
 * on-device emitter reads it to choose each operand's instant text. Both read
 * this one classification, so neither can lower or refuse what the other does
 * not.
 *
 * A comparison is classified by its operands' leaves: an `if`, `coalesce` or
 * `switch` passes the value of one branch through unchanged
 * (`XPathIfFunc.evalBody`, `XpathCoalesceFunc.evalBody`), so each branch keeps
 * its own held representation, and the composite's type alone cannot say what
 * a device holds (a form rule set types `if(c, now(), #form/dt)` as nothing,
 * since `now()` is a scalar and the read a node).
 */
import type { ExpressionContext } from "./context";
import {
	ANY_TYPE,
	literalShape,
	literalType,
	TEXT_SHAPED_TYPES,
} from "./ruleSets";
import {
	formLiteralsShaped,
	type NodeType,
	type ScalarType,
	scalarDataType,
	typeOf,
} from "./typeChecker";
import type { Expression, Literal } from "./types";

const LITERAL_INSTANT =
	/^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?([Zz]|[+-]\d{2}(?::?\d{2})?)?)?$/;

/** Days since 1970-01-01 of a proleptic Gregorian date (era arithmetic, the
 * same days the device parse computes,
 * `lib/commcare/xpath/wire/instant.ts::instantMicros`). */
function daysFromCivil(year: number, month: number, day: number): number {
	const y = year - (month <= 2 ? 1 : 0);
	const era = Math.floor(y / 400);
	const yearOfEra = y - era * 400;
	const dayOfYear = Math.floor((153 * ((month + 9) % 12) + 2) / 5) + day - 1;
	const dayOfEra =
		yearOfEra * 365 +
		Math.floor(yearOfEra / 4) -
		Math.floor(yearOfEra / 100) +
		dayOfYear;
	return era * 146097 + dayOfEra - 719468;
}

function daysInMonth(year: number, month: number): number {
	return month === 2
		? year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
			? 29
			: 28
		: [4, 6, 9, 11].includes(month)
			? 30
			: 31;
}

/** A date-and-time literal read by its fields: the authored date and clock,
 * the fraction's digits, and the written offset in seconds east of UTC with
 * its hours and minutes as written. */
interface LiteralInstant {
	readonly date: string;
	readonly hour: string;
	readonly minute: string;
	readonly second: string;
	readonly fraction: string | undefined;
	readonly offset: {
		readonly seconds: number;
		readonly hours: string;
		readonly minutes: string;
	};
	readonly days: number;
}

/**
 * A literal's fields, or undefined when it names no moment. It reads a date
 * (its UTC midnight) or a date and time with a `T`, `t` or space, minutes,
 * seconds and any fraction, and `Z`, `z`, `±HH`, `±HHMM`, `±HH:MM` or no
 * offset (UTC). The month and day must exist and the clock run to 23:59:59,
 * as Core's `DateFields.check` requires; an offset's hours and minutes are
 * any two digits, which Core reads as integers and adds to the clock
 * (`DateUtils.parseTimeAndStore`).
 */
function parseLiteralInstant(text: string): LiteralInstant | undefined {
	const match = LITERAL_INSTANT.exec(text);
	if (match === null) return undefined;
	const [, y, mo, d, h = "00", mi = "00", s = "00", fraction, zone] = match;
	const year = Number(y),
		month = Number(mo),
		day = Number(d);
	if (
		month < 1 ||
		month > 12 ||
		day < 1 ||
		day > daysInMonth(year, month) ||
		Number(h) > 23 ||
		Number(mi) > 59 ||
		Number(s) > 59
	)
		return undefined;
	let offset = { seconds: 0, hours: "00", minutes: "00" };
	if (zone !== undefined && zone !== "Z" && zone !== "z") {
		const digits = zone.slice(1).replace(":", "");
		const hours = digits.slice(0, 2);
		const minutes = digits.slice(2) || "00";
		offset = {
			seconds:
				(zone[0] === "-" ? -1 : 1) *
				(Number(hours) * 3600 + Number(minutes) * 60),
			hours,
			minutes,
		};
	}
	return {
		date: `${y}-${mo}-${d}`,
		hour: h,
		minute: mi,
		second: s,
		fraction,
		offset,
		days: daysFromCivil(year, month, day),
	};
}

/**
 * A literal's moment in integer microseconds, or undefined when the literal
 * names none (`parseLiteralInstant`). A fraction is rounded to the
 * microsecond as the device parse rounds it. This reads a literal's value,
 * never expression text.
 */
export function literalInstantMicros(text: string): number | undefined {
	const literal = parseLiteralInstant(text);
	if (literal === undefined) return undefined;
	const seconds =
		literal.days * 86400 +
		Number(literal.hour) * 3600 +
		Number(literal.minute) * 60 +
		Number(literal.second) -
		literal.offset.seconds;
	const micros =
		literal.fraction === undefined
			? 0
			: Math.floor(Number(`0.${literal.fraction}`) * 1_000_000 + 0.5);
	// The device parse's own double operations, in its order: past 2^53
	// microseconds (the year 2255) both round alike.
	return seconds * 1_000_000 + micros;
}

/**
 * The text a device prints for a literal, or undefined when it names no
 * moment: the authored date and clock with seconds, the fraction's own
 * digits (at least three), and the literal's own offset, `Z` or `±HH:MM`.
 * Keeping the authored date and offset spells every literal with its own
 * four-digit year, which the device parse reads by position
 * (`lib/commcare/xpath/wire/instant.ts::instantMicros`) to the same
 * microseconds `literalInstantMicros` gives, and which Core's own parse reads
 * with the authored date (`DateUtils.parseTimeAndStore` applies an offset to
 * the clock only).
 */
export function literalInstantText(text: string): string | undefined {
	const literal = parseLiteralInstant(text);
	if (literal === undefined) return undefined;
	const { offset } = literal;
	const zone =
		offset.seconds === 0
			? "Z"
			: `${offset.seconds < 0 ? "-" : "+"}${offset.hours}:${offset.minutes}`;
	return `${literal.date}T${literal.hour}:${literal.minute}:${literal.second}.${(literal.fraction ?? "").padEnd(3, "0")}${zone}`;
}

export type InstantComparisonKind = "eq" | "neq" | "lt" | "lte" | "gt" | "gte";

/** What one leaf of an operand holds on a device:
 * - `literal-instant`: a date-and-time literal, or a `datetime-coerce` of a
 *   date literal, folded at emission (`dayAligned` for the latter);
 * - `text`: date-and-time text (a case property, a Hidden Value holding text,
 *   a lookup column, a Search answer, a worker or session value);
 * - `typed`: a typed date and time (a date-and-time question, a Hidden Value
 *   bound `xsd:dateTime`, `now()`);
 * - `coerced-date-typed` / `coerced-date-text`: a `datetime-coerce` of a typed
 *   date or of date text, the date's UTC midnight;
 * - `coerced-text`: a `datetime-coerce` of text, a date or a date and time;
 * - `epoch-days`: a `datetime-coerce` of a number of days since 1970-01-01;
 * - `day-only`: `date_opened` or `last_modified` read from `casedb`, which
 *   Core holds as the device's day (`CaseChildElement.java`, `DateData`);
 * - `clock-lost`: a date and time some value of which kept only its day;
 * - `not-instant`: a value that names no moment (blank, text, a number, a
 *   date), `data` its type;
 * - `unknown`: a value of no known type, `held` what its node holds. */
export type InstantLeaf =
	| {
			readonly kind: "leaf";
			readonly class: "literal-instant";
			readonly value: Expression;
			readonly literal: Literal & { readonly value: string };
			readonly dayAligned: boolean;
	  }
	| {
			readonly kind: "leaf";
			readonly class:
				| "text"
				| "typed"
				| "clock-lost"
				| "coerced-date-typed"
				| "coerced-date-text"
				| "coerced-text"
				| "epoch-days";
			readonly value: Expression;
	  }
	| {
			readonly kind: "leaf";
			readonly class: "day-only";
			readonly value: Expression;
			readonly property: "date_opened" | "last_modified";
	  }
	| {
			readonly kind: "leaf";
			readonly class: "not-instant";
			readonly value: Expression;
			readonly data?: ScalarType;
	  }
	| {
			readonly kind: "leaf";
			readonly class: "unknown";
			readonly value: Expression;
			readonly held?: "boolean" | "number" | "string" | "date";
	  };
export type InstantLeafClass = InstantLeaf["class"];

/** An operand's tree of branches. `source` is the composite whose condition
 * (or switch subject) chooses the branch; a `datetime-coerce` of a composite
 * distributes over its branches, so its branches are coerced leaves. */
export type InstantOperand =
	| InstantLeaf
	| {
			readonly kind: "if";
			readonly source: Extract<Expression, { kind: "if" }>;
			readonly whenTrue: InstantOperand;
			readonly whenFalse: InstantOperand;
	  }
	| {
			readonly kind: "coalesce";
			readonly source: Extract<Expression, { kind: "coalesce" }>;
			readonly values: readonly InstantOperand[];
	  }
	| {
			readonly kind: "switch";
			readonly source: Extract<Expression, { kind: "switch" }>;
			readonly cases: readonly InstantOperand[];
			readonly fallback: InstantOperand;
	  };

const INSTANT_CLASSES: ReadonlySet<InstantLeafClass> = new Set([
	"literal-instant",
	"text",
	"typed",
	"coerced-date-typed",
	"coerced-date-text",
	"coerced-text",
	"epoch-days",
	"day-only",
	"clock-lost",
]);

const SYSTEM_DATES: ReadonlySet<string> = new Set([
	"date_opened",
	"last_modified",
]);

function heldOf(
	type: NodeType | undefined,
): "boolean" | "number" | "string" | "date" | undefined {
	if (type === undefined || type.held === "sequence") return undefined;
	return typeof type.held === "object" ? type.held.nodes : type.held;
}

/** A form question's held class when its read has no type of its own. */
function fieldHeld(
	expression: Expression,
	ctx: ExpressionContext,
): "boolean" | "number" | "string" | "date" | undefined {
	if (expression.kind !== "term" || expression.term.kind !== "field")
		return undefined;
	const held = ctx.form?.fields.get(expression.term.uuid)?.held;
	return held === undefined || typeof held === "object" || held === "sequence"
		? undefined
		: held;
}

/** `date_opened` or `last_modified` read as one case row's value. */
function systemDateRead(
	expression: Expression,
): "date_opened" | "last_modified" | undefined {
	const read =
		expression.kind === "term"
			? expression.term
			: expression.kind === "project"
				? expression.value
				: undefined;
	if (
		read === undefined ||
		(read.kind !== "prop" && read.kind !== "form-case") ||
		!SYSTEM_DATES.has(read.property)
	)
		return undefined;
	return read.property as "date_opened" | "last_modified";
}

function directLiteral(expression: Expression): Literal | undefined {
	return expression.kind === "term" && expression.term.kind === "literal"
		? expression.term
		: undefined;
}

function literalInstant(
	value: Expression,
	literal: Literal,
	dayAligned: boolean,
): InstantLeaf {
	return typeof literal.value === "string" && literal.value !== ""
		? {
				kind: "leaf",
				class: "literal-instant",
				value,
				literal: literal as Literal & { readonly value: string },
				dayAligned,
			}
		: { kind: "leaf", class: "not-instant", value, data: "datetime" };
}

/**
 * How one operand's leaves are typed:
 * - `literals`: in form logic, how an untyped literal leaf is typed, branch or
 *   direct operand alike. `shaped` where the comparison types a string literal
 *   by the ISO shape it spells (`typeChecker.ts::formLiteralsShaped`), `text`
 *   where it stays text; absent in a record slot, where a literal has the type
 *   its `data_type` names and no other.
 * - `typeOf`: the type of a leaf, where the caller already holds it; the
 *   checker's own inference otherwise.
 * - `memo`: operands already classified in this context, so a caller that
 *   meets one expression several times (a `switch` subject, a side shared by
 *   `in` or `between`) classifies it once.
 */
export interface InstantOperandTyping {
	readonly literals?: "shaped" | "text";
	readonly typeOf?: (expression: Expression) => NodeType | undefined;
	readonly memo?: InstantOperandMemo;
}
/** Operands classified in one context, by expression and literal typing. */
export type InstantOperandMemo = WeakMap<
	Expression,
	Partial<Record<"shaped" | "text" | "record", InstantOperand>>
>;

/** A leaf classified by its type and held representation. */
function byType(
	value: Expression,
	type: NodeType | undefined,
	ctx: ExpressionContext,
): InstantLeaf {
	const data = scalarDataType(type?.data);
	const held = heldOf(type) ?? fieldHeld(value, ctx);
	if (
		type?.clockLost === true &&
		(data === "datetime" || data === ANY_TYPE || data === undefined)
	)
		return { kind: "leaf", class: "clock-lost", value };
	if (data === "datetime") {
		const property = held === "date" ? systemDateRead(value) : undefined;
		if (property !== undefined)
			return { kind: "leaf", class: "day-only", value, property };
		if (held === "date") return { kind: "leaf", class: "typed", value };
		if (held === "string") return { kind: "leaf", class: "text", value };
		return {
			kind: "leaf",
			class: "unknown",
			value,
			...(held === undefined ? {} : { held }),
		};
	}
	if (data === undefined || data === ANY_TYPE)
		return {
			kind: "leaf",
			class: "unknown",
			value,
			...(held === undefined ? {} : { held }),
		};
	return { kind: "leaf", class: "not-instant", value, data };
}

/** A literal leaf's type: its `data_type`, or in form logic the type the
 * form rule set gives it (`literalType`, a string by its shape where the
 * comparison shapes it). */
function literalLeafType(
	literal: Literal,
	literals: InstantOperandTyping["literals"],
): ScalarType | undefined {
	if (literal.data_type !== undefined) return literal.data_type;
	if (literals === undefined) return undefined;
	if (literals === "shaped" && typeof literal.value === "string")
		return literalShape(literal.value)?.type ?? literalType(literal);
	return literalType(literal);
}

/** The leaves a `datetime-coerce` of `inner` holds. */
function coerced(
	inner: Expression,
	ctx: ExpressionContext,
	typeOfLeaf: (expression: Expression) => NodeType | undefined,
): InstantOperand {
	switch (inner.kind) {
		case "if":
			return {
				kind: "if",
				source: inner,
				whenTrue: coerced(inner.then, ctx, typeOfLeaf),
				whenFalse: coerced(inner.else, ctx, typeOfLeaf),
			};
		case "coalesce":
			return {
				kind: "coalesce",
				source: inner,
				values: inner.values.map((value) => coerced(value, ctx, typeOfLeaf)),
			};
		case "switch":
			return {
				kind: "switch",
				source: inner,
				cases: inner.cases.map((entry) => coerced(entry.then, ctx, typeOfLeaf)),
				fallback: coerced(inner.fallback, ctx, typeOfLeaf),
			};
		case "datetime-coerce":
			return coerced(inner.value, ctx, typeOfLeaf);
		default:
			break;
	}
	const literal = directLiteral(inner);
	if (literal !== undefined) {
		if (typeof literal.value === "number")
			return { kind: "leaf", class: "epoch-days", value: inner };
		if (typeof literal.value !== "string" || literal.value === "")
			return { kind: "leaf", class: "not-instant", value: inner };
		const shape = literalShape(literal.value)?.type;
		if (
			literal.data_type === "date" ||
			literal.data_type === "datetime" ||
			shape === "date" ||
			shape === "datetime"
		)
			return literalInstant(
				inner,
				literal,
				literal.data_type === "date" ||
					(literal.data_type === undefined && shape === "date"),
			);
		return { kind: "leaf", class: "coerced-text", value: inner };
	}
	const type = typeOfLeaf(inner);
	const data = scalarDataType(type?.data);
	const held = heldOf(type) ?? fieldHeld(inner, ctx);
	if (type?.clockLost === true)
		return { kind: "leaf", class: "clock-lost", value: inner };
	if (data === "date")
		return {
			kind: "leaf",
			class: held === "date" ? "coerced-date-typed" : "coerced-date-text",
			value: inner,
		};
	if (data === "datetime") return byType(inner, type, ctx);
	if (data === "int" || data === "decimal")
		return { kind: "leaf", class: "epoch-days", value: inner };
	if (data !== undefined && TEXT_SHAPED_TYPES.has(data))
		return { kind: "leaf", class: "coerced-text", value: inner };
	if (data === undefined || data === ANY_TYPE) {
		if (held === "date") return { kind: "leaf", class: "typed", value: inner };
		if (held === "string")
			return { kind: "leaf", class: "coerced-text", value: inner };
		if (held === "number")
			return { kind: "leaf", class: "epoch-days", value: inner };
		return {
			kind: "leaf",
			class: "unknown",
			value: inner,
			...(held === undefined ? {} : { held }),
		};
	}
	return { kind: "leaf", class: "not-instant", value: inner, data };
}

/**
 * One operand's leaves. A literal leaf, a direct operand or a branch of an
 * `if`, `coalesce` or `switch`, is typed as `typing.literals` says, so a form
 * string literal shaped as a date and time is one wherever its comparison
 * types it so, and is folded as one.
 */
export function instantOperand(
	expression: Expression,
	ctx: ExpressionContext,
	typing: InstantOperandTyping = {},
): InstantOperand {
	const slot = typing.literals ?? "record";
	const memoised = typing.memo?.get(expression)?.[slot];
	if (memoised !== undefined) return memoised;
	const operand = classifyOperand(expression, ctx, typing);
	if (typing.memo !== undefined)
		typing.memo.set(expression, {
			...typing.memo.get(expression),
			[slot]: operand,
		});
	return operand;
}
function classifyOperand(
	expression: Expression,
	ctx: ExpressionContext,
	typing: InstantOperandTyping,
): InstantOperand {
	const typeOfLeaf =
		typing.typeOf ?? ((value: Expression) => typeOf(value, ctx));
	const branch = (value: Expression): InstantOperand =>
		instantOperand(value, ctx, { ...typing, typeOf: typeOfLeaf });
	switch (expression.kind) {
		case "if":
			return {
				kind: "if",
				source: expression,
				whenTrue: branch(expression.then),
				whenFalse: branch(expression.else),
			};
		case "coalesce":
			return {
				kind: "coalesce",
				source: expression,
				values: expression.values.map(branch),
			};
		case "switch":
			return {
				kind: "switch",
				source: expression,
				cases: expression.cases.map((entry) => branch(entry.then)),
				fallback: branch(expression.fallback),
			};
		case "datetime-coerce":
			return coerced(expression.value, ctx, typeOfLeaf);
		default:
			break;
	}
	const literal = directLiteral(expression);
	if (literal !== undefined) {
		const data = literalLeafType(literal, typing.literals);
		return data === "datetime"
			? literalInstant(expression, literal, false)
			: {
					kind: "leaf",
					class: "not-instant",
					value: expression,
					...(data === undefined ? {} : { data }),
				};
	}
	return byType(expression, typeOfLeaf(expression), ctx);
}

/** Both sides of a comparison, each literal leaf typed as the form rule set
 * types the comparison's own literals (`typeChecker.ts::formLiteralsShaped`).
 * `typing.typeOf` serves the types the caller already holds. */
export function comparisonOperands(
	expression: Extract<Expression, { kind: InstantComparisonKind }>,
	ctx: ExpressionContext,
	typing: Omit<InstantOperandTyping, "literals"> = {},
): { readonly left: InstantOperand; readonly right: InstantOperand } {
	if (ctx.ruleSet !== "form")
		return {
			left: instantOperand(expression.left, ctx, typing),
			right: instantOperand(expression.right, ctx, typing),
		};
	const typeOfLeaf =
		typing.typeOf ?? ((value: Expression) => typeOf(value, ctx));
	const shaped = formLiteralsShaped(
		expression,
		scalarDataType(typeOfLeaf(expression.left)?.data),
		scalarDataType(typeOfLeaf(expression.right)?.data),
	);
	return {
		left: instantOperand(expression.left, ctx, {
			...typing,
			literals: shaped.left ? "shaped" : "text",
			typeOf: typeOfLeaf,
		}),
		right: instantOperand(expression.right, ctx, {
			...typing,
			literals: shaped.right ? "shaped" : "text",
			typeOf: typeOfLeaf,
		}),
	};
}

export function instantLeaves(operand: InstantOperand): readonly InstantLeaf[] {
	switch (operand.kind) {
		case "leaf":
			return [operand];
		case "if":
			return [
				...instantLeaves(operand.whenTrue),
				...instantLeaves(operand.whenFalse),
			];
		case "coalesce":
			return operand.values.flatMap(instantLeaves);
		case "switch":
			return [
				...operand.cases.flatMap(instantLeaves),
				...instantLeaves(operand.fallback),
			];
	}
}

/** Some value the operand can take names a moment. */
export function holdsInstant(operand: InstantOperand): boolean {
	return instantLeaves(operand).some((leaf) => INSTANT_CLASSES.has(leaf.class));
}

function instantClasses(operand: InstantOperand): readonly InstantLeaf[] {
	return instantLeaves(operand).filter((leaf) =>
		INSTANT_CLASSES.has(leaf.class),
	);
}

/** Every moment the operand names is a casedb system date: a day. */
export function isDayOnly(operand: InstantOperand): boolean {
	const leaves = instantClasses(operand);
	return leaves.length > 0 && leaves.every((leaf) => leaf.class === "day-only");
}

/** Every moment the operand names is a day's start, or a system date's day:
 * a `datetime-coerce` of a date, of a date literal or of a day number. */
export function isDayAligned(operand: InstantOperand): boolean {
	const leaves = instantClasses(operand);
	return (
		leaves.length > 0 &&
		leaves.every(
			(leaf) =>
				leaf.class === "day-only" ||
				leaf.class === "coerced-date-typed" ||
				leaf.class === "coerced-date-text" ||
				leaf.class === "epoch-days" ||
				(leaf.class === "literal-instant" && leaf.dayAligned),
		)
	);
}

/** Some value the operand can take is of no known type, which takes the row
 * of its held representation against a moment. */
function holdsUnknown(operand: InstantOperand): boolean {
	return instantLeaves(operand).some((leaf) => leaf.class === "unknown");
}

/**
 * How a comparison runs on a device:
 * - `lowered`: both sides compared as instants, in integer microseconds;
 * - `day`: a casedb system date ordered against a day-aligned operand, or two
 *   system dates, which compare by day as Core holds them (`date(x)` for a
 *   coerced side);
 * - `bare`: as written, where no side is a moment, or (an equality) one side
 *   is neither a moment nor of unknown type: `x = ''` is the blank test.
 *
 * A side of unknown type against a moment takes the row of its held
 * representation, under an ordering and an equality alike, so an untyped
 * Hidden Value holding a moment's text equals that moment in every spelling.
 */
export function comparisonPlan(
	kind: InstantComparisonKind,
	left: InstantOperand,
	right: InstantOperand,
): "lowered" | "day" | "bare" {
	const ordering = kind !== "eq" && kind !== "neq";
	const leftInstant = holdsInstant(left),
		rightInstant = holdsInstant(right);
	if (!leftInstant && !rightInstant) return "bare";
	if (isDayOnly(left) && isDayOnly(right)) return "day";
	if (!ordering)
		return (leftInstant || holdsUnknown(left)) &&
			(rightInstant || holdsUnknown(right))
			? "lowered"
			: "bare";
	if (
		(isDayOnly(left) && isDayAligned(right)) ||
		(isDayOnly(right) && isDayAligned(left))
	)
		return "day";
	return "lowered";
}

/** A literal of a known kind other than a date and time that is not blank
 * (text that spells no moment, a number, a date): a lowered comparison would
 * read it as no moment. A blank literal names no moment and reads as none. */
function otherKindLiteral(leaf: InstantLeaf): boolean {
	if (leaf.class !== "not-instant") return false;
	const literal = directLiteral(leaf.value);
	return (
		literal !== undefined &&
		literal.value !== null &&
		literal.value !== "" &&
		leaf.data !== undefined &&
		leaf.data !== ANY_TYPE &&
		leaf.data !== "datetime"
	);
}

/** The leaves a lowered comparison cannot print as an instant: a casedb
 * system date (its day only), a clock-lost value, a date, a date-and-time
 * literal that names no moment, a literal of another kind, and a value of
 * unknown type whose node holds neither text nor a typed date. Empty when
 * every leaf has an instant text. */
export function unlowerableLeaves(
	operand: InstantOperand,
): readonly InstantLeaf[] {
	return instantLeaves(operand).filter(
		(leaf) =>
			leaf.class === "day-only" ||
			(leaf.class === "literal-instant" &&
				literalInstantMicros(leaf.literal.value) === undefined) ||
			leaf.class === "clock-lost" ||
			(leaf.class === "not-instant" && leaf.data === "date") ||
			otherKindLiteral(leaf) ||
			(leaf.class === "unknown" &&
				leaf.held !== "string" &&
				leaf.held !== "date"),
	);
}

/** The literal leaves of an operand that name no moment though written as a
 * date or a date and time: what a `datetime-coerce` printed as a value
 * cannot spell (`instant.ts::datetimeCoerceValue`). */
export function unreadableInstantLiterals(
	operand: InstantOperand,
): readonly Extract<InstantLeaf, { class: "literal-instant" }>[] {
	return instantLeaves(operand).filter(
		(leaf): leaf is Extract<InstantLeaf, { class: "literal-instant" }> =>
			leaf.class === "literal-instant" &&
			literalInstantMicros(leaf.literal.value) === undefined,
	);
}
