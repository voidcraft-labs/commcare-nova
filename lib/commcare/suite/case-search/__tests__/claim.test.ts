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
//      xpath_query slots live on `<query>`, not `<post>`).

import { describe, expect, it } from "vitest";
import {
	CLAIM_DEFAULT_RELEVANT,
	CLAIM_URL_TEMPLATE,
	emitClaimPost,
	SEARCH_CASE_ID_REF,
} from "../claim";

describe("emitClaimPost — structural shape", () => {
	it("emits the canonical compact <post> template", () => {
		const xml = emitClaimPost();
		// Compact serializer output; XPath single-quote literals
		// (`'casedb'`, `'commcaresession'`) round-trip as `&apos;`
		// inside the double-quoted `relevant` / `ref` attributes.
		expect(xml).toBe(
			`<post url="https://www.commcarehq.org/a/__DOMAIN__/phone/claim-case/"` +
				` relevant="count(instance(&apos;casedb&apos;)/casedb/case[@case_id=instance(&apos;commcaresession&apos;)/session/data/search_case_id]) = 0">` +
				`<data key="case_id" ref="instance(&apos;commcaresession&apos;)/session/data/search_case_id"/>` +
				`</post>`,
		);
	});

	it("references the canonical CCHQ claim URL with the domain placeholder", () => {
		// CCHQ regenerates suite.xml at BUILD time via
		// `commcare-hq/corehq/apps/app_manager/models.py::Application.create_suite`
		// (delegating to `SuiteGenerator.generate_suite`), substituting
		// the live domain into the `__DOMAIN__` placeholder. The
		// literal placeholder reaching the wire matches what CCHQ
		// replaces; direct .ccz sideload is not a current Nova path.
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
		// no-additional-relevant branch. Nova exposes no author
		// composition affordance; every emission carries the bare
		// default guard string. The constant stays untouched (XPath
		// single-quote literals); the wire form encodes them as
		// `&apos;` inside the `relevant` attribute value.
		const xml = emitClaimPost();
		expect(xml).toContain(
			`relevant="count(instance(&apos;casedb&apos;)/casedb/case[@case_id=instance(&apos;commcaresession&apos;)/session/data/search_case_id]) = 0"`,
		);
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
		// XPath single-quote literal (`'commcaresession'`) round-trips
		// as `&apos;` inside the double-quoted `ref` attribute value.
		expect(xml).toContain(
			`<data key="case_id" ref="instance(&apos;commcaresession&apos;)/session/data/search_case_id"/>`,
		);
	});

	it("threads the same session-data ref the orchestrator's <stack> rewind frame uses", () => {
		// The `<post>` body's `case_id` data child and the
		// surrounding `<stack>`'s rewind frame both target the same
		// `search_case_id` session datum. Centralising the literal
		// in `claim.ts::SEARCH_CASE_ID_REF` keeps the rewind frame's
		// `value` attribute and the post body's `ref` attribute
		// pointing at one source. The Nova constant stays in its
		// raw XPath form; both surfaces XML-encode the embedded `'`
		// at serialization time.
		expect(SEARCH_CASE_ID_REF).toBe(
			"instance('commcaresession')/session/data/search_case_id",
		);
		const xml = emitClaimPost();
		expect(xml).toContain(
			"instance(&apos;commcaresession&apos;)/session/data/search_case_id",
		);
	});
});
