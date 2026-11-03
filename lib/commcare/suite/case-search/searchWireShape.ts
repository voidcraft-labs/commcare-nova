// lib/commcare/suite/case-search/searchWireShape.ts
//
// The authored search workflow's wire spelling: one `WireShape` flag set for
// every platform an app declares. The flags drive the `<remote-request>`
// orchestrator's `<query>` attributes and the case-list short-detail
// emitter's `<action auto_launch>` attribute (see `types.ts` for the per-flag
// wire landing). Android reads no `auto_launch` and opens its list first,
// which the platform table states (`lib/domain/platforms.ts`, `search-first`,
// `skip-to-results`).

import { type OrdinaryCaseSearchConfig, searchWorkflow } from "@/lib/domain";
import type { WireShape } from "./types";

/**
 * Spell the menu's effective search config as its `WireShape`. Total over
 * the input domain:
 *
 *   | workflow      | formsReadSearch | auto_launch | default_search | inline |
 *   |---------------|-----------------|-------------|----------------|--------|
 *   | listFirst     | absent          | false       | false          | false  |
 *   | searchFirst   | absent / true   | true        | false          | = forms|
 *   | skipToResults | absent / true   | true        | true           | = forms|
 *
 * `listFirst` beside `formsReadSearch` is unrepresentable
 * (`ordinaryCaseSearchConfigSchema`'s refine). The inline shape needs both
 * `inline_search` and `auto_launch` (`app_manager/util.py::module_uses_inline_search`),
 * which the refine guarantees wherever the forms read the search.
 */
export function searchWireShape(
	caseSearchConfig: OrdinaryCaseSearchConfig,
): WireShape {
	const workflow = searchWorkflow(caseSearchConfig);
	return {
		autoLaunch: workflow !== "listFirst",
		defaultSearch: workflow === "skipToResults",
		inlineSearch: caseSearchConfig.formsReadSearch === true,
	};
}
