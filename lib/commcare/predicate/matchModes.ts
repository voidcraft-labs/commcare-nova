// lib/commcare/predicate/matchModes.ts
//
// Which of the four match modes a device can actually evaluate.
//
// This is one fact with four readers, and it used to be spelled
// separately in each of them — two validator rules, the on-device
// emitter, and (once the editor learned to withhold the modes) a
// picker. Four copies of a CommCare runtime fact is exactly how a
// carrier gets forgotten, which is what happened to case operations.

import type { MatchMode } from "@/lib/domain/predicate";

/**
 * The modes CommCare's own XPath evaluator implements. Exactly one.
 *
 * `starts-with` is XPath 1.0 standard and is registered in Core's
 * dispatch (`commcare-core .../javarosa/xpath/parser/ast/ASTNodeFunctionCall.java::buildFuncExpr`).
 * `fuzzy-match`, `phonetic-match`, and `fuzzy-date` are not in it, and
 * are not in Formplayer either — Formplayer shares Core's table and
 * adds only `here()`. They are case-search query functions compiled to
 * Elasticsearch on the server
 * (`commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_QUERY_FUNCTIONS`),
 * and reach it only inside a case-search `_xpath_query` payload, which
 * the device forwards as opaque text rather than evaluating.
 *
 * The distinction is invisible at install time: an unregistered name
 * still parses, because Core's dispatch falls through to
 * `XPathCustomRuntimeFunc` with no arity check. It throws
 * `XPathUnhandledException` when the expression is evaluated — a form
 * error at fill time, and in a case list a cell that renders
 * `<invalid xpath: …>` instead of failing.
 */
export const ON_DEVICE_MATCH_MODES: ReadonlySet<MatchMode> = new Set([
	"starts-with",
]);

/** Whether CommCare's on-device evaluator implements `mode`. */
export function matchModeRunsOnDevice(mode: MatchMode): boolean {
	return ON_DEVICE_MATCH_MODES.has(mode);
}
