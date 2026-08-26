import { openJdk17DoubleToString } from "./openJdk17DoubleString";
import {
	isXPathNodeSet,
	unpackXPathRuntimeValue,
	type XPathRuntimeValue,
} from "./runtimeValues";
import { isXPathDate, XPathDate } from "./types";

/**
 * XPath 1.0 type coercion: value → number.
 *
 * CommCare extension: XPathDate coerces to integer days since epoch,
 * matching `DateUtils.daysSinceEpoch()` in commcare-core. This is what
 * makes `today() + 1` return tomorrow's day-number.
 *
 * String coercion mirrors JavaRosa's `FunctionUtils.toNumeric`
 * (`commcare-core .../xpath/expr/FunctionUtils.java`): a character gate
 * admits only `[0-9.-]` (rejecting scientific notation and `Infinity`
 * per the XPath spec), then numeric parse, then — the load-bearing
 * fallback — DATE parse to days-since-epoch. The date fallback is what
 * makes `. <= today()` hold on a date field, whose instance value is
 * the ISO string: without it the comparison reads `NaN <= <days>` and
 * every authored date validation fails on every value the user enters.
 *
 * Casedb timestamps are projected as first-class `XPathDate` values, just as
 * Core exposes `DateData`. Extending string coercion to compensate for a
 * wrongly typed projection would make authored datetime string literals
 * behave differently in Preview and on-device.
 */

export function toNumber(input: XPathRuntimeValue): number {
	const v = unpackXPathRuntimeValue(input);
	if (typeof v === "number") return v;
	if (typeof v === "boolean") return v ? 1 : 0;
	if (isXPathDate(v)) return v.days;
	const trimmed = (v as string).trim();
	if (trimmed === "") return NaN;
	if (/[^0-9.-]/.test(trimmed)) return NaN;
	const parsed = Number(trimmed);
	if (!Number.isNaN(parsed)) return parsed;
	const date = XPathDate.parse(trimmed);
	return date !== null ? date.days : NaN;
}

/**
 * XPath 1.0 type coercion: value → string.
 *
 * XPathDate emits Core's local ISO date (`YYYY-MM-DD`); even `now()` loses its
 * time component under `FunctionUtils.toString(Date)`.
 */

export function xpathToString(input: XPathRuntimeValue): string {
	const v = unpackXPathRuntimeValue(input);
	if (typeof v === "string") return v;
	if (typeof v === "boolean") return v ? "true" : "false";
	if (isXPathDate(v)) return v.toISOString();
	/* number */
	if (Number.isNaN(v)) return "NaN";
	if (Math.abs(v) < 1.0e-12) return "0";
	if (!Number.isFinite(v)) return v < 0 ? "-Infinity" : "Infinity";
	if (
		v >= -2_147_483_648 &&
		v <= 2_147_483_647 &&
		Math.abs(v - Math.trunc(v)) < 1.0e-12
	) {
		return String(Math.trunc(v));
	}
	return openJdk17DoubleToString(v);
}

/** CommCare's `FunctionUtils.toDouble` preserves fractional days only when its
 * DIRECT argument is a Date. A path remains an XPathNodeset at this boundary;
 * Core sends that wrapper through `toNumeric()`, which unpacks the singleton
 * and applies whole-day Date coercion. */

export function toDouble(input: XPathRuntimeValue): number {
	if (isXPathNodeSet(input) || !isXPathDate(input)) return toNumber(input);
	const instant = input.toJSDate();
	if (input.time === null) return input.days;
	const epoch = new Date(1970, 0, 1);
	const timezoneDriftMs =
		(instant.getTimezoneOffset() - epoch.getTimezoneOffset()) * 60_000;
	return (instant.getTime() - epoch.getTime() - timezoneDriftMs) / 86_400_000;
}

/**
 * XPath 1.0 type coercion: value → boolean.
 *
 * Dates are always truthy (matches CommCare core).
 */

export function toBoolean(input: XPathRuntimeValue): boolean {
	const v = unpackXPathRuntimeValue(input);
	if (typeof v === "boolean") return v;
	if (typeof v === "number") return Math.abs(v) > 1.0e-12 && !Number.isNaN(v);
	if (isXPathDate(v)) return true;
	return (v as string).length > 0;
}

/**
 * Coerce any XPath value to an XPathDate.
 *
 * - XPathDate → returned as-is
 * - number   → interpreted as days since epoch (matches CommCare `date(n)`)
 * - string   → parsed as ISO-8601 date
 *
 * Returns null if the value can't be interpreted as a date.
 */

export function toDate(input: XPathRuntimeValue): XPathDate | null {
	const v = unpackXPathRuntimeValue(input);
	if (isXPathDate(v)) return v;
	if (typeof v === "number") {
		if (!Number.isFinite(v) || v > 2_147_483_647 || v < -2_147_483_648) {
			return null;
		}
		return XPathDate.fromDays(v);
	}
	if (typeof v === "string") return XPathDate.parse(v);
	/* boolean — no date interpretation */
	return null;
}

/**
 * XPath 1.0 equality comparison.
 * If either operand is boolean → compare as booleans.
 * If either operand is number → compare as numbers.
 * Otherwise compare as strings.
 */

export function compareEqual(
	aInput: XPathRuntimeValue,
	bInput: XPathRuntimeValue,
): boolean {
	const a = unpackXPathRuntimeValue(aInput);
	const b = unpackXPathRuntimeValue(bInput);
	if (typeof a === "boolean" || typeof b === "boolean")
		return toBoolean(a) === toBoolean(b);
	if (typeof a === "number" || typeof b === "number")
		return Math.abs(toNumber(a) - toNumber(b)) < 1.0e-12;
	return xpathToString(a) === xpathToString(b);
}

/**
 * XPath 1.0 relational comparison (for <, <=, >, >=).
 * Compares as numbers.
 */
export function compareRelational(
	a: XPathRuntimeValue,
	b: XPathRuntimeValue,
	op: "<" | "<=" | ">" | ">=",
): boolean {
	const na = toNumber(a);
	const nb = toNumber(b);
	switch (op) {
		case "<":
			return na < nb;
		case "<=":
			return na <= nb;
		case ">":
			return na > nb;
		case ">=":
			return na >= nb;
	}
}
