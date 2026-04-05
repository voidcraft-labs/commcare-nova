import type { XPathValue } from "./types";
import { isXPathDate, XPathDate } from "./types";

/**
 * XPath 1.0 type coercion: value → number.
 *
 * CommCare extension: XPathDate coerces to integer days since epoch,
 * matching `DateUtils.daysSinceEpoch()` in commcare-core. This is what
 * makes `today() + 1` return tomorrow's day-number.
 */
export function toNumber(v: XPathValue): number {
	if (typeof v === "number") return v;
	if (typeof v === "boolean") return v ? 1 : 0;
	if (isXPathDate(v)) return v.days;
	const trimmed = (v as string).trim();
	if (trimmed === "") return NaN;
	return Number(trimmed);
}

/**
 * XPath 1.0 type coercion: value → string.
 *
 * XPathDate emits ISO-8601 (`YYYY-MM-DD`, or full timestamp if it
 * carries a time component from `now()`).
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

/**
 * XPath 1.0 type coercion: value → boolean.
 *
 * Dates are always truthy (matches CommCare core).
 */
export function toBoolean(v: XPathValue): boolean {
	if (typeof v === "boolean") return v;
	if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
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
 * Date-aware addition: if either operand is an XPathDate, the result
 * is an XPathDate shifted by the other operand's numeric value.
 *
 * - `date + number` → date shifted forward by N days
 * - `number + date` → same (commutative)
 * - `date + date`   → numeric sum of days (unusual, but consistent)
 * - otherwise        → plain numeric addition
 */
export function dateAwareAdd(a: XPathValue, b: XPathValue): XPathValue {
	const aIsDate = isXPathDate(a);
	const bIsDate = isXPathDate(b);
	if (!aIsDate && !bIsDate) return toNumber(a) + toNumber(b);
	/* At least one operand is a date — compute the numeric sum */
	const sum = toNumber(a) + toNumber(b);
	if (Number.isNaN(sum)) return NaN;
	/* Preserve date type when shifting (date + number or number + date) */
	if (aIsDate !== bIsDate) return XPathDate.fromDays(sum);
	/* Both dates — return raw number (day sum has no date semantics) */
	return sum;
}

/**
 * Date-aware subtraction: preserves date type when shifting backward,
 * returns a plain number for date differences.
 *
 * - `date - number` → date shifted backward by N days
 * - `date - date`   → number of days between them
 * - `number - date`  → raw number (no date semantics)
 * - otherwise         → plain numeric subtraction
 */
export function dateAwareSubtract(a: XPathValue, b: XPathValue): XPathValue {
	const aIsDate = isXPathDate(a);
	const bIsDate = isXPathDate(b);
	if (!aIsDate && !bIsDate) return toNumber(a) - toNumber(b);
	const diff = toNumber(a) - toNumber(b);
	if (Number.isNaN(diff)) return NaN;
	/* date - number → shifted date */
	if (aIsDate && !bIsDate) return XPathDate.fromDays(diff);
	/* date - date → day difference (plain number) */
	/* number - date → plain number (no meaningful date semantics) */
	return diff;
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
