// lib/commcare/predicate/caseListFilterEmitter.ts
//
// Per-dialect predicate emitter for CommCare's on-device
// case-list-filter context — the XPath dialect that drops directly
// into a casedb XPath nodeset (`instance('casedb')/casedb/case[<this>]`).
// The wire string this visitor produces appears verbatim inside the
// `<detail>` nodeset filter on every CommCare platform.
//
// Three CommCare wire dialects share the predicate AST: this one,
// CSQL (the predicate inside `<data key="_xpath_query">`), and the
// post-ES search filter. They diverge on operator coverage and on the
// per-operator wire form. This file owns operator dispatch for the
// case-list-filter dialect only; the lexical concerns (string
// quoting, identifier emission, numeric formatting) flow through the
// shared `./stringQuoting` helpers.
//
// Operator coverage (the on-device subset, verified against the
// dispatcher at
// `commcare-core/src/main/java/org/javarosa/xpath/parser/ast/ASTNodeFunctionCall.java:113-269`
// — that file is the canonical list of XPath functions registered
// for case-list-filter evaluation):
//
//   - Sentinels (`match-all` / `match-none`): emit as the boolean
//     literals `true()` / `false()` — XPath 1.0 zero-arg literal
//     functions universally available.
//   - Logical (`and` / `or` / `not`): standard XPath operators with
//     parent-precedence-driven paren-wrapping; `and` binds tighter
//     than `or`.
//   - Comparison: `=`, `!=`, `<`, `<=`, `>`, `>=` — six standard XPath
//     comparison operators.
//   - `is-blank`: the portable absent-or-empty wire form `prop = ''`.
//     Matches absent / cleared / empty alike on every CCHQ dialect
//     because the wire layer collapses the three states into one
//     match set.
//   - `is-null`: throws — strict-absent semantics has no CCHQ wire
//     form (the AST is Postgres-strict family-wide; the wire layer's
//     three-state collapse loses the strictness signal). B5
//     representability checker rejects at authoring time; this throw
//     is the defensive backstop.
//   - `in`: value-equality set membership via or-of-equalities.
//     Single-value collapses to a plain equality; multi-value expands
//     to `(prop = v1 or prop = v2 ...)`. CCHQ's `selected-any` looks
//     similar at first glance but tokenizes its value argument by
//     whitespace at
//     `commcare-hq/corehq/apps/es/case_search.py:291-296`, which
//     would silently break `isIn` on space-bearing values. Citation
//     in the operator arm.
//   - `between`: expand to `gte`/`gt` and/or `lte`/`lt` clauses
//     joined by `and`, picking the strict / non-strict comparator
//     from each `*Inclusive` flag. Single-bound forms emit as a
//     standalone comparison; both-bound forms wrap in parens.
//   - `multi-select-contains`: `selected(prop, 'v')` per-value, with
//     OR / AND composition over multi-value lists per the
//     `quantifier` discriminator. The on-device dispatcher registers
//     `selected` (not `selected-any` / `selected-all` — those are
//     CSQL-only).
//   - `match` mode=starts-with: `starts-with(prop, 'v')` — XPath 1.0
//     standard function.
//   - `match` mode∈{fuzzy, phonetic, fuzzy-date}: throws — CSQL-only
//     wire functions, not registered in the on-device dispatcher.
//   - `within-distance`: throws — CSQL-only wire function.
//   - `exists` / `missing`: `count(...) > 0` / `count(...) = 0`
//     against an `instance('casedb')/casedb/case[...]` join nodeset.
//     Ancestor walks anchor on `current()/index/<rel>`; subcase
//     walks reverse direction on `index/<rel>=current()/@case_id`.
//     Multi-hop ancestors compose nested `[@case_id=...]` joins.
//   - `when-input-present`: `if(count(<input>), <clause>, true())` —
//     `true()` is the AND-chain identity for the no-input branch
//     (XPath's boolean coercion of `''` is `false`, which would
//     silently exclude every case on input-unset).

