// lib/commcare/suite/case-search/compileForPlatform.ts
//
// Pure decision tree from authored content + platform context to a
// `WireShape` flag set. Same pair in, same flags out — there is no
// per-platform UI affordance, no mode picker, no author override.
// The flags drive the `<remote-request>` orchestrator's `<query>`
// attributes and the case-list short-detail emitter's `<action
// auto_launch>` attribute (see `types.ts` for the per-flag wire
// landing).

import type { CaseListConfig, CaseSearchConfig } from "@/lib/domain";
import type { PlatformContext, WireShape } from "./types";

/**
 * Compile the authored configuration to a `WireShape` for the
 * given platform context. Total over the input domain — every
 * combination produces a valid `WireShape`, never throws.
 *
 * Three branches:
 *
 *   1. **Android** — always list-first. The Android runtime ignores
 *      `auto_launch` / `default_search` and shows the case list
 *      first regardless; `inlineSearch: true` is the Android-
 *      compatible wire shape.
 *   2. **Web, filter set, zero search inputs** — skip-to-results.
 *      The filter narrows the list and there is nothing to type, so
 *      run the search immediately on screen entry.
 *   3. **Web fallback** — list-first. Forcing a user to fill a
 *      search form before they see whether they have any local
 *      cases is worse UX than letting them see the list first.
 *
 * `caseSearchConfig` is part of the uniform call shape but doesn't
 * feed the flags — every flag derives from `caseListConfig.filter`,
 * `caseListConfig.searchInputs`, and the platform.
 */
export function compileForPlatform(
	caseListConfig: CaseListConfig,
	_caseSearchConfig: CaseSearchConfig,
	ctx: PlatformContext,
): WireShape {
	if (ctx.platform === "android") {
		// Android always shows the case list first regardless of any
		// search-side flag. CCHQ's `module_uses_inline_search` at
		// `commcare-hq/.../app_manager/util.py::module_uses_inline_search`
		// gates inline-search mode on BOTH `auto_launch=True` AND
		// `inline_search=True` — the `auto_launch=false, inline_search=true`
		// combination has no canonical CCHQ generator and reaches
		// undefined wire behavior. The list-first shape (all three
		// flags false) is structurally identical to CCHQ's standard
		// `<remote-request>` emission and matches the spec's "always
		// emits as a normal case-list module with inline list
		// filtering" rule for Android. The runtime ignores
		// `auto_launch` / `default_search` on Android anyway per
		// `_get_auto_launch_expression`'s `if not in_search` guard, so
		// the persisted value drives only the web-side rendering.
		return {
			autoLaunch: false,
			defaultSearch: false,
			inlineSearch: false,
		};
	}

	// `match-all` is the conjunction identity element — CCHQ's wire
	// emission is `true()`, which leaves the match set unchanged. A
	// `match-all` filter with zero inputs would otherwise trip skip-
	// to-results without an effective narrowing predicate.
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

	return {
		autoLaunch: false,
		defaultSearch: false,
		inlineSearch: false,
	};
}
