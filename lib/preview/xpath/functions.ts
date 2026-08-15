import { PREVIEW_NATIVE_FUNCTIONS } from "@/lib/commcare/xpath/functionCapabilities";
import { toBoolean, toDate, toDouble, toNumber, xpathToString } from "./coerce";
import { formatCommCareDate } from "./dateFormatting";
import type { XPathFunctionInvocation, XPathValue } from "./types";
import { isXPathDate, XPathDate } from "./types";

type XPathFn = (args: XPathValue[]) => XPathValue;

/** Registry of supported XPath/CommCare functions. */
const registry = new Map<string, XPathFn>();

function register(name: string, fn: XPathFn) {
	if (!PREVIEW_NATIVE_FUNCTIONS.has(name)) {
		throw new Error(
			`Preview registered ${name}(), but the XPath carrier contract does not classify it as implemented.`,
		);
	}
	registry.set(name, fn);
}

/** Test/audit surface: the implementation must equal the carrier contract. */
export function registeredPreviewFunctions(): ReadonlySet<string> {
	return new Set(registry.keys());
}

/**
 * Invoke only a function registered by this module.
 *
 * XPath text is user-authored, so the parsed function name is untrusted. Keep
 * the membership and callable checks adjacent to invocation: an unknown name
 * (including an Object prototype method) can never become a dynamic call.
 */
export function invokeFunction(
	name: string,
	args: XPathValue[],
): XPathFunctionInvocation {
	if (!registry.has(name)) return { kind: "unsupported" };

	const fn = registry.get(name);
	if (typeof fn !== "function") return { kind: "unsupported" };

	return { kind: "handled", value: fn(args) };
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
register("double", (args) => toDouble(args[0] ?? ""));
register("int", (args) => {
	const n = toNumber(args[0] ?? "");
	return Number.isNaN(n) ? NaN : Math.trunc(n);
});
register("round", (args) => {
	const n = toDouble(args[0] ?? "");
	const decimals = args.length > 1 ? toNumber(args[1] ?? 0) : 0;
	if (Number.isNaN(n)) return NaN;
	const factor = 10 ** decimals;
	return Math.round(n * factor) / factor;
});

// ── String functions ────────────────────────────────────────────────

register("concat", (args) => args.map((arg) => xpathToString(arg)).join(""));
register("string-length", (args) => xpathToString(args[0] ?? "").length);
register("contains", (args) =>
	xpathToString(args[0] ?? "").includes(xpathToString(args[1] ?? "")),
);
register("starts-with", (args) =>
	xpathToString(args[0] ?? "").startsWith(xpathToString(args[1] ?? "")),
);
register("normalize-space", (args) =>
	xpathToString(args[0] ?? "")
		.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "")
		.replace(/[ \t\r\n]+/g, " "),
);
register("translate", (args) => {
	const str = xpathToString(args[0] ?? "");
	const from = xpathToString(args[1] ?? "");
	const to = xpathToString(args[2] ?? "");
	const replacementLimit = Math.min(from.length, to.length);
	const replacements = new Map<string, string>();
	for (let index = 0; index < replacementLimit; index += 1) {
		const fromUnit = from[index] ?? "";
		if (!replacements.has(fromUnit)) {
			replacements.set(fromUnit, to[index] ?? "");
		}
	}
	const toDelete = from.slice(replacementLimit);
	let result = "";
	// Java iterates UTF-16 `char` units, not Unicode code points. Indexed JS
	// strings expose the same units, including the two halves of an astral char.
	for (let index = 0; index < str.length; index += 1) {
		const ch = str[index] ?? "";
		if (toDelete.includes(ch)) continue;
		result += replacements.get(ch) ?? ch;
	}
	return result;
});
register("substr", (args) => {
	const str = xpathToString(args[0] ?? "");
	// JavaRosa is 0-based, accepts negative offsets from the end, and returns
	// blank (rather than swapping indices like String.substring) for an invalid
	// adjusted range.
	let start = javaIntValue(toNumber(args[1] ?? 0));
	let end = args.length > 2 ? javaIntValue(toNumber(args[2] ?? 0)) : str.length;
	if (start < 0) start = str.length + start;
	if (end < 0) end = str.length + end;
	start = Math.min(Math.max(0, start), end);
	end = Math.min(Math.max(0, end), end);
	return start <= end && end <= str.length ? str.slice(start, end) : "";
});
register("join", (args) => {
	const separator = xpathToString(args[0] ?? "");
	return args
		.slice(1)
		.map((arg) => xpathToString(arg))
		.join(separator);
});
// ── CommCare selected() — multi-select check ────────────────────────

