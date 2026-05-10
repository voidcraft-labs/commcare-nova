// lib/commcare/suite/case-search/searchSession.ts
//
// Suite-XML emission for the `<session>` body of a `<remote-request>`.
// `<session>` wraps two child element families:
//
//   - `<query>` — the search-execution config CCHQ's runtime fires
//     when the user submits the search form (or, with `default_search`
//     enabled, on screen entry). Carries:
//       * The CCHQ-side search endpoint URL (with `__APP_ID__` /
//         `__DOMAIN__` placeholders — see `claim.ts` for the
//         placeholder rationale).
//       * Three required attributes: `default_search`,
//         `storage-instance`, `template`.
//       * A `<title>` referencing the
//         `case_search.{module_id}.inputs` locale.
//       * A `<data>` slot list in CCHQ's canonical order:
//         `case_type` → excluded-owners (when set) → hoist wrappers →
//         `_xpath_query` (when present and non-trivial). Order
//         verified against
//         `commcare-hq/corehq/apps/app_manager/suite_xml/post_process/remote_requests.py::RemoteRequestFactory._remote_request_query_datums`.
//       * The `<prompt>` block from `searchPrompts.ts`.
//
//   - `<datum>` — the case-selection datum. Carries the search-side
//     storage-instance reference (`results` / `results:inline`) and
//     the two detail ids (`detail-confirm` / `detail-select`)
//     pointing at `m{N}_search_long` / `m{N}_search_short`.
//
// Verified against
// `commcare-hq/corehq/apps/app_manager/tests/data/suite/remote_request.xml`'s
// `<remote-request>/<session>` body and
// `commcare-hq/corehq/apps/app_manager/tests/data/suite/search_config_blacklisted_owners.xml`'s
// `<remote-request>/<session>` body.

import type { CaseListConfig, CaseSearchConfig } from "@/lib/domain";
import { and } from "@/lib/domain/predicate";
import type { Predicate } from "@/lib/domain/predicate/types";
import { emitOnDeviceExpression } from "../../expression/onDeviceEmitter";
import { emitCsql } from "../../predicate";
import { escapeXml } from "../../xml";
import { emitSearchPrompts, getAdvancedArmPredicates } from "./searchPrompts";
import type { WireShape } from "./types";

/**
 * The CCHQ-side `app_aware_remote_search` endpoint URL template.
 * Same placeholder rationale as `CLAIM_URL_TEMPLATE` in `claim.ts`.
 * CCHQ rebuilds suite.xml at BUILD time via
 * `commcare-hq/corehq/apps/app_manager/models.py::Application.create_suite`
 * (which delegates to `SuiteGenerator.generate_suite`);
 * `RemoteRequestFactory.build_remote_request_queries` substitutes
 * both the live domain and the live app id through
 * `absolute_reverse('app_aware_remote_search', args=[self.app.domain, self.app._id])`.
 * The literal placeholders never reach a runtime — direct .ccz
 * sideload is not a current path.
 */
const SEARCH_URL_TEMPLATE =
	"https://www.commcarehq.org/a/__DOMAIN__/phone/search/__APP_ID__/";

/**
 * CCHQ wire-key for the excluded-owners filter. The literal token
 * is CCHQ-controlled vocabulary lifted verbatim from
 * `commcare-hq/corehq/apps/case_search/models.py::CASE_SEARCH_BLACKLISTED_OWNER_ID_KEY`.
 * Nova's authoring vocabulary calls the slot `excludedOwnerIds`;
 * the suite-XML emission below carries the CCHQ wire token. The
 * site at the `dataLines.push(...)` call is the explicit
 * translation point.
 */
const EXCLUDED_OWNER_IDS_WIRE_KEY = "commcare_blacklisted_owner_ids";

/**
 * CCHQ wire-key for the AND-composed CSQL query string. Lifted
 * verbatim from
 * `commcare-hq/corehq/apps/case_search/models.py::CASE_SEARCH_XPATH_QUERY_KEY`.
 * Centralising the constant here keeps the orchestrator's emission
 * sites a single source for the key string and surfaces a CCHQ-
 * upstream key change as one edit.
 */
const XPATH_QUERY_KEY = "_xpath_query";

/**
 * Pure return shape for the orchestrator. Three pieces flow out:
 *
 *   - `xml` — the indented `<session>` block (4-space outer indent
 *     matching the surrounding `<remote-request>`).
 *   - `strings` — the `app_strings.txt` entries the orchestrator
 *     threads into the surrounding compiler. The `<title>`'s
 *     locale (`case_search.{module_id}.inputs`) registers here so
 *     the runtime renders the authored search-screen title; per-
 *     prompt locale ids accumulate from `emitSearchPrompts`.
 *   - `instances` — the per-fixture instance ids the orchestrator
 *     accumulates from term-walking AST contributions. The base
 *     instance set (`casedb`, `commcaresession`, results-instance)
 *     surfaces structurally on every emission; this list flows
 *     through the orchestrator so future term-walks (e.g.
 *     non-casedb fixture references in `_xpath_query`) accumulate
 *     uniformly.
 */
