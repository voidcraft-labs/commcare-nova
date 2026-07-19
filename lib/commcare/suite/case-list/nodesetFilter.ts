// lib/commcare/suite/case-list/nodesetFilter.ts
//
// Suite-XML wire emission for the module-level case-list filter
// (`caseListConfig.filter`). The emitter produces the bracketed
// XPath fragment that appends to a case-loading entry's session-
// datum nodeset, narrowing the case set the runtime selects from
// when the user opens the case list.
//
// Wire shape: the surrounding session datum's nodeset starts as
// `instance('casedb')/casedb/case[@case_type='X'][@status='open']`.
// When the module carries an authored filter, this emitter builds
// the third bracketed predicate so the full nodeset reads
// `instance('casedb')/casedb/case[@case_type='X'][@status='open'][<filter>]`.
// The CCHQ canonical builder at
// `commcare-hq/corehq/apps/app_manager/suite_xml/sections/entries.py::EntriesHelper._get_nodeset_xpath`
// composes the same string by concatenating
// `case_type_filter` / `[@status='open']` / `filter_xpath` in that
// order; CCHQ's `EntriesHelper.get_filter_xpath` wraps the user
// filter in `[...]` before the concat. Nova's wire emission
// matches this precedence faithfully — the `@case_type` /
// `@status` predicates come first; the user filter appends after.
//
// Predicate compilation reuses the shared on-device XPath
// emitter at
// `lib/commcare/predicate/caseListFilterEmitter.ts::emitCaseListFilter`.
// That emitter targets the same case-list-filter slot CCHQ
// describes, so the dialect lines up by construction.
//
// Match-all / match-none / absent semantics:
//
//   - Absent (`undefined`) and `match-all` collapse to the empty
//     fragment. `match-all` is the AND-chain identity element
//     (CCHQ's wire emission of `match-all` is `true()` per the
//     on-device emitter); concatenating `[true()]` to the nodeset
//     leaves the match set unchanged. Returning the empty fragment
//     keeps the wire string clean — same observable behaviour, no
//     tautological bracket pair.
//   - `match-none` emits as the literal `[false()]` fragment. The
//     authored intent of `match-none` is "match no cases"; the
//     case list's match set must reflect that. Collapsing
//     `match-none` to the empty fragment would silently widen the
//     match set to every case, contradicting the AST. The wire
//     `[false()]` is the closest CCHQ shape that preserves the
//     authored emptiness.
//   - Every other `Predicate` shape compiles via
//     `emitCaseListFilter` and wraps in `[...]`. The compiled XPath
//     is well-formed against CCHQ's query-function grammar by the
//     emitter's contract.

import { emitOnDeviceExpression } from "@/lib/commcare/expression/onDeviceEmitter";
import { emitCaseListFilter } from "@/lib/commcare/predicate";
import {
	effectiveFilterForEmission,
	substituteUnansweredSearchInputsInExpression,
	substituteUnansweredSearchInputsInPredicate,
} from "@/lib/domain/predicate";
import type { RelationEvaluationScopeContext } from "@/lib/domain/predicate/normalizeRelationEvaluationScopes";
import type { Predicate, ValueExpression } from "@/lib/domain/predicate/types";

/**
 * Compile a module-level `caseListConfig.filter` to the bracketed
 * XPath fragment that appends to a case-list session datum's
 * nodeset. Returns the empty string when no fragment should be
 * emitted (absent filter or `match-all` sentinel).
 *
 * The caller concatenates the result onto the existing case-type /
 * status nodeset; this function never builds the full nodeset
 * itself, so the case-type qualifier and status filter remain the
 * concern of the session-datum builder.
 */
export function emitNodesetFilter(
	filter: Predicate | undefined,
	relationContext: RelationEvaluationScopeContext = {},
): string {
	// The ordinary case list evaluates before any Search runs, so every
	// Search-input dependency substitutes to its unanswered reading first
	// (`when-input-present` envelopes → `match-all`, bare refs → '').
	// Emitting the `instance('search-input:results')` reference instead
	// would crash the entry: Core throws `XPathMissingInstanceException`
	// for the declared-but-unloaded instance before the envelope's own
	// `if(count(...))` guard can evaluate
	// (`commcare-core .../org/javarosa/xpath/expr/XPathPathExpr.java::evalRaw`).
	//
	// `effectiveFilterForEmission` then returns the narrowing predicate
	// to emit, or `undefined` when nothing narrows — an absent filter
	// (most modules) OR one that reduces to `match-all` (top-level,
	// nested in an authored `and`, or via the substitution above).
	// Either way no bracket appends, so the session-datum nodeset stays
	// at the canonical `[@case_type='X'][@status='open']` shape rather
	// than a tautological `[true() and …]`. See
	// `lib/domain/predicate/simplify.ts`.
	const effective = effectiveFilterForEmission(
		filter === undefined
			? undefined
			: substituteUnansweredSearchInputsInPredicate(filter),
	);
	if (effective === undefined) return "";

	// Every other predicate (including `match-none`) compiles via
	// the shared on-device emitter and wraps in `[...]` at the
	// nodeset position. `match-none` emits as `false()` — wrapped
	// here as `[false()]`, the wire form that faithfully represents
	// "match no cases" against the surrounding nodeset.
	return `[${emitCaseListFilter(effective, undefined, relationContext)}]`;
}

