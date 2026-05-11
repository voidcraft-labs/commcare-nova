// lib/commcare/suite/case-search/searchSession.ts
//
// `<session>` body of a `<remote-request>`. Wraps `<query>` (search-
// execution config — endpoint URL, required attributes, `<title>`,
// `<data>` slots in CCHQ's canonical order, `<prompt>` block) and
// `<datum>` (case-selection datum referencing the search-side detail
// ids). The orchestrator at `remoteRequest.ts` splices the result
// into the `<remote-request>` body.

import type { CaseListConfig, CaseSearchConfig } from "@/lib/domain";
import { emitOnDeviceExpression } from "../../expression/onDeviceEmitter";
import {
	collectExpressionInstances,
	collectPredicateInstances,
} from "../../predicate";
import { escapeXml } from "../../xml";
import { emitSearchPrompts, getAdvancedArmPredicates } from "./searchPrompts";
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
	readonly xml: string;
	readonly strings: Record<string, string>;
	readonly instances: ReadonlySet<string>;
}

/**
 * Compose the `<session>` block. `wire` flows from `compileForPlatform`:
 * `inlineSearch` picks the storage-instance id (`results:inline` vs
 * `results`); `defaultSearch` lands on `<query default_search>`.
 * `autoLaunch` flows past — the case-list short-detail emitter
 * consumes it for `<action auto_launch>` on `m{N}_case_short`.
 */
