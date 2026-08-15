import type { XPathValue } from "./types";
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
 * One deliberate extension past the string-for-string mirror: a gate-
 * rejected string still gets a date-parse attempt, so full ISO
 * DATETIMES ("…T21:31:18Z") coerce to their day-number. On-device those
 * values are never strings — casedb hands JavaRosa a typed date the
 * Date arm converts — so "what the device computes" is the datetime's
 * day-number, and preview (where every value IS a string, including the
 * `date_opened`/`last_modified` preloads) must reach the same result.
 * A non-date gate-rejected string ("banana") still fails the parse and
 * lands on NaN, preserving the gate's spec-side rejections.
 */
export function toNumber(v: XPathValue): number {
	if (typeof v === "number") return v;
	if (typeof v === "boolean") return v ? 1 : 0;
	if (isXPathDate(v)) return v.days;
	const trimmed = (v as string).trim();
	if (trimmed === "") return NaN;
	if (/[^0-9.-]/.test(trimmed)) {
		const date = XPathDate.parse(trimmed);
		return date !== null ? date.days : NaN;
	}
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
export function xpathToString(v: XPathValue): string {
	if (typeof v === "string") return v;
	if (typeof v === "boolean") return v ? "true" : "false";
	if (isXPathDate(v)) return v.toISOString();
	/* number */
	if (Number.isNaN(v)) return "NaN";
	if (Number.isInteger(v)) return String(v);
	return String(v);
}

/** CommCare's `FunctionUtils.toDouble` differs from ordinary XPath numeric
 * coercion only for Date values: it preserves the local time-of-day as a
 * fractional day instead of rounding to the local calendar day. */
export function toDouble(v: XPathValue): number {
	if (!isXPathDate(v)) return toNumber(v);
	const instant = v.toJSDate();
	if (v.time === null) return v.days;
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
export function toBoolean(v: XPathValue): boolean {
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
export function toDate(v: XPathValue): XPathDate | null {
	if (isXPathDate(v)) return v;
	if (typeof v === "number") {
		if (Number.isNaN(v)) return null;
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
export function compareEqual(a: XPathValue, b: XPathValue): boolean {
	if (typeof a === "boolean" || typeof b === "boolean")
		return toBoolean(a) === toBoolean(b);
	if (typeof a === "number" || typeof b === "number")
		return toNumber(a) === toNumber(b);
	return xpathToString(a) === xpathToString(b);
}

/**
 * XPath 1.0 relational comparison (for <, <=, >, >=).
 * Compares as numbers.
 */
export function compareRelational(
	a: XPathValue,
	b: XPathValue,
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
