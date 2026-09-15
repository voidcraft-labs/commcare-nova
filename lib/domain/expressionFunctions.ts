/**
 * Expression function signatures shared by authoring, validation and documentation.
 *
 * Source of truth for arities: commcare-core's ASTNodeFunctionCall.java
 * Source of truth for types: XPath 1.0 spec + CommCare runtime behavior
 *
 * -1 for maxArgs means variadic (no upper limit).
 */

/** JavaRosa runtime types plus 'any' for polymorphic contexts. */
export type XPathType =
	| "string"
	| "number"
	| "boolean"
	| "nodeset"
	| "sequence"
	| "any";

export interface FunctionSpec {
	minArgs: number;
	maxArgs: number;
	returnType: XPathType;
	/** Core evaluates lazy functions branch-by-branch rather than eagerly. */
	evaluation?: "eager" | "lazy";
	/** Core marks the expression volatile for dependency/reevaluation purposes. */
	volatile?: boolean;
	/** Positional parameter types. Omit for variadic or all-any functions. */
	paramTypes?: XPathType[];
	/** Variadic groups add this many arguments after the minimum. */
	argumentStep?: number;
}

// Shorthand constructors for common patterns
const num = (
	minArgs: number,
	maxArgs: number,
	paramTypes?: XPathType[],
): FunctionSpec => ({ minArgs, maxArgs, returnType: "number", paramTypes });
const str = (
	minArgs: number,
	maxArgs: number,
	paramTypes?: XPathType[],
): FunctionSpec => ({ minArgs, maxArgs, returnType: "string", paramTypes });
const bool = (
	minArgs: number,
	maxArgs: number,
	paramTypes?: XPathType[],
): FunctionSpec => ({ minArgs, maxArgs, returnType: "boolean", paramTypes });
const any = (
	minArgs: number,
	maxArgs: number,
	paramTypes?: XPathType[],
): FunctionSpec => ({ minArgs, maxArgs, returnType: "any", paramTypes });

/**
 * Functions Nova admits in authored XForm XPath.
 *
 * Membership is intentionally narrower than "known XPath": every ordinary
 * call is either native in JavaRosa or has a proven lowering at the wire
 * boundary. `instance()` and `current()` are the two path-only parser
 * intrinsics; xpathValidator enforces their position separately.
 */
export const FUNCTION_REGISTRY: ReadonlyMap<string, FunctionSpec> = new Map<
	string,
	FunctionSpec