export interface SearchSessionEmission {
	readonly xml: string;
	readonly strings: Record<string, string>;
	readonly instances: ReadonlySet<string>;
}

/**
 * Compose the `<session>` block for a `<remote-request>`.
 *
 * `caseListConfig` and `caseSearchConfig` carry the authored
 * content: the unified filter (`caseListConfig.filter`), the search
 * inputs (`caseListConfig.searchInputs`), and the niche advanced
 * filters on the search config (`caseSearchConfig.excludedOwnerIds`).
 *
 * `wire` carries the `WireShape` flags from
 * `compileForPlatform`. `inlineSearch` selects the storage-instance
 * id (`results:inline` when inline, `results` otherwise) and the
 * `<datum nodeset>` instance reference; `defaultSearch` lands on
 * the `<query default_search>` attribute. `autoLaunch` is consumed
 * by the case-list short-detail emitter (the `<action auto_launch>`
 * attribute lives on `m{N}_case_short`, not on `<query>`) and
 * passes through this layer untouched.
 *
 * `caseType` is the module's case type — referenced on the
 * `<data key="case_type">` slot and on the `<datum nodeset>`'s
 * `[@case_type='...']` filter. `moduleIndex` composes the surrounding
 * `m{N}` prefix on the `<title>` locale id and the `<datum>`'s two
 * detail-id references.
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

	// Storage-instance + datum-nodeset instance derive from the
	// `inlineSearch` flag. CCHQ's runtime uses `results:inline` to
	// signal that the search results are embedded in the surrounding
	// session (Android + the inline-search-with-parent-relationship
	// shape) and `results` for the standalone post-and-query roundtrip.
	const storageInstance = wire.inlineSearch ? "results:inline" : "results";

	// Compose the `<data>` slots in CCHQ's canonical order.
	// Verified against
	// `commcare-hq/corehq/apps/app_manager/suite_xml/post_process/remote_requests.py::RemoteRequestFactory._remote_request_query_datums`:
	// `case_type` first, then optional CCHQ-specific keys
	// (excluded-owners, registry, custom-related-case property, sort
	// properties), then any `_xpath_query` slot last.
	const dataLines: string[] = [];

	// 1. `case_type` — required, always present.
	dataLines.push(
		`        <data key="case_type" ref="'${escapeXml(caseType)}'"/>`,
	);

	// 2. `commcare_blacklisted_owner_ids` — emitted only when the
	// author has set the slot. CCHQ's wire-side key is the literal
	// CCHQ-controlled vocabulary; Nova's authoring vocabulary is
	// `excludedOwnerIds`. This site is the translation boundary:
	// the schema field reads `excludedOwnerIds`; the wire field
	// reads `commcare_blacklisted_owner_ids` per
	// `commcare-hq/corehq/apps/case_search/models.py::CASE_SEARCH_BLACKLISTED_OWNER_ID_KEY`.
	// The `ref` carries the on-device XPath expression that resolves
	// at runtime to a space-separated list of owner ids whose cases
	// are excluded from the result set. CCHQ scopes the slot on
	// `<query>` (NOT `<post>`) per `_remote_request_query_datums`
	// and the canonical fixture
	// `commcare-hq/corehq/apps/app_manager/tests/data/suite/search_config_blacklisted_owners.xml`.
	if (caseSearchConfig.excludedOwnerIds !== undefined) {
		const excludedRef = emitOnDeviceExpression(
			caseSearchConfig.excludedOwnerIds,
		);
		dataLines.push(
			`        <data key="${EXCLUDED_OWNER_IDS_WIRE_KEY}" ref="${escapeXml(excludedRef)}"/>`,
		);
	}

	// 3. `_xpath_query` — the AND-composition of the unified filter
	// and every advanced-arm search input's predicate. CCHQ accepts
	// at most one `_xpath_query` element per `<query>`; multiple
	// authored predicates compose via AST-level `and(...)` before
	// the CSQL emitter walks the result.
	//
	// Each lifted wrapper from `emitCsql` (the on-device-only AST
	// shapes the CSQL grammar can't host inline) emits as its own
	// `<data key="<inputRef>" ref="<on-device-XPath>">` slot before
	// the `_xpath_query` element so the wrapper inputs resolve
	// before CCHQ evaluates the CSQL fragment.
	const xpathQueryEmission = composeXPathQueryEmission(caseListConfig);
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

	// `<prompt>` block from `searchPrompts.ts`. Empty inputs
	// produce an empty XML string, which the surrounding `<query>`
	// composer threads in unchanged — CCHQ accepts a zero-prompt
	// `<query>` cleanly when no inputs are authored.
	const promptEmission = emitSearchPrompts(
		caseListConfig.searchInputs,
		moduleId,
	);

	// Compose the `<title>` locale id per CCHQ's
	// `commcare-hq/corehq/apps/app_manager/id_strings.py::case_search_title_translation`:
	// `case_search.{module_id}.inputs`. Display string defaults to
	// the authored screen title when set, otherwise the case type
	// name as a sensible UX fallback (the runtime renders the
	// locale value rather than the raw locale id when no override
	// is registered upstream).
	const titleLocaleId = `case_search.${moduleId}.inputs`;
	const titleDisplay =
		caseSearchConfig.searchScreenTitle !== undefined &&
		caseSearchConfig.searchScreenTitle !== ""
			? caseSearchConfig.searchScreenTitle
			: caseType;

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
		...dataLines,
	];
	if (promptEmission.xml !== "") {
		queryBody.push(promptEmission.xml);
	}
	queryBody.push(`      </query>`);

	// `<datum>` element — the case-selection datum. References the
	// search-side detail ids (`m{N}_search_short` / `m{N}_search_long`,
	// distinct from the case-list `m{N}_case_short` /
	// `m{N}_case_long` ids the local case-list entry references).
	// The nodeset's instance ref is the same `storageInstance`
	// string the `<query>` carries; the inner `[not(commcare_is_related_case=true())]`
	// filter is CCHQ's `EXCLUDE_RELATED_CASES_FILTER` constant from
	// `commcare-hq/corehq/apps/case_search/const.py`, lifted verbatim.
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

	// Accumulate the locale-id → display-string entries the
	// surrounding compiler threads into `app_strings.txt`. The
	// `<title>` entry registers under the canonical `case_search.{m}.inputs`
	// locale; per-prompt entries from `emitSearchPrompts` accumulate
	// here too.
	const strings: Record<string, string> = {
		[titleLocaleId]: titleDisplay,
		...promptEmission.strings,
	};

	// Instance accumulation: the structural set every `<remote-request>`
	// requires — `casedb` (referenced on the `<post relevant>` guard),
	// `commcaresession` (referenced on the same guard's session-data
	// XPath), and the chosen `results` / `results:inline` instance
	// the `<datum nodeset>` references. The orchestrator writes the
	// `<instance>` declarations against this set.
	const instances = new Set<string>([
		"casedb",
		"commcaresession",
		storageInstance,
	]);

	return { xml, strings, instances };
}

/**
 * Compose the `<datum nodeset>` value. Two slots vary across
 * emissions: the storage-instance id and the case-type filter.
 * The `[not(commcare_is_related_case=true())]` filter is CCHQ's
 * canonical exclusion (the result set must not include cases
 * indexed as related-only artifacts of an existing search) lifted
 * verbatim from
 * `commcare-hq/corehq/apps/case_search/const.py::EXCLUDE_RELATED_CASES_FILTER`.
 */
