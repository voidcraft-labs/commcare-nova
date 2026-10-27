/**
 * The instant lowering: a comparison between dates and times compares their
 * moments, in integer microseconds since 1970-01-01T00:00:00Z, on every
 * device. Core compares two values through `FunctionUtils.toNumeric`, which
 * turns a typed `Date` into whole days and date-and-time text into NaN
 * (`XPathCmpExpr.evalRaw`), and compares two strings by text
 * (`XPathEqExpr.testEquality`), so neither the bare ordering nor the bare
 * equality is one between moments.
 *
 * Each operand becomes an instant text `T` by how its device holds it
 * (`lib/domain/expression/instantOperand.ts` classifies it), and `T` is read by
 * one parse whose every sub-term is built once and shared, so the print, which
 * memoises shared nodes, stays linear in its bytes.
 */

import { INSTANT_TEXT_PATTERN } from "@/lib/domain/expression/datePattern";
import {
	type InstantLeaf,
	type InstantOperand,
	literalInstantMicros,
	literalInstantText,
	unlowerableLeaves,
} from "@/lib/domain/expression/instantOperand";
import type { Expression } from "@/lib/domain/expression/types";
import { w } from "./builders";
import type { WireExpr } from "./tree";

const MICROS_PER_DAY = 86_400_000_000;

/**
 * Integer microseconds of instant text `t`: days from the civil date (era
 * arithmetic) times 86,400, plus the clock, minus the written offset, then
 * microseconds plus the rounded fraction. It reads `Z` or `z`, `±HH`,
 * `±HH:MM`, `±HHMM` or no offset (read as UTC), any number of fraction digits
 * (rounded to the microsecond as Core's `round` does, `floor(x + 0.5)`), and a
 * `T`, `t` or space between the date and the clock, which it reads by
 * position. Blank or malformed text reads as NaN or a defined number, never
 * an error: Core's `substring-after` returns the whole string when the
 * separator is absent and `substr` returns `''` past the end
 * (`XPathSubstringAfterFunc.java::substringAfter`,
 * `XPathSubstrFunc.java::substring`), which the offset guard is for.
 */
export function instantMicros(t: WireExpr): WireExpr {
	const field = (start: number, end: number) =>
		w.call("number", [w.call("substr", [t, w.num(start), w.num(end)])]);
	const year = field(0, 4);
	const month = field(5, 7);
	const day = field(8, 10);
	const tail = w.call("substr", [t, w.num(19)]);
	const marked = w.call("translate", [tail, w.str("Zz+-"), w.str("||||")]);
	const offset = w.call("if", [
		w.call("contains", [marked, w.str("|")]),
		w.call("substring-after", [marked, w.str("|")]),
		w.str(""),
	]);
	const offsetLength = w.call("string-length", [offset]);
	// The March-based year: January and February count with the year before.
	const y = w.sub(year, w.cmp("<=", month, w.num(2)));
	const era = w.call("floor", [w.div(y, w.num(400))]);
	const yearOfEra = w.sub(y, w.mul(era, w.num(400)));
	const dayOfYear = w.sub(
		w.add(
			w.call("floor", [
				w.div(
					w.add(
						w.mul(w.num(153), w.mod(w.add(month, w.num(9)), w.num(12))),
						w.num(2),
					),
					w.num(5),
				),
			]),
			day,
		),
		w.num(1),
	);
	const dayOfEra = w.add(
		w.sub(
			w.add(
				w.mul(yearOfEra, w.num(365)),
				w.call("floor", [w.div(yearOfEra, w.num(4))]),
			),
			w.call("floor", [w.div(yearOfEra, w.num(100))]),
		),
		dayOfYear,
	);
	const days = w.sub(w.add(w.mul(era, w.num(146097)), dayOfEra), w.num(719468));
	const offsetSeconds = w.call("if", [
		w.eq(offset, w.str("")),
		w.num(0),
		w.mul(
			w.call("if", [
				w.call("contains", [tail, w.str("-")]),
				w.num(-1),
				w.num(1),
			]),
			w.add(
				w.mul(
					w.call("number", [w.call("substr", [offset, w.num(0), w.num(2)])]),
					w.num(3600),
				),
				w.call("if", [
					w.gt(offsetLength, w.num(2)),
					w.mul(
						w.call("number", [
							w.call("substr", [offset, w.sub(offsetLength, w.num(2))]),
						]),
						w.num(60),
					),
					w.num(0),
				]),
			),
		),
	]);
	const seconds = w.sub(
		w.add(
			w.add(
				w.add(w.mul(days, w.num(86400)), w.mul(field(11, 13), w.num(3600))),
				w.mul(field(14, 16), w.num(60)),
			),
			field(17, 19),
		),
		offsetSeconds,
	);
	const fraction = w.call("if", [
		w.call("starts-with", [tail, w.str(".")]),
		w.call("round", [
			w.mul(
				w.call("number", [
					w.call("concat", [
						w.str("0"),
						w.call("substring-before", [
							w.call("concat", [marked, w.str("|")]),
							w.str("|"),
						]),
					]),
				]),
				w.num(1_000_000),
			),
		]),
		w.num(0),
	]);
	return w.add(w.mul(seconds, w.num(1_000_000)), fraction);
}

