// lib/commcare/predicate/caseListFilterEmitter.ts
//
// Per-dialect predicate emitter for CommCare's on-device XPath
// dialect — the wire string this visitor produces is usable in both
// the case-list `<detail nodeset>` slot and the post-ES
// `<search_filter>` slot. Both slots run on the same on-device XPath
// evaluator; the wire-routing layer drops the same string into the
// correct slot at emission time.
//
// Emission policy: this visitor produces the maximum CCHQ-supported
// feature subset. Every wire string is well-formed XPath that
// CommCare HQ accepts on import as defined by its query-function
// registry — the visitor commits to that wire-syntax surface and
// nothing narrower.
//
// File ownership: this file owns operator dispatch for the on-device
// dialect. Lexical concerns (string quoting, identifier emission,
// numeric formatting) flow through the shared `./stringQuoting`
// helpers. Operand-side ValueExpression unwrapping is the visitor's
// own concern and lives below.
//
// Operator surface:
//
//   - Sentinels (`match-all` / `match-none`): emit as the boolean
//     literals `true()` / `false()` — XPath 1.0 zero-arg literal
//     functions universally available.
//   - Logical (`and` / `or` / `not`): standard XPath operators with
//     parent-precedence-driven paren-wrapping; `and` binds tighter
//     than `or`.
//   - Comparison: `=`, `!=`, `<`, `<=`, `>`, `>=` — six standard XPath
//     comparison operators.
//   - `is-blank` / `is-null`: both emit `<term> = ''`. CCHQ wire
//     collapses absent / cleared / empty alike on every dialect; the
//     equality form is the closest CCHQ shape for both operators.
//     The Postgres runtime preserves the AST distinction natively.
//   - `in`: value-equality set membership via or-of-equalities.
//     Single-value collapses to a plain equality; multi-value expands
//     to `(prop = 'a' or prop = 'b' ...)`. Or-of-equalities preserves
//     each value as a single equality RHS, so spaces inside a value
//     stay wire-side opaque (CCHQ's `selected-any` would tokenize the
//     value argument by whitespace per
//     `commcare-hq/corehq/apps/es/case_search.py:291-296`, breaking
//     space-bearing values).
//   - `between`: expand to `gte`/`gt` and/or `lte`/`lt` clauses
//     joined by `and`, picking the strict / non-strict comparator
//     from each `*Inclusive` flag. Single-bound forms emit as a
//     standalone comparison; both-bound forms wrap in parens.
//   - `multi-select-contains`: per-value `selected(prop, 'v')` calls
//     composed via OR / AND per the `quantifier` discriminator.
//   - `match`: each mode emits the named CCHQ wire function call.
//     `starts-with(prop, 'v')` is XPath 1.0 standard; `fuzzy-match`,
//     `phonetic-match`, and `fuzzy-date` are CCHQ extensions
//     registered in CSQL's query-function table at
//     `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py:39-54`.
//   - `within-distance`: emit
//     `within-distance(prop, '<lat,lon>', <distance>, '<unit>')`
//     per the CCHQ wire signature at
//     `commcare-hq/corehq/apps/case_search/xpath_functions/query_functions.py:54-81`.
//   - `exists` / `missing` with `via.kind === "ancestor"`:
//     `count(...) > 0` / `count(...) = 0` against an
//     `instance('casedb')/casedb/case[@case_id=current()/index/<rel>]`
//     join. Multi-hop ancestors compose nested `[@case_id=...]`
//     joins. The hashtag-replacement pattern at
//     `commcare-hq/corehq/apps/app_manager/xpath.py:101-103` builds
//     the same wire shape (`#parent` / `#host` expand to
//     `instance('casedb')/casedb/case[@case_id=<base>/index/<rel>]`).
//   - `exists` / `missing` with `via.kind === "subcase"`: reverse-
//     direction join — `[index/<rel>=current()/@case_id]`. The
//     canonical CCHQ example pinning this shape is at
//     `commcare-hq/corehq/apps/app_manager/suite_xml/sections/entries.py:1118-1131`.
//   - `exists` / `missing` with `via.kind === "self"`: collapses to
//     a no-op. `exists(self, filter)` reduces to `filter`;
//     `exists(self)` to `true()`; `missing(self, filter)` to
//     `not(filter)`; `missing(self)` to `false()`.
//   - `exists` / `missing` with `via.kind === "any-relation"`:
//     direction-agnostic walk. Emit both ancestor and subcase
//     expansions OR'd together (negated via `not(...)` for the
//     `missing` form).
//   - `prop` term with non-self `via`: emit as an inline relational
//     path expression. Same anchor-building logic as
//     `exists` / `missing`'s ancestor and subcase walks; the
//     property name (or `@`-prefixed reserved attribute) appends
//     after the path.
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
 * against the union — extending `ComparisonKind` surfaces here as a
 * compile-time error.
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
 *     these four carry the `@` prefix, the other six do not.
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
// conditional, etc.). The on-device dialect's per-operator wire
// forms emitted here accept only term-shaped operands; non-term
// arms (`arith`, `if`, `today`, etc.) emit through the per-dialect
// Expression emitter on a separate layer. This helper unwraps the
// `term` arm and throws on every other arm with an exhaustive
// switch — a new ValueExpression kind surfaces here as a compile-
// time error rather than as silent fall-through.

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
 * Compile a `Predicate` AST to its on-device XPath wire string. The
 * output drops directly into a casedb XPath nodeset
 * (`instance('casedb')/casedb/case[<this>]`) for the case-list-filter
 * slot, or into the `<search_filter>` slot of a case-search config.
 * The starting `parentPrec` is `0` so the outermost predicate is
 * never wrapped in parens — only nested operators trigger grouping.
 *
 * Throws only on structural-bypass shapes the schema is meant to
 * reject (`between` with both bounds absent) and on non-term
 * `ValueExpression` operand arms (which emit through the
 * per-dialect Expression emitter on a separate layer).
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
		case "is-null":
			// Both the absent-or-empty operator and the strict-absent
			// operator emit as `<term> = ''`. The CCHQ wire collapses
			// absent / cleared / empty alike, and the equality form is
			// the closest available CCHQ shape for both. The AST
			// distinction is preserved at the Postgres runtime.
			return `${emitTerm(unwrapTermFromExpression(p.left))} = ''`;
		case "within-distance":
			// CCHQ wire signature:
			// `within-distance(prop, '<lat,lon>', <distance>, '<unit>')`
			// per `commcare-hq/corehq/apps/case_search/xpath_functions/query_functions.py:54-81`
			// (`confirm_args_count(node, 4)` with arg order
			// property / coords / distance / unit).
			//
			// `p.center` is a `ValueExpression`; only the term arm
			// surfaces at this layer. Distance routes through
			// `formatNumeric` for the scientific-notation guard.
			return `within-distance(${emitTerm(p.property)}, ${emitTerm(unwrapTermFromExpression(p.center))}, ${formatNumeric(p.distance)}, '${p.unit}')`;
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
 * CCHQ's `selected-any(prop, '<a> <b>')` looks like a candidate
 * but carries multi-select-token semantics: ES's
 * `case_property_text_query` tokenizes the value string by
 * whitespace and matches ANY token (verified at
 * `commcare-hq/corehq/apps/es/case_search.py:291-296` — the
 * docstring states "If the value has multiple words, they will be
 * OR'd together in this query"). That breaks `in` on space-bearing
 * values: `isIn(name, "Alice Smith")` (one literal) and
 * `isIn(name, "Alice Smith", "Bob")` (a list of two) would land on
 * different result sets if `in` routed through `selected-any`.
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
	// both-bounds-absent at parse time; this throw defends the
	// bypass path so a structural shape that the schema is meant to
	// filter out surfaces loudly rather than as an empty wire
	// string.
	throw new Error(
		"caseListFilterEmitter: 'between' has no bounds; the schema's at-least-one-bound refinement was bypassed.",
	);
}

