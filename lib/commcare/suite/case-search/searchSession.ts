// lib/commcare/suite/case-search/searchSession.ts
//
// `<session>` body of a `<remote-request>`. Wraps `<query>` (search-
// execution config — endpoint URL, required attributes, `<title>`,
// `<data>` slots in CCHQ's canonical order, `<prompt>` block) and
// `<datum>` (case-selection datum referencing the search-side detail
// ids). The orchestrator at `remoteRequest.ts` splices the result
// into the `<remote-request>` body.

import render from "dom-serializer";
import type { Element } from "domhandler";
import { el, RENDER_OPTS } from "@/lib/commcare/elementBuilders";
import type { CaseListConfig, CaseSearchConfig } from "@/lib/domain";
import { emitOnDeviceExpression } from "../../expression/onDeviceEmitter";
import { validateCaseType } from "../../identifierValidation";
import {
	collectExpressionInstances,
	collectPredicateInstances,
} from "../../predicate";
import { buildSearchPrompts, getAdvancedArmPredicates } from "./searchPrompts";
import {
	deriveSimpleArmPredicate,
	simpleArmNeedsXPathQueryEmission,
} from "./simpleArmDerivation";
import type { WireShape } from "./types";
import { composeXPathQueryEmission } from "./xpathQuery";

/**
 * The CCHQ `app_aware_remote_search` endpoint URL with `__DOMAIN__`
 * / `__APP_ID__` placeholders. CCHQ's `Application.create_suite`
 * substitutes both at build time; the literal placeholders never
 * reach a runtime (same path as `CLAIM_URL_TEMPLATE`).
 */
const SEARCH_URL_TEMPLATE =
	"https://www.commcarehq.org/a/__DOMAIN__/phone/search/__APP_ID__/";

/**
 * CCHQ wire-key for the excluded-owners filter, lifted verbatim
 * from `CASE_SEARCH_BLACKLISTED_OWNER_ID_KEY`. Nova's authoring
 * vocabulary calls the slot `excludedOwnerIds`; this constant is
 * the wire-side translation, applied at the emission site below.
 */
const EXCLUDED_OWNER_IDS_WIRE_KEY = "commcare_blacklisted_owner_ids";

/**
 * CCHQ wire-key for the AND-composed CSQL query string, lifted
 * from `CASE_SEARCH_XPATH_QUERY_KEY`. Centralized so a CCHQ-
 * upstream key change is one edit.
 */
const XPATH_QUERY_KEY = "_xpath_query";

/**
 * Composed `<session>` emission.
 *
 *   - `xml` — the indented `<session>` block at 4-space outer indent.
 *   - `strings` — locale entries for the `<title>` and per-prompt
 *     labels, threaded into the per-language string tables.
 *   - `instances` — the instance ids the body references (`casedb` +
 *     `commcaresession` + the chosen `results` / `results:inline`).
 *     The orchestrator turns this set into `<instance>` declarations.
 */
export interface SearchSessionEmission {
	readonly element: Element;
	readonly strings: Record<string, string>;
	readonly instances: ReadonlySet<string>;
}

/**
 * Build the `<session>` Element. `wire` flows from `compileForPlatform`:
 * `inlineSearch` picks the storage-instance id (`results:inline` vs
 * `results`); `defaultSearch` lands on `<query default_search>`.
 * `autoLaunch` flows past — the case-list short-detail emitter
 * consumes it for `<action auto_launch>` on `m{N}_case_short`.
 */
