// lib/commcare/suite/case-search/xpathQuery.ts
//
// Shared `_xpath_query` composer. Two wire surfaces consume the
// composition: the suite-XML emitter at `searchSession.ts` (slots
// the result into a `<data key="_xpath_query">` element on
// `<query>`) and the HQ-JSON emitter at `lib/commcare/expander.ts`
// (slots the same result into
// `module.search_config.default_properties[]` per CCHQ's
// `DefaultCaseSearchProperty` shape). Both surfaces export the
// same authored content to CCHQ — keeping the AND-composition rule
// in one place makes drift between them structurally impossible.
//
// CCHQ accepts at most one `_xpath_query` per `<query>` (the
// runtime CSQL parser treats it as a single source); the AST-level
// `and(...)` reducer folds the unified `caseListConfig.filter` with
// every advanced-arm `searchInputs[i].predicate` into ONE Predicate
// before the CSQL emitter walks the result. The CSQL emitter's
// `hoists` list captures any non-grammar value expressions lifted
// out as on-device wrappers — each hoist lands as its own slot
// (a sibling `<data>` element on `<query>` or its own
// `DefaultCaseSearchProperty` entry on `default_properties`)
// BEFORE the `_xpath_query` slot so the hoist inputs resolve first
// at runtime.

import type { CaseListConfig } from "@/lib/domain";
import { and } from "@/lib/domain/predicate";
import type { Predicate } from "@/lib/domain/predicate/types";
import { type CsqlEmissionResult, emitCsql } from "../../predicate";
import { getAdvancedArmPredicates } from "./searchPrompts";

/**
 * Emission output. `wrapper` is the on-device XPath expression that
 * runtime-evaluates to the CSQL query string interpolated into the
 * `_xpath_query` slot. `hoists` is the wrapper-expression list —
 * each entry binds a synthetic search-input name to an on-device
 * expression the consumer slots in BEFORE the `_xpath_query`. The
 * shape mirrors `CsqlEmissionResult` exactly; the type alias keeps
 * the contract symmetric across both consumers.
 */
export type ComposedXPathQuery = CsqlEmissionResult;

/**
 * Compose the unified `_xpath_query`. Returns `undefined` when the
 * AND-composition collapses to `match-all` (no filter authored, no
 * advanced-arm predicates) — consumers omit the slot entirely
 * rather than emitting `_xpath_query = "true()"`, which CCHQ
 * accepts but reads as noise.
 *
 * Reducer policy:
 *
 *   - Zero clauses → `undefined` (consumer omits the slot).
 *   - One clause → that clause, used directly (no `and(...)` envelope).
 *   - 2+ clauses → standard `and(...)` envelope; the reducer folds
 *     authored `match-all` clauses on the way through.
 *
 * Single-clause short-circuit also handles the `match-all` arm — a
 * lone authored `match-all` lands here and the explicit check below
 * routes it to `undefined`.
 */
export function composeXPathQueryEmission(
	caseListConfig: CaseListConfig,
): ComposedXPathQuery | undefined {
	const clauses: Predicate[] = [];
	if (caseListConfig.filter !== undefined) {
		clauses.push(caseListConfig.filter);
	}
	for (const entry of getAdvancedArmPredicates(caseListConfig.searchInputs)) {
		clauses.push(entry.predicate);
	}
	if (clauses.length === 0) {
		return undefined;
	}

	// `and(...)` is the AND-reducer entry point. One clause returns
	// itself; two-or-more clauses fold authored `match-all` arms and
	// return the standard `and` envelope.
	const composed =
		clauses.length === 1
			? clauses[0]
			: and(clauses[0], clauses[1], ...clauses.slice(2));

	if (composed.kind === "match-all") {
		return undefined;
	}

	return emitCsql(composed);
}