register("selected", (args) => {
	const value = xpathToString(args[0] ?? "");
	const option = xpathToString(args[1] ?? "").trim();
	return ` ${value} `.includes(` ${option} `);
});
register("count-selected", (args) => {
	const value = xpathToString(args[0] ?? "");
	if (value === "") return 0;
	const entries = value.split(/ +/);
	while (entries.length > 0 && entries[entries.length - 1] === "") {
		entries.pop();
	}
	return entries.length;
});
register("selected-at", (args) => {
	// Mirrors commcare-core `XPathSelectedAtFunc.selectedAt`: the selection
	// splits per `DataUtil.splitOnSpaces` ("" → zero entries; runs of spaces
	// collapse; Java's split drops trailing empty tokens), and an
	// out-of-range index THROWS — the device errors the evaluating screen
	// rather than rendering an empty string, and Preview must fail the same
	// way instead of green-lighting an expression that crashes the real app.
	const selection = xpathToString(args[0] ?? "");
	const index = javaIntValue(toNumber(args[1] ?? 0));
	const entries = selection === "" ? [] : selection.split(/ +/);
	while (entries.length > 0 && entries[entries.length - 1] === "") {
		entries.pop();
	}
	if (index < 0 || entries.length <= index) {
		throw new Error(
			`Attempting to select element ${index} of a list with only ${entries.length} elements.`,
		);
	}
	return entries[index];
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

register("ceiling", (args) => Math.ceil(toDouble(args[0] ?? "")));
register("floor", (args) => Math.floor(toDouble(args[0] ?? "")));
register("abs", (args) => Math.abs(toDouble(args[0] ?? "")));
register("pow", (args) => toDouble(args[0] ?? 0) ** toDouble(args[1] ?? 0));
register("min", (args) => Math.min(...args.map((arg) => toNumber(arg))));
register("max", (args) => Math.max(...args.map((arg) => toNumber(arg))));

// ── Position ────────────────────────────────────────────────────────
// Handled directly by the evaluator via context.position; registered so the
// implementation table still names every supported function.
register("position", () => 1);

// ── Date / Time ─────────────────────────────────────────────────────

/**
 * today() → XPathDate representing midnight of the current day.
 * Matches CommCare core's XPathTodayFunc: `DateUtils.roundDate(new Date())`.
 */
register("today", () => XPathDate.fromJSDateOnly(new Date()));

/**
 * now() → XPathDate with time retained for double()/format-date(). Core's
 * ordinary string/number coercions still use the local calendar date.
 */
register("now", () => XPathDate.fromJSDate(new Date()));

/**
 * date(value) → XPathDate.
 *
 * - number → days since epoch (e.g. `date(0)` = 1970-01-01)
 * - string → parse ISO-8601 date
 * - XPathDate → rounded to its local date
 *
 * Matches CommCare core's XPathDateFunc / FunctionUtils.toDate().
 */
register("date", (args) => {
	const v = args[0] ?? "";
	const d = isXPathDate(v) ? XPathDate.fromDays(v.days) : toDate(v);
	if (d) return d;
	if (v === "" || (typeof v === "number" && Number.isNaN(v))) return v;
	throw new Error("The XPath date() value is invalid in Preview.");
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
	if (!xd) {
		if (raw === "" || (typeof raw === "number" && Number.isNaN(raw))) return "";
		throw new Error("The XPath format-date() value is invalid in Preview.");
	}
	const result = formatCommCareDate(xd, format);
	if (result.kind === "formatted") return result.text;
	throw new Error("The XPath format-date() pattern is unsupported in Preview.");
});

// ── Misc ────────────────────────────────────────────────────────────

register("uuid", (args) => {
	if (args.length === 0) return crypto.randomUUID();
	const length = Math.trunc(toNumber(args[0] ?? 0));
	let value = "";
	for (let index = 0; index < length; index += 1) {
		value += Math.floor(Math.random() * 36).toString(36);
	}
	return value.toUpperCase();
});

/** Java's final `Double.intValue()` narrowing after FunctionUtils.toInt(). */
function javaIntValue(value: number): number {
	if (Number.isNaN(value)) return 0;
	if (value >= 2_147_483_647) return 2_147_483_647;
	if (value <= -2_147_483_648) return -2_147_483_648;
	return Math.trunc(value);
}
