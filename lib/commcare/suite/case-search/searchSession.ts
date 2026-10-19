import { type RuntimeTarget, runtimeUrls } from "@/lib/commcare/runtimeTarget";

// lib/commcare/suite/case-search/searchSession.ts
//
// `<session>` body of a `<remote-request>`. Wraps `<query>` (search-
// execution config — endpoint URL, required attributes, `<title>`,
// `<data>` slots in CCHQ's canonical order, `<prompt>` block) and
// `<datum>` (case-selection datum referencing the search-side detail
// ids). The orchestrator at `remoteRequest.ts` splices the result
// into the `<remote-request>` body.

import type { Element } from "domhandler";
import {
	el,
	type WireElementContext,
	xel,
} from "@/lib/commcare/elementBuilders";
import { w } from "@/lib/commcare/xpath/wire/builders";
import {
	type InstanceDecl,
	InstanceSink,
	resultsInstance,
} from "@/lib/commcare/xpath/wire/instances";
import type { WireExpr } from "@/lib/commcare/xpath/wire/tree";
import {
	type CaseListConfig,
	DEFAULT_CASE_SEARCH_TITLE,
	type OrdinaryCaseSearchConfig,
	type WireStringSource,
} from "@/lib/domain";
import type { DatumRef } from "@/lib/domain/expression/types";
import type { ModuleExpressionContexts } from "../../expressionContext";
import { validateCaseType } from "../../identifierValidation";
import type { LookupWireNaming } from "../../lookup/naming";
import { emitNormalizedExcludedOwnerIdsExpression } from "../case-list/nodesetFilter";
import { SEARCH_SELECTED_CASES_ID } from "./claim";
import { searchNeedsSupportingCases } from "./relatedCaseProjection";
import { buildSearchPrompts } from "./searchPrompts";
import {
	searchInputInstanceId,
	searchStorageInstance,
	type WireShape,
} from "./types";
import {
	buildRuntimeCsqlPromptValidations,
	composeXPathQueryEmission,
	xpathQueryRequestValues,
} from "./xpathQuery";

/** Portable URL used only by unbound structural emission and fixture tests.
 * Actual exports supply their resolved selected-server runtime target. */
export const SEARCH_URL_TEMPLATE = runtimeUrls().search;

/**
 * CCHQ wire-key for the excluded-owners filter, lifted verbatim
 * from `CASE_SEARCH_BLACKLISTED_OWNER_ID_KEY`. Nova's authoring
 * vocabulary calls the slot `excludedOwnerIds`; this constant is
 * the wire-side translation, applied at the emission site below.
 */
const EXCLUDED_OWNER_IDS_WIRE_KEY = "commcare_blacklisted_owner_ids";

/**
 * Private CCHQ query datum requesting the supporting case rows needed to
 * evaluate relation-backed Search details. Nova derives it from emitted
 * information; it is never authoring state.
 */
const INCLUDE_ALL_RELATED_CASES_WIRE_KEY =
	"x_commcare_include_all_related_cases";

/**
 * CCHQ wire-key for a CSQL query value, lifted from
 * `CASE_SEARCH_XPATH_QUERY_KEY`. The key repeats — one `<data>` per
 * composed clause; the server ANDs every value it receives under this
 * key. Centralized so a CCHQ-upstream key change is one edit.
 */
const XPATH_QUERY_KEY = "_xpath_query";

/**
 * The Element-returning shape `buildSearchSession` produces for the
 * `<remote-request>` orchestrator (`remoteRequest.ts::buildRemoteRequest`).
 *
 *   - `element` — the `<session>` Element ready to splice into the
 *     surrounding `<remote-request>` parent.
 *   - `strings` — locale entries for the `<title>` and per-prompt
 *     labels, threaded into the per-language string tables.
 *   - `instances` — declarations for the instances actually read by the
 *     emitted query and selection datum. The orchestrator combines them
 *     with the referenced detail and post declarations.
 */
export interface SearchSessionEmission {
	readonly element: Element;
	readonly strings: Record<string, string>;
	readonly translationUnits: Record<string, WireStringSource>;
	readonly instances: readonly InstanceDecl[];
}

/**
 * The `<query>` alone: what a search-first module's entries embed
 * directly in `<session>` (CCHQ's `EntriesHelper.get_query_datums`), and
 * what the standalone `<remote-request>` wraps with its own datum.
 * `instances` are declarations for what the query body reads; the caller adds the
 * storage instance its datum reads and whatever its post reads.
 */
export interface SearchQueryEmission {
	readonly element: Element;
	readonly strings: Record<string, string>;
	readonly translationUnits: Record<string, WireStringSource>;
	readonly instances: readonly InstanceDecl[];
	/** Whether the query carries any `<prompt>`, hidden ones included. HQ's
	 *  `WorkflowQueryMeta.requires_selection` is `not prompts and
	 *  default_search` over every emitted prompt (`remote_requests.py::
	 *  build_query_prompts` skips only groups), so a hidden-only search is
	 *  a prompted one for frame purposes even though nobody answers it. */
	readonly hasPrompts: boolean;
}

