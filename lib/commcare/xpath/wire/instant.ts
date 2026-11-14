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
	literalStoredInstantText,
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
 * under a blank guard, date-and-time text itself, a typed date and time as
 * `typedInstantValue`, a day number its UTC midnight. A
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

/** A literal's stored text (`literalStoredInstantText`), CommCare HQ's
 * spelling of its moment. */
function literalStoredText(
	leaf: Extract<InstantLeaf, { class: "literal-instant" }>,
) {
	const text = literalStoredInstantText(leaf.literal.value);
	if (text === undefined) throw new Error(UNREADABLE(leaf.literal.value));
	return text;
}

/** CommCare HQ's spelling of a UTC midnight. */
const STORED_MIDNIGHT = "T00:00:00.000000Z";

/** Date text's UTC midnight as CommCare HQ stores it, blank when it is. */
function dayTextMidnight(value: WireExpr): WireExpr {
	return blankGuard(value, w.call("concat", [value, w.str(STORED_MIDNIGHT)]));
}

/**
 * A date and time as the text a case holds, CommCare HQ's spelling of its
 * moment (`storedInstantOfText`), distributed over `if`, `coalesce` and
 * `switch` as `datetimeCoerceValue` is, each leaf by what a device holds: a
 * typed moment, a value of unknown type holding a date and a `casedb` system
 * date (a `Date` at the device's midnight) through `storedInstantValue`;
 * stored text, a value of unknown type holding text and a blank as itself,
 * since stored text is already a stored moment and Core parses nothing; a
 * literal folded to its stored text; a coerced date or day number, and a
 * search result's `date_opened` (text holding the UTC day), as its UTC
 * midnight. `clock` reads a typed leaf
 * whose tree holds `now()` from the node that holds it (`if(N = '', '',
 * storedInstantOfText(N))`), because each print of a value evaluates it
 * again and `now()` reads the clock each time. A clock-lost value is
 * refused by the checker (`expected-value`, reason `clock-lost`) before it
 * reaches here.
 */
export function storedDatetimeValue(
	operand: InstantOperand,
	emit: InstantEmission,
	clock?: (expression: Expression) => WireExpr | undefined,
): WireExpr {
	switch (operand.kind) {
		case "if":
			return w.call("if", [
				emit.condition(operand.source.cond),
				storedDatetimeValue(operand.whenTrue, emit, clock),
				storedDatetimeValue(operand.whenFalse, emit, clock),
			]);
		case "coalesce":
			return w.call(
				"coalesce",
				operand.values.map((value) => storedDatetimeValue(value, emit, clock)),
			);
		case "switch": {
			const tests = emit.switchTests(operand.source);
			let result = storedDatetimeValue(operand.fallback, emit, clock);
			for (let index = operand.cases.length - 1; index >= 0; index--) {
				const test = tests[index];
				const branch = operand.cases[index];
				if (test === undefined || branch === undefined)
					throw new Error("A switch case has no test in its emitted chain.");
				result = w.call("if", [
					test,
					storedDatetimeValue(branch, emit, clock),
					result,
				]);
			}
			return result;
		}
		case "leaf":
			break;
	}
	const typed = (expression: Expression): WireExpr => {
		const node = clock?.(expression);
		return node === undefined
			? storedInstantValue(emit.value(expression))
			: blankGuard(node, storedInstantOfText(node));
	};
	switch (operand.class) {
		case "literal-instant":
			return w.str(literalStoredText(operand));
		case "typed":
			return typed(operand.value);
		case "day-only":
			return operand.held === "date"
				? typed(operand.value)
				: dayTextMidnight(emit.value(operand.value));
		case "unknown":
			return operand.held === "date"
				? typed(operand.value)
				: emit.value(operand.value);
		case "text":
		case "not-instant":
			return emit.value(operand.value);
		case "coerced-date-typed": {
			const value = emit.value(operand.value);
			return blankGuard(value, typedDateMidnight(value, STORED_MIDNIGHT));
		}
		case "coerced-date-text":
			return dayTextMidnight(emit.value(operand.value));
		case "coerced-text":
			return coercedTextInstant(emit.value(operand.value), STORED_MIDNIGHT);
		case "epoch-days": {
			const value = emit.value(operand.value);
			return blankGuard(value, epochDayMidnight(value, STORED_MIDNIGHT));
		}
		case "clock-lost":
			throw new Error(
				"A date and time whose clock may be lost reached a case write. The checker should refuse it (expected-value, clock-lost) before emission.",
			);
	}
}