import type {
	ComparisonKind,
	Predicate,
	PropertyRef,
	RelationPath,
	Term,
	ValueExpression,
} from "@/lib/domain/predicate/types";
import { formatNumeric, quoteIdentifier, quoteLiteral } from "./stringQuoting";

/**
 * Mapping from comparison-operator AST kind to its XPath wire token.
 * The six comparison operators share an identical emission shape
 * (`<left> <op> <right>`), so the visitor dispatches off this table
 * rather than restating six near-identical cases. The
 * `Record<ComparisonKind, string>` type pins the table exhaustive
 * against the union — adding a comparison kind to `ComparisonKind`
 * surfaces here as a compile-time error.
 */
const COMPARISON_OPS: Record<ComparisonKind, string> = {
	eq: "=",
	neq: "!=",
	gt: ">",
	gte: ">=",
	lt: "<",
	lte: "<=",
};

/**
 * The four CommCare case properties that CCHQ stores as XML
 * attributes on `<case>` in the casedb restore output. XPath
 * accesses them via the `@` prefix because that is the syntax for
 * addressing XML attributes; the `@` is not a generic CommCare
 * convention but a literal XML-attribute access.
 *
 * Sources (production code, not tests):
 *
 *   - `corehq/ex-submodules/casexml/apps/case/xml/generator.py:237-246`
 *     — `CaseDBXMLGenerator.get_root_element()` sets exactly these
 *     four as XML attributes on `<case>`; everything else is emitted
 *     as a child element.
 *   - `corehq/apps/case_search/const.py:53-103` —
 *     `INDEXED_METADATA_BY_KEY` registers ten system metadata keys;
 *     these four carry the `@` prefix, the other six do not. CSQL
 *     uses the same `@`-prefixed names for the same four.
 */
const RESERVED_CASE_ATTRIBUTES: ReadonlySet<string> = new Set([
	"case_id",
	"case_type",
	"owner_id",
	"status",
]);

/**
 * Operator-precedence levels for paren-grouping decisions. Higher
 * binds tighter; the recursive walker passes its own level down as
 * `parentPrec`, and a child whose level is lower than `parentPrec`
 * wraps itself in parens to preserve the authored grouping. XPath's
 * own precedence (`and` tighter than `or`) drives the two values.
 *
 * Comparisons hold no slot here — they are leaves at this layer
 * because their operands are terms (or term-shaped value
 * expressions), not predicates, so a comparison never wraps a child
 * predicate.
 */
const PREC_OR = 1;
const PREC_AND = 2;

// ============================================================
// Operand handling — ValueExpression -> Term
// ============================================================
//
// Predicate operators carry `ValueExpression` operands (the broader
// expression family that lifts a Term, an arithmetic expression, a
// conditional, etc.). The case-list-filter dialect's per-operator
// wire forms accept only term-shaped operands at this layer; the
// per-dialect Expression emission task wires non-term arms later.
// Until then, this helper unwraps the `term` arm and throws on every
// other arm with an exhaustive switch — a new ValueExpression kind
// surfaces here as a compile-time error rather than as silent
// fall-through.

/**
 * Extract the underlying `Term` from a `ValueExpression`'s `term`
 * arm. Throws on every non-term arm. The exhaustive switch produces
 * a compile-time `never` error when a new ValueExpression kind
 * appears in the union without a matching arm here.
 */
function unwrapTermFromExpression(expr: ValueExpression): Term {
	switch (expr.kind) {
		case "term":
			return expr.term;
		case "today":
		case "now":
		case "date-add":
		case "date-coerce":
		case "datetime-coerce":
		case "double":
		case "arith":
		case "concat":
		case "coalesce":
		case "if":
		case "switch":
		case "count":
		case "unwrap-list":
		case "format-date":
			throw new Error(
				`caseListFilterEmitter: arm '${expr.kind}' is not handled by this emitter; only the term-arm structural lifter is supported here.`,
			);
		default: {
			const _exhaustive: never = expr;
			throw new Error(
				`caseListFilterEmitter: unhandled ValueExpression kind ${String(_exhaustive)}`,
			);
		}
	}
}

// ============================================================
// Public entry point
// ============================================================