export function buildSearchSession(args: {
	readonly caseListConfig: CaseListConfig;
	readonly caseSearchConfig: CaseSearchConfig;
	readonly wire: WireShape;
	readonly caseType: string;
	readonly moduleIndex: number;
}): SearchSessionEmission {
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

	// `results:inline` signals embedded results (Android, inline-with-
	// parent-relationship); `results` is the standalone post-and-query
	// roundtrip.
	const storageInstance = wire.inlineSearch ? "results:inline" : "results";

	// `<data>` slot order matches CCHQ's canonical order at
	// `commcare-hq/.../suite_xml/post_process/remote_requests.py::_remote_request_query_datums`:
	// `case_type` first, then every `default_properties[]` entry
	// (where `_xpath_query` lives on CCHQ's side), then
	// `commcare_blacklisted_owner_ids`. Order is runtime-irrelevant —
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
	dataElements.push(el("data", { key: "case_type", ref: `'${caseType}'` }));

	// `_xpath_query` — AND-composition of the unified filter with
	// every advanced-arm search input's predicate plus every
	// simple-arm input routed through the wire (per the
	// simple-arm-with-via or `name !== property` shapes). CCHQ
	// accepts at most one `_xpath_query` per `<query>`; the
	// AST-level `and(...)` reduces to one Predicate before the CSQL
	// emitter walks it. Non-grammar value expressions inline as
	// on-device XPath fragments inside the wrapper concat — CCHQ's
	// `RemoteQuerySessionManager.initUserAnswers` only seeds the
	// `search-input:results` instance from `<prompt>` defaults, so a
	// sibling `<data>` slot's value would resolve to the empty string
	// at evaluation time AND silently add a server-side property
	// filter against case data that matches no cases. The single
	// `_xpath_query` slot carries everything.
	const xpathQueryEmission = composeXPathQueryEmission(
		caseListConfig,
		caseType,
	);
	if (xpathQueryEmission !== undefined) {
		dataElements.push(
			el("data", {
				key: XPATH_QUERY_KEY,
				ref: xpathQueryEmission.wrapper,
			}),
		);
	}

	// Authoring → wire vocabulary translation. Schema slot reads
	// `excludedOwnerIds`; CCHQ wire slot reads `commcare_blacklisted_owner_ids`.
	// CCHQ scopes this on `<query>`, not `<post>` — the post fires
	// after case selection, by which point the filter has already
	// gated the visible result set.
	if (caseSearchConfig.excludedOwnerIds !== undefined) {
		dataElements.push(
			el("data", {
				key: EXCLUDED_OWNER_IDS_WIRE_KEY,
				ref: emitOnDeviceExpression(caseSearchConfig.excludedOwnerIds),
			}),
		);
	}

	const promptEmission = buildSearchPrompts(
		caseListConfig.searchInputs,
		moduleId,
	);

	// Title locale id pattern is CCHQ's `case_search.{m}.inputs`. The
	// fallback case-type display reads cleanly at runtime — when no
	// override is registered, the runtime renders the locale value
	// rather than the raw locale id.
	const titleLocaleId = `case_search.${moduleId}.inputs`;
	// The schema's `searchScreenTitle: z.string().min(1).optional()`
	// guarantees the slot is either `undefined` or a non-empty string,
	// so `undefined` is the sole "no override" sentinel. The case-type
	// fallback mirrors the HQ-JSON projection's symmetric fallback at
	// `lib/commcare/hqJson/caseList.ts::buildSearchConfigDocument` so
	// the same authored input lands the same locale string regardless
	// of which path (local suite XML vs CCHQ-regenerated suite) the
	// runtime sees.
	const titleDisplay = caseSearchConfig.searchScreenTitle ?? caseType;

	// Description (subtitle) is conditional — CCHQ's `<query>` carries
	// `<description>` only when the author supplied copy. The locale id
	// pattern is CCHQ's `case_search.{m}.description`; an absent
	// subtitle elides the element entirely so the runtime renders the
	// screen without a subtitle slot rather than printing a blank
	// locale fallback. Element ordering inside `<query>` is
	// title → description → data → prompts, matching CCHQ's
	// `RemoteRequestQuery` factory.
	const subtitleDisplay = caseSearchConfig.searchScreenSubtitle;
	const descriptionLocaleId = `case_search.${moduleId}.description`;

	// `<query>` children in canonical order: title → description? →
	// data → prompts. The serializer preserves child insertion order.
	const queryChildren: Element[] = [
		el("title", {}, [el("text", {}, [el("locale", { id: titleLocaleId })])]),
	];
	if (subtitleDisplay !== undefined) {
		queryChildren.push(
			el("description", {}, [
				el("text", {}, [el("locale", { id: descriptionLocaleId })]),
			]),
		);
	}
	queryChildren.push(...dataElements, ...promptEmission.elements);

	// `<query>` attribute insertion order — `url, default_search,
	// storage-instance, template` — matches CCHQ's canonical order
	// on `RemoteRequestQuery` so the rendered bytes stay diffable
	// against the CCHQ-regenerated suite.
	const queryEl = el(
		"query",
		{
			url: SEARCH_URL_TEMPLATE,
			default_search: wire.defaultSearch ? "true" : "false",
			"storage-instance": storageInstance,
			template: "case",
		},
		queryChildren,
	);

	// `<datum>` references the search-side detail ids
	// (`m{N}_search_short` / `m{N}_search_long`) — distinct from the
	// `m{N}_case_short` / `m{N}_case_long` ids the local case-list
	// entry uses.
	const datumNodeset = composeDatumNodeset(storageInstance, caseType);
	const datumEl = el("datum", {
		id: "search_case_id",
		nodeset: datumNodeset,
		value: "./@case_id",
		"detail-confirm": `${moduleId}_search_long`,
		"detail-select": `${moduleId}_search_short`,
	});

	const sessionEl = el("session", {}, [queryEl, datumEl]);

	const strings: Record<string, string> = {
		[titleLocaleId]: titleDisplay,
		...(subtitleDisplay !== undefined
			? { [descriptionLocaleId]: subtitleDisplay }
			: {}),
		...promptEmission.strings,
	};

	// `casedb` and `commcaresession` are always required (the `<post
	// relevant>` guard references both); the chosen results instance
	// is what the `<datum nodeset>` references.
	const instances = new Set<string>([
		"casedb",
		"commcaresession",
		storageInstance,
	]);

	// Every Term ref reachable from a wire-emitted XPath needs its
	// instance declared on the surrounding `<remote-request>`.
	// `casedb` and `commcaresession` are always present (above);
	// `search-input:results` appears whenever a filter / advanced-arm
	// predicate / excluded-owner expression / simple-arm-with-via
	// derived predicate / per-prompt default expression references an
	// `input(...)` Term, which CCHQ resolves through
	// `instance('search-input:results')/input/field[@name='…']`.
	// Without the accumulation, the wire would carry an
	// instance-reference XPath the runtime can't resolve — the same
	// gap CCHQ's `InstancesHelper.add_entry_instances` plugs on the
	// server-regenerated suite path. Every surface that contributes
	// XPath to the `<remote-request>` body walks here; missing one
	// surfaces as a wire that ships valid XML but raises
	// `XPathException` at search-execution time.
	if (caseListConfig.filter !== undefined) {
		for (const id of collectPredicateInstances(caseListConfig.filter)) {
			instances.add(id);
		}
	}
	for (const entry of getAdvancedArmPredicates(caseListConfig.searchInputs)) {
		for (const id of collectPredicateInstances(entry.predicate)) {
			instances.add(id);
		}
	}
	for (const input of caseListConfig.searchInputs) {
		// Simple-arm inputs whose `via` walks a relation route through
		// the `_xpath_query` AND-composition via
		// `deriveSimpleArmPredicate`. The derived predicate references
		// `instance('search-input:results')` for the user's typed value;
		// the instance accumulator must walk it the same way the
		// advanced-arm predicates above are walked.
		if (input.kind === "simple" && simpleArmNeedsXPathQueryEmission(input)) {
			const derived = deriveSimpleArmPredicate(input, caseType);
			for (const id of collectPredicateInstances(derived)) {
				instances.add(id);
			}
		}
		// `input.default` lowers via `emitOnDeviceExpression` into the
		// `<prompt default="…">` attribute. A default that references
		// another input or a session term needs the matching instance
		// declared on `<remote-request>`.
		if (input.default !== undefined) {
			for (const id of collectExpressionInstances(input.default)) {
				instances.add(id);
			}
		}
	}
	if (caseSearchConfig.excludedOwnerIds !== undefined) {
		for (const id of collectExpressionInstances(
			caseSearchConfig.excludedOwnerIds,
		)) {
			instances.add(id);
		}
	}
	// Calc-column expressions land on `m{N}_search_short` /
	// `m{N}_search_long` (the search-target details). CCHQ resolves
	// each detail's XPath against the enclosing element's instance
	// declarations — for the search-target details that's this
	// `<remote-request>`. Walk every calc-arm column expression so the
	// local `.ccz` carries the same declarations CCHQ's
	// server-regenerated suite gets via
	// `commcare-hq/.../suite_xml/post_process/instances.py::InstancesHelper.add_entry_instances`.
	for (const column of caseListConfig.columns) {
		if (column.kind !== "calculated") continue;
		for (const id of collectExpressionInstances(column.expression)) {
			instances.add(id);
		}
	}

	return { element: sessionEl, strings, instances };
}

/**
 * String adapter — serializes `buildSearchSession`'s Element for
 * callers that assert against the rendered XML string (the test
 * surface). The `<remote-request>` orchestrator
 * (`remoteRequest.ts::buildRemoteRequest`) consumes the Element
 * directly.
 */
export function emitSearchSession(args: {
	readonly caseListConfig: CaseListConfig;
	readonly caseSearchConfig: CaseSearchConfig;
	readonly wire: WireShape;
	readonly caseType: string;
	readonly moduleIndex: number;
}): {
	readonly xml: string;
	readonly strings: Record<string, string>;
	readonly instances: ReadonlySet<string>;
} {
	const { element, strings, instances } = buildSearchSession(args);
	return { xml: render(element, RENDER_OPTS), strings, instances };
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
	storageInstance: string,
	caseType: string,
): string {
	// CCHQ pins the path segment to `/results/case` regardless of
	// instance id — the instance discriminator is the colon suffix
	// on the instance reference, not the path that follows.
	return `instance('${storageInstance}')/results/case[@case_type='${caseType}'][not(commcare_is_related_case=true())]`;
}
