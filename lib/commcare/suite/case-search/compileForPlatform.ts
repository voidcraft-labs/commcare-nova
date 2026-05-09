// lib/commcare/suite/case-search/compileForPlatform.ts
//
// Pure decision tree from authored content + platform context to a
// `WireShape` flag set. The export adapter calls this once per
// module-export per platform; the resulting flags drive the
// `<remote-request>` orchestrator (`<query>` attributes, `<datum>`
// nodeset instance reference) and the case-list short-detail
// emitter (the `<action auto_launch>` attribute inside
// `m{N}_case_short`).
//
// The principle Nova locks here: the author configures one
// coherent surface (filter + columns + search inputs); the
// compiler picks the closest CCHQ-supported emission per platform.
// There is no per-platform UI affordance, no mode picker, no
// author override. The three `WireShape` flags fall out of
// inference over the `(content, platform)` pair — same pair, same
// flags.
//
// CCHQ's wire-side semantics the three flags map to:
//
//   - `autoLaunch` lands on the `<action auto_launch>` attribute
//     inside the case-list short detail (per
//     `commcare-hq/corehq/apps/app_manager/suite_xml/sections/details.py::DetailContributor._get_auto_launch_expression`).
//     The wire form is an XPath expression — `false()` when off;
//     `AUTO_LAUNCH_EXPRESSIONS["single-select"|"multi-select"]`
//     when on.
//   - `defaultSearch` lands on the `<query default_search>`
//     attribute inside `<remote-request>/<session>` (per
//     `commcare-hq/corehq/apps/app_manager/suite_xml/post_process/remote_requests.py::RemoteRequestFactory.build_remote_request_queries`).
//   - `inlineSearch` selects the storage-instance identifier the
//     search-side `<datum nodeset>` references:
//     `instance('results')` (standalone) vs `instance('results:inline')`
//     (inline). Wire consumers also emit the `<query inline_search>`
//     attribute from this same flag.

import type { CaseListConfig, CaseSearchConfig } from "@/lib/domain";
import type { PlatformContext, WireShape } from "./types";

/**
 * Compile the authored case-list + case-search configuration to a
 * `WireShape` flag set for the given platform context. The
 * function is total — every input combination produces a valid
 * `WireShape`; no throws.
 *
 * Branch order:
 *
 *   1. **Android** — always list-first. Android's runtime player
 *      shows the case list first regardless of any wire flag, so
 *      the compiler emits `inlineSearch: true` (the inline post-
 *      and-query embedding is the Android-compatible shape) and
 *      every other flag false.
 *   2. **Web, filter set, zero search inputs** — skip-to-results.
 *      Author intent is unambiguous: the filter narrows the case
 *      list, and there is nothing for the user to type. The
 *      runtime executes the search immediately on screen entry,
 *      surfacing the filtered results without an intermediate
 *      input form.
 *   3. **Web fallback** — list-first. The default web shape
 *      whenever skip-to-results doesn't apply. Forcing a user to
 *      fill a search form before they see whether they have any
 *      local cases at all is a worse UX than letting them see
 *      the list first; if they need to search, they hit the
 *      search button.
 *
 * `caseSearchConfig` is part of the uniform call shape but does
 * not feed the three flags — every flag derives from
 * `caseListConfig.filter` / `caseListConfig.searchInputs` and the
 * platform context.
 */
export function compileForPlatform(
	caseListConfig: CaseListConfig,
	_caseSearchConfig: CaseSearchConfig,
	ctx: PlatformContext,
): WireShape {
	// Branch 1 — Android always emits the list-first / inline shape
	// regardless of authored content. The Android runtime player
	// ignores `auto_launch` / `default_search` semantics and shows
	// the case list first; the inline storage-instance reference
	// is the Android-compatible wire shape.
	if (ctx.platform === "android") {
		return {
			autoLaunch: false,
			defaultSearch: false,
			inlineSearch: true,
		};
	}

	// Branch 2 — Web, skip-to-results. Pick between skip-to-results
	// and the list-first fallback by examining the authored content.
	//
	// Skip-to-results triggers when the author has configured an
	// effective filter AND zero search inputs — the filter narrows
	// the case list and the user has nothing to type, so the
	// natural UX is to show the filtered results immediately.
	//
	// `match-all` is the boolean-algebra identity element of
	// conjunction; a `match-all` filter is structurally a no-op
	// (CCHQ's wire emission is `true()`, which leaves the match
	// set unchanged). The compiler treats it as an absent filter
	// for branch-selection purposes — match-all + zero inputs
	// would otherwise erroneously trip skip-to-results when the
	// author has not authored an effective narrowing predicate.
	const filterEffective =
		caseListConfig.filter !== undefined &&
		caseListConfig.filter.kind !== "match-all";
	const noSearchInputs = caseListConfig.searchInputs.length === 0;
	if (filterEffective && noSearchInputs) {
		return {
			autoLaunch: true,
			defaultSearch: true,
			inlineSearch: false,
		};
	}

	// Branch 3 — Web fallback. List-first. The wire layer surfaces
	// no auto-launch / default-search behavior; the user sees the
	// case list and reaches search via the explicit search action.
	return {
		autoLaunch: false,
		defaultSearch: false,
		inlineSearch: false,
	};
}