/** A typed date and time as text, blank when it is: the device's clock in
 * one fixed shape with its offset, the spelling a generated clock node holds
 * (`xform/caseOps.ts`), in which one `format-date` feeds the text, so it
 * names one moment. */
export function typedInstantValue(value: WireExpr): WireExpr {
	return blankGuard(value, typedInstantText(value));
}

/**
 * Instant text in `typedInstantText`'s own shape (`YYYY-MM-DDTHH:MM:SS.mmm`
 * then Core's `%Z`: `Z`, `±HH` or `±HH:MM`, `DateUtils.getOffsetInStandardFormat`)
 * as the text CommCare HQ stores for it: UTC, six fraction digits and `Z`
 * (`dimagi/utils/parsing.py::json_format_datetime`). Whole-number arithmetic
 * moves the clock to UTC: `%Z` prints whole minutes, so the seconds and
 * milliseconds of the UTC text are `t`'s own, copied; the minute of the UTC
 * day `U` lies from -840 to 2159, so the day moves by at most one either way
 * and `U + 1440` is never negative (`XPathArithExpr` takes Java's
 * remainder); and `substr(100 + h, 1)` is `h` in two digits, since Core
 * prints a whole number with no decimal point (`FunctionUtils.toString`).
 *
 * The day before or after is worked out from the written year, month and
 * day, never through a day number: a day number counts from the epoch of the
 * JVM's zone (`DateUtils.daysSinceEpoch`), which on Web Apps is UTC's while
 * `date()` of text is the browser zone's midnight, so `date(date(day) + 1)`
 * would land a day early in a zone more than twelve hours ahead of UTC.
 * Every sub-term is built once and shared, so the memoised print stays
 * linear.
 *
 * An offset under an hour and not zero prints as `Z:MM` whatever its sign,
 * so it reads as UTC here; only historic offsets are such. A moment whose UTC
 * year has no four digits has no such text.
 */
export function storedInstantOfText(t: WireExpr): WireExpr {
	const piece = (start: number, end?: number) =>
		w.call(
			"substr",
			end === undefined ? [t, w.num(start)] : [t, w.num(start), w.num(end)],
		);
	const tail = piece(23);
	const offset = w.call("if", [
		w.call("starts-with", [tail, w.str("Z")]),
		w.num(0),
		w.mul(
			w.call("if", [
				w.call("starts-with", [tail, w.str("-")]),
				w.num(-1),
				w.num(1),
			]),
			w.add(
				w.mul(
					w.call("number", [w.call("substr", [tail, w.num(1), w.num(3)])]),
					w.num(60),
				),
				w.call("if", [
					w.gt(w.call("string-length", [tail]), w.num(3)),
					w.call("number", [w.call("substr", [tail, w.num(4), w.num(6)])]),
					w.num(0),
				]),
			),
		),
	]);
	const minuteOfDay = w.sub(
		w.add(
			w.mul(w.call("number", [piece(11, 13)]), w.num(60)),
			w.call("number", [piece(14, 16)]),
		),
		offset,
	);
	const utcMinute = w.mod(w.add(minuteOfDay, w.num(1440)), w.num(1440));
	const twoDigits = (value: WireExpr) =>
		w.call("substr", [w.add(w.num(100), value), w.num(1)]);
	const fourDigits = (value: WireExpr) =>
		w.call("substr", [w.add(w.num(10000), value), w.num(1)]);
	const year = w.call("number", [piece(0, 4)]);
	const month = w.call("number", [piece(5, 7)]);
	const day = w.call("number", [piece(8, 10)]);
	const yearMonth = piece(0, 8);
	const leapYear = w.or(
		w.and(
			w.eq(w.mod(year, w.num(4)), w.num(0)),
			w.cmp("!=", w.mod(year, w.num(100)), w.num(0)),
		),
		w.eq(w.mod(year, w.num(400)), w.num(0)),
	);
	// A month's days: February's 28 and a leap day; otherwise 31 for January,
	// March, May, July, August, October and December, 30 for the rest.
	const daysIn = (m: WireExpr) =>
		w.call("if", [
			w.eq(m, w.num(2)),
			w.add(w.num(28), leapYear),
			w.add(
				w.num(30),
				w.mod(w.add(m, w.call("floor", [w.div(m, w.num(8))])), w.num(2)),
			),
		]);
	const nextDay = w.call("if", [
		w.lt(day, daysIn(month)),
		w.call("concat", [yearMonth, twoDigits(w.add(day, w.num(1)))]),
		w.call("if", [
			w.lt(month, w.num(12)),
			w.call("concat", [
				piece(0, 5),
				twoDigits(w.add(month, w.num(1))),
				w.str("-01"),
			]),
			w.call("concat", [fourDigits(w.add(year, w.num(1))), w.str("-01-01")]),
		]),
	]);
	const previousMonth = w.sub(month, w.num(1));
	const previousDay = w.call("if", [
		w.gt(day, w.num(1)),
		w.call("concat", [yearMonth, twoDigits(w.sub(day, w.num(1)))]),
		w.call("if", [
			w.gt(month, w.num(1)),
			w.call("concat", [
				piece(0, 5),
				twoDigits(previousMonth),
				w.str("-"),
				twoDigits(daysIn(previousMonth)),
			]),
			w.call("concat", [fourDigits(w.sub(year, w.num(1))), w.str("-12-31")]),
		]),
	]);
	const utcDay = w.call("if", [
		w.lt(minuteOfDay, w.num(0)),
		previousDay,
		w.call("if", [w.gte(minuteOfDay, w.num(1440)), nextDay, piece(0, 10)]),
	]);
	return w.call("concat", [
		utcDay,
		w.str("T"),
		twoDigits(w.call("floor", [w.div(utcMinute, w.num(60))])),
		w.str(":"),
		twoDigits(w.mod(utcMinute, w.num(60))),
		w.str(":"),
		piece(17, 23),
		w.str("000Z"),
	]);
}