>([
	// ── Constants ─────────────────────────────────────────────────────
	["true", bool(0, 0)],
	["false", bool(0, 0)],
	["pi", num(0, 0)],

	// ── Date/Time (dates are numbers internally — days since epoch) ──
	["today", { ...num(0, 0), volatile: true }],
	["now", { ...num(0, 0), volatile: true }],
	["date", num(1, 1)], // string → date-as-number
	["format-date", str(2, 2, ["number", "string"])],
	["format-date-for-calendar", str(2, 3, ["number", "string"])],

	// ── Type conversion ───────────────────────────────────────────────
	["boolean", bool(1, 1)], // any → boolean (explicit cast)
	["number", num(1, 1)], // any → number (explicit cast)
	["int", num(1, 1)], // any → integer
	["double", num(1, 1)], // any → double
	["string", str(1, 1)], // any → string (explicit cast)
	["boolean-from-string", bool(1, 1)], // string → boolean

	// ── Boolean / Logic ───────────────────────────────────────────────
	["not", bool(1, 1, ["boolean"])],
	["is-blank", bool(1, 1)],

	// ── Numeric (1 arg) ───────────────────────────────────────────────
	["abs", num(1, 1, ["number"])],
	["ceiling", num(1, 1, ["number"])],
	["floor", num(1, 1, ["number"])],
	["round", num(1, 1, ["number"])],
	["log", num(1, 1, ["number"])],
	["log10", num(1, 1, ["number"])],
	["sqrt", num(1, 1, ["number"])],
	["exp", num(1, 1, ["number"])],
	["sin", num(1, 1, ["number"])],
	["cos", num(1, 1, ["number"])],
	["tan", num(1, 1, ["number"])],
	["asin", num(1, 1, ["number"])],
	["acos", num(1, 1, ["number"])],
	["atan", num(1, 1, ["number"])],

	// ── Numeric (2 args) ──────────────────────────────────────────────
	["pow", num(2, 2, ["number", "number"])],
	["atan2", num(2, 2, ["number", "number"])],

	// ── String functions ──────────────────────────────────────────────
	["string-length", num(1, 1, ["string"])],
	["upper-case", str(1, 1, ["string"])],
	["lower-case", str(1, 1, ["string"])],
	["normalize-space", str(1, 1, ["string"])],
	["contains", bool(2, 2, ["string", "string"])],
	["starts-with", bool(2, 2, ["string", "string"])],
	["ends-with", bool(2, 2, ["string", "string"])],
	["substring-before", str(2, 2, ["string", "string"])],
	["substring-after", str(2, 2, ["string", "string"])],
	["translate", str(3, 3, ["string", "string", "string"])],
	["replace", str(3, 3, ["string", "string", "string"])],
	["substr", str(2, 3, ["string", "number"])],
	["regex", bool(2, 2, ["string", "string"])],

	// ── Nodeset / Aggregation ─────────────────────────────────────────
	["count", num(1, 1)],
	["sum", num(1, 1)],
	["position", num(0, 1)],

	// ── Multi-select helpers ──────────────────────────────────────────
	["selected", bool(2, 2, ["string", "string"])],
	["is-selected", bool(2, 2, ["string", "string"])],
	["count-selected", num(1, 1, ["string"])],
	["selected-at", str(2, 2, ["string", "number"])],

	// ── Variadic (all-any params) ─────────────────────────────────────
	["concat", str(0, -1)],
	["join", str(1, -1)],
	["join-chunked", str(3, -1)],
	["coalesce", any(1, -1)],
	["depend", { ...any(1, -1), volatile: true }],
	["min", num(1, -1)],
	["max", num(1, -1)],

	// ── Conditionals (polymorphic return) ─────────────────────────────
	[
		"if",
		{
			...any(3, 3, ["boolean"]),
			returnType: "any",
			evaluation: "lazy",
		},
	],
	[
		"cond",
		{
			...any(3, -1),
			evaluation: "lazy",
			argumentStep: 2,
		},
	],

	// ── Volatile ──────────────────────────────────────────────────────
	["random", { ...num(0, 0), volatile: true }],
	["uuid", { ...str(0, 1), volatile: true }],

	// ── Geo ───────────────────────────────────────────────────────────
	["distance", num(2, 2, ["string", "string"])],
	["closest-point-on-polygon", str(2, 2, ["string", "string"])],
	["is-point-inside-polygon", bool(2, 2, ["string", "string"])],

	// ── Sort / Collection ─────────────────────────────────────────────
	["sort", str(1, 2)],
	["sort-by", str(2, 3)],
	["distinct-values", { minArgs: 1, maxArgs: 1, returnType: "sequence" }],
	// Core returns a zero-based number when found and the empty string otherwise.
	["index-of", any(2, 2)],

	// ── Checklist ─────────────────────────────────────────────────────
	["checklist", bool(2, -1)],
	[
		"weighted-checklist",
		{
			...bool(2, -1),
			argumentStep: 2,
		},
	],

	// ── Secondary Instances ──────────────────────────────────────────
	[
		"instance",
		{
			minArgs: 1,
			maxArgs: 1,
			returnType: "nodeset" as XPathType,
			paramTypes: ["string" as XPathType],
		},
	],
	[
		"current",
		{
			minArgs: 0,
			maxArgs: 0,
			returnType: "nodeset" as XPathType,
		},
	],

	// ── Crypto / Utility ──────────────────────────────────────────────
	["checksum", str(2, 2, ["string", "string"])],
	["encrypt-string", str(3, 3, ["string", "string", "string"])],
	["decrypt-string", str(3, 3, ["string", "string", "string"])],
	["json-property", str(2, 2, ["string", "string"])],
	["id-compress", str(5, 5)],
	["sleep", { ...any(2, 2, ["number", "any"]), volatile: true }],
]);

