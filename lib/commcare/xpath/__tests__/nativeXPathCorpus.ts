import type { JavaRosaFunction } from "../functionCapabilities";

/** Expectations are semantic values, shared with the independent Core runner. */
export const normalizationCases = [
	{
		name: "XML whitespace",
		source: "normalize-space('  alpha\tbeta\r\ngamma  ')",
		expected: "alpha beta gamma",
	},
	{ name: "empty string", source: "normalize-space('')", expected: "" },
	{
		name: "whitespace only",
		source: "normalize-space(' \t\n\r ')",
		expected: "",
	},
	{
		name: "non XML whitespace",
		source: "normalize-space('alpha\u00a0  beta\u2003')",
		expected: "alpha\u00a0 beta\u2003",
	},
	{
		name: "nested calls",
		source: "normalize-space(normalize-space('  alpha  '))",
		expected: "alpha",
	},
	{
		name: "multiple disjoint calls",
		source: "concat(normalize-space(' a '), '|', normalize-space(' b '))",
		expected: "a|b",
	},
	{
		name: "function spelling in literal",
		source: "concat('normalize-space(', normalize-space(' a '))",
		expected: "normalize-space(a",
	},
	{ name: "numeric coercion", source: "normalize-space(42)", expected: "42" },
	{
		name: "boolean coercion",
		source: "normalize-space(true())",
		expected: "true",
	},
	{
		name: "runtime question",
		source: "normalize-space(/data/answer)",
		expected: "alpha beta gamma",
	},
] as const;

/** The actual calculate slot is /data/normalized, beside answer and group. */
export const nativePathCases = [
	{
		name: "absolute field",
		source: "string(/data/group/value)",
		expected: "nested",
	},
	{
		name: "explicit child axis",
		source: "string(/data/child::group/child::value)",
		expected: "nested",
	},
	{
		name: "step predicate",
		source: "string(/data/group/value[. = 'nested'])",
		expected: "nested",
	},
	{
		name: "predicate empty result",
		source: "count(/data/group/value[. = 'other'])",
		expected: 0,
	},
	{
		name: "self axis",
		source: "string(self::node()/../group/value)",
		expected: "nested",
	},
	{
		name: "current question",
		source: "string(current()/../group/value)",
		expected: "nested",
	},
] as const;

/** Core can read these raw paths, but they have no authored graph identity.
 * They are independent runtime controls, never admitted Nova expressions. */
export const rawCorePathControls = [
	{ name: "child wildcard", source: "count(/data/group/*)", expected: 2 },
	{
		name: "explicit child wildcard",
		source: "count(/data/child::group/child::*)",
		expected: 2,
	},
	{
		name: "root name attribute",
		source: "string(/data/attribute::name)",
		expected: "XPath proof",
	},
] as const;

/** One authored invocation for every native name in the model's mapping.
 * The producer binds each invocation and emits its canonical production wire;
 * Core independently checks the dispatched class against this original call. */