/**
 * Compile a `Predicate` AST to its on-device case-list-filter wire
 * string. The output drops directly into a casedb XPath nodeset
 * (`instance('casedb')/casedb/case[<this>]`). The starting
 * `parentPrec` is `0` so the outermost predicate is never wrapped in
 * parens — only nested operators trigger grouping.
 *
 * Throws on operators with no on-device wire form (`is-null`,
 * `within-distance`, `match` modes other than `starts-with`),
 * defensive backstops behind B5's representability checker. Throws
 * on any non-term `ValueExpression` operand because per-dialect
 * Expression emission is its own task; predicate operators emit only
 * with term-shaped operands at this layer.
 */
export function emitCaseListFilter(predicate: Predicate): string {
	return emitPredicate(predicate, 0);
}

// ============================================================
// Predicate dispatch
// ============================================================

/**
 * Recursive walker. Each operator arm consults `parentPrec` to
 * decide whether its emitted string needs to be wrapped in parens to
 * preserve the authored grouping when the parent binds tighter than
 * this operator. Leaf operators (comparisons) ignore `parentPrec` —
 * they never produce a parsing ambiguity at this layer because their
 * operands are terms, not predicates.
 */
function emitPredicate(p: Predicate, parentPrec: number): string {
	switch (p.kind) {
		case "match-all":
			// XPath 1.0 zero-arg literal function. The boolean-algebra
			// identity element of conjunction; AND-combining a clause
			// with `true()` leaves the clause unchanged.
			return "true()";
		case "match-none":
			// XPath 1.0 zero-arg literal function. The boolean-algebra
			// absorbing element of conjunction; AND-combining a clause
			// with `false()` collapses to `false()`.
			return "false()";
		case "eq":
		case "neq":
		case "gt":
		case "gte":
		case "lt":
		case "lte":
			// Six comparison operators share the `<left> <op> <right>`
			// shape. Operands are `ValueExpression`; only the term arm
			// is handled at this layer.
			return `${emitTerm(unwrapTermFromExpression(p.left))} ${COMPARISON_OPS[p.kind]} ${emitTerm(unwrapTermFromExpression(p.right))}`;
		case "and": {
			// `and` recurses with `PREC_AND` as parent precedence so any
			// `or` nested inside an `and` clause wraps itself in parens.
			// XPath's `and` binds tighter than `or`; `A or B and C` would
			// re-associate to `A or (B and C)` rather than `(A or B) and
			// C` if grouping were dropped.
			const inner = p.clauses
				.map((c) => emitPredicate(c, PREC_AND))
				.join(" and ");
			return parentPrec > PREC_AND ? `(${inner})` : inner;
		}
		case "or": {
			// `or` recurses with `PREC_OR` (the lowest level), so nested
			// `and` / comparison sub-expressions never need to group
			// beneath an `or` — XPath's precedence already resolves them
			// correctly.
			const inner = p.clauses
				.map((c) => emitPredicate(c, PREC_OR))
				.join(" or ");
			return parentPrec > PREC_OR ? `(${inner})` : inner;
		}
		case "not":
			// `not()` is an XPath function call, not a prefix operator;
			// the parens around the inner are the function-call argument
			// list. Pass `parentPrec` of `0` so the inner never adds
			// redundant grouping.
			return `not(${emitPredicate(p.clause, 0)})`;
		case "in":
			return emitIn(p);
		case "between":
			return emitBetween(p);
		case "match":
			return emitMatch(p);
		case "multi-select-contains":
			return emitMultiSelectContains(p);
		case "exists":
			return emitExistsOrMissing(p.via, p.where, "exists");
		case "missing":
			return emitExistsOrMissing(p.via, p.where, "missing");
		case "when-input-present":
			return emitWhenInputPresent(p);
		case "is-blank":
			// Portable absent-or-empty: `<term> = ''` covers absent /
			// cleared / empty alike on every CCHQ dialect.
			return `${emitTerm(unwrapTermFromExpression(p.left))} = ''`;
		case "is-null":
			// Strict-absent has no CCHQ wire form; the on-device wire
			// layer collapses absent / cleared / empty into one match
			// set. B5 representability checker rejects at authoring
			// time — this throw protects the bypass path.
			throw new Error(
				"caseListFilterEmitter: 'is-null' is unrepresentable on the case-list-filter wire dialect; use 'is-blank' for absent-or-empty matching.",
			);
		case "within-distance":
			// `within-distance` is registered only in CCHQ's CSQL query-
			// function table at
			// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py:39-54`;
			// the on-device dispatcher
			// (`commcare-core/.../parser/ast/ASTNodeFunctionCall.java:113-269`)
			// registers no handler. Emitting the call would surface as a
			// runtime XPath evaluation failure on Android.
			throw new Error(
				"caseListFilterEmitter: 'within-distance' is CSQL-only and has no on-device wire form.",
			);
		default: {
			const _exhaustive: never = p;
			throw new Error(
				`caseListFilterEmitter: unhandled Predicate kind ${String(_exhaustive)}`,
			);
		}
	}
}

