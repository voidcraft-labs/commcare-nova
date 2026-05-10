// lib/commcare/suite/case-search/claim.ts
//
// Suite-XML emission for the `<post>` claim element inside a
// `<remote-request>`. CCHQ's runtime fires this POST when the user
// selects a case from search results, claiming ownership of the
// case so subsequent restores carry it down to the device's
// casedb.
//
// `<post>` carries one structural element wire-required regardless
// of authoring: every case-search-enabled module emits the same
// shape. Two slots vary across emissions:
//
//   - `url` — the CCHQ-side claim endpoint URL. Emitted with the
//     `__DOMAIN__` placeholder string at compile time. CCHQ's
//     server-side `Application.create_suite` regenerates suite.xml
//     at build time (via `SuiteGenerator.generate_suite`), and
//     `RemoteRequestFactory` substitutes the live domain through
//     `absolute_reverse('claim_case', args=[self.domain])`. The
//     uploaded .ccz never reaches a runtime carrying the literal
//     placeholder; direct sideload is not a current path.
//
//   - `relevant` — the case-not-already-claimed guard. Lifted
//     verbatim from
//     `commcare-hq/corehq/apps/app_manager/xpath.py::CaseClaimXpath.default_relevant`
//     and `commcare-hq/corehq/apps/app_manager/models.py::CaseSearch.get_relevant`:
//     `count(instance('casedb')/casedb/case[@case_id=instance('commcaresession')/session/data/search_case_id]) = 0`.
//     Structural defense against repeat-claim writes (the underlying
//     cause of `state hash mismatch` log spam in CCHQ webapps logs).
//     There is no author-controlled composition: every emission
//     carries this exact guard string.
//
// The `<post>` body carries a single `<data>` child:
//
//   <data key="case_id" ref="instance('commcaresession')/session/data/search_case_id"/>
//
// Verified against the canonical fixture
// `commcare-hq/corehq/apps/app_manager/tests/data/suite/remote_request.xml`'s
// `<remote-request>/<post>` element and
// `commcare-hq/corehq/apps/app_manager/tests/data/suite/search_config_blacklisted_owners.xml`'s
// `<remote-request>/<post>` element (both share the canonical shape;
// the second pins the `<post>` body when the search has no
// additional `relevant` composition).

/**
 * The CCHQ-side claim URL placeholder. CCHQ rebuilds suite.xml at
 * BUILD time via
 * `commcare-hq/corehq/apps/app_manager/models.py::Application.create_suite`
 * (which delegates to `SuiteGenerator.generate_suite`); the live
 * domain is substituted at that point through
 * `absolute_reverse('claim_case', args=[self.domain])` inside
 * `RemoteRequestFactory`. The literal placeholder never reaches a
 * runtime — direct .ccz sideload is not a current Nova path. The
 * constant lives at module scope so both the fixture-comparison
 * tests and the runtime emitter share the same source.
 */
export const CLAIM_URL_TEMPLATE =
	"https://www.commcarehq.org/a/__DOMAIN__/phone/claim-case/";

/**
 * The case-not-already-claimed default guard. Lifted verbatim from
 * `commcare-hq/corehq/apps/app_manager/xpath.py::CaseClaimXpath.default_relevant`
 * via `commcare-hq/corehq/apps/app_manager/models.py::CaseSearch.get_relevant`.
 * Every `<remote-request>` Nova emits carries this exact string —
 * no author override, no AND-composition with author-supplied
 * predicates. The structural guard ships unconditionally.
 */
export const CLAIM_DEFAULT_RELEVANT =
	"count(instance('casedb')/casedb/case[@case_id=instance('commcaresession')/session/data/search_case_id]) = 0";

/**
 * The session-data XPath that resolves to the case id selected
 * from search results. Both the `<post>` body's `<data
 * key="case_id">` element and the `<stack>` rewind frame point at
 * this same session datum.
 */
export const SEARCH_CASE_ID_REF =
	"instance('commcaresession')/session/data/search_case_id";

/**
 * Compose the `<post>` element for a `<remote-request>`. Returns
 * the indented multi-line XML chunk the orchestrator splices
 * directly into the `<remote-request>` body.
 *
 * Indent depth: 4 spaces from column zero. Matches the canonical
 * fixture's `<post>` indent inside `<remote-request>`. Children
 * indent two further spaces.
 *
 * The `<post>` element carries ONLY the `case_id` data child. CCHQ
 * extension features that contribute additional `<post>` data
 * children (`commcare_blacklisted_owner_ids`, registry id) live on
 * the sibling `<query>` element's data section in this codebase —
 * see `lib/commcare/suite/case-search/searchSession.ts`. The
 * excluded-owners filter's authoring contract resolves via on-device
 * XPath at `<query>`-side evaluation; placing it on `<post>` would
 * carry no runtime effect because the post fires after case
 * selection, by which point the filter has already gated the visible
 * result set.
 */
export function emitClaimPost(): string {
	return [
		`    <post url="${CLAIM_URL_TEMPLATE}"`,
		`          relevant="${CLAIM_DEFAULT_RELEVANT}">`,
		`      <data key="case_id" ref="${SEARCH_CASE_ID_REF}"/>`,
		`    </post>`,
	].join("\n");
}
