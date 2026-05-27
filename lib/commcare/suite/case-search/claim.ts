// lib/commcare/suite/case-search/claim.ts
//
// `<post>` claim element inside `<remote-request>`. CCHQ's runtime
// fires this POST when the user selects a case from search results,
// claiming ownership so subsequent restores carry the case down to
// the device's casedb. Every case-search-enabled module emits the
// same shape — there is no author-controlled composition.
//
// The element is CONSTRUCTED via `domhandler` + the shared
// `elementBuilders` helpers; the serializer is the single, exclusive
// escaping authority on the attribute values it carries (the CCHQ XPath
// guard, the search-case-id ref, the claim URL).

import render from "dom-serializer";
import type { Element } from "domhandler";
import { el, RENDER_OPTS } from "@/lib/commcare/elementBuilders";

/**
 * The CCHQ claim endpoint URL with `__DOMAIN__` placeholder. CCHQ's
 * `Application.create_suite` substitutes the live domain at build
 * time via `absolute_reverse('claim_case', args=[self.domain])`,
 * so the literal placeholder never reaches a runtime — direct .ccz
 * sideload is not a Nova path.
 */
export const CLAIM_URL_TEMPLATE =
	"https://www.commcarehq.org/a/__DOMAIN__/phone/claim-case/";

/**
 * The case-not-already-claimed guard, lifted verbatim from CCHQ's
 * `CaseClaimXpath.default_relevant`. Structural defense against
 * repeat-claim writes (the underlying cause of `state hash mismatch`
 * log spam in CCHQ webapps logs). Every `<remote-request>` Nova
 * emits carries this exact string.
 */
export const CLAIM_DEFAULT_RELEVANT =
	"count(instance('casedb')/casedb/case[@case_id=instance('commcaresession')/session/data/search_case_id]) = 0";

/**
 * The session-data XPath that resolves to the selected search-result
 * case id. Both the `<post>` body's `<data key="case_id">` element
 * and the `<stack>` rewind frame point at this same datum.
 */
export const SEARCH_CASE_ID_REF =
	"instance('commcaresession')/session/data/search_case_id";

/**
 * Compose the `<post>` Element. The orchestrator splices the returned
 * Element directly into the `<remote-request>` body; the surrounding
 * serializer handles attribute-value escaping at render time.
 *
 * `<post>` carries only the `case_id` data child — the excluded-
 * owners filter and other CCHQ extensions live on the sibling
 * `<query>` (see `searchSession.ts`). Placing them on `<post>`
 * would carry no runtime effect because the post fires after case
 * selection, by which point those filters have already gated the
 * visible result set.
 *
 * Attribute insertion order — `url, relevant` on `<post>`; `key, ref`
 * on `<data>` — matches the canonical CCHQ fixture
 * `commcare-hq/corehq/apps/app_manager/tests/data/suite/case_search.xml`'s
 * `<post>` element, so the rendered bytes stay diffable against the
 * CCHQ-regenerated suite.
 */
export function buildClaimPost(): Element {
	return el(
		"post",
		{ url: CLAIM_URL_TEMPLATE, relevant: CLAIM_DEFAULT_RELEVANT },
		[el("data", { key: "case_id", ref: SEARCH_CASE_ID_REF })],
	);
}

/**
 * Boundary shim — serializes `buildClaimPost`'s Element to a string for
 * callers that still consume the string-returning shape (the
 * `claim.test.ts` test surface). The orchestrator (`remoteRequest.ts`)
 * calls `buildClaimPost` directly.
 */
export function emitClaimPost(): string {
	return render(buildClaimPost(), RENDER_OPTS);
}