// ============================================================
// `in` (set membership)
// ============================================================

/**
 * Emit value-equality set membership: "the term equals one of the
 * literals in `values`". Single-value collapses to a plain equality
 * (the canonical "this property equals this value" form);
 * multi-value expands to a parenthesized OR-of-equalities so the
 * semantics stay structurally continuous from one to many.
 *
 * CCHQ's `selected-any(prop, '<v1> <v2>')` looks like a candidate
 * but carries multi-select-token semantics: ES's
 * `case_property_text_query` tokenizes the value string by
 * whitespace and matches ANY token (verified at
 * `commcare-hq/corehq/apps/es/case_search.py:291-296` — the
 * docstring states "If the value has multiple words, they will be
 * OR'd together in this query"). That silently breaks `in` on
 * space-bearing values: `isIn(name, "Alice Smith")` (one literal)
 * and `isIn(name, "Alice Smith", "Bob")` (a list of two) would land
 * on different result sets if `in` routed through `selected-any`.
 * Multi-select containment is its own AST kind with its own emitter
 * (`emitMultiSelectContains` below).
 *
 * The defensive paren-wrap on the multi-value branch defends
 * against a parent `and` re-associating the OR-chain — XPath's
 * `and` binds tighter than `or`, so an unwrapped or-chain inside an
 * and-chain would silently change meaning.
 */
function emitIn(p: Extract<Predicate, { kind: "in" }>): string {
	const left = emitTerm(unwrapTermFromExpression(p.left));
	if (p.values.length === 1) {
		return `${left} = ${emitLiteralValue(p.values[0].value)}`;
	}
	const clauses = p.values
		.map((v) => `${left} = ${emitLiteralValue(v.value)}`)
		.join(" or ");
	return `(${clauses})`;
}

// ============================================================
// `between` (range)
// ============================================================

/**
 * Emit a range predicate. The schema rejects the both-bounds-absent
 * shape, so at least one of `lower` / `upper` is set. Each present
 * bound emits as a comparison whose operator is picked from the
 * inclusivity flag (`>=` / `>` for `lower`; `<=` / `<` for `upper`).
 *
 * Both-bound form joins the two comparisons with ` and ` and wraps
 * the result in parens — same defensive grouping rationale as
 * multi-value `in`. Single-bound form emits as a standalone
 * comparison without grouping; the outer `parentPrec` is what
 * decides whether the parent operator needs to wrap.
 */
function emitBetween(p: Extract<Predicate, { kind: "between" }>): string {
	const left = emitTerm(unwrapTermFromExpression(p.left));
	const lowerOp = p.lowerInclusive ? ">=" : ">";
	const upperOp = p.upperInclusive ? "<=" : "<";
	const lowerClause =
		p.lower !== undefined
			? `${left} ${lowerOp} ${emitTerm(unwrapTermFromExpression(p.lower))}`
			: undefined;
	const upperClause =
		p.upper !== undefined
			? `${left} ${upperOp} ${emitTerm(unwrapTermFromExpression(p.upper))}`
			: undefined;
	if (lowerClause !== undefined && upperClause !== undefined) {
		return `(${lowerClause} and ${upperClause})`;
	}
	// Single-bound forms emit unwrapped — no defensive grouping
	// needed because the comparison is a leaf with no internal
	// precedence.
	if (lowerClause !== undefined) return lowerClause;
	if (upperClause !== undefined) return upperClause;
	// The schema's `.refine(...)` on `betweenSchema` rejects
	// both-bounds-absent at parse time, but defensively throw here
	// so a bypass surfaces loudly rather than as an empty wire
	// string.
	throw new Error(
		"caseListFilterEmitter: 'between' has no bounds; the schema's at-least-one-bound refinement was bypassed.",
	);
}

