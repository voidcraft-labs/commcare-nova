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

/** Explicit context supplied by the emitted form: root /data, answer and group. */
export const nativePathCases = [
	{
		name: "absolute field",
		source: "string(/data/group/value)",
		expected: "nested",
	},
	{ name: "child wildcard", source: "count(/data/group/*)", expected: 2 },
	{
		name: "explicit child axis",
		source: "count(/data/child::group/child::*)",
		expected: 2,
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
		name: "attribute axis",
		source: "string(/data/attribute::name)",
		expected: "xpath_proof",
	},
	{
		name: "self axis",
		source: "string(self::node()/group/value)",
		expected: "nested",
	},
	{
		name: "current root",
		source: "string(current()/group/value)",
		expected: "nested",
	},
] as const;

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
