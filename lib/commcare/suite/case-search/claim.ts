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

import type { Element } from "domhandler";
import { type WireElementContext, xel } from "@/lib/commcare/elementBuilders";
import { w } from "@/lib/commcare/xpath/wire/builders";
import {
	caseDbInstance,
	type InstanceDecl,
	InstanceSink,
	selectedCasesInstance,
	sessionInstance,
} from "@/lib/commcare/xpath/wire/instances";
import type { WireExpr } from "@/lib/commcare/xpath/wire/tree";

/** Portable URL used only by unbound structural emission and fixture tests.
 * Actual exports supply their resolved selected-server runtime target. */
export const CLAIM_URL_TEMPLATE = runtimeUrls().claim;

/**
 * The case-not-already-claimed guard, lifted verbatim from CCHQ's
 * `CaseClaimXpath.default_relevant`. Structural defense against
 * repeat-claim writes (the underlying cause of `state hash mismatch`
 * log spam in CCHQ webapps logs). Every `<remote-request>` Nova
 * emits carries this condition.
 */
export const CLAIM_DEFAULT_RELEVANT = w.eq(
	claimed(sessionRef("search_case_id")),
	w.num(0),
);

/**
 * The session-data XPath that resolves to the selected search-result
 * case id. Both the `<post>` body's `<data key="case_id">` element
 * and the `<stack>` rewind frame point at this same datum.
 */
export const SEARCH_CASE_ID_REF = sessionRef("search_case_id");

export const SEARCH_SELECTED_CASES_ID = "search_selected_cases";
export const SEARCH_SELECTED_CASES_REF = sessionRef(SEARCH_SELECTED_CASES_ID);
export const CLAIM_MULTI_RELEVANT = w.ne(w.caseIdVar(), w.str(""));
export const CLAIM_MULTI_NODESET = w.instance(
	selectedCasesInstance(SEARCH_SELECTED_CASES_ID),
	[w.step("results"), w.step("value")],
);
export const CLAIM_MULTI_EXCLUDE = w.eq(
	claimed(w.current([w.self()])),
	w.num(1),
);

function sessionRef(id: string): WireExpr {
	return w.instance(sessionInstance(), [
		w.step("session"),
		w.step("data"),
		w.step(id),
	]);
}

function claimed(ref: WireExpr): WireExpr {
	return w.call("count", [
		w.instance(caseDbInstance(), [
			w.step("casedb"),
			w.step("case", [w.eq(w.context([w.attr("case_id")]), ref)]),
		]),
	]);
}

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
	multiple: boolean,
	context: WireElementContext,
	runtimeTarget?: RuntimeTarget,
): Element {
	if (multiple) {
		return xel(
			"post",
			{
				attributes: { url: runtimeUrls(runtimeTarget).claim },
				xpath: { relevant: CLAIM_MULTI_RELEVANT },
			},
			context,
			[
				xel(
					"data",
					{
						attributes: { key: "case_id" },
						xpath: {
							nodeset: CLAIM_MULTI_NODESET,
							exclude: CLAIM_MULTI_EXCLUDE,
							ref: w.context([w.self()]),
						},
					},
					context,
				),
			],
		);
	}
	return xel(
		"post",
		{
			attributes: { url: runtimeUrls(runtimeTarget).claim },
			xpath: { relevant: CLAIM_DEFAULT_RELEVANT },
		},
		context,
		[
			xel(
				"data",
				{ attributes: { key: "case_id" }, xpath: { ref: SEARCH_CASE_ID_REF } },
				context,
			),
		],
	);
}

/** The claim `<post>` of an inline (search-first) entry and the instances
 *  its XPath reads. */
export interface InlineClaimPost {
	readonly element: Element;
	readonly instances: readonly InstanceDecl[];
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
	const instances = new InstanceSink();
	const context: WireElementContext = { mode: { target: "suite" }, instances };
	const own = collection
		? xel(
				"data",
				{
					attributes: { key: "case_id" },
					xpath: {
						ref: w.context([w.self()]),
						nodeset: w.instance(selectedCasesInstance(sessionVar), [
							w.step("results"),
							w.step("value"),
						]),
						exclude: CLAIM_MULTI_EXCLUDE,
					},
				},
				context,
			)
		: xel(
				"data",
				{
					attributes: { key: "case_id" },
					xpath: {
						ref: sessionRef(sessionVar),
						...(parentSelect && {
							exclude: w.ne(claimed(sessionRef(sessionVar)), w.num(0)),
						}),
					},
				},
				context,
			);
	const extra = others.map((id) =>
		xel(
			"data",
			{
				attributes: { key: "case_id" },
				xpath: {
					ref: sessionRef(id),
					exclude: w.ne(claimed(sessionRef(id)), w.num(0)),
				},
			},
			context,
		),
	);
	const relevant =
		collection || parentSelect
			? CLAIM_MULTI_RELEVANT
			: w.eq(claimed(sessionRef(sessionVar)), w.num(0));
	const element = xel(
		"post",
		{
			attributes: { url: runtimeUrls(args.runtimeTarget).claim },
			xpath: { relevant },
		},
		context,
		[own, ...extra],
	);
	return {
		element,
		instances: instances.declarations(),
	};
}