// ============================================================
// `match` (text-match)
// ============================================================

/**
 * Emit text-match per `mode`. Only `starts-with` has an on-device
 * wire form — `starts-with(prop, 'v')`, an XPath 1.0 standard
 * function admitted by the on-device dispatcher.
 *
 * The other three modes (`fuzzy`, `phonetic`, `fuzzy-date`) are
 * CSQL-only — verified at
 * `commcare-core/src/main/java/org/javarosa/xpath/parser/ast/ASTNodeFunctionCall.java:113-269`,
 * the on-device dispatcher that registers no handler for
 * `fuzzy-match` / `phonetic-match` / `fuzzy-date`. CCHQ's CSQL
 * dialect registers each at
 * `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py:39-54`,
 * but the on-device evaluator has no path to them. Emitting any of
 * the three would surface as a runtime XPath evaluation failure on
 * Android.
 *
 * `match.value` is a plain string (not a term) at the schema
 * layer, so it routes through `quoteLiteral` directly without
 * unwrapping.
 */
function emitMatch(p: Extract<Predicate, { kind: "match" }>): string {
	// Exhaustive switch on the closed `MATCH_MODES` enum. A new mode
	// appearing in the union surfaces here as a compile-time `never`
	// error rather than silently falling through to the throw arm,
	// forcing an explicit representability decision per mode.
	switch (p.mode) {
		case "starts-with":
			return `starts-with(${emitTerm(p.property)}, ${quoteLiteral(p.value, "case-list-filter")})`;
		case "fuzzy":
		case "phonetic":
		case "fuzzy-date":
			throw new Error(
				`caseListFilterEmitter: 'match' mode '${p.mode}' is CSQL-only and has no on-device wire form.`,
			);
		default: {
			const _exhaustive: never = p.mode;
			throw new Error(
				`caseListFilterEmitter: unhandled match mode ${String(_exhaustive)}`,
			);
		}
	}
}

// ============================================================
// `multi-select-contains`
// ============================================================

/**
 * Emit multi-select containment per `quantifier`. CCHQ's on-device
 * dispatcher registers `selected(prop, 'v')` (single-value
 * containment). Multi-value forms expand to OR / AND chains of
 * `selected()` calls per the quantifier.
 *
 * The CSQL dialect uses `selected-any(prop, 'v1 v2')` /
 * `selected-all(prop, 'v1 v2')` directly, but those tokenize the
 * value argument by whitespace at the wire layer
 * (`commcare-hq/corehq/apps/es/case_search.py:291-296`). Expanding
 * to per-value `selected()` calls on-device dodges that
 * tokenization and produces semantically equivalent output for
 * non-space-bearing values; for space-bearing values, the on-device
 * expansion is the only way to preserve the literal token in the
 * filter.
 */
function emitMultiSelectContains(
	p: Extract<Predicate, { kind: "multi-select-contains" }>,
): string {
	const left = emitTerm(p.property);
	const calls = p.values.map(
		(v) => `selected(${left}, ${emitLiteralValue(v.value)})`,
	);
	if (calls.length === 1) {
		return calls[0];
	}
	// Exhaustive switch on the closed `MULTI_SELECT_QUANTIFIERS`
	// enum. A new quantifier in the union surfaces here as a
	// compile-time `never` error rather than silently routing to one
	// of the existing branches.
	let joiner: string;
	switch (p.quantifier) {
		case "any":
			joiner = " or ";
			break;
		case "all":
			joiner = " and ";
			break;
		default: {
			const _exhaustive: never = p.quantifier;
			throw new Error(
				`caseListFilterEmitter: unhandled multi-select quantifier ${String(_exhaustive)}`,
			);
		}
	}
	return `(${calls.join(joiner)})`;
}

