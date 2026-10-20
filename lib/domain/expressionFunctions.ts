/**
 * Expression function signatures shared by authoring, validation and documentation.
 *
 * Source of truth for arities: each commcare-core function class's
 * `EXPECTED_ARG_COUNT` / `validateArgCount`, dispatched from ASTNodeFunctionCall.java
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
	/**
	 * Argument positions Core reads as a node-set without unpacking it, for a
	 * call with this many arguments: each function class's `evalBody` tests
	 * `instanceof XPathNodeset` or reads `FunctionUtils.getSequence`. Every other
	 * argument is unpacked (`FunctionUtils.unpack`, `toString`, `toNumeric`,
	 * `toBoolean`), which throws on more than one node
	 * (`org/javarosa/xpath/XPathNodeset.java::unpack`).
	 */
	manyArguments?: (argumentCount: number) => ReadonlySet<number>;
	/** The node-set positions are admitted only together: Core takes its
	 * node-set branch only when every listed argument is a node-set. */
	manyArgumentsJointly?: true;
	/** Argument positions Core returns unchanged, so the caller unpacks them and
	 * the call's result carries what the argument holds. */
	passThrough?: (argumentCount: number) => ReadonlySet<number>;
	/** The call returns one of its `passThrough` arguments as its value, so it
	 * types as those arguments agree, as an `if` expression's branches do. */
	returnsBranch?: true;
	/** Core returns an integral Double, which `Recalculate.java::wrapData`
	 * stores as `IntegerData`, so the call types `int`. */
	integral?: true;
	/** Core returns a Double that is whole when every argument is a whole
	 * number or a yes/no (`FunctionUtils.toNumeric` reads `true` as 1), which
	 * `Recalculate.java::wrapData` stores as `IntegerData`, so the call types
	 * `int` over `int` and yes/no arguments and `decimal` over anything else. */
	integralOverIntegers?: true;
}

const NO_ARGUMENTS: ReadonlySet<number> = new Set();
const onlyWith =
	(count: number, ...positions: number[]) =>
	(argumentCount: number): ReadonlySet<number> =>
		argumentCount === count ? new Set(positions) : NO_ARGUMENTS;