function composeDatumNodeset(
	storageInstance: string,
	caseType: string,
): string {
	// CCHQ pins the path-segment-after-slash to `/results/case`
	// regardless of the instance id — the instance discriminator
	// (`results` vs `results:inline`) is the colon-suffix on the
	// instance reference, not the path segment that follows.
	return `instance('${storageInstance}')/results/case[@case_type='${escapeXml(caseType)}'][not(commcare_is_related_case=true())]`;
}

/**
 * Compose the `_xpath_query` data slot's wire form. AND-composes
 * the unified filter (`caseListConfig.filter`) with every advanced-
 * arm search input's predicate, runs the result through the CSQL
 * emitter, and returns either the full emission (for the
 * orchestrator to splice in) or `undefined` when the composed
 * result is `match-all` (the no-op identity — CCHQ accepts the
 * `_xpath_query` absence cleanly when there is no authored
 * predicate).
 *
 * Two arms collapse trivial input to the `match-all` no-op:
 * multi-clause inputs flow through `and(...)`'s reducer (which
 * folds authored `match-all` clauses on the way through); the
 * single-clause arm short-circuits the reducer and falls through
 * to the explicit `composed.kind === "match-all"` check below. A
 * length-zero clause list is rejected at the top of the function;
 * length-one preserves the clause; length-N runs the reducer.
 */
function composeXPathQueryEmission(
	caseListConfig: CaseListConfig,
):
	| { wrapper: string; hoists: ReturnType<typeof emitCsql>["hoists"] }
	| undefined {
	const clauses: Predicate[] = [];
	if (caseListConfig.filter !== undefined) {
		clauses.push(caseListConfig.filter);
	}
	const advancedPredicates = getAdvancedArmPredicates(
		caseListConfig.searchInputs,
	);
	for (const entry of advancedPredicates) {
		clauses.push(entry.predicate);
	}
	if (clauses.length === 0) {
		return undefined;
	}

	// `and(...)` overload set: zero clauses → match-all (handled
	// above by the length check), one clause → the clause itself,
	// 2+ clauses → the standard `and` envelope. The reducer
	// collapses authored `match-all` clauses on the way through.
	const composed =
		clauses.length === 1
			? clauses[0]
			: and(clauses[0], clauses[1], ...clauses.slice(2));

	if (composed.kind === "match-all") {
		return undefined;
	}

	const emission = emitCsql(composed);
	return { wrapper: emission.wrapper, hoists: emission.hoists };
}