/**
 * Compile Nova's owner-exclusion value expression to the bare on-device
 * predicate used by an ordinary case list. CommCare's `selected()` function
 * treats the first argument as a space-delimited token list, so negating the
 * membership check removes only cases whose `@owner_id` is present in the
 * authored exclusion list.
 *
 * Search-input refs never reach this wire surface as instance references.
 * The ordinary list evaluates before any Search runs, and Core throws
 * `XPathMissingInstanceException` for the declared-but-unloaded
 * `search-input:results` instance before ANY enclosing expression — the
 * blank guard included — can evaluate
 * (`commcare-core .../org/javarosa/xpath/expr/XPathPathExpr.java::evalRaw`).
 * So the emitter substitutes the unanswered reading statically (bare refs
 * → '', envelopes → `match-all`); an exclusion that reduces to the blank
 * literal emits no fragment at all, because blank means "exclude nobody".
 *
 * The runtime blank guard stays load-bearing for values only known at
 * evaluation time (a missing session-user field, an empty conditional
 * branch). Core's
 * `org/javarosa/xpath/expr/XPathSelectedFunc.java::multiSelected`
 * implements `(" " + s1 + " ").contains(" " + s2.trim() + " ")`, which
 * makes `selected('', '')` true — without the guard a runtime-blank
 * exclusion would hide every unassigned case on the ordinary list while
 * Preview and remote Search parse the blank value as an empty exclusion
 * set. Whitespace-only has the same identity meaning, hence
 * `normalize-space(...) = ''`.
 *
 * This is deliberately independent of remote case search. CCHQ's
 * `blacklisted_owner_ids_expression` is a query datum and therefore only
 * affects results returned by a remote request; Nova also applies the same
 * authoring intent to the local `casedb` list so entering a module through its
 * ordinary case-list path cannot reveal a case the search path excludes.
 */
export function emitExcludedOwnerFilterExpression(
	excludedOwnerIds: ValueExpression | undefined,
	relationContext: RelationEvaluationScopeContext = {},
): string | undefined {
	if (excludedOwnerIds === undefined) return undefined;
	const unanswered =
		substituteUnansweredSearchInputsInExpression(excludedOwnerIds);
	if (staticallyBlankExclusion(unanswered)) return undefined;
	const expression = emitNormalizedExcludedOwnerIdsExpression(
		unanswered,
		relationContext,
	);
	return `${expression} = '' or not(selected(${expression}, @owner_id))`;
}

/**
 * A blank-literal exclusion — the shape a pure Search-answer exclusion
 * reduces to under the unanswered substitution — matches the runtime
 * guard's "exclude nobody" arm statically, so no fragment is emitted.
 */
function staticallyBlankExclusion(expression: ValueExpression): boolean {
	return (
		expression.kind === "term" &&
		expression.term.kind === "literal" &&
		String(expression.term.value ?? "").trim() === ""
	);
}

/**
 * Emit the canonical owner-id list shared by every wire consumer.
 *
 * Preview trims and splits on whitespace. Core's `selected()` preserves raw
 * spacing, while CCHQ's remote `SearchCriteria.value_as_list` splits on the
 * literal space character and can retain empty tokens. Normalizing once in the
 * emitted XPath makes trailing, repeated, tab, and newline whitespace mean the
 * same token list on the ordinary case list, local remote request, HQ JSON
 * upload, and Preview.
 */
export function emitNormalizedExcludedOwnerIdsExpression(
	excludedOwnerIds: ValueExpression,
	relationContext: RelationEvaluationScopeContext = {},
): string {
	return `normalize-space(${emitOnDeviceExpression(
		excludedOwnerIds,
		undefined,
		relationContext,
	)})`;
}

/** Bracketed form appended directly to a case-loading datum's nodeset. */
export function emitExcludedOwnerNodesetFilter(
	excludedOwnerIds: ValueExpression | undefined,
	relationContext: RelationEvaluationScopeContext = {},
): string {
	const predicate = emitExcludedOwnerFilterExpression(
		excludedOwnerIds,
		relationContext,
	);
	return predicate === undefined ? "" : `[${predicate}]`;
}