/** Whether any leaf of `operand` can hold date-and-time text with a written
 * offset, which Core's date-and-time parse misreads on a device whose date
 * for the moment is not the written one (`deviceInstantText`). A typed leaf
 * holds a `Date`, and a value that names no moment holds no such text. */
export function mayHoldInstantText(operand: InstantOperand): boolean {
	switch (operand.kind) {
		case "if":
			return (
				mayHoldInstantText(operand.whenTrue) ||
				mayHoldInstantText(operand.whenFalse)
			);
		case "coalesce":
			return operand.values.some(mayHoldInstantText);
		case "switch":
			return (
				operand.cases.some(mayHoldInstantText) ||
				mayHoldInstantText(operand.fallback)
			);
		case "leaf":
			break;
	}
	switch (operand.class) {
		case "typed":
		case "clock-lost":
		case "not-instant":
			return false;
		case "day-only":
		case "unknown":
			return operand.held !== "date";
		case "literal-instant":
		case "text":
		case "coerced-date-typed":
		case "coerced-date-text":
		case "coerced-text":
		case "epoch-days":
			return true;
	}
}

/**
 * Instant text `t` as text Core's date-and-time parse reads back to the same
 * moment on the device that evaluates it: the device's own date and clock
 * for the moment, and its offset then. Core's parse keeps the written date
 * and moves only the clock to the device's zone
 * (`DateUtils.java::parseDateTime`, `parseTimeAndStore`), so CommCare HQ's
 * UTC text, read where the device's date for the moment is not the UTC one,
 * names a moment a day away. Every reader of text as a typed date and time
 * reaches that parse: a starting value cast into a date-and-time node
 * (`SetValueAction` casts through `DateTimeData.cast`), `format-date` and
 * `date()` (`FunctionUtils.toDate`).
 *
 * Text with no `T` at its eleventh character or with no offset after its
 * minutes is itself, since Core reads it as written (a date, a wall clock in
 * the device's zone, a blank). Otherwise, with whole-number arithmetic over
 * the written fields, which read an offset written `Z`, `±HH` or `±HH:MM`:
 *
 * - `U`, the moment's minute counted from the written date's UTC midnight,
 *   is the written clock less the written offset;
 * - `C`, the device's clock for the moment, is Core's own: `format-date(t,
 *   '%H')` and `'%M'`, which print the clock the parse moved;
 * - the whole days `d` between the written date and the device's are those
 *   that bring `C - U` nearest the offset Core prints for the parsed value
 *   (`'%Z'`, read to the hour), which differs from the device's offset for
 *   the moment by a daylight saving turn at most, while the candidates
 *   differ by a day; the device's offset `O` is `C - U + 1440 d`;
 * - the device's date is the written one moved by `d`, worked out from the
 *   written year, month and day (a day number counts from the JVM's epoch,
 *   which on Web Apps is not the zone `date()` reads, and `date(n)` misses a
 *   day in a zone whose offset moved by more than twelve hours since 1970);
 * - the text is that date, `C`, the written seconds, the written milliseconds
 *   and a `5` (Core reads the seconds as a double and truncates their
 *   milliseconds, `DateUtils.parseRawTime`, so `.999` alone can read as 998
 *   and `.9995` reads as 999), and `O` as `+00:O`: Core reads an offset's
 *   hours and minutes as signed integers and adds them
 *   (`parseTimeAndStore`), so `O` minutes need no hours and no sign of
 *   their own, and the value is printed once.
 *
 * The date, `C` and `O` name the moment whatever `C` is (`date + C - O` is
 * the written date's midnight plus `U`), so a clock Core moved forward across
 * a skipped hour on the written date still names it. Every compound term is
 * printed at each of its uses, and the terms are chosen for few uses of `t`.
 */