const UNREADABLE = (value: string) =>
	`The date-and-time value '${value}' names no moment, so no device text spells it. The checker should refuse it (unreadable-datetime) before emission.`;

function folded(leaf: Extract<InstantLeaf, { class: "literal-instant" }>) {
	const micros = literalInstantMicros(leaf.literal.value);
	if (micros === undefined) throw new Error(UNREADABLE(leaf.literal.value));
	return micros;
}

/** A literal's text as a device prints it (`literalInstantText`): its own
 * date, clock and offset, which the parse reads back to its microseconds. */
function literalText(leaf: Extract<InstantLeaf, { class: "literal-instant" }>) {
	const text = literalInstantText(leaf.literal.value);
	if (text === undefined) throw new Error(UNREADABLE(leaf.literal.value));
	return text;
}

/** A typed date and time's own text, with the device's offset and
 * milliseconds. Core's `format-date` of a node set passes through `toDate`,
 * which rounds a typed `Date` to the day; `coalesce` unpacks the node first. */
export function typedInstantText(value: WireExpr): WireExpr {
	return w.call("format-date", [
		w.call("coalesce", [value, w.str("")]),
		w.str(INSTANT_TEXT_PATTERN),
	]);
}

function blankGuard(value: WireExpr, text: WireExpr): WireExpr {
	return w.call("if", [w.eq(value, w.str("")), w.str(""), text]);
}

/** A typed date's UTC midnight. */
function typedDateMidnight(value: WireExpr, suffix: string): WireExpr {
	return w.call("concat", [
		w.call("format-date", [
			w.call("coalesce", [value, w.str("")]),
			w.str("%Y-%m-%d"),
		]),
		w.str(suffix),
	]);
}

/** Text coerced to a date and time: date-only text (ten characters) starts
 * at its UTC midnight; anything else is read as date-and-time text. Blank
 * stays blank. */
function coercedTextInstant(value: WireExpr, suffix: string): WireExpr {
	return w.call("if", [
		w.eq(w.call("string-length", [value]), w.num(10)),
		w.call("concat", [value, w.str(suffix)]),
		value,
	]);
}

function epochDayMidnight(value: WireExpr, suffix: string): WireExpr {
	return w.call("concat", [
		w.call("format-date", [w.call("date", [value]), w.str("%Y-%m-%d")]),
		w.str(suffix),
	]);
}