// ============================================================
// `exists` / `missing` (relational quantifiers)
// ============================================================

/**
 * Emit the count-presence test for an `exists` (`count(...) > 0`)
 * or `missing` (`count(...) = 0`) predicate. The inner nodeset is
 * an `instance('casedb')/casedb/case[...]` join whose shape
 * depends on the relation's direction:
 *
 *   - **Ancestor walks** (parent / host / custom upward index):
 *     each hop links the inner case's `@case_id` to the outer
 *     scope's `index/<rel>` value — the canonical CCHQ pattern at
 *     `commcare-hq/corehq/apps/app_manager/xpath.py:101-103`,
 *     where the `#parent` / `#host` hashtag transform builds
 *     `instance('casedb')/casedb/case[@case_id=<base>/index/<rel>]`
 *     against a parent CaseXPath base. Multi-hop walks compose by
 *     using the full nodeset of the previous hop as the next
 *     hop's `<base>`, producing nested `[@case_id=...]` joins.
 *   - **Subcase walks** (reverse-direction; the inner case has an
 *     index pointing back at the outer): the nodeset filter is
 *     `[index/<rel>=current()/@case_id]` — the canonical CCHQ
 *     pattern at
 *     `commcare-hq/corehq/apps/app_manager/suite_xml/sections/entries.py:1118-1131`,
 *     where the canonical example pins `[index/parent =
 *     <case-id>]` on a subcase nodeset. The `current()/@case_id`
 *     resolves the outer case's id from the predicate's
 *     evaluation context.
 *   - **`self`** collapses to the no-traversal degenerate. The AST
 *     admits the kind for symmetry with the relation-path union,
 *     but the on-device emitter throws — `exists(self)` /
 *     `missing(self)` reduces to no-op semantics that the
 *     authoring layer should not produce.
 *   - **`any-relation`** is direction-agnostic; CCHQ's on-device
 *     and CSQL function sets expose only direction-specific
 *     operators, so the kind has no CCHQ wire form and the emitter
 *     throws. B5 representability checker rejects at authoring
 *     time.
 *
 * The optional `where` predicate filters the related cases at the
 * destination scope. When present, it appends as another
 * bracketed predicate on the join nodeset and emits via the
 * normal recursive walker (so the filter inside `exists` carries
 * the same operator coverage as a top-level predicate). When
 * absent, the predicate degenerates to a presence test on the
 * relation alone.
 */
function emitExistsOrMissing(
	via: RelationPath,
	where: Predicate | undefined,
	kind: "exists" | "missing",
): string {
	const nodeset = buildCaseJoinNodeset(via);
	const filter = where !== undefined ? `[${emitPredicate(where, 0)}]` : "";
	const op = kind === "exists" ? "> 0" : "= 0";
	return `count(${nodeset}${filter}) ${op}`;
}

/**
 * Build the `instance('casedb')/casedb/case[...]` nodeset that
 * anchors an `exists` / `missing` join. The bracketed segments
 * encode the relation's direction; multi-hop ancestor walks
 * compose by using the full nodeset of the previous hop as the
 * next hop's `@case_id` anchor.
 *
 * Throws on `self` and `any-relation` per the JSDoc on
 * `emitExistsOrMissing` — both are AST shapes that have no CCHQ
 * wire form on this dialect.
 */