export function deviceInstantText(t: WireExpr): WireExpr {
	const piece = (start: number, end?: number) =>
		w.call(
			"substr",
			end === undefined ? [t, w.num(start)] : [t, w.num(start), w.num(end)],
		);
	const number = (value: WireExpr) => w.call("number", [value]);
	// A blank piece of the offset reads as zero.
	const zeroed = (value: WireExpr) =>
		number(w.call("concat", [w.str("0"), value]));
	const twoDigits = (value: WireExpr) =>
		w.call("substr", [w.add(w.num(100), value), w.num(1)]);
	const sign = (negative: WireExpr) =>
		w.call("if", [negative, w.num(-1), w.num(1)]);
	// After the minutes: the seconds, a fraction and the offset, as written.
	const rest = piece(16);
	const marked = w.call("translate", [rest, w.str("Z+-"), w.str("|||")]);
	const zoned = w.and(
		w.eq(piece(10, 11), w.str("T")),
		w.call("contains", [marked, w.str("|")]),
	);
	// The written offset's digits, `HH` or `HH:MM`, and none for `Z`.
	const digits = w.call("substring-after", [marked, w.str("|")]);
	const writtenOffset = w.mul(
		sign(w.call("contains", [rest, w.str("-")])),
		w.add(
			w.mul(zeroed(w.call("substr", [digits, w.num(0), w.num(2)])), w.num(60)),
			zeroed(w.call("substr", [digits, w.num(3), w.num(5)])),
		),
	);
	const utcMinute = w.sub(
		w.add(w.mul(number(piece(11, 13)), w.num(60)), number(piece(14, 16))),
		writtenOffset,
	);
	const deviceClock = (pattern: string) =>
		number(w.call("format-date", [t, w.str(pattern)]));
	const deviceMinute = w.add(
		w.mul(deviceClock("%H"), w.num(60)),
		deviceClock("%M"),
	);
	// Core's `%Z` for the parsed value (`Z`, `±HH`, `±HH:MM`, or `Z:MM` for
	// an offset under an hour), read to the hour, which is near enough to
	// choose a day.
	const printedZone = w.call("format-date", [t, w.str("%Z")]);
	const printedOffset = w.mul(
		sign(w.call("starts-with", [printedZone, w.str("-")])),
		w.mul(
			zeroed(
				w.call("translate", [
					w.call("substr", [printedZone, w.num(1), w.num(3)]),
					w.str(":"),
					w.str(""),
				]),
			),
			w.num(60),
		),
	);
	const days = w.call("round", [
		w.div(w.add(w.sub(printedOffset, deviceMinute), utcMinute), w.num(1440)),
	]);
	const offset = w.add(
		w.sub(deviceMinute, utcMinute),
		w.mul(days, w.num(1440)),
	);
	const year = number(piece(0, 4));
	const month = number(piece(5, 7));
	const target = w.add(number(piece(8, 10)), days);
	const leap = (y: WireExpr) =>
		w.or(
			w.and(
				w.eq(w.mod(y, w.num(4)), w.num(0)),
				w.cmp("!=", w.mod(y, w.num(100)), w.num(0)),
			),
			w.eq(w.mod(y, w.num(400)), w.num(0)),
		);
	// A month's days: February's 28 and a leap day; otherwise 31 for January,
	// March, May, July, August, October and December, 30 for the rest.
	const daysIn = (m: WireExpr, y: WireExpr) =>
		w.call("if", [
			w.eq(m, w.num(2)),
			w.add(w.num(28), leap(y)),
			w.add(
				w.num(30),
				w.mod(w.add(m, w.call("floor", [w.div(m, w.num(8))])), w.num(2)),
			),
		]);
	const yearText = (y: WireExpr) =>
		w.call("if", [
			w.gt(y, w.num(9999)),
			y,
			w.call("substr", [w.add(w.num(10000), y), w.num(1)]),
		]);
	const firstMonth = w.eq(month, w.num(1));
	const lastMonth = w.eq(month, w.num(12));
	const previousMonth = w.call("if", [
		firstMonth,
		w.num(12),
		w.sub(month, w.num(1)),
	]);
	const previousYear = w.call("if", [firstMonth, w.sub(year, w.num(1)), year]);
	const monthDays = daysIn(month, year);
	const date = w.call("if", [
		w.lt(target, w.num(1)),
		w.call("concat", [
			yearText(previousYear),
			w.str("-"),
			twoDigits(previousMonth),
			w.str("-"),
			twoDigits(w.add(daysIn(previousMonth, previousYear), target)),
		]),
		w.call("if", [
			w.gt(target, monthDays),
			w.call("concat", [
				yearText(w.call("if", [lastMonth, w.add(year, w.num(1)), year])),
				w.str("-"),
				twoDigits(w.call("if", [lastMonth, w.num(1), w.add(month, w.num(1))])),
				w.str("-"),
				twoDigits(w.sub(target, monthDays)),
			]),
			w.call("concat", [piece(0, 8), twoDigits(target)]),
		]),
	]);
	const clockTail = w.call("substring-before", [marked, w.str("|")]);
	const seconds = w.call("if", [
		w.gte(w.call("string-length", [clockTail]), w.num(3)),
		w.call("substr", [clockTail, w.num(1), w.num(3)]),
		w.str("00"),
	]);
	const milliseconds = w.call("substr", [
		w.call("concat", [w.call("substr", [clockTail, w.num(4)]), w.str("000")]),
		w.num(0),
		w.num(3),
	]);
	const converted = w.call("concat", [
		date,
		w.str("T"),
		twoDigits(w.call("floor", [w.div(deviceMinute, w.num(60))])),
		w.str(":"),
		twoDigits(w.mod(deviceMinute, w.num(60))),
		w.str(":"),
		seconds,
		w.str("."),
		milliseconds,
		w.str("5+00:"),
		offset,
	]);
	return w.call("if", [zoned, converted, t]);
}

