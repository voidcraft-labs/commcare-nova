/**
 * Doc-store-backed summary hook for a module's case-list config.
 *
 * `useCaseListSummary(moduleUuid)` is a small primitive-only summary
 * used by surfaces that just need at-a-glance counts (e.g.
 * `ModuleScreen`'s "Case List & Search" affordance card). Returns
 * `{ caseType, columnCount, hasFilter, searchInputCount }`.
 *
 * The hook consolidates the "read a module's case list config"
 * pattern into a named domain hook, so consumers don't import the
 * raw `useBlueprintDocShallow` directly — that selector-accepting
 * hook is package-private (Biome `noRestrictedImports` enforces),
 * so every component reaches the doc through a named domain hook.
 *
 * The shallow comparator short-circuits when none of the primitives
 * change — every entry is a primitive, so identity comparison is
 * value comparison.
 */

"use client";

import { useBlueprintDocShallow } from "@/lib/doc/hooks/useBlueprintDoc";
import type { Uuid } from "@/lib/doc/types";

/**
 * Compact summary returned by `useCaseListSummary`. Every entry is
 * a primitive so the shallow comparator short-circuits on identity.
 * The `caseType` slot is the module's case-type name (or
 * `undefined` when the module is case-less).
 */
export interface CaseListSummary {
	readonly caseType: string | undefined;
	readonly columnCount: number;
	readonly hasFilter: boolean;
	readonly searchInputCount: number;
}

/**
 * Compact summary hook. Returns the four primitives a status-line
 * surface needs to render at-a-glance counts for a module's case
 * list — total column count (every kind, including `calculated`,
 * renders a row in the runtime case list), filter presence flag,
 * and search-input count.
 */
export function useCaseListSummary(moduleUuid: Uuid): CaseListSummary {
	return useBlueprintDocShallow((s) => {
		const mod = s.modules[moduleUuid];
		const config = mod?.caseListConfig;
		return {
			caseType: mod?.caseType,
			columnCount: config?.columns.length ?? 0,
			hasFilter: config?.filter !== undefined,
			searchInputCount: config?.searchInputs.length ?? 0,
		};
	});
}