function buildCaseJoinNodeset(via: RelationPath): string {
	switch (via.kind) {
		case "self":
			throw new Error(
				"caseListFilterEmitter: 'exists' / 'missing' with 'self' relation has no on-device wire form; the AST shape collapses to no-op semantics.",
			);
		case "any-relation":
			// CCHQ's on-device and CSQL function sets expose only
			// direction-specific operators (`ancestor-exists` /
			// `subcase-exists`). The Postgres target compiles
			// `any-relation` to a direction-agnostic
			// `case_indices.identifier` lookup, but no CCHQ wire form
			// matches both directions in one query.
			throw new Error(
				"caseListFilterEmitter: 'any-relation' has no CCHQ wire form; CCHQ exposes only direction-specific operators (ancestor-exists / subcase-exists).",
			);
		case "ancestor": {
			// Walk the chain from outermost (last hop) to innermost
			// (first hop). The first hop anchors against
			// `current()/index/<rel>`; each subsequent hop nests inside
			// the previous hop's nodeset as `<previous>/index/<next>`.
			// The canonical shape with one hop is
			// `instance('casedb')/casedb/case[@case_id=current()/index/<rel0>]`.
			// With two hops it composes to
			// `instance('casedb')/casedb/case[@case_id=instance('casedb')/casedb/case[@case_id=current()/index/<rel0>]/index/<rel1>]`.
			let anchor = `current()/index/${via.via[0].identifier}`;
			for (let i = 1; i < via.via.length; i++) {
				anchor = `instance('casedb')/casedb/case[@case_id=${anchor}]/index/${via.via[i].identifier}`;
			}
			return `instance('casedb')/casedb/case[@case_id=${anchor}]`;
		}
		case "subcase":
			// Reverse-direction join: the inner case has
			// `index/<rel>` pointing back at the outer case's
			// `@case_id`. The canonical shape is
			// `instance('casedb')/casedb/case[index/<rel>=current()/@case_id]`.
			// `current()/@case_id` reads the outer case's id from the
			// predicate's evaluation context (inside a casedb nodeset
			// filter, `current()` is the case being filtered).
			return `instance('casedb')/casedb/case[index/${via.identifier}=current()/@case_id]`;
		default: {
			const _exhaustive: never = via;
			throw new Error(
				`caseListFilterEmitter: unhandled RelationPath kind ${String(_exhaustive)}`,
			);
		}
	}
}

// ============================================================
// `when-input-present`
// ============================================================

/**
 * Emit the conditional-include wrapper. The wrapped clause runs only
 * when the named search input is set at runtime; otherwise the
 * wrapper is a no-op (`true()`, the AND-chain identity).
 *
 * Wire form: `if(count(<input-path>), <clause>, true())`. The
 * fallback is `true()` (not `''`) because XPath's boolean coercion
 * of `''` is `false`, which would silently exclude every case on
 * input-unset. `true()` AND-combines with sibling clauses without
 * changing them, so the wrapper drops cleanly into a multi-clause
 * filter.
 *
 * The inner clause recurses with `parentPrec: 0` because the
 * function-call argument position is its own grouping boundary;
 * no outer parens wrap a logical-operator inner.
 */
function emitWhenInputPresent(
	p: Extract<Predicate, { kind: "when-input-present" }>,
): string {
	const inputPath = emitTerm(p.input);
	const inner = emitPredicate(p.clause, 0);
	return `if(count(${inputPath}), ${inner}, true())`;
}

// ============================================================
// Term emission
// ============================================================

/**
 * Compile a term to its on-device wire form. Each variant has a
 * fixed wire shape verified against CCHQ source:
 *
 *   - `prop`: bare identifier (or `@`-prefixed for the four reserved
 *     attributes). The case-type qualifier is dropped at this layer
 *     — the wire-correct case type is whichever one the surrounding
 *     casedb nodeset selects. `via`-bearing property refs are
 *     `exists`-shaped at the AST level; the visitor throws because
 *     the on-device wire form for relational reads is a count-based
 *     presence test, not an inline relational read.
 *   - `input`: `instance('search-input:results')/input/field[@name='<n>']`
 *     — the canonical search-input path documented at
 *     `commcare-hq/docs/case_search_query_language.rst:299` and
 *     registered at
 *     `commcare-hq/corehq/apps/app_manager/suite_xml/post_process/instances.py:354`
 *     (`SEARCH_INPUT_INSTANCE_FACTORY`).
 *   - `session-user`: open-namespace
 *     `instance('commcaresession')/session/user/data/<field>` —
 *     populated by `addUserProperties` in
 *     `commcare-core/src/main/java/org/commcare/session/SessionInstanceBuilder.java`
 *     (the `addUserProperties` writer iterates an arbitrary
 *     `userFields` Hashtable and writes each as a `<data>` child
 *     under `<user>`). CCHQ's `session_var(var, path='user/data')`
 *     in `commcare-hq/corehq/apps/app_manager/xpath.py:114-119`
 *     builds the same path.
 *   - `session-context`: closed-namespace
 *     `instance('commcaresession')/session/context/<field>` —
 *     populated by `addMetadata` in the same
 *     `SessionInstanceBuilder.java` symbol anchor; CCHQ's
 *     `session_var(var, path='context')` resolves to the same wire
 *     path (e.g. `commcare-hq/corehq/apps/app_manager/xpath.py:248`
 *     for the canonical `session_var('userid', path='context')`
 *     usage).
 *   - `literal`: routes through `emitLiteralValue` for the
 *     wire-form literal.
 */