export function emitSearchSession(args: {
	readonly caseListConfig: CaseListConfig;
	readonly caseSearchConfig: CaseSearchConfig;
	readonly wire: WireShape;
	readonly caseType: string;
	readonly moduleIndex: number;
}): SearchSessionEmission {
	const { caseListConfig, caseSearchConfig, wire, caseType, moduleIndex } =
		args;
	const moduleId = `m${moduleIndex}`;

	// `results:inline` signals embedded results (Android, inline-with-
	// parent-relationship); `results` is the standalone post-and-query
	// roundtrip.
	const storageInstance = wire.inlineSearch ? "results:inline" : "results";

	// `<data>` slot order is CCHQ-canonical (per
	// `RemoteRequestFactory._remote_request_query_datums`): `case_type`
	// first, then any optional CCHQ-specific keys, `_xpath_query` last.
	const dataLines: string[] = [];

	// `case_type` — always present.
	dataLines.push(
		`        <data key="case_type" ref="'${escapeXml(caseType)}'"/>`,
	);

	// Authoring → wire vocabulary translation. Schema slot reads
	// `excludedOwnerIds`; CCHQ wire slot reads `commcare_blacklisted_owner_ids`.
	// CCHQ scopes this on `<query>`, not `<post>` — the post fires
	// after case selection, by which point the filter has already
	// gated the visible result set.
	if (caseSearchConfig.excludedOwnerIds !== undefined) {
		const excludedRef = emitOnDeviceExpression(
			caseSearchConfig.excludedOwnerIds,
		);
		dataLines.push(
			`        <data key="${EXCLUDED_OWNER_IDS_WIRE_KEY}" ref="${escapeXml(excludedRef)}"/>`,
		);
	}

	// `_xpath_query` — AND-composition of the unified filter with
	// every advanced-arm search input's predicate. CCHQ accepts at
	// most one `_xpath_query` per `<query>`; the AST-level `and(...)`
	// reduces to one Predicate before the CSQL emitter walks it.
	//
	// `emitCsql`'s hoists lift on-device-only AST shapes the CSQL
	// grammar can't host inline; each emits as its own `<data>` slot
	// BEFORE the `_xpath_query` so its inputs resolve first at runtime.
	const xpathQueryEmission = composeXPathQueryEmission(
		caseListConfig,
		caseType,
	);
	if (xpathQueryEmission !== undefined) {
		for (const hoist of xpathQueryEmission.hoists) {
			const hoistRef = emitOnDeviceExpression(hoist.expression);
			dataLines.push(
				`        <data key="${escapeXml(hoist.inputRef)}" ref="${escapeXml(hoistRef)}"/>`,
			);
		}
		dataLines.push(
			`        <data key="${XPATH_QUERY_KEY}" ref="${escapeXml(xpathQueryEmission.wrapper)}"/>`,
		);
	}

	const promptEmission = emitSearchPrompts(
		caseListConfig.searchInputs,
		moduleId,
	);

	// Title locale id pattern is CCHQ's `case_search.{m}.inputs`. The
	// fallback case-type display reads cleanly at runtime — when no
	// override is registered, the runtime renders the locale value
	// rather than the raw locale id.
	const titleLocaleId = `case_search.${moduleId}.inputs`;
	const titleDisplay =
		caseSearchConfig.searchScreenTitle !== undefined &&
		caseSearchConfig.searchScreenTitle !== ""
			? caseSearchConfig.searchScreenTitle
			: caseType;

	// Description (subtitle) is conditional — CCHQ's `<query>` carries
	// `<description>` only when the author supplied copy. The locale id
	// pattern is CCHQ's `case_search.{m}.description`; an unset or
	// empty-string subtitle elides the element entirely so the runtime
	// renders the screen without a subtitle slot rather than printing a
	// blank locale fallback. Element ordering inside `<query>` is
	// title → description → data → prompts, matching CCHQ's
	// `RemoteRequestQuery` factory.
	const subtitleDisplay =
		caseSearchConfig.searchScreenSubtitle !== undefined &&
		caseSearchConfig.searchScreenSubtitle !== ""
			? caseSearchConfig.searchScreenSubtitle
			: undefined;
	const descriptionLocaleId = `case_search.${moduleId}.description`;

	const queryBody: string[] = [
		`      <query url="${SEARCH_URL_TEMPLATE}"`,
		`             default_search="${wire.defaultSearch ? "true" : "false"}"`,
		`             storage-instance="${storageInstance}"`,
		`             template="case">`,
		`        <title>`,
		`          <text>`,
		`            <locale id="${titleLocaleId}"/>`,
		`          </text>`,
		`        </title>`,
	];
	if (subtitleDisplay !== undefined) {
		queryBody.push(
			`        <description>`,
			`          <text>`,
			`            <locale id="${descriptionLocaleId}"/>`,
			`          </text>`,
			`        </description>`,
		);
	}
	queryBody.push(...dataLines);
	if (promptEmission.xml !== "") {
		queryBody.push(promptEmission.xml);
	}
	queryBody.push(`      </query>`);

	// `<datum>` references the search-side detail ids
	// (`m{N}_search_short` / `m{N}_search_long`) — distinct from the
	// `m{N}_case_short` / `m{N}_case_long` ids the local case-list
	// entry uses.
	const datumNodeset = composeDatumNodeset(storageInstance, caseType);
	const datumLine = [
		`      <datum id="search_case_id"`,
		`             nodeset="${datumNodeset}"`,
		`             value="./@case_id"`,
		`             detail-confirm="${moduleId}_search_long"`,
		`             detail-select="${moduleId}_search_short"/>`,
	].join("\n");

	const xml = [
		`    <session>`,
		queryBody.join("\n"),
		datumLine,
		`    </session>`,
	].join("\n");

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
	// predicate / excluded-owner expression references an
	// `input(...)` Term, which CCHQ resolves through
	// `instance('search-input:results')/input/field[@name='…']`.
	// Without the accumulation, the wire would carry an
	// instance-reference XPath the runtime can't resolve — the same
	// gap CCHQ's `InstancesHelper.add_entry_instances` plugs on the
	// server-regenerated suite path.
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
	if (caseSearchConfig.excludedOwnerIds !== undefined) {
		for (const id of collectExpressionInstances(
			caseSearchConfig.excludedOwnerIds,
		)) {
			instances.add(id);
		}
	}

	return { xml, strings, instances };
}

/**
 * Compose the `<datum nodeset>` value. The
 * `[not(commcare_is_related_case=true())]` filter is CCHQ's
 * `EXCLUDE_RELATED_CASES_FILTER` (excludes cases indexed as related-
 * only artifacts of an existing search), lifted verbatim.
 */
function composeDatumNodeset(
	storageInstance: string,
	caseType: string,
): string {
	// CCHQ pins the path segment to `/results/case` regardless of
	// instance id — the instance discriminator is the colon suffix
	// on the instance reference, not the path that follows.
	return `instance('${storageInstance}')/results/case[@case_type='${escapeXml(caseType)}'][not(commcare_is_related_case=true())]`;
}
