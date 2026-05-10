// lib/commcare/suite/case-search/__tests__/claim.test.ts
//
// Acceptance tests for `emitClaimPost` — the structural `<post>`
// element CCHQ's runtime fires on case selection from search
// results. The element is the same five-line template across every
// emission (no author composition); the tests pin the structural
// shape against the canonical fixtures
// `commcare-hq/corehq/apps/app_manager/tests/data/suite/remote_request.xml`'s
// `<remote-request>/<post>` block (without additional `relevant`
// composition) and
// `commcare-hq/corehq/apps/app_manager/tests/data/suite/search_config_blacklisted_owners.xml`'s
// `<remote-request>/<post>` block.
//
// Structural pins:
//
//   1. The `relevant` attribute carries CCHQ's
//      `CaseClaimXpath.default_relevant` formula verbatim (lifted
//      via `CaseSearch.get_relevant`).
//   2. The `url` attribute carries the canonical CCHQ-hosted
//      `claim_case` URL with the `__DOMAIN__` placeholder.
//   3. The `<post>` body carries exactly one `<data>` child —
//      `case_id` referencing the session's `search_case_id`
//      datum. No other data children (the excluded-owners +
//      xpath_query slots live on `<query>` per Task 8).

import { describe, expect, it } from "vitest";
import {
	CLAIM_DEFAULT_RELEVANT,
	CLAIM_URL_TEMPLATE,
	emitClaimPost,
	SEARCH_CASE_ID_REF,
} from "../claim";

describe("emitClaimPost — structural shape", () => {
	it("emits the five-line canonical template", () => {
		const xml = emitClaimPost();
		expect(xml).toBe(
			[
				`    <post url="https://www.commcarehq.org/a/__DOMAIN__/phone/claim-case/"`,
				`          relevant="count(instance('casedb')/casedb/case[@case_id=instance('commcaresession')/session/data/search_case_id]) = 0">`,
				`      <data key="case_id" ref="instance('commcaresession')/session/data/search_case_id"/>`,
				`    </post>`,
			].join("\n"),
		);
	});

	it("references the canonical CCHQ claim URL with the domain placeholder", () => {
		// CCHQ regenerates suite.xml server-side on `import_app`,
		// substituting the live domain at import time. The literal
		// `__DOMAIN__` placeholder reaching the wire matches what
		// CCHQ replaces; direct .ccz sideload is not a current Nova
		// path.
		const xml = emitClaimPost();
		expect(xml).toContain(
			`url="https://www.commcarehq.org/a/__DOMAIN__/phone/claim-case/"`,
		);
		expect(CLAIM_URL_TEMPLATE).toBe(
			"https://www.commcarehq.org/a/__DOMAIN__/phone/claim-case/",
		);
	});

	it("emits the canonical default-relevant guard verbatim", () => {
		// CCHQ's `CaseClaimXpath.default_relevant` formula at
		// `commcare-hq/corehq/apps/app_manager/xpath.py::CaseClaimXpath.default_relevant`,
		// surfaced through
		// `commcare-hq/corehq/apps/app_manager/models.py::CaseSearch.get_relevant`'s
		// no-additional-relevant branch. The single-author-allowed
		// composition affordance was nuked in Task 21; every emission
		// carries the bare default guard.
		const xml = emitClaimPost();
		expect(xml).toContain(`relevant="${CLAIM_DEFAULT_RELEVANT}"`);
		expect(CLAIM_DEFAULT_RELEVANT).toBe(
			"count(instance('casedb')/casedb/case[@case_id=instance('commcaresession')/session/data/search_case_id]) = 0",
		);
	});

	it("emits exactly one <data key='case_id'> child and no others", () => {
		const xml = emitClaimPost();
		// Single data child, referencing the search_case_id session
		// datum.
		const dataMatches = xml.match(/<data\s/g) ?? [];
		expect(dataMatches.length).toBe(1);
		expect(xml).toContain(
			`<data key="case_id" ref="instance('commcaresession')/session/data/search_case_id"/>`,
		);
	});

	it("threads the same session-data ref the orchestrator's <stack> rewind frame uses", () => {
		// The `<post>` body's `case_id` data child and the
		// surrounding `<stack>`'s rewind frame both target the same
		// `search_case_id` session datum. Centralising the literal
		// in `claim.ts::SEARCH_CASE_ID_REF` keeps the rewind frame's
		// `value` attribute and the post body's `ref` attribute
		// pointing at one source.
		expect(SEARCH_CASE_ID_REF).toBe(
			"instance('commcaresession')/session/data/search_case_id",
		);
		const xml = emitClaimPost();
		expect(xml).toContain(SEARCH_CASE_ID_REF);
	});
});
