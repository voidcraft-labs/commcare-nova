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

import { emitCaseListFilter } from "@/lib/commcare/predicate";
import { effectiveFilterForEmission } from "@/lib/domain/predicate";
import type { Predicate } from "@/lib/domain/predicate/types";

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
export function emitNodesetFilter(filter: Predicate | undefined): string {
	// `effectiveFilterForEmission` returns the narrowing predicate to
	// emit, or `undefined` when nothing narrows — an absent filter (most
	// modules) OR one that reduces to `match-all` (top-level or nested
	// in an authored `and`). Either way no bracket appends, so the
	// session-datum nodeset stays at the canonical
	// `[@case_type='X'][@status='open']` shape rather than a tautological
	// `[true() and …]`. See `lib/domain/predicate/simplify.ts`.
	const effective = effectiveFilterForEmission(filter);
	if (effective === undefined) return "";

	// Every other predicate (including `match-none`) compiles via
	// the shared on-device emitter and wraps in `[...]` at the
	// nodeset position. `match-none` emits as `false()` — wrapped
	// here as `[false()]`, the wire form that faithfully represents
	// "match no cases" against the surrounding nodeset.
	return `[${emitCaseListFilter(effective)}]`;
}