// ============================================================
// `match` (text-match)
// ============================================================

/**
 * Emit text-match per `mode`. Each mode maps to a CCHQ wire
 * function:
 *
 *   - `starts-with` → `starts-with(prop, 'v')` (XPath 1.0 standard).
 *   - `fuzzy` → `fuzzy-match(prop, 'v')`.
 *   - `phonetic` → `phonetic-match(prop, 'v')`.
 *   - `fuzzy-date` → `fuzzy-date(prop, 'v')`.
 *
 * The three CCHQ extensions (`fuzzy-match`, `phonetic-match`,
 * `fuzzy-date`) are registered in CSQL's query-function table at
 * `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py:39-54`.
 * The wire syntax is the same well-formed function-call shape
 * regardless of slot.
 *
 * `match.value` is a plain string (not a term) at the schema
 * layer, so it routes through `quoteLiteral` directly without
 * unwrapping.
 */
function emitMatch(p: Extract<Predicate, { kind: "match" }>): string {
	const wireFunction = matchModeToWireFunction(p.mode);
	return `${wireFunction}(${emitTerm(p.property)}, ${quoteLiteral(p.value, "case-list-filter")})`;
}

/**
 * Map a `MatchMode` discriminator to the CCHQ wire function name.
 * Exhaustive switch on the closed `MATCH_MODES` enum — extending
 * the union surfaces here as a compile-time `never` error rather
 * than silently falling through to one of the existing branches.
 */