export interface SearchQueryArgs {
	readonly runtimeTarget?: RuntimeTarget;
	readonly caseListConfig: CaseListConfig;
	readonly caseSearchConfig: OrdinaryCaseSearchConfig;
	readonly wire: WireShape;
	readonly caseType: string;
	readonly moduleIndex: number;
	readonly expressions: ModuleExpressionContexts;
	readonly lookupNaming?: LookupWireNaming;
	/**
	 * For a search-first module whose cases sit under a selected parent
	 * (HQ `parent_select` with the `parent` relationship): the parent's
	 * case type, sent as a trailing `_xpath_query` so the server returns
	 * only cases with such an ancestor
	 * (`RemoteRequestFactory._remote_request_query_datums`).
	 */
	readonly ancestorCaseType?: string;
	/** The id each case chosen before the module's case list step prints
	 * under (`formLinkProjection.ts::caseListStepDatumId`). */
	readonly datumId?: (ref: DatumRef) => string | undefined;
}

/**
 * Build the `<session>` Element. `wire` flows from `compileForPlatform`:
 * `inlineSearch` picks the storage-instance id (`results:inline` vs
 * `results`); `defaultSearch` lands on `<query default_search>`.
 * `autoLaunch` flows past — the case-list short-detail emitter
 * consumes it for `<action auto_launch>` on `m{N}_case_short`.
 */
export function buildSearchSession(
	args: SearchQueryArgs & { readonly hasDetailScreen?: boolean },
): SearchSessionEmission {
	const { caseListConfig, wire, moduleIndex } = args;
	const caseType = validateCaseType(args.caseType);
	const moduleId = `m${moduleIndex}`;
	const storageInstance = searchStorageInstance(wire);
	const query = buildSearchQuery(args);
	const instances = new InstanceSink(query.instances);
	const context: WireElementContext = { mode: { target: "suite" }, instances };

	// `<datum>` references the search-side detail ids
	// (`m{N}_search_short` / `m{N}_search_long`) — distinct from the
	// `m{N}_case_short` / `m{N}_case_long` ids the local case-list
	// entry uses.
	const datumNodeset = composeDatumNodeset(storageInstance, caseType);
	const selection = caseListConfig.selection;
	const multiple = selection?.kind === "multiple";
	const datumEl = xel(
		multiple ? "instance-datum" : "datum",
		{
			attributes: {
				id: multiple ? SEARCH_SELECTED_CASES_ID : "search_case_id",
				...((args.hasDetailScreen ?? true) && {
					"detail-confirm": `${moduleId}_search_long`,
				}),
				"detail-select": `${moduleId}_search_short`,
				...(selection !== undefined && {
					"max-select-value": String(selection.maximum),
				}),
			},
			xpath: {
				nodeset: datumNodeset,
				value: w.context([w.self(), w.attr("case_id")]),
			},
		},
		context,
	);

	const sessionEl = el("session", {}, [query.element, datumEl]);

	return {
		element: sessionEl,
		strings: query.strings,
		translationUnits: query.translationUnits,
		instances: instances.declarations(),
	};
}

/**
 * Build the `<query>` Element and everything it carries. `wire` flows
 * from `compileForPlatform`: `inlineSearch` picks the storage-instance id
 * (`results:inline` vs `results`) and the answer instance every
 * `input(...)` read prints through; `defaultSearch` lands on
 * `<query default_search>`.
 */
export function searchQueryHasPrompts(config: CaseListConfig): boolean {
	return config.searchInputs.length > 0;
}