/** How a lowered comparison emits the expressions an operand's tree names. */
export interface InstantEmission {
	value(expression: Expression): WireExpr;
	/** An `if`'s condition, in the position the emitter gives it. */
	condition(expression: Expression): WireExpr;
	/** A `switch`'s case tests, its subject emitted once. */
	switchTests(
		expression: Extract<Expression, { kind: "switch" }>,
	): readonly WireExpr[];
}

function directLiteralValue(expression: Expression) {
	return expression.kind === "term" && expression.term.kind === "literal"
		? expression.term.value
		: undefined;
}

function refuseUnlowerable(operand: InstantOperand): void {
	const [leaf] = unlowerableLeaves(operand);
	if (leaf === undefined) return;
	throw new Error(
		leaf.class === "day-only"
			? `A device keeps only the day of '${leaf.property}', so it cannot be compared with a moment. The checker should refuse this comparison (day-only-on-device) before emission.`
			: leaf.class === "clock-lost"
				? "A date and time whose clock may be lost reached an instant comparison. The checker should refuse it (clock-lost) before emission."
				: leaf.class === "literal-instant"
					? UNREADABLE(leaf.literal.value)
					: leaf.class === "not-instant"
						? leaf.data === "date"
							? "A date reached an instant comparison with a date and time. The checker should refuse it (date-datetime) before emission."
							: `A literal of another kind ('${String(directLiteralValue(leaf.value))}') reached an instant comparison, where it would read as no moment. The checker should refuse it (datetime-ordering or datetime-equality) before emission.`
						: "A value of unknown type whose node holds neither text nor a typed date reached an instant comparison, so it has no instant text.",
	);
}

/** One leaf's instant text. `blankStays`: inside a `coalesce`, where a blank
 * value must stay blank so the next value is chosen. */
function leafText(
	leaf: InstantLeaf,
	emit: InstantEmission,
	blankStays: boolean,
): WireExpr {
	switch (leaf.class) {
		case "literal-instant":
			return w.str(literalText(leaf));
		case "text":
			return emit.value(leaf.value);
		case "typed":
			return typedInstantText(emit.value(leaf.value));
		case "coerced-date-typed": {
			const value = emit.value(leaf.value);
			const text = typedDateMidnight(value, "T00:00:00Z");
			return blankStays ? blankGuard(value, text) : text;
		}
		case "coerced-date-text": {
			const value = emit.value(leaf.value);
			const text = w.call("concat", [value, w.str("T00:00:00Z")]);
			return blankStays ? blankGuard(value, text) : text;
		}
		case "coerced-text":
			return coercedTextInstant(emit.value(leaf.value), "T00:00:00Z");
		case "epoch-days": {
			const value = emit.value(leaf.value);
			const text = epochDayMidnight(value, "T00:00:00Z");
			return blankStays ? blankGuard(value, text) : text;
		}
		case "not-instant":
			return emit.value(leaf.value);
		case "unknown":
			return leaf.held === "date"
				? typedInstantText(emit.value(leaf.value))
				: emit.value(leaf.value);
		case "day-only":
		case "clock-lost":
			throw new Error("An unlowerable leaf reached its instant text.");
	}
}

function operandText(
	operand: InstantOperand,
	emit: InstantEmission,
	blankStays: boolean,
): WireExpr {
	switch (operand.kind) {
		case "leaf":
			return leafText(operand, emit, blankStays);
		case "if":
			return w.call("if", [
				emit.condition(operand.source.cond),
				operandText(operand.whenTrue, emit, blankStays),
				operandText(operand.whenFalse, emit, blankStays),
			]);
		case "coalesce":
			return w.call(
				"coalesce",
				operand.values.map((value) => operandText(value, emit, true)),
			);
		case "switch": {
			const tests = emit.switchTests(operand.source);
			let result = operandText(operand.fallback, emit, blankStays);
			for (let index = operand.cases.length - 1; index >= 0; index--) {
				const test = tests[index];
				const branch = operand.cases[index];
				if (test === undefined || branch === undefined)
					throw new Error("A switch case has no test in its emitted chain.");
				result = w.call("if", [
					test,
					operandText(branch, emit, blankStays),
					result,
				]);
			}
			return result;
		}
	}
}

