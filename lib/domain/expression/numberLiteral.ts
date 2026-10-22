import { openJdk17DoubleToString } from "./openJdk17DoubleString";

const LONG_MIN = BigInt("-9223372036854775808");
const LONG_MAX = BigInt("9223372036854775807");

/**
 * Native answer text for a finite numeric result assigned to a select.
 * Core's Recalculate.wrapData first narrows numbers within 1e-9 of their
 * truncated Java long to IntegerData or LongData; SetValueAction then casts
 * their uncast text to the select. Java's long conversion saturates, and its
 * comparison promotes that long back to a double. Other numbers use
 * DecimalData's OpenJDK 17 Double.toString spelling.
 */
export function numericAnswerText(value: number): string {
	const truncated = BigInt(Math.trunc(value));
	const integral =
		truncated < LONG_MIN
			? LONG_MIN
			: truncated > LONG_MAX
				? LONG_MAX
				: truncated;
	return Math.abs(value - Number(integral)) < 1e-9
		? integral.toString()
		: openJdk17DoubleToString(value);
}

/**
 * Compile a finite numeric value to its wire-form decimal literal,
 * avoiding scientific notation. CommCare's XPath grammar at
 * `lib/commcare/xpath/grammar.lezer.grammar::NumberLiteral` admits decimal
 * literals only — `digit+ ('.' digit*)? | '.' digit+` — and rejects
 * exponent syntax, so a wire-form value with an `e` or `E` would
 * parse-fail downstream.
 *
 * The function early-returns the canonical `String(n)` for any
 * number whose decimal form is already non-exponent. That preserves
 * the shortest round-trip form (e.g. `String(3.14)` is the literal
 * `"3.14"`, not the `toFixed(20)` artifact `"3.14000000000000012434"`)
 * for every value an author would realistically type. Only when
 * `String(n)` produces exponent form does the function reformat by
 * parsing the mantissa and exponent out of the string and shifting
 * the decimal point manually, producing an exact decimal expansion
 * of the IEEE-754 double's `String(n)` form without `toFixed`'s
 * precision-related truncation at the limits.
 *
 * The schema layer (`z.number()` in `lib/domain/expression/types.ts`)
 * rejects `NaN` and `±Infinity`, so this helper is only ever called
 * with finite numbers.
 */
export function formatNumeric(n: number): string {
	const s = String(n);
	if (!s.includes("e") && !s.includes("E")) return s;
	// `String(n)` for any finite double in exponent form matches
	// `^(-)?<int>(\.<frac>)?[eE][+-]?<exp>$`. Parse the components
	// and rebuild as a non-exponent decimal by sliding the decimal
	// point `exp` places. The combined `<int><frac>` digit sequence
	// is the significand; the decimal point lands at position
	// `int.length + exp` in that sequence, with leading or trailing
	// zeros filling any positions outside the significand's range.
	const match = s.match(/^(-)?(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/);
	if (!match) return s;
	const sign = match[1] ?? "";
	const intPart = match[2];
	const fracPart = match[3] ?? "";
	const exp = Number.parseInt(match[4], 10);
	const digits = intPart + fracPart;
	const decimalPos = intPart.length + exp;
	if (decimalPos >= digits.length) {
		return `${sign}${digits}${"0".repeat(decimalPos - digits.length)}`;
	}
	if (decimalPos > 0) {
		return `${sign}${digits.slice(0, decimalPos)}.${digits.slice(decimalPos)}`;
	}
	return `${sign}0.${"0".repeat(-decimalPos)}${digits}`;
}
