/*
 * Copyright (c) 1996, 2016, Oracle and/or its affiliates. All rights reserved.
 * DO NOT ALTER OR REMOVE COPYRIGHT NOTICES OR THIS FILE HEADER.
 *
 * This code is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License version 2 only, as
 * published by the Free Software Foundation.  Oracle designates this
 * particular file as subject to the "Classpath" exception as provided
 * by Oracle in the LICENSE file that accompanied this code.
 *
 * This code is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE.  See the GNU General Public License
 * version 2 for more details (a copy is included in the LICENSE file that
 * accompanied this code).
 *
 * You should have received a copy of the GNU General Public License version
 * 2 along with this work; if not, write to the Free Software Foundation,
 * Inc., 51 Franklin St, Fifth Floor, Boston, MA 02110-1301 USA.
 *
 * Please contact Oracle, 500 Oracle Parkway, Redwood Shores, CA 94065 USA
 * or visit www.oracle.com if you need additional information or have any
 * questions.
 */

/*
 * Modified by Dimagi, Inc. on 2026-08-25 for the CommCare Nova browser
 * runtime. See scripts/java-pattern-runtime/MODIFICATIONS.md.
 */

/**
 * OpenJDK 17's `FloatingDecimal.BinaryToASCIIBuffer` conversion, expressed
 * with JavaScript BigInt rather than the JDK's private FDBigInteger helper.
 *
 * ECMAScript also promises a round-trippable shortest decimal, but JDK 17's
 * historical stopping rule is observably different for values such as 1e23.
 * JavaRosa routes every numeric string coercion through `Double.toString`, so
 * Preview must retain this exact older spelling rather than use Number text.
 */

const ZERO = BigInt(0);
const ONE = BigInt(1);
const FIVE = BigInt(5);
const TEN = BigInt(10);
const FRACTION_HIGH_BIT = ONE << BigInt(52);
const FRACTION_MASK = FRACTION_HIGH_BIT - ONE;
const EXPONENT_MASK = BigInt(0x7ff);
const EXPONENT_BIAS = 1023;
const TWO_POW_52 = 2 ** 52;

const INSIGNIFICANT_DIGITS_FOR_POW2 = [
	0, 0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6, 6, 7, 7,
	7, 8, 8, 8, 9, 9, 9, 9, 10, 10, 10, 11, 11, 11, 12, 12, 12, 12, 13, 13, 13,
	14, 14, 14, 15, 15, 15, 15, 16, 16, 16, 17, 17, 17, 18, 18, 18, 19,
] as const;

interface DecimalDigits {
	readonly digits: string;
	readonly exponent: number;
}

/** Exact `Double.toString(double)` spelling used by pinned OpenJDK 17. */
export function openJdk17DoubleToString(value: number): string {
	const bits = rawDoubleBits(value);
	const negative = bits >> BigInt(63) !== ZERO;
	let fraction = bits & FRACTION_MASK;
	let binaryExponent = Number((bits >> BigInt(52)) & EXPONENT_MASK);

	if (binaryExponent === 0x7ff) {
		if (fraction === ZERO) return negative ? "-Infinity" : "Infinity";
		return "NaN";
	}
	if (binaryExponent === 0 && fraction === ZERO) {
		return negative ? "-0.0" : "0.0";
	}

	let significantBits: number;
	if (binaryExponent === 0) {
		const leadingZeros = 64 - bitLength(fraction);
		const shift = leadingZeros - 11;
		fraction <<= BigInt(shift);
		binaryExponent = 1 - shift;
		significantBits = 64 - leadingZeros;
	} else {
		fraction |= FRACTION_HIGH_BIT;
		significantBits = 53;
	}
	binaryExponent -= EXPONENT_BIAS;

	const converted = binaryToDecimal(binaryExponent, fraction, significantBits);
	return formatJavaDouble(converted, negative);
}