/** A typed date and time as the text CommCare HQ stores, blank when it is:
 * the spelling a case write of a typed date and time takes
 * (`xform/datetimeCaseValue.ts::datetimeCaseValue`). */
export function storedInstantValue(value: WireExpr): WireExpr {
	return blankGuard(value, storedInstantOfText(typedInstantText(value)));
}

/** The value `storedInstantValue` was built over, or undefined: the blank
 * guard's first operand, kept only where `storedInstantValue` of it is the
 * tree. */
export function storedInstantSource(tree: WireExpr): WireExpr | undefined {
	if (tree.k !== "call" || tree.fn !== "if" || tree.args.length !== 3)
		return undefined;
	const guard = tree.args[0];
	if (guard?.k !== "cmp" || guard.op !== "=") return undefined;
	const candidate = guard.left;
	return sameWire(storedInstantValue(candidate), tree) ? candidate : undefined;
}

/** Structural equality of two wire trees. */
function sameWire(a: WireExpr, b: WireExpr): boolean {
	if (a === b) return true;
	if (a.k !== b.k) return false;
	const left = a as unknown as Record<string, unknown>;
	const right = b as unknown as Record<string, unknown>;
	const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
	for (const key of keys) {
		if (!sameValue(left[key], right[key])) return false;
	}
	return true;
}

function sameValue(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
			return false;
		return a.every((item, index) => sameValue(item, b[index]));
	}
	if (
		typeof a !== "object" ||
		typeof b !== "object" ||
		a === null ||
		b === null
	)
		return false;
	if ("k" in a && "k" in b) return sameWire(a as WireExpr, b as WireExpr);
	const left = a as Record<string, unknown>;
	const right = b as Record<string, unknown>;
	const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
	for (const key of keys) {
		if (!sameValue(left[key], right[key])) return false;
	}
	return true;
}
