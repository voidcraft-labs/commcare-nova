import { type RuntimeTarget, runtimeUrls } from "@/lib/commcare/runtimeTarget";
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

/** Portable URL used only by unbound structural emission and fixture tests.
 * Actual exports supply their resolved selected-server runtime target. */
export const CLAIM_URL_TEMPLATE = runtimeUrls().claim;

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

export const SEARCH_SELECTED_CASES_ID = "search_selected_cases";
export const SEARCH_SELECTED_CASES_REF =
	"instance('commcaresession')/session/data/search_selected_cases";
export const CLAIM_MULTI_RELEVANT = "$case_id != ''";
export const CLAIM_MULTI_NODESET =
	"instance('search_selected_cases')/results/value";
export const CLAIM_MULTI_EXCLUDE =
	"count(instance('casedb')/casedb/case[@case_id=current()/.]) = 1";

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

export function buildClaimPost(
	multiple = false,
	runtimeTarget?: RuntimeTarget,
): Element {
	if (multiple) {
		return el(
			"post",
			{ url: runtimeUrls(runtimeTarget).claim, relevant: CLAIM_MULTI_RELEVANT },
			[
				el("data", {
					key: "case_id",
					nodeset: CLAIM_MULTI_NODESET,
					exclude: CLAIM_MULTI_EXCLUDE,
					ref: ".",
				}),
			],
		);
	}
	return el(
		"post",
		{ url: runtimeUrls(runtimeTarget).claim, relevant: CLAIM_DEFAULT_RELEVANT },
		[el("data", { key: "case_id", ref: SEARCH_CASE_ID_REF })],
	);
}

/** The claim `<post>` of an inline (search-first) entry and the instances
 *  its XPath reads. */
export interface InlineClaimPost {
	readonly element: Element;
	readonly instances: readonly string[];
}

/**
 * The claim `<post>` a search-first module's case-requiring entry carries
 * (`EntriesHelper.add_post_to_entry`). Unlike the `<remote-request>` post,
 * it reads the entry's OWN case datum (`case_id`, or the collection
 * `selected_cases`), and under a selected parent it also offers every
 * earlier selection, each excluded when the device already holds it, with
 * the relevance loosened to `$case_id != ''`
 * (`RemoteRequestFactory.build_case_id_query_data`).
 */
export function buildInlineClaimPost(args: {
	readonly runtimeTarget?: RuntimeTarget;
	/** The entry's own case datum id. */
	readonly sessionVar: string;
	/** Whether that datum is a multiple selection (`instance-datum`). */
	readonly collection: boolean;
	/**
	 * Present when the module selects its cases under a parent
	 * (`module_uses_inline_search_with_parent_relationship_parent_select`):
	 * every other case datum of the entry, in entry order, excluding the
	 * entry's new-case ids. HQ offers each for claiming too.
	 */
	readonly parentSelect?: { readonly otherSessionVars: readonly string[] };
}): InlineClaimPost {
	const { sessionVar, collection } = args;
	const parentSelect = args.parentSelect !== undefined;
	const others = args.parentSelect?.otherSessionVars ?? [];
	const sessionRef = (id: string): string =>
		`instance('commcaresession')/session/data/${id}`;
	const claimed = (ref: string): string =>
		`count(instance('casedb')/casedb/case[@case_id=${ref}])`;
	const own = collection
		? el("data", {
				key: "case_id",
				ref: ".",
				nodeset: `instance('${sessionVar}')/results/value`,
				exclude: CLAIM_MULTI_EXCLUDE,
			})
		: el("data", {
				key: "case_id",
				ref: sessionRef(sessionVar),
				...(parentSelect && {
					exclude: `${claimed(sessionRef(sessionVar))} != 0`,
				}),
			});
	const extra = others.map((id) =>
		el("data", {
			key: "case_id",
			ref: sessionRef(id),
			exclude: `${claimed(sessionRef(id))} != 0`,
		}),
	);
	const relevant =
		collection || parentSelect
			? CLAIM_MULTI_RELEVANT
			: `${claimed(sessionRef(sessionVar))} = 0`;
	return {
		element: el(
			"post",
			{ url: runtimeUrls(args.runtimeTarget).claim, relevant },
			[own, ...extra],
		),
		instances: [
			"casedb",
			...(collection && others.length === 0 ? [] : ["commcaresession"]),
		],
	};
}

/**
 * String adapter — serializes `buildClaimPost`'s Element for callers
 * that assert against the rendered XML string (the `claim.test.ts`
 * test surface). The orchestrator (`remoteRequest.ts`) calls
 * `buildClaimPost` directly.
 */
export function emitClaimPost(multiple = false): string {
	return render(buildClaimPost(multiple), RENDER_OPTS);
}