function matchModeToWireFunction(
	mode: Extract<Predicate, { kind: "match" }>["mode"],
): string {
	switch (mode) {
		case "starts-with":
			return "starts-with";
		case "fuzzy":
			return "fuzzy-match";
		case "phonetic":
			return "phonetic-match";
		case "fuzzy-date":
			return "fuzzy-date";
		default: {
			const _exhaustive: never = mode;
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
 * Emit multi-select containment. Each value emits as a
 * `selected(prop, 'v')` call; multi-value forms compose via OR / AND
 * per the `quantifier` discriminator. Single-value collapses to one
 * `selected()` call regardless of quantifier.
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
 * Emit the relational-quantifier predicate.
 *
 * Direction-bearing kinds (`ancestor`, `subcase`) emit as a
 * count-based presence test against an
 * `instance('casedb')/casedb/case[...]` join nodeset.
 *
 *   - **Ancestor** walks anchor on `current()/index/<rel>`. Multi-hop
 *     walks compose by using the full nodeset of the previous hop as
 *     the next hop's `@case_id` anchor. CCHQ's hashtag-replacement
 *     pattern at `commcare-hq/corehq/apps/app_manager/xpath.py:101-103`
 *     builds the same wire shape (`#parent` / `#host` expand to
 *     `instance('casedb')/casedb/case[@case_id=<base>/index/<rel>]`).
 *   - **Subcase** walks reverse direction:
 *     `[index/<rel>=current()/@case_id]`. The canonical CCHQ example
 *     pinning this shape is at
 *     `commcare-hq/corehq/apps/app_manager/suite_xml/sections/entries.py:1118-1131`.
 *
 * `via.kind === "self"` is degenerate — a relational walk with no
 * traversal — so the emitter reduces it to non-relational shape:
 * `exists(self, filter)` collapses to `filter`; `exists(self)` to
 * `true()`; `missing(self, filter)` to `not(filter)`; `missing(self)`
 * to `false()`.
 *
 * `via.kind === "any-relation"` is direction-agnostic; the emitter
 * expands to `(<ancestor-form> or <subcase-form>)` so the predicate
 * matches a related case in either direction. The `missing` form
 * negates the disjunction (`not((ancestor or subcase))`).
 *
 * The optional `where` predicate filters the related cases at the
 * destination scope. When present on a direction-bearing kind, it
 * appends as another bracketed predicate on the join nodeset and
 * emits via the normal recursive walker (so the filter inside
 * `exists` carries the same operator surface as a top-level
 * predicate).
 */
function emitExistsOrMissing(
	via: RelationPath,
	where: Predicate | undefined,
	kind: "exists" | "missing",
): string {
	switch (via.kind) {
		case "self":
			return emitSelfRelationalCollapse(where, kind);
		case "any-relation": {
			// Direction-agnostic walk: build presence tests on both
			// directions independently and OR them together. Each
			// inner test uses `count(...) > 0` regardless of the
			// outer `kind` — the negation for `missing` wraps the
			// whole disjunction with `not(...)` rather than flipping
			// the inner comparator (which would AND-of-`= 0` rather
			// than the equivalent `not(or-of->-0)`; the chosen shape
			// is shorter and reads more naturally).
			const ancestorClause = emitCountPresenceTest(
				buildAncestorJoinNodeset([{ identifier: via.identifier }]),
				where,
				"exists",
			);
			const subcaseClause = emitCountPresenceTest(
				buildSubcaseJoinNodeset(via.identifier),
				where,
				"exists",
			);
			const disjunction = `(${ancestorClause} or ${subcaseClause})`;
			return kind === "exists" ? disjunction : `not(${disjunction})`;
		}
		case "ancestor":
			return emitCountPresenceTest(
				buildAncestorJoinNodeset(via.via),
				where,
				kind,
			);
		case "subcase":
			return emitCountPresenceTest(
				buildSubcaseJoinNodeset(via.identifier),
				where,
				kind,
			);
		default: {
			const _exhaustive: never = via;
			throw new Error(
				`caseListFilterEmitter: unhandled RelationPath kind ${String(_exhaustive)}`,
			);
		}
	}
}

/**
 * Emit the relational-collapse forms when `via.kind === "self"`.
 * The walk reduces to non-relational shape — see
 * `emitExistsOrMissing`'s JSDoc for the per-form mapping.
 */
function emitSelfRelationalCollapse(
	where: Predicate | undefined,
	kind: "exists" | "missing",
): string {
	if (where === undefined) {
		return kind === "exists" ? "true()" : "false()";
	}
	const inner = emitPredicate(where, 0);
	return kind === "exists" ? inner : `not(${inner})`;
}

/**
 * Build the `count(<nodeset>[<filter>]) <comparator> 0` shape for a
 * directed walk, picking `> 0` for `exists` and `= 0` for
 * `missing`. Threading the comparator at the build site (rather
 * than string-replacing it after the fact) keeps the comparator
 * trailing the count call — important because the inner filter may
 * itself contain `> 0` substrings (e.g. `gt(prop, literal(0))`)
 * that a post-hoc string replace would corrupt.
 *
 * The optional filter appends as another bracketed predicate on the
 * nodeset; when absent, the predicate degenerates to a presence
 * test on the relation alone.
 */
function emitCountPresenceTest(
	nodeset: string,
	where: Predicate | undefined,
	kind: "exists" | "missing",
): string {
	const filter = where !== undefined ? `[${emitPredicate(where, 0)}]` : "";
	const comparator = kind === "exists" ? "> 0" : "= 0";
	return `count(${nodeset}${filter}) ${comparator}`;
}

// ============================================================
// Relation-walk anchor builders
// ============================================================

/**
 * Build the `instance('casedb')/casedb/case[@case_id=<anchor>]`
 * nodeset for an ancestor walk. The first hop anchors against
 * `current()/index/<rel>`; each subsequent hop nests inside the
 * previous hop's nodeset as `<previous>/index/<next>`. The
 * canonical shape with one hop is
 * `instance('casedb')/casedb/case[@case_id=current()/index/<rel0>]`;
 * with two hops it composes to
 * `instance('casedb')/casedb/case[@case_id=instance('casedb')/casedb/case[@case_id=current()/index/<rel0>]/index/<rel1>]`.
 *
 * Accepts a non-empty list of relation steps; the
 * `RelationPath`-with-`ancestor` schema's tuple-with-rest shape
 * already enforces non-empty at parse time.
 */
function buildAncestorJoinNodeset(
	via: ReadonlyArray<{ identifier: string }>,
): string {
	let anchor = `current()/index/${via[0].identifier}`;
	for (let i = 1; i < via.length; i++) {
		anchor = `instance('casedb')/casedb/case[@case_id=${anchor}]/index/${via[i].identifier}`;
	}
	return `instance('casedb')/casedb/case[@case_id=${anchor}]`;
}

/**
 * Build the
 * `instance('casedb')/casedb/case[index/<rel>=current()/@case_id]`
 * nodeset for a subcase walk. Reverse-direction join: the inner
 * case has `index/<rel>` pointing back at the outer case's
 * `@case_id`. `current()/@case_id` reads the outer case's id from
 * the predicate's evaluation context (inside a casedb nodeset
 * filter, `current()` is the case being filtered).
 */
function buildSubcaseJoinNodeset(identifier: string): string {
	return `instance('casedb')/casedb/case[index/${identifier}=current()/@case_id]`;
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
 *     casedb nodeset selects. A non-self `via` walk emits as an
 *     inline relational path expression (see
 *     `emitPropertyRef` for the per-direction shape).
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
		default: {
			const _exhaustive: never = term;
			throw new Error(`emitTerm: unhandled term kind ${String(_exhaustive)}`);
		}
	}
}

/**
 * Emit a property reference. The wire shape depends on the optional
 * `via` walk:
 *
 *   - **No walk** (`via` absent or `via.kind === "self"`): emit the
 *     bare property name (or `@`-prefixed reserved attribute). The
 *     case-type qualifier is dropped; the surrounding casedb
 *     nodeset selects the wire-correct case type at execution time.
 *   - **Ancestor walk**: prepend
 *     `instance('casedb')/casedb/case[@case_id=current()/index/<rel>]`
 *     (with multi-hop nesting) and join the property name with `/`.
 *   - **Subcase walk**: prepend
 *     `instance('casedb')/casedb/case[index/<rel>=current()/@case_id]`
 *     and join with `/`. Note: the subcase walk for a value read
 *     selects multiple cases when more than one subcase points back;
 *     authors who need cardinality control compose via `exists` /
 *     `count` instead.
 *   - **Direction-agnostic walk** (`any-relation`): combine both
 *     direction-specific paths via XPath's union operator `|`,
 *     producing `(<ancestor-path> | <subcase-path>)`. Union joins
 *     two node-sets into one node-set whose comparisons follow XPath
 *     1.0's existential semantics — `(a | b) = 'south'` is true when
 *     any node in the unified set equals `'south'`. A boolean
 *     `or` would coerce each path to its boolean value (non-empty →
 *     `true()`) before string equality, comparing the literal
 *     `'true'` / `'false'` against the RHS — which is never the
 *     intent. The union form is the same node-set semantics every
 *     bare `prop` reference uses; the walk just widens the source
 *     node-set.
 *
 * Reserved CommCare attributes pick up the `@` prefix at the leaf;
 * everything else flows through `quoteIdentifier` for the lexical
 * pass-through.
 */
function emitPropertyRef(prop: PropertyRef): string {
	const leaf = RESERVED_CASE_ATTRIBUTES.has(prop.property)
		? `@${quoteIdentifier(prop.property)}`
		: quoteIdentifier(prop.property);
	const via = prop.via;
	if (via === undefined || via.kind === "self") {
		return leaf;
	}
	switch (via.kind) {
		case "ancestor":
			return `${buildAncestorJoinNodeset(via.via)}/${leaf}`;
		case "subcase":
			return `${buildSubcaseJoinNodeset(via.identifier)}/${leaf}`;
		case "any-relation": {
			// XPath `|` is the node-set union operator; the result
			// is one node-set containing every node from either
			// direction, and `(<set>) = <rhs>` returns true when any
			// member of the set equals the RHS. Boolean `or` would
			// be wrong here — see the JSDoc above for the coercion
			// trap.
			const ancestor = `${buildAncestorJoinNodeset([{ identifier: via.identifier }])}/${leaf}`;
			const subcase = `${buildSubcaseJoinNodeset(via.identifier)}/${leaf}`;
			return `(${ancestor} | ${subcase})`;
		}
		default: {
			const _exhaustive: never = via;
			throw new Error(
				`caseListFilterEmitter: unhandled RelationPath kind ${String(_exhaustive)}`,
			);
		}
	}
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
 * escape strategy. The on-device dialect has XPath 1.0's `concat()`
 * available for the embedded-quote fallback, so values containing
 * single quotes emit as `concat('part1', "'", 'part2', ...)`.
 */
function emitLiteralValue(value: string | number | boolean | null): string {
	if (value === null) return "''";
	if (typeof value === "number") return formatNumeric(value);
	if (typeof value === "boolean") return value ? "'true'" : "'false'";
	return quoteLiteral(value, "case-list-filter");
}
