// lib/commcare/suite/case-list/nodesetFilter.ts
//
// The case-list filter is a bare WireExpr predicate. The session builder
// attaches it to the case step after the case-type and open-status guards;
// the serializer owns every bracket and operator spelling.
// Absent and match-all filters return undefined, while match-none remains
// false() so an authored empty list never widens to all cases.

import type { LookupWireNaming } from "@/lib/commcare/lookup/naming";
import { w } from "@/lib/commcare/xpath/wire/builders";
import { toWire } from "@/lib/commcare/xpath/wire/fromExpression";
import type { WireExpr } from "@/lib/commcare/xpath/wire/tree";
import {
	effectiveFilterForEmission,
	substituteUnansweredSearchInputs,
} from "@/lib/domain/expression";
import type { ExpressionContext } from "@/lib/domain/expression/context";
import type { Expression } from "@/lib/domain/expression/types";
import { normalizeSpace } from "../wire";

/**
 * Build the predicate attached to a case-list session datum's case step.
 * An absent filter or match-all sentinel returns undefined. The caller owns
 * the surrounding case-type and status predicates and the complete nodeset.
 */
export function emitNodesetFilter(
	filter: Expression | undefined,
	relationContext: ExpressionContext,
	lookupNaming?: LookupWireNaming,
): WireExpr | undefined {
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
	// `lib/domain/expression/simplify.ts`.
	const effective = effectiveFilterForEmission(
		filter === undefined ? undefined : substituteUnansweredSearchInputs(filter),
	);
	if (effective === undefined) return undefined;

	// Every other predicate, including match-none, remains in the tree.
	// The session builder attaches it at the case-step predicate position.
	return toWire(effective, {
		target: "suite",
		types: relationContext,
		bindings:
			lookupNaming === undefined
				? {}
				: { lookup: { naming: lookupNaming, instanceScope: "suite" } },
	});
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
	excludedOwnerIds: Expression | undefined,
	relationContext: ExpressionContext,
	lookupNaming?: LookupWireNaming,
): WireExpr | undefined {
	if (excludedOwnerIds === undefined) return undefined;
	const unanswered = substituteUnansweredSearchInputs(excludedOwnerIds);
	if (staticallyBlankExclusion(unanswered)) return undefined;
	const expression = emitNormalizedExcludedOwnerIdsExpression(
		unanswered,
		relationContext,
		lookupNaming,
	);
	return w.or(
		w.eq(expression, w.str("")),
		w.not(w.call("selected", [expression, w.context([w.attr("owner_id")])])),
	);
}

/**
 * A blank-literal exclusion — the shape a pure Search-answer exclusion
 * reduces to under the unanswered substitution — matches the runtime
 * guard's "exclude nobody" arm statically, so no fragment is emitted.
 */
function staticallyBlankExclusion(expression: Expression): boolean {
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
	excludedOwnerIds: Expression,
	relationContext: ExpressionContext,
	lookupNaming?: LookupWireNaming,
	searchInputInstanceId?: `search-input:${string}`,
): WireExpr {
	return normalizeSpace(
		toWire(excludedOwnerIds, {
			target: "suite",
			types: relationContext,
			bindings: {
				searchInputInstanceId,
				...(lookupNaming === undefined
					? {}
					: { lookup: { naming: lookupNaming, instanceScope: "suite" } }),
			},
		}),
	);
}

/** The owner predicate appended to a case-loading datum's case step. */
export function emitExcludedOwnerNodesetFilter(
	excludedOwnerIds: Expression | undefined,
	relationContext: ExpressionContext,
	lookupNaming?: LookupWireNaming,
): WireExpr | undefined {
	return emitExcludedOwnerFilterExpression(
		excludedOwnerIds,
		relationContext,
		lookupNaming,
	);
}
