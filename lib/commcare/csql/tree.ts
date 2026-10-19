/**
 * The CSQL tree: what the CSQL emitter builds and `print.ts::printCsql`
 * prints. CSQL text is assembled nowhere else.
 *
 * A node is either CSQL HQ reads (a comparison, a query or value function, a
 * step, a literal, a number, `and`/`or`/`not` and a grouping) or a piece the
 * device works out before HQ sees the text: a runtime hole holding the
 * on-device wire tree of one value, or a choice between two clauses made on
 * the device. Holes and choices carry the segment key Preview's fold
 * substitutes by: the checker path of the subtree they evaluate in the
 * prepared clause (`emitter.ts::prepareCsqlClause`).
 */
import type { WireExpr } from "../xpath/wire/tree";
import type { RuntimeCsqlRejectionKind } from "./segment";

export type CsqlComparison = "=" | "!=" | "<" | "<=" | ">" | ">=";

/** HQ's query functions (`xpath_functions/__init__.py::XPATH_QUERY_FUNCTIONS`)
 * Nova writes. */
export type CsqlQueryFunction =
	| "match-all"
	| "match-none"
	| "not"
	| "ancestor-exists"
	| "subcase-exists"
	| "subcase-count"
	| "selected"
	| "selected-any"
	| "selected-all"
	| "within-distance"
	| "starts-with"
	| "fuzzy-match"
	| "phonetic-match"
	| "fuzzy-date";

/** HQ's value functions (`xpath_functions/__init__.py::XPATH_VALUE_FUNCTIONS`)
 * Nova writes. */
export type CsqlValueFunction =
	| "now"
	| "date"
	| "datetime"
	| "double"
	| "date-add"
	| "datetime-add"
	| "unwrap-list";

/** A condition the device checks before the query is built: while it holds,
 * the whole `_xpath_query` value is `'match-none()'`. */
export interface CsqlObligation {
	readonly condition: WireExpr;
	readonly kind: RuntimeCsqlRejectionKind;
	/** Search prompts whose bytes reach this obligation. */
	readonly inputNames?: readonly string[];
}

/**
 * One value the device works out and splices into the text.
 *
 * - `quoted`: a string between delimiters the device picks from the value
 *   (double quotes unless the value holds one); a value holding both is the
 *   `quote` obligation.
 * - `quote-free`: a value that cannot hold a quote, between fixed double
 *   quotes (a date picker's answer, `today()`, a value an obligation proves
 *   quote-free).
 * - `bare`: interpolated with no delimiters (a number HQ reads as a number).
 */
export interface CsqlRuntimeHole {
	readonly key: string;
	/** The raw on-device read, before any quoting. */
	readonly value: WireExpr;
	readonly quoting: "quoted" | "quote-free" | "bare";
	/** What enters the concat when it differs from `value`. */
	readonly print?: WireExpr;
	/** The value is never blank (`today()`), so no blank guard reads it. */
	readonly neverBlank?: true;
	/** For `quoted`, the prompts the quote obligation blames. */
	readonly inputNames?: readonly string[];
	/** A typed obligation on this value. */
	readonly obligation?: CsqlObligation;
}