/** Case-insensitive lookup for suggesting corrections (e.g. "Today" → "today"). */
export function findCaseInsensitiveMatch(name: string): string | undefined {
	const lower = name.toLowerCase();
	for (const key of FUNCTION_REGISTRY.keys()) {
		if (key.toLowerCase() === lower) return key;
	}
	return undefined;
}

export type FunctionArity = Pick<
	FunctionSpec,
	"minArgs" | "maxArgs" | "argumentStep"
>;

/** Query expressions share ordinary operations with forms. Relationships and
 * record selection add functions whose arguments have a different scope. */
export const QUERY_FUNCTIONS: ReadonlyMap<string, FunctionArity> = new Map([
	...[
		"true",
		"false",
		"today",
		"now",
		"date",
		"number",
		"format-date",
		"not",
		"is-blank",
		"concat",
		"coalesce",
		"if",
		"starts-with",
	].map((name): [string, FunctionArity] => {
		const spec = FUNCTION_REGISTRY.get(name);
		if (!spec) throw new Error(`Missing shared expression signature: ${name}`);
		return [name, spec];
	}),
	...Object.entries({
		null: [0, 0],
		self: [0, 0],
		unbounded: [0, 0],
		"acting-user": [0, 0],
		unowned: [0, 0],
		children: [0, 2],
		related: [0, 2],
		ancestor: [1, -1],
		link: [1, 2],
		property: [2, 3],
		via: [2, 2],
		field: [1, 1],
		search: [1, 1],
		user: [1, 1],
		session: [1, 1],
		"external-user": [1, 1],
		location: [1, 1],
		"owner-location": [2, 2],
		"table-column": [2, 2],
		literal: [1, 2],
		quotient: [2, 2],
		"id-of": [1, 1],
		lookup: [3, 3],
		"date-add": [3, 3],
		datetime: [1, 1],
		count: [1, 2],
		all: [0, -1],
		any: [0, -1],
		in: [2, -1],
		"matches-pattern": [2, 2],
		between: [3, 5],
		"selected-any": [2, -1],
		"selected-all": [2, -1],
		fuzzy: [2, 2],
		phonetic: [2, 2],
		"fuzzy-date": [2, 2],
		"within-distance": [4, 4],
		"when-provided": [2, 2],
		exists: [1, 2],
		missing: [1, 2],
	}).map(([name, [minArgs, maxArgs]]): [string, FunctionArity] => [
		name,
		{ minArgs, maxArgs },
	]),
	["switch", { minArgs: 4, maxArgs: -1, argumentStep: 2 }],
]);

export function functionArgumentCount(spec: FunctionArity): string {
	if (spec.minArgs === spec.maxArgs) return `${spec.minArgs} arguments`;
	if (spec.argumentStep === 2)
		return `an ${spec.minArgs % 2 === 0 ? "even" : "odd"} number of arguments, at least ${spec.minArgs}`;
	return spec.maxArgs === -1
		? `${spec.minArgs} or more arguments`
		: `${spec.minArgs} to ${spec.maxArgs} arguments`;
}

export function functionArityIssue(
	name: string,
	count: number,
	spec: FunctionArity,
): string | undefined {
	if (
		count >= spec.minArgs &&
		(spec.maxArgs === -1 || count <= spec.maxArgs) &&
		(count - spec.minArgs) % (spec.argumentStep ?? 1) === 0
	)
		return;
	return `${name}() needs ${functionArgumentCount(spec)}; received ${count}.`;
}