function emitTerm(term: Term): string {
	switch (term.kind) {
		case "prop":
			return emitPropertyRef(term);
		case "input":
			return `instance('search-input:results')/input/field[@name='${term.name}']`;
		case "session-user":
			// `field` is constrained to XML element-name vocabulary at
			// the schema layer (no quoting / escaping required for
			// valid values; invalid values reject at parse time).
			return `instance('commcaresession')/session/user/data/${term.field}`;
		case "session-context":
			// `field` is one of the four `SESSION_CONTEXT_FIELDS`
			// members validated at the schema layer; direct
			// interpolation is safe.
			return `instance('commcaresession')/session/context/${term.field}`;
		case "literal":
			return emitLiteralValue(term.value);
	}
}

/**
 * Emit a property reference. Reserved CommCare attributes pick up
 * the `@` prefix; everything else flows through `quoteIdentifier`
 * for the lexical pass-through (the schema's regex on `property`
 * already rejects invalid characters at parse time).
 *
 * The case-type qualifier (`term.caseType`) is dropped at this
 * layer — every property reference emits the same wire form
 * regardless of which case type the AST names. The wire-correct
 * case type is whichever one the surrounding casedb nodeset selects
 * at execution time.
 *
 * `via` (the optional relation walk) on a property reference is
 * conceptually `exists`-shaped at the AST level — the predicate
 * reads a property on a related case. The on-device wire form for
 * that read is a count-based presence test through `exists`, not
 * an inline relational read. Authors construct the relational form
 * via `exists(via, where: <predicate-against-related-prop>)`; the
 * emitter throws here so that authoring intent surfaces explicitly
 * rather than silently degrading to a same-scope read.
 */
function emitPropertyRef(prop: PropertyRef): string {
	if (prop.via !== undefined && prop.via.kind !== "self") {
		throw new Error(
			"caseListFilterEmitter: property reference with non-self 'via' has no inline wire form; use 'exists(via, where: ...)' to read across relations.",
		);
	}
	if (RESERVED_CASE_ATTRIBUTES.has(prop.property)) {
		return `@${quoteIdentifier(prop.property)}`;
	}
	return quoteIdentifier(prop.property);
}

/**
 * Compile a primitive literal to its wire form. Numbers emit as
 * unquoted XPath numbers via `formatNumeric` (CommCare's grammar
 * rejects scientific notation; see `formatNumeric`'s JSDoc for the
 * grammar citation). Booleans emit as the strings `'true'` /
 * `'false'`; `null` emits as `''` because XPath compares an absent
 * attribute equal to `''`, so `<prop> = ''` is the natural "is
 * unset" form.
 *
 * String literals route through `quoteLiteral` for the per-dialect
 * escape strategy. The case-list-filter dialect has XPath 1.0's
 * `concat()` available for the embedded-quote fallback, so values
 * containing single quotes emit as
 * `concat('part1', "'", 'part2', ...)`.
 */
function emitLiteralValue(value: string | number | boolean | null): string {
	if (value === null) return "''";
	if (typeof value === "number") return formatNumeric(value);
	if (typeof value === "boolean") return value ? "'true'" : "'false'";
	return quoteLiteral(value, "case-list-filter");
}