function binaryToDecimal(
	binaryExponent: number,
	fraction: bigint,
	significantBits: number,
): DecimalDigits {
	const trailingZeros = countTrailingZeros(fraction);
	const fractionBits = 53 - trailingZeros;
	const tinyBits = Math.max(0, fractionBits - binaryExponent - 1);

	// Preserve FloatingDecimal's integer fast path, including its historical
	// decimal rounding before insignificant low-order digits are discarded.
	if (binaryExponent <= 62 && binaryExponent >= -21 && tinyBits === 0) {
		const insignificant =
			binaryExponent > significantBits
				? (INSIGNIFICANT_DIGITS_FOR_POW2[
						binaryExponent - significantBits - 1
					] ?? 0)
				: 0;
		const integer =
			binaryExponent >= 52
				? fraction << BigInt(binaryExponent - 52)
				: fraction >> BigInt(52 - binaryExponent);
		return developIntegerDigits(integer, insignificant);
	}

	let decimalExponent = estimateDecimalExponent(fraction, binaryExponent);
	const numeratorFive = Math.max(0, -decimalExponent);
	let numeratorTwo = numeratorFive + tinyBits + binaryExponent;
	const denominatorFive = Math.max(0, decimalExponent);
	let denominatorTwo = denominatorFive + tinyBits;
	const marginFive = numeratorFive;
	let marginTwo = numeratorTwo - significantBits;

	fraction >>= BigInt(trailingZeros);
	numeratorTwo -= fractionBits - 1;
	const commonTwo = Math.min(numeratorTwo, denominatorTwo);
	numeratorTwo -= commonTwo;
	denominatorTwo -= commonTwo;
	marginTwo -= commonTwo;

	// At powers of two, the preceding double is only half an ordinary ULP away.
	if (fractionBits === 1) marginTwo -= 1;
	if (marginTwo < 0) {
		numeratorTwo -= marginTwo;
		denominatorTwo -= marginTwo;
		marginTwo = 0;
	}

	let numerator = scaleByFiveAndTwo(fraction, numeratorFive, numeratorTwo);
	const denominator = scaleByFiveAndTwo(ONE, denominatorFive, denominatorTwo);
	let margin = scaleByFiveAndTwo(ONE, marginFive + 1, marginTwo + 1);
	const tenDenominator = denominator * TEN;
	const digits: number[] = [];

	let quotient = Number(numerator / denominator);
	numerator = TEN * (numerator % denominator);
	let low = numerator < margin;
	let high = numerator + margin > tenDenominator;
	if (quotient === 0 && !high) {
		decimalExponent -= 1;
	} else {
		digits.push(quotient);
	}

	// Java format always requires one digit after the decimal point in E form.
	if (decimalExponent < -3 || decimalExponent >= 8) {
		low = false;
		high = false;
	}
	while (!low && !high) {
		quotient = Number(numerator / denominator);
		numerator = TEN * (numerator % denominator);
		margin *= TEN;
		low = numerator < margin;
		high = numerator + margin > tenDenominator;
		digits.push(quotient);
	}

	if (high) {
		const difference = low
			? compareBigInts(numerator * BigInt(2), tenDenominator)
			: 1;
		if (
			!low ||
			difference > 0 ||
			(difference === 0 && ((digits.at(-1) ?? 0) & 1) !== 0)
		) {
			if (roundUpDigits(digits)) decimalExponent += 1;
		}
	}

	return { digits: digits.join(""), exponent: decimalExponent + 1 };
}

function developIntegerDigits(
	input: bigint,
	insignificantDigits: number,
): DecimalDigits {
	let value = input;
	let exponent = insignificantDigits;
	if (insignificantDigits !== 0) {
		const scale = TEN ** BigInt(insignificantDigits);
		const remainder = value % scale;
		value /= scale;
		if (remainder >= scale / BigInt(2)) value += ONE;
	}
	let digits = value.toString();
	while (digits.length > 1 && digits.endsWith("0")) {
		digits = digits.slice(0, -1);
		exponent += 1;
	}
	return { digits, exponent: exponent + digits.length };
}

function estimateDecimalExponent(
	fraction: bigint,
	binaryExponent: number,
): number {
	const normalized = Number(fraction) / TWO_POW_52;
	return Math.floor(
		(normalized - 1.5) * 0.289529654 +
			0.176091259 +
			binaryExponent * 0.301029995663981,
	);
}

function formatJavaDouble(converted: DecimalDigits, negative: boolean): string {
	const sign = negative ? "-" : "";
	const { digits, exponent } = converted;
	if (exponent > 0 && exponent < 8) {
		const integerLength = Math.min(digits.length, exponent);
		const integer =
			digits.slice(0, integerLength) + "0".repeat(exponent - integerLength);
		const fraction =
			integerLength < digits.length ? digits.slice(integerLength) : "0";
		return `${sign}${integer}.${fraction}`;
	}
	if (exponent <= 0 && exponent > -3) {
		return `${sign}0.${"0".repeat(-exponent)}${digits}`;
	}
	const fraction = digits.length > 1 ? digits.slice(1) : "0";
	return `${sign}${digits[0]}.${fraction}E${exponent - 1}`;
}

/** Increment digits in place; return true when the carry raises the exponent. */
function roundUpDigits(digits: number[]): boolean {
	for (let index = digits.length - 1; index >= 0; index -= 1) {
		if ((digits[index] ?? 0) !== 9) {
			digits[index] = (digits[index] ?? 0) + 1;
			return false;
		}
		digits[index] = 0;
	}
	digits[0] = 1;
	return true;
}

function scaleByFiveAndTwo(value: bigint, fives: number, twos: number): bigint {
	return value * FIVE ** BigInt(fives) * (ONE << BigInt(twos));
}

function bitLength(value: bigint): number {
	return value.toString(2).length;
}

function countTrailingZeros(value: bigint): number {
	let count = 0;
	while ((value & ONE) === ZERO) {
		value >>= ONE;
		count += 1;
	}
	return count;
}

function compareBigInts(left: bigint, right: bigint): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function rawDoubleBits(value: number): bigint {
	const buffer = new ArrayBuffer(8);
	const view = new DataView(buffer);
	view.setFloat64(0, value, false);
	return (
		(BigInt(view.getUint32(0, false)) << BigInt(32)) +
		BigInt(view.getUint32(4, false))
	);
}