export function buildSearchQuery(args: SearchQueryArgs): SearchQueryEmission {
	const { caseListConfig, caseSearchConfig, wire, moduleIndex } = args;
	// Route `caseType` through the identifier-validation gate before
	// interpolating into the XPath body — the sibling derivation at
	// `session.ts::deriveSessionDatums` makes the same call, so both
	// suite-XML surfaces (case-loading datum + case-search datum)
	// stay symmetric on the wire-emitter's "total function over its
	// inputs" contract. The upstream validator gates non-conforming
	// case-type strings, but the wire emitter doesn't trust callers
	// — a future surface bypassing the validator would otherwise
	// interpolate an unchecked string into an attribute value.
	const caseType = validateCaseType(args.caseType);
	const moduleId = `m${moduleIndex}`;
	const instances = new InstanceSink();
	const context: WireElementContext = { mode: { target: "suite" }, instances };

	// `results:inline` is the inline shape (search first); `results` is
	// the standalone post-and-query roundtrip. Every `input(...)` read in
	// the body prints through the matching answer instance.
	const storageInstance = searchStorageInstance(wire);

	// `<data>` slot order matches CCHQ's canonical order at
	// `commcare-hq/.../suite_xml/post_process/remote_requests.py::_remote_request_query_datums`:
	// `case_type` first, then every `default_properties[]` entry
	// (where `_xpath_query` lives on CCHQ's side), then
	// `commcare_blacklisted_owner_ids`, then the derived supporting-case
	// request when emitted information needs it. Order is runtime-irrelevant —
	// `RemoteQuerySessionManager.getRawQueryParams` keys data into a
	// `Multimap<String, String>` by key — but the canonical order
	// keeps Nova's local suite.xml structurally mirroring the suite
	// CCHQ regenerates from the HQ JSON upload, so the local-
	// diagnostic `.ccz` reads cleanly against
	// `~/code/commcare-hq/.../tests/data/suite/search_command_detail.xml`.
	const dataElements: Element[] = [];

	// `case_type` — always present, always first. The XPath single-
	// quoted literal flows raw into the `ref` attribute; the
	// serializer escapes the surrounding `'` characters once at render
	// time (`&apos;`).
	dataElements.push(
		xel(
			"data",
			{
				attributes: { key: "case_type" },
				xpath: { ref: w.str(caseType) },
			},
			context,
		),
	);

	// `_xpath_query` — one `<data>` element per composed clause: the
	// unified filter's top-level conjuncts, every advanced-arm search
	// input's predicate, and every simple-arm input routed through the
	// explicit predicate path (related targets, renamed prompt keys,
	// non-exact modes, reserved paths, and exact whole-day date
	// inputs). The server AND-composes repeated `_xpath_query` values
	// (`commcare-hq/corehq/apps/case_search/utils.py::_apply_filter`
	// loops the multi-term criteria into one ES filter each; the
	// client sends one query param per element because
	// `RemoteQuerySessionManager.getRawQueryParams` accumulates a
	// `Multimap`), so the split preserves the fused meaning while each
	// emitted expression stays small enough to read. Non-grammar value
	// expressions inline as on-device XPath fragments inside their
	// clause's wrapper — CCHQ's `RemoteQuerySessionManager.initUserAnswers`
	// only seeds the `search-input:results` instance from `<prompt>`
	// defaults, so a synthetic non-`_xpath_query` `<data>` slot's value
	// would resolve to the empty string at evaluation time AND silently
	// add a server-side property filter against case data that matches
	// no cases.
	const xpathQueryEmission = composeXPathQueryEmission(
		caseListConfig,
		caseType,
		args.expressions,
		args.lookupNaming,
		searchInputInstanceId(wire),
		args.datumId,
	);
	// A search with no input and no clause sends the zero-input sentinel,
	// as HQ's build of the same search does.
	for (const value of xpathQueryRequestValues(
		caseListConfig,
		xpathQueryEmission,
	)) {
		dataElements.push(
			xel(
				"data",
				{
					attributes: { key: XPATH_QUERY_KEY },
					xpath: { ref: value },
				},
				context,
			),
		);
	}

	// Authoring → wire vocabulary translation. Schema slot reads
	// `excludedOwnerIds`; CCHQ wire slot reads `commcare_blacklisted_owner_ids`.
	// The shared normalization helper also feeds HQ JSON and the ordinary list,
	// so repeated/trailing/tab whitespace cannot create empty owner-id tokens on
	// one path while Preview trims them away.
	// CCHQ scopes this on `<query>`, not `<post>` — the post fires
	// after case selection, by which point the filter has already
	// gated the visible result set.
	if (caseSearchConfig.excludedOwnerIds !== undefined) {
		const excludedOwnerIds = emitNormalizedExcludedOwnerIdsExpression(
			caseSearchConfig.excludedOwnerIds,
			args.expressions({ slot: "excluded_owner_ids" }),
			args.lookupNaming,
			searchInputInstanceId(wire),
		);
		dataElements.push(
			xel(
				"data",
				{
					attributes: { key: EXCLUDED_OWNER_IDS_WIRE_KEY },
					xpath: { ref: excludedOwnerIds },
				},
				context,
			),
		);
	}

	if (searchNeedsSupportingCases(caseListConfig, args.expressions)) {
		dataElements.push(
			xel(
				"data",
				{
					attributes: { key: INCLUDE_ALL_RELATED_CASES_WIRE_KEY },
					xpath: { ref: w.str("true") },
				},
				context,
			),
		);
	}

	// Under a selected parent, the inline shape narrows the server search
	// to that parent's descendants by type; CCHQ appends this last.
	if (wire.inlineSearch && args.ancestorCaseType !== undefined) {
		dataElements.push(
			xel(
				"data",
				{
					attributes: { key: XPATH_QUERY_KEY },
					xpath: {
						ref: w.str(
							`ancestor-exists(parent, @case_type='${validateCaseType(args.ancestorCaseType)}')`,
						),
					},
				},
				context,
			),
		);
	}

	// `<prompt>`s render in searchInputs array order; the instance accumulation
	// below is order-independent (a Set).
	const promptEmission = buildSearchPrompts(
		[...caseListConfig.searchInputs],
		moduleId,
		buildRuntimeCsqlPromptValidations(xpathQueryEmission),
		args.expressions,
		args.lookupNaming,
		searchInputInstanceId(wire),
	);
	instances.add(promptEmission.instances);

	// Title locale id pattern is CCHQ's `case_search.{m}.inputs`. The
	// default is shared with preview and HQ JSON, so every runtime renders the
	// same friendly screen copy.
	const titleLocaleId = `case_search.${moduleId}.inputs`;
	// The schema's `searchScreenTitle: z.string().min(1).optional()`
	// guarantees the slot is either `undefined` or a non-empty string,
	// so `undefined` is the sole "no override" sentinel. The Nova default
	// mirrors the HQ-JSON projection's symmetric fallback at
	// `lib/commcare/hqJson/caseList.ts::buildSearchConfigDocument` so
	// the same authored input lands the same locale string regardless
	// of which path (local suite XML vs CCHQ-regenerated suite) the
	// runtime sees.
	const titleDisplay =
		caseSearchConfig.searchScreenTitle ?? DEFAULT_CASE_SEARCH_TITLE;

	// Every search writes `<description>`, blank where no subtitle is
	// authored: HQ's Case List save writes the description for the page's
	// language on every menu, empty for none, and HQ's build of the saved
	// app then writes the element
	// (`views/modules.py::_gather_and_update_search_properties`), so the HQ
	// JSON stores the blank map and both paths write the element. A blank
	// value has no translation unit, so it is a literal every language's
	// table writes, as a non-breaking space
	// (`localeFile.ts::serializeLocaleFileValue`). The locale id pattern is
	// CCHQ's `case_search.{m}.description`; element ordering inside
	// `<query>` is title → description → data → prompts, matching CCHQ's
	// `RemoteRequestQuery` factory.
	const subtitleDisplay = caseSearchConfig.searchScreenSubtitle ?? "";
	const descriptionLocaleId = `case_search.${moduleId}.description`;

	// `<query>` children in canonical order: title → description →
	// data → prompts. The serializer preserves child insertion order.
	const queryChildren: Element[] = [
		el("title", {}, [el("text", {}, [el("locale", { id: titleLocaleId })])]),
		el("description", {}, [
			el("text", {}, [el("locale", { id: descriptionLocaleId })]),
		]),
		...dataElements,
		...promptEmission.elements,
	];

	// `<query>` attribute insertion order — `url, default_search,
	// storage-instance, template` — matches CCHQ's canonical order
	// on `RemoteRequestQuery` so the rendered bytes stay diffable
	// against the CCHQ-regenerated suite.
	const queryEl = el(
		"query",
		{
			url: runtimeUrls(args.runtimeTarget).search,
			default_search: wire.defaultSearch ? "true" : "false",
			"storage-instance": storageInstance,
			template: "case",
		},
		queryChildren,
	);

	const strings: Record<string, string> = {
		[titleLocaleId]: titleDisplay,
		[descriptionLocaleId]: subtitleDisplay,
		...promptEmission.strings,
	};
	const translationUnits = { ...promptEmission.translationUnits };

	return {
		element: queryEl,
		strings,
		translationUnits,
		instances: instances.declarations(),
		hasPrompts: searchQueryHasPrompts(caseListConfig),
	};
}

/**
 * Compose the `<datum nodeset>` value. The
 * `[not(commcare_is_related_case=true())]` filter is CCHQ's
 * `EXCLUDE_RELATED_CASES_FILTER` (excludes cases indexed as related-
 * only artifacts of an existing search), lifted verbatim.
 *
 * The XPath single-quote literals (`'casedb'`, `'patient'`) flow raw
 * into the surrounding attribute value; the serializer escapes them
 * once at render time so the wire reads `instance(&apos;…&apos;)`.
 */
function composeDatumNodeset(
	storageInstance: "results" | "results:inline",
	caseType: string,
): WireExpr {
	// CCHQ pins the path segment to `/results/case` regardless of
	// instance id — the instance discriminator is the colon suffix
	// on the instance reference, not the path that follows.
	return w.instance(resultsInstance(storageInstance), [
		w.step("results"),
		w.step("case", [
			w.eq(w.context([w.attr("case_type")]), w.str(caseType)),
			w.not(
				w.eq(
					w.context([w.step("commcare_is_related_case")]),
					w.call("true", []),
				),
			),
		]),
	]);
}