const fromSecond = (argumentCount: number): ReadonlySet<number> =>
	new Set(
		Array.from({ length: Math.max(argumentCount - 1, 0) }, (_, i) => i + 1),
	);

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
	// XPathNumberFunc: FunctionUtils.toNumeric of its argument.
	["number", { ...num(1, 1), integralOverIntegers: true }], // any → number (explicit cast)
	// XPathIntFunc: FunctionUtils.toInt truncates through long.
	["int", { ...num(1, 1), integral: true }], // any → integer
	["double", num(1, 1)], // any → double
	["string", str(1, 1)], // any → string (explicit cast)
	["boolean-from-string", bool(1, 1)], // string → boolean

	// ── Boolean / Logic ───────────────────────────────────────────────
	["not", bool(1, 1, ["boolean"])],
	["is-blank", bool(1, 1)],

	// ── Numeric (1 arg) ───────────────────────────────────────────────
	["abs", num(1, 1, ["number"])],
	// XPathCeilingFunc: Math.ceil.
	["ceiling", { ...num(1, 1, ["number"]), integral: true }],
	// XPathFloorFunc: Math.floor.
	["floor", { ...num(1, 1, ["number"]), integral: true }],
	// XPathRoundFunc: Math.floor(x + 0.5); Core has no two-argument round.
	["round", { ...num(1, 1, ["number"]), integral: true }],
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
	// XPathStringLengthFunc: Double.valueOf(s.length()).
	["string-length", { ...num(1, 1, ["string"]), integral: true }],
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
	// XPathCountFunc / XPathSumFunc: a non-node-set argument throws.
	["count", { ...num(1, 1), manyArguments: onlyWith(1, 0) }],
	// XPathSumFunc adds each node's toNumeric.
	[
		"sum",
		{ ...num(1, 1), manyArguments: onlyWith(1, 0), integralOverIntegers: true },
	],
	// XPathPositionFunc casts its argument to XPathNodeset and reads its first
	// reference, so several nodes are read; the result is an integral Double.
	["position", { ...num(0, 1), manyArguments: onlyWith(1, 0), integral: true }],

	// ── Multi-select helpers ──────────────────────────────────────────
	["selected", bool(2, 2, ["string", "string"])],
	["is-selected", bool(2, 2, ["string", "string"])],
	// XPathCountSelectedFunc: Double.valueOf(splitOnSpaces(s).length).
	["count-selected", { ...num(1, 1, ["string"]), integral: true }],
	["selected-at", str(2, 2, ["string", "number"])],

	// ── Variadic (all-any params) ─────────────────────────────────────
	// XPathConcatFunc: one node-set argument is joined; otherwise each unpacks.
	["concat", { ...str(0, -1), manyArguments: onlyWith(1, 0) }],
	// XPathJoinFunc: the second of two may be a node-set or a sequence.
	["join", { ...str(1, -1), manyArguments: onlyWith(2, 1) }],
	// XPathJoinChunkFunc: the third of three may be a node-set.
	["join-chunked", { ...str(3, -1), manyArguments: onlyWith(3, 2) }],
	// XpathCoalesceFunc: arguments before the last unpack; the last is returned
	// as it evaluates.
	[
		"coalesce",
		{
			...any(1, -1),
			passThrough: (argumentCount) => new Set([argumentCount - 1]),
		},
	],
	// XPathDependFunc: returns its first argument as evaluated and never reads
	// the rest.
	[
		"depend",
		{
			...any(1, -1),
			volatile: true,
			manyArguments: fromSecond,
			passThrough: () => new Set([0]),
		},
	],
	// XPathMinFunc / XPathMaxFunc: one node-set argument is read whole;
	// otherwise each argument goes through toNumeric.
	[
		"min",
		{
			...num(1, -1),
			manyArguments: onlyWith(1, 0),
			integralOverIntegers: true,
		},
	],
	[
		"max",
		{
			...num(1, -1),
			manyArguments: onlyWith(1, 0),
			integralOverIntegers: true,
		},
	],

	// ── Conditionals (polymorphic return) ─────────────────────────────
	[
		"if",
		{
			...any(3, 3, ["boolean"]),
			returnType: "any",
			evaluation: "lazy",
			// XPathIfFunc: the branch taken is returned without unpacking.
			passThrough: () => new Set([1, 2]),
		},
	],
	[
		"cond",
		{
			...any(3, -1),
			evaluation: "lazy",
			argumentStep: 2,
			// XPathCondFunc: each condition goes through toBoolean; the branch
			// taken (an odd argument, or the last) is returned as it evaluates.
			returnsBranch: true,
			passThrough: (argumentCount) =>
				new Set(
					Array.from({ length: argumentCount }, (_, index) => index).filter(
						(index) => index % 2 === 1 || index === argumentCount - 1,
					),
				),
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
	// XPathDistinctValuesFunc reads its argument through getSequence.
	[
		"distinct-values",
		{
			minArgs: 1,
			maxArgs: 1,
			returnType: "sequence",
			manyArguments: onlyWith(1, 0),
		},
	],
	// XPathIndexOfFunc reads its first argument through getSequence and returns
	// a zero-based integral Double when found, the empty string otherwise.
	// XPathIndexOfFunc returns "" when nothing matches, so it is not integral.
	["index-of", { ...any(2, 2), manyArguments: onlyWith(2, 0) }],

	// ── Checklist ─────────────────────────────────────────────────────
	// XPathChecklistFunc: the third of three may be a node-set.
	["checklist", { ...bool(2, -1), manyArguments: onlyWith(3, 2) }],
	// XPathWeightedChecklistFunc: the third and fourth of four are read as
	// node-sets only when both are; otherwise every argument unpacks.
	[
		"weighted-checklist",
		{
			...bool(2, -1),
			argumentStep: 2,
			manyArguments: onlyWith(4, 2, 3),
			manyArgumentsJointly: true,
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
	// XPathSleepFunc: returns its second argument as evaluated.
	[
		"sleep",
		{
			...any(2, 2, ["number", "any"]),
			volatile: true,
			passThrough: () => new Set([1]),
		},
	],
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
		here: [0, 0],
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