/** One side of a lowered comparison: a folded literal, a day number scaled,
 * a value that names no moment as itself, or the parse of its instant text. */
export function instantOperandWire(
	operand: InstantOperand,
	emit: InstantEmission,
): WireExpr {
	refuseUnlowerable(operand);
	if (operand.kind === "leaf") {
		if (operand.class === "literal-instant") return w.num(folded(operand));
		if (operand.class === "epoch-days") {
			const literal =
				operand.value.kind === "term" && operand.value.term.kind === "literal"
					? operand.value.term.value
					: undefined;
			return typeof literal === "number"
				? w.num(literal * MICROS_PER_DAY)
				: w.mul(emit.value(operand.value), w.num(MICROS_PER_DAY));
		}
		if (operand.class === "not-instant") return emit.value(operand.value);
	}
	return instantMicros(operandText(operand, emit, false));
}

/**
 * A `datetime-coerce` as a value (a case write, a calculated column, a
 * `format-date` operand): the moment as text. A date is its UTC midnight
 * under a blank guard, date-and-time text itself, a typed date and time in
 * `datetimeCaseValueExpression`'s shape, a day number its UTC midnight. A
 * casedb system date, a clock-lost value or a value that names no moment has
 * no moment to print; it keeps Core's `date()`, a day.
 */
export function datetimeCoerceValue(
	operand: InstantOperand,
	emit: InstantEmission,
): WireExpr {
	switch (operand.kind) {
		case "if":
			return w.call("if", [
				emit.condition(operand.source.cond),
				datetimeCoerceValue(operand.whenTrue, emit),
				datetimeCoerceValue(operand.whenFalse, emit),
			]);
		case "coalesce":
			return w.call(
				"coalesce",
				operand.values.map((value) => datetimeCoerceValue(value, emit)),
			);
		case "switch": {
			const tests = emit.switchTests(operand.source);
			let result = datetimeCoerceValue(operand.fallback, emit);
			for (let index = operand.cases.length - 1; index >= 0; index--) {
				const test = tests[index];
				const branch = operand.cases[index];
				if (test === undefined || branch === undefined)
					throw new Error("A switch case has no test in its emitted chain.");
				result = w.call("if", [
					test,
					datetimeCoerceValue(branch, emit),
					result,
				]);
			}
			return result;
		}
		case "leaf":
			break;
	}
	switch (operand.class) {
		case "literal-instant":
			return w.str(literalText(operand));
		case "text":
			return emit.value(operand.value);
		case "typed":
			return typedInstantValue(emit.value(operand.value));
		case "coerced-date-typed": {
			const value = emit.value(operand.value);
			return blankGuard(value, typedDateMidnight(value, "T00:00:00.000Z"));
		}
		case "coerced-date-text": {
			const value = emit.value(operand.value);
			return blankGuard(
				value,
				w.call("concat", [value, w.str("T00:00:00.000Z")]),
			);
		}
		case "coerced-text":
			return coercedTextInstant(emit.value(operand.value), "T00:00:00.000Z");
		case "epoch-days": {
			const value = emit.value(operand.value);
			return blankGuard(value, epochDayMidnight(value, "T00:00:00.000Z"));
		}
		case "unknown":
			return operand.held === "date"
				? typedInstantValue(emit.value(operand.value))
				: operand.held === "string"
					? emit.value(operand.value)
					: w.call("date", [emit.value(operand.value)]);
		case "not-instant":
		case "day-only":
		case "clock-lost":
			return w.call("date", [emit.value(operand.value)]);
	}
}

/** A typed date and time as text, blank when it is: the one spelling a
 * date-and-time value takes where its clock must survive an untyped node. */
export function typedInstantValue(value: WireExpr): WireExpr {
	return blankGuard(value, typedInstantText(value));
}