export type CsqlNode =
	| {
			readonly k: "cmp";
			readonly op: CsqlComparison;
			readonly left: CsqlNode;
			readonly right: CsqlNode;
	  }
	| {
			readonly k: "and" | "or";
			readonly items: readonly [CsqlNode, CsqlNode, ...CsqlNode[]];
	  }
	| { readonly k: "not"; readonly item: CsqlNode }
	/** Explicit parentheses: an argument HQ's lexer needs grouped, or a
	 * disjunction kept whole under any parent. */
	| { readonly k: "group"; readonly item: CsqlNode }
	| {
			readonly k: "query-call";
			readonly fn: CsqlQueryFunction;
			readonly args: readonly CsqlNode[];
	  }
	| {
			readonly k: "value-call";
			readonly fn: CsqlValueFunction;
			readonly args: readonly CsqlNode[];
	  }
	/** A case property, `@case_type`, or an ancestor path such as
	 * `parent/host` or `parent/@case_id`. */
	| { readonly k: "step"; readonly path: readonly string[] }
	| { readonly k: "literal"; readonly value: string }
	| { readonly k: "number"; readonly value: number }
	/** `unwrap-list`'s argument: a JSON array in one CSQL string literal. */
	| {
			readonly k: "json-list";
			readonly items: readonly (
				| { readonly k: "item"; readonly value: string }
				| { readonly k: "runtime"; readonly hole: CsqlRuntimeHole }
			)[];
	  }
	| { readonly k: "runtime"; readonly hole: CsqlRuntimeHole }
	/** A node followed by an obligation that splices nothing. */
	| {
			readonly k: "guarded";
			readonly item: CsqlNode;
			readonly obligation: CsqlObligation;
	  }
	/** The device picks `then` while `condition` holds, else `else`. */
	| {
			readonly k: "choice";
			readonly key: string;
			readonly condition: WireExpr;
			readonly then: CsqlNode;
			readonly else: CsqlNode;
	  }
	/** `when-input-present`: the clause while the input has an answer, else
	 * `match-all()`. At a clause root it is the flat presence cascade. */
	| {
			readonly k: "presence";
			readonly key: string;
			readonly trigger: WireExpr;
			readonly clause: CsqlNode;
	  };

/** The constructors every emission site uses. */
export const c = {
	cmp: (op: CsqlComparison, left: CsqlNode, right: CsqlNode): CsqlNode => ({
		k: "cmp",
		op,
		left,
		right,
	}),
	and: (first: CsqlNode, second: CsqlNode, ...rest: CsqlNode[]): CsqlNode => ({
		k: "and",
		items: [first, second, ...rest],
	}),
	or: (first: CsqlNode, second: CsqlNode, ...rest: CsqlNode[]): CsqlNode => ({
		k: "or",
		items: [first, second, ...rest],
	}),
	/** `items` joined by `and`/`or`, or the one item alone. */
	join: (k: "and" | "or", items: readonly CsqlNode[]): CsqlNode => {
		const [first, second, ...rest] = items;
		if (first === undefined)
			throw new Error("A CSQL conjunction or disjunction needs a clause.");
		return second === undefined
			? first
			: { k, items: [first, second, ...rest] };
	},
	not: (item: CsqlNode): CsqlNode => ({ k: "not", item }),
	group: (item: CsqlNode): CsqlNode => ({ k: "group", item }),
	query: (fn: CsqlQueryFunction, args: readonly CsqlNode[] = []): CsqlNode => ({
		k: "query-call",
		fn,
		args,
	}),
	value: (fn: CsqlValueFunction, args: readonly CsqlNode[] = []): CsqlNode => ({
		k: "value-call",
		fn,
		args,
	}),
	step: (...path: string[]): CsqlNode => ({ k: "step", path }),
	literal: (value: string): CsqlNode => ({ k: "literal", value }),
	number: (value: number): CsqlNode => ({ k: "number", value }),
	runtime: (hole: CsqlRuntimeHole): CsqlNode => ({ k: "runtime", hole }),
	guarded: (item: CsqlNode, obligation: CsqlObligation): CsqlNode => ({
		k: "guarded",
		item,
		obligation,
	}),
	choice: (
		key: string,
		condition: WireExpr,
		thenNode: CsqlNode,
		elseNode: CsqlNode,
	): CsqlNode => ({
		k: "choice",
		key,
		condition,
		// biome-ignore lint/suspicious/noThenProperty: a tree branch, never awaited.
		then: thenNode,
		else: elseNode,
	}),
	presence: (key: string, trigger: WireExpr, clause: CsqlNode): CsqlNode => ({
		k: "presence",
		key,
		trigger,
		clause,
	}),
} as const;
