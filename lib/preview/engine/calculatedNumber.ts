import { numericAnswerText } from "@/lib/domain/expression/numberLiteral";
import { openJdk17DoubleToString } from "@/lib/domain/expression/openJdk17DoubleString";

const INT_MIN = -2147483648;
const INT_MAX = 2147483647;
const WHOLE_TEXT = /^-?[0-9]+$/;

/** Java's `(int)` of a double: truncated toward zero, saturating at `int`'s
 *  bounds, `NaN` to zero (JLS 5.1.3). */
function javaIntOf(value: number): number {
	if (Number.isNaN(value)) return 0;
	if (value >= INT_MAX) return INT_MAX;
	if (value <= INT_MIN) return INT_MIN;
	return Math.trunc(value) || 0;
}

/**
 * What a device holds for a number a calculation gives, and the text it
 * submits for it (`Recalculate.java::wrapData`, then
 * `XFormAnswerDataSerializer.serializeAnswerData`): under a whole-number
 * bind, `IntegerData` of the number's `(int)`; under any other bind,
 * `IntegerData` or `LongData` of the number's `long` where it is within a
 * billionth of it, else `DecimalData` of the number itself, written as
 * OpenJDK 17's `Double.toString`. So `3e9` is `3000000000`, a tenth of a
 * billionth is `1.0E-10`, and an infinity is `Infinity`. A number that is no
 * number (`NaN`) holds nothing, which the caller writes as blank.
 */
export function heldCalculatedNumber(
	value: number,
	wholeNumberBind: boolean,
): { readonly text: string; readonly value: number } {
	if (wholeNumberBind) {
		const held = javaIntOf(value);
		return { text: String(held), value: held };
	}
	if (!Number.isFinite(value))
		return { text: openJdk17DoubleToString(value), value };
	const text = numericAnswerText(value);
	// A whole number's text is its long's digits, which a read unpacks.
	return WHOLE_TEXT.test(text)
		? { text, value: Number(text) }
		: { text, value };
}
