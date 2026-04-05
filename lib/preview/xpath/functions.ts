import { toBoolean, toDate, toNumber, xpathToString } from "./coerce";
import type { XPathValue } from "./types";
import { XPathDate } from "./types";

type XPathFn = (args: XPathValue[]) => XPathValue;

/** Registry of supported XPath/CommCare functions. */
const registry = new Map<string, XPathFn>();

function register(name: string, fn: XPathFn) {
	registry.set(name, fn);
}

export function getFunction(name: string): XPathFn | undefined {
	return registry.get(name);
}

// ── Boolean / Logic ──────────────────────────────────────────────────

register("true", () => true);
register("false", () => false);
register("not", (args) => !toBoolean(args[0] ?? ""));
register("boolean", (args) => toBoolean(args[0] ?? ""));

// ── CommCare if() — if(cond, then, else) ────────────────────────────

register("if", (args) => {
	const cond = toBoolean(args[0] ?? "");
	return cond ? (args[1] ?? "") : (args[2] ?? "");
});

// ── Type conversion ─────────────────────────────────────────────────

register("string", (args) => xpathToString(args[0] ?? ""));
register("number", (args) => toNumber(args[0] ?? ""));
register("int", (args) => {
	const n = toNumber(args[0] ?? "");
	return Number.isNaN(n) ? NaN : Math.trunc(n);
});
register("round", (args) => {
	const n = toNumber(args[0] ?? "");
	const decimals = args.length > 1 ? toNumber(args[1] ?? 0) : 0;
	if (Number.isNaN(n)) return NaN;
	const factor = 10 ** decimals;
	return Math.round(n * factor) / factor;
});

// ── String functions ────────────────────────────────────────────────

register("concat", (args) => args.map((a) => xpathToString(a)).join(""));
register("string-length", (args) => xpathToString(args[0] ?? "").length);
register("contains", (args) =>
	xpathToString(args[0] ?? "").includes(xpathToString(args[1] ?? "")),
);
register("starts-with", (args) =>
	xpathToString(args[0] ?? "").startsWith(xpathToString(args[1] ?? "")),
);
register("normalize-space", (args) =>
	xpathToString(args[0] ?? "")
		.trim()
		.replace(/\s+/g, " "),
);
register("translate", (args) => {
	const str = xpathToString(args[0] ?? "");
	const from = xpathToString(args[1] ?? "");
	const to = xpathToString(args[2] ?? "");
	let result = "";
	for (const ch of str) {
		const idx = from.indexOf(ch);
		if (idx === -1) result += ch;
		else if (idx < to.length) result += to[idx];
		// else: character is removed (no replacement)
	}
	return result;
});
register("substr", (args) => {
	const str = xpathToString(args[0] ?? "");
	// CommCare substr is 0-based: substr(string, start, end?)
	const start = Math.max(0, toNumber(args[1] ?? 0));
	if (args.length > 2) {
		const end = toNumber(args[2] ?? 0);
		return str.substring(start, end);
	}
	return str.substring(start);
});
register("join", (args) => {
	// join(separator, ...items)
	const sep = xpathToString(args[0] ?? "");
	return args
		.slice(1)
		.map((a) => xpathToString(a))
		.join(sep);
});

// ── CommCare selected() — multi-select check ────────────────────────

register("selected", (args) => {
	const value = xpathToString(args[0] ?? "");
	const option = xpathToString(args[1] ?? "");
	return value.split(" ").includes(option);
});
register("count-selected", (args) => {
	const value = xpathToString(args[0] ?? "").trim();
	if (value === "") return 0;
	return value.split(" ").length;
});

// ── Coalesce ────────────────────────────────────────────────────────

register("coalesce", (args) => {
	for (const a of args) {
		const s = xpathToString(a);
		if (s !== "") return s;
	}
	return "";
});

// ── Math ────────────────────────────────────────────────────────────

register("ceiling", (args) => Math.ceil(toNumber(args[0] ?? "")));
register("floor", (args) => Math.floor(toNumber(args[0] ?? "")));
register("abs", (args) => Math.abs(toNumber(args[0] ?? "")));
register("pow", (args) => toNumber(args[0] ?? 0) ** toNumber(args[1] ?? 0));
register("min", (args) => Math.min(...args.map((a) => toNumber(a))));
register("max", (args) => Math.max(...args.map((a) => toNumber(a))));

// ── Aggregate (count, sum — operate on nodeset approximation) ───────

register("count", (args) => {
	// In preview, count() of a path returns the repeat count or 0/1
	// This is handled as a number pass-through from the evaluator
	return toNumber(args[0] ?? 0);
});
register("sum", (args) => {
	// Simple pass-through — sum of scalar
	return toNumber(args[0] ?? 0);
});

// ── Position / Size ─────────────────────────────────────────────────
// These are handled directly by the evaluator via context.position/size
// but we register stubs so they don't error when called as functions.
register("position", () => 1);
register("last", () => 1);

// ── Date / Time ─────────────────────────────────────────────────────

/**
 * today() → XPathDate representing midnight of the current day.
 * Matches CommCare core's XPathTodayFunc: `DateUtils.roundDate(new Date())`.
 */
register("today", () => XPathDate.fromJSDateOnly(new Date()));

/**
 * now() → XPathDate with time component preserved.
 * String coercion emits full ISO-8601 timestamp; numeric coercion
 * still truncates to whole days (matching CommCare behavior).
 */
register("now", () => XPathDate.fromJSDate(new Date()));

/**
 * date(value) → XPathDate.
 *
 * - number → days since epoch (e.g. `date(0)` = 1970-01-01)
 * - string → parse ISO-8601 date
 * - XPathDate → returned as-is
 *
 * Matches CommCare core's XPathDateFunc / FunctionUtils.toDate().
 */
register("date", (args) => {
	const v = args[0] ?? "";
	const d = toDate(v);
	if (d) return d;
	/* Unparseable — return the string unchanged (CommCare passthrough). */
	return xpathToString(v);
});

/**
 * format-date(date, format) — format a date value with %-tokens.
 *
 * Accepts XPathDate, date strings, or day-numbers. The first argument
 * is coerced via toDate() so expressions like `format-date(today(), '%Y')`
 * and `format-date('2024-01-15', '%e')` both work.
 */
register("format-date", (args) => {
	const raw = args[0] ?? "";
	const format = xpathToString(args[1] ?? "%Y-%m-%d");

	/* Coerce first arg to a date, then to a JS Date for field extraction. */
	const xd = toDate(raw);
	if (!xd) return xpathToString(raw);
	const d = xd.toJSDate();

	return format
		.replace("%Y", String(d.getUTCFullYear()))
		.replace("%m", String(d.getUTCMonth() + 1).padStart(2, "0"))
		.replace("%d", String(d.getUTCDate()).padStart(2, "0"))
		.replace("%H", String(d.getUTCHours()).padStart(2, "0"))
		.replace("%M", String(d.getUTCMinutes()).padStart(2, "0"))
		.replace("%S", String(d.getUTCSeconds()).padStart(2, "0"))
		.replace("%e", String(d.getUTCDate()));
});

// ── Misc ────────────────────────────────────────────────────────────

register("uuid", () => crypto.randomUUID());
register("regex", (args) => {
	try {
		const str = xpathToString(args[0] ?? "");
		const pattern = xpathToString(args[1] ?? "");
		return new RegExp(pattern).test(str);
	} catch {
		return false;
	}
});
register("instance", () => "");