export const nativeFunctionCases = {
	abs: "abs(-2)",
	acos: "acos(0)",
	asin: "asin(0)",
	atan: "atan(0)",
	atan2: "atan2(1, 2)",
	boolean: "boolean(/data/answer)",
	"boolean-from-string": "boolean-from-string('true')",
	ceiling: "ceiling(2.5)",
	checklist: "checklist(0, 2, true())",
	checksum: "checksum('abc', 'MD5')",
	"closest-point-on-polygon":
		"closest-point-on-polygon('0 0', '0 0;0 1;1 1;0 0')",
	coalesce: "coalesce(/data/answer, 'fallback')",
	concat: "concat(/data/answer, 'suffix')",
	cond: "cond(true(), 'yes', 'no')",
	contains: "contains(/data/answer, 'alpha')",
	cos: "cos(0)",
	count: "count(/data/group/value)",
	"count-selected": "count-selected('a b')",
	date: "date('2026-01-02')",
	"decrypt-string": "decrypt-string('value', 'key', 'AES')",
	depend: "depend(/data/answer, /data/group/value)",
	distance: "distance('0 0', '1 1')",
	"distinct-values": "distinct-values(/data/group/value)",
	double: "double(2)",
	"encrypt-string": "encrypt-string('value', 'key', 'AES')",
	"ends-with": "ends-with(/data/answer, 'gamma')",
	exp: "exp(1)",
	false: "false()",
	floor: "floor(2.5)",
	"format-date": "format-date(today(), '%Y-%m-%d')",
	"format-date-for-calendar": "format-date-for-calendar(today(), '%Y-%m-%d')",
	"id-compress": "id-compress('a', 'b', 'c', 'd', 'e')",
	if: "if(true(), 'yes', 'no')",
	"index-of": "index-of(/data/group/value, 'nested')",
	int: "int(2.5)",
	"is-point-inside-polygon":
		"is-point-inside-polygon('0 0', '0 0;0 1;1 1;0 0')",
	"is-selected": "is-selected('a b', 'a')",
	join: "join(' ', /data/group/value)",
	"join-chunked": "join-chunked(' ', 2, /data/group/value)",
	"json-property": "json-property('{\"key\":\"value\"}', 'key')",
	log: "log(2)",
	log10: "log10(10)",
	"lower-case": "lower-case(/data/answer)",
	max: "max(1, 2)",
	min: "min(1, 2)",
	not: "not(false())",
	now: "now()",
	number: "number('2')",
	pi: "pi()",
	position: "position()",
	pow: "pow(2, 3)",
	random: "random()",
	regex: "regex(/data/answer, 'alpha')",
	replace: "replace(/data/answer, 'alpha', 'one')",
	round: "round(2.5)",
	selected: "selected('a b', 'a')",
	"selected-at": "selected-at('a b', 0)",
	sin: "sin(0)",
	sleep: "sleep(0, /data/answer)",
	sort: "sort(/data/group/value)",
	"sort-by": "sort-by(/data/group/value, /data/group/other)",
	sqrt: "sqrt(4)",
	"starts-with": "starts-with(/data/answer, 'alpha')",
	string: "string(/data/answer)",
	"string-length": "string-length(/data/answer)",
	substr: "substr(/data/answer, 0, 2)",
	"substring-after": "substring-after(/data/answer, 'alpha')",
	"substring-before": "substring-before(/data/answer, 'gamma')",
	sum: "sum(/data/group/value)",
	tan: "tan(0)",
	today: "today()",
	translate: "translate(/data/answer, 'ab', 'xy')",
	true: "true()",
	"upper-case": "upper-case(/data/answer)",
	uuid: "uuid()",
	"weighted-checklist": "weighted-checklist(0, 2, true(), 1)",
} as const satisfies Record<JavaRosaFunction, string>;

export const refusedNativePaths = [
	"/data/answer | /data/group/value",
	"//value",
	"(/data/group/value)[1]",
	"descendant::value",
	"child::node()",
	"self::node(1)",
	"parent::node('x')",
	"child::ns:*",
	"ns:*",
	"@*",
	"/data/..",
	"group/../answer",
	"current()/group/../answer",
	"current()/@id/../answer",
] as const;

/** Java String.trim strips ASCII controls/spaces, not Unicode NBSP. */
export const nativeCoercionCases = [
	{
		name: "selected ASCII trim",
		source: "selected('a b', ' a ')",
		expected: true,
	},
	{
		name: "selected preserves NBSP",
		source: "selected('a b', '\u00a0a\u00a0')",
		expected: false,
	},
	{ name: "number ASCII trim", source: "number(' 2 ')", expected: 2 },
	{
		name: "number rejects NBSP",
		source: "number('\u00a02\u00a0')",
		expected: Number.NaN,
	},
] as const;

/** Blankness does not use truthiness or trim text. */
export const blankValueCases = [
	{ name: "empty value", source: "is-blank('')", expected: true },
	{
		name: "missing answer",
		source: "is-blank(/data/group/other)",
		expected: true,
	},
	{ name: "zero", source: "is-blank(0)", expected: false },
	{ name: "false", source: "is-blank(false())", expected: false },
	{ name: "whitespace", source: "is-blank(' \t\n')", expected: false },
	{
		name: "computed blank",
		source: "is-blank(normalize-space('  '))",
		expected: true,
	},
	{
		name: "nested boolean",
		source: "is-blank(is-blank('x'))",
		expected: false,
	},
	{
		name: "fallback after empty",
		source: "coalesce('', 'fallback')",
		expected: "fallback",
	},
	{
		name: "fallback after missing",
		source: "coalesce(/data/group/other, 'fallback')",
		expected: "fallback",
	},
	{ name: "keep zero", source: "coalesce(0, 3)", expected: 0 },
	{
		name: "keep false",
		source: "coalesce(false(), true())",
		expected: false,
	},
	{
		name: "keep whitespace",
		source: "coalesce(' ', 'fallback')",
		expected: " ",
	},
] as const;
