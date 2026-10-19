import { javaTrim } from "./javaString";

// FloatingDecimal.readJavaFormatString accepts `NaN` and `Infinity` only as the
// exact rest of the string, so the type suffix belongs to the numeric arm alone.
const JAVA_DECIMAL_DOUBLE =
	/^[+-]?(?:NaN|Infinity|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[fFdD]?)$/;
const JAVA_HEXADECIMAL_DOUBLE =
	/^([+-]?)0[xX]((?:[0-9a-fA-F]+(?:\.[0-9a-fA-F]*)?|\.[0-9a-fA-F]+))[pP]([+-]?\d+)(?:[fFdD])?$/;
const BIGINT_ZERO = BigInt(0);
const BIGINT_ONE = BigInt(1);

/**
 * Java 17's `Double.parseDouble`, exactly: its lexical grammar
 * (`jdk.internal.math.FloatingDecimal::readJavaFormatString`, after
 * `String.trim()`) and its rounding. `undefined` is the text Java refuses with
 * a `NumberFormatException`.
 */
export function parseJavaDouble(value: string): number | undefined {
	const trimmed = javaTrim(value);
	const hexadecimal = JAVA_HEXADECIMAL_DOUBLE.exec(trimmed);
	if (hexadecimal !== null) return parseJavaHexadecimalDouble(hexadecimal);
	if (!JAVA_DECIMAL_DOUBLE.test(trimmed)) return undefined;
	const withoutSuffix = /[fFdD]$/.test(trimmed)
		? trimmed.slice(0, -1)
		: trimmed;
	// ECMAScript and Java both require correctly rounded IEEE-754 conversion for
	// decimal input. The grammar check above excludes JavaScript-only spellings.
	return Number(withoutSuffix);
}

function parseJavaHexadecimalDouble(match: RegExpExecArray): number {
	const negative = match[1] === "-";
	const significandText = match[2] ?? "";
	const exponentText = match[3] ?? "";
	const point = significandText.indexOf(".");
	const fractionalDigits = point < 0 ? 0 : significandText.length - point - 1;
	const digits = significandText.replace(".", "").replace(/^0+/, "");
	if (digits === "") return negative ? -0 : 0;

	const exponent = Number(exponentText);
	if (exponent === Number.POSITIVE_INFINITY) {
		return negative ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
	}
	if (exponent === Number.NEGATIVE_INFINITY) return negative ? -0 : 0;

	const significand = BigInt(`0x${digits}`);
	const leadingBits = 32 - Math.clz32(Number.parseInt(digits[0] ?? "0", 16));
	const bitLength = (digits.length - 1) * 4 + leadingBits;
	const binaryExponent = exponent - fractionalDigits * 4;
	let value: number;

	const highestExponent = bitLength - 1 + binaryExponent;
	if (highestExponent > 1023) {
		value = Number.POSITIVE_INFINITY;
	} else if (highestExponent >= -1022) {
		let rounded = roundBinaryInteger(significand, bitLength - 53);
		let normalizedExponent = highestExponent;
		if (rounded === BIGINT_ONE << BigInt(53)) {
			rounded >>= BIGINT_ONE;
			normalizedExponent += 1;
		}
		value =
			normalizedExponent > 1023
				? Number.POSITIVE_INFINITY
				: Number(rounded) * 2 ** (normalizedExponent - 52);
	} else {
		// Subnormals are integral multiples of 2^-1074. Round directly in that
		// unit so the normal/subnormal boundary and halfway-to-zero cases use the
		// same ties-to-even rule as Java.
		const rounded = roundBinaryInteger(significand, -(binaryExponent + 1074));
		value = Number(rounded) * 2 ** -1074;
	}
	return negative ? -value : value;
}

function roundBinaryInteger(value: bigint, rightShift: number): bigint {
	if (rightShift <= 0) return value << BigInt(-rightShift);
	const bitLength = value.toString(2).length;
	if (rightShift > bitLength) return BIGINT_ZERO;
	const shift = BigInt(rightShift);
	const quotient = value >> shift;
	const remainder = value - (quotient << shift);
	const halfway = BIGINT_ONE << BigInt(rightShift - 1);
	return remainder > halfway ||
		(remainder === halfway && (quotient & BIGINT_ONE) === BIGINT_ONE)
		? quotient + BIGINT_ONE
		: quotient;
}
