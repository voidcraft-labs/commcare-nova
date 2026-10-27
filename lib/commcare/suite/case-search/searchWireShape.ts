// lib/commcare/suite/case-search/searchWireShape.ts
//
// Pure decision tree from authored content to a `WireShape` flag set: one
// shape for every platform an app declares. Same content in, same flags out:
// there is no per-platform emission, no mode picker, no author override.
// The flags drive the `<remote-request>` orchestrator's `<query>` attributes
// and the case-list short-detail emitter's `<action auto_launch>` attribute
// (see `types.ts` for the per-flag wire landing). Android reads no
// `auto_launch` and opens the list first, which the platform table states
// (`lib/domain/platforms.ts`, `skip-to-results`).

import {
	type CaseListConfig,
	type OrdinaryCaseSearchConfig,
	visibleSearchInputs,
} from "@/lib/domain";
import { effectiveFilterForEmission } from "@/lib/domain/expression";
import type { WireShape } from "./types";

/**
 * Compile the authored configuration to a `WireShape`. Total over the input
 * domain: every combination produces a valid `WireShape`, never throws.
 *
 * Search first comes first; then two branches:
 *
 *   1. **Filter set, zero search inputs**: skip-to-results. The filter
 *      narrows the list and there is nothing to type, so run the search
 *      immediately on screen entry.
 *   2. **Otherwise**: list-first. Forcing a worker to fill a search form
 *      before they see whether they have any local cases is worse than
 *      letting them see the list first.
 */
export function searchWireShape(
	caseListConfig: CaseListConfig,
	caseSearchConfig: OrdinaryCaseSearchConfig,
): WireShape {
	// Search first is CommCare's inline shape: the query and the claim post
	// live inside each case-requiring entry, there is no `<remote-request>`
	// and no browse list to land on (`app_manager/util.py::module_uses_inline_search`
	// requires both `inline_search` and `auto_launch`). With nothing visible
	// to answer, the search runs on its own the moment the screen opens
	// (`default_search`); Core still seeds hidden defaults on that path.
	// Search first is unavailable on Android (`search-first`), so only an app
	// that runs in Web Apps only holds it.
	if (caseSearchConfig.searchFirst === true) {
		return {
			autoLaunch: true,
			defaultSearch:
				visibleSearchInputs(caseListConfig.searchInputs).length === 0,
			inlineSearch: true,
		};
	}

	// "Effective" = narrows something AFTER boolean-identity
	// normalization, so this decision agrees with what emission
	// actually produces. An absent filter, or one that reduces to
	// `match-all` (the top-level sentinel OR e.g. `and(match-all,
	// match-all)`), emits no query, so it must NOT trip skip-to-results.
	// `effectiveFilterForEmission` is the shared "no effective filter"
	// decision the wire emitters consume too; a shallow check here would
	// desync the flags from the emitted query.
	const filterEffective =
		effectiveFilterForEmission(caseListConfig.filter) !== undefined;
	// Hidden inputs put nothing on the screen for a worker to answer, so a
	// module whose only inputs are hidden has the same nothing-to-fill-in
	// search screen as one with none. Core still seeds hidden defaults under
	// `default_search` (`RemoteQuerySessionManager.initUserAnswers`), so the
	// values reach the search-input instance either way.
	const noSearchInputs =
		visibleSearchInputs(caseListConfig.searchInputs).length === 0;
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
