/**
 * Connect-deliver wire-emit defaults — small, dependency-free module
 * so the package barrel stays client-safe.
 *
 * `entity_id` and `entity_name` on a `ConnectDeliverUnit` are optional
 * in the domain. When the doc carries no explicit value, the wire
 * layer substitutes the canonical defaults below; when it carries a
 * non-empty value, that custom XPath wins. `effectiveDeliverEntities`
 * is the single resolver — both the bind emitter (`./xform/builder`)
 * and the session-preload builder (`./formActions`) call through it,
 * so they cannot disagree about which XPath actually runs at form-fill.
 *
 * Lives at the package root rather than inside `./xform/` because two
 * different consumers need it. Importing from `./xform/builder` would
 * pull `htmlparser2` / `dom-serializer` / `domhandler` / `domutils`
 * (top-level imports in that file) into every barrel consumer —
 * `RESERVED_CASE_PROPERTIES` and other client-safe exports would each drag
 * the DOM-parser graph through `formActions` into client bundles.
 * The Node-only modules (`./xform`, `./expander`) and the heavy
 * emission pipeline are therefore reached by sub-path only, so
 * Turbopack tree-shakes them out of client bundles.
 */

import type { ConnectAssessment, ConnectDeliverUnit } from "@/lib/domain";
import {
	printXPath,
	type XPathPrintableDoc,
	xpathPrintContext,
} from "@/lib/domain";

/**
 * Default XPath expression substituted for a Connect deliver_unit's
 * `entity_id` bind when the doc carries no explicit value.
 *
 * Connect uses `entity_id` to deduplicate visits per worker. The
 * canonical default — `concat(#user/username, '-', today())` — yields
 * one logical entity per (FLW, day) pair, the dominant pattern across
 * deliver-app workflows. The doc type leaves `entity_id` optional so
 * a custom expression can override; the bind emitter falls back to
 * this constant when the doc didn't supply one.
 *
 * Exported so tests can assert on the exact XPath the emitter writes.
 */
export const DEFAULT_DELIVER_ENTITY_ID = "concat(#user/username, '-', today())";

/**
 * Default XPath expression substituted for a Connect deliver_unit's
 * `entity_name` bind when the doc carries no explicit value.
 *
 * `#user/username` is the safe label fallback when the form has no
 * obvious case-side naming property to point at. Same emit-time-only
 * fallback contract as {@link DEFAULT_DELIVER_ENTITY_ID}.
 */
export const DEFAULT_DELIVER_ENTITY_NAME = "#user/username";

/**
 * Default XPath expression substituted for a Connect assessment's
 * `user_score` bind when the doc carries no explicit value.
 *
 * The literal `"100"` reads as full marks on Connect's side — the safe
 * stance for an assessment whose author hasn't wired a real score source
 * (typically a hidden calculated field, `#form/<hidden_score_field>`)
 * yet: completing the form passes rather than silently failing every
 * learner on a missing expression. Same emit-time-only fallback contract
 * as {@link DEFAULT_DELIVER_ENTITY_ID}.
 */
export const DEFAULT_ASSESSMENT_USER_SCORE = "100";

/**
 * Resolve the effective `user_score` XPath expression for a Connect
 * assessment. Returns the doc's explicit value when present and
 * otherwise the canonical default.
 */
export function effectiveAssessmentUserScore(
	assessment: ConnectAssessment,
	doc: XPathPrintableDoc,
): string {
	return (
		projectConnectXPath(assessment.user_score, doc) ??
		DEFAULT_ASSESSMENT_USER_SCORE
	);
}

/** Project a canonical stored Connect XPath slot. Live Connect expressions
 * are AST-only; pre-cutover text is handled exclusively by the frozen
 * migration before a Blueprint reaches this boundary. */
function projectConnectXPath(
	value:
		| ConnectAssessment["user_score"]
		| ConnectDeliverUnit["entity_id"]
		| ConnectDeliverUnit["entity_name"],
	doc: XPathPrintableDoc,
): string | undefined {
	return value === undefined
		? undefined
		: printXPath(value, xpathPrintContext(doc));
}

/**
 * Resolve the effective `entity_id` / `entity_name` XPath expressions
 * for a Connect deliver_unit. Returns the doc's explicit values when
 * present and non-empty; otherwise the canonical defaults.
 *
 * Single home for the wire-default policy. Only an absent slot gets a
 * default; an authored expression is emitted exactly.
 */
export function effectiveDeliverEntities(
	du: ConnectDeliverUnit,
	doc: XPathPrintableDoc,
): { entityId: string; entityName: string } {
	return {
		entityId:
			projectConnectXPath(du.entity_id, doc) ?? DEFAULT_DELIVER_ENTITY_ID,
		entityName:
			projectConnectXPath(du.entity_name, doc) ?? DEFAULT_DELIVER_ENTITY_NAME,
	};
}
