/**
 * Doc-store-backed summary hooks for a module's case-list config.
 *
 * Two hooks live here, both shallow-stable subscriptions over a
 * single module's `caseListConfig` slot:
 *
 *   - `useCaseListSummary(moduleUuid)` — small primitive-only
 *     summary used by surfaces that just need at-a-glance counts
 *     (e.g. `ModuleScreen`'s "Case List" affordance card). Returns
 *     `{ caseType, columnCount, hasFilter, searchInputCount }`.
 *
 *   - `useCaseListWorkspaceState(moduleUuid)` — extended summary
 *     used by the `CaseListWorkspace` shell. Returns the same
 *     primitives plus `sortKeyCount` / `firstSortKey` /
 *     `searchInputDefaultCount` AND the full `config` reference
 *     so the workspace can pass it down to its sections without a
 *     second subscription pass.
 *
 * Both hooks consolidate the "read a module's case list config"
 * pattern into named domain hooks, so consumers don't import the
 * raw `useBlueprintDocShallow` (which is lib-private per the
 * boundary rule documented in `lib/doc/CLAUDE.md`).
 *
 * The shallow comparator short-circuits when none of the
 * primitives change reference. `firstSortKey` and `config` are
 * structural-shared by Immer in the underlying store, so an edit
 * to a different module produces the same references and the
 * comparator skips the re-render.
 */

"use client";

import { useBlueprintDocShallow } from "@/lib/doc/hooks/useBlueprintDoc";
import type { Uuid } from "@/lib/doc/types";
import type { CaseListConfig, SortKey } from "@/lib/domain";
import type { Predicate } from "@/lib/domain/predicate";

// ── Empty-config sentinel ─────────────────────────────────────────

/**
 * Module-level empty `CaseListConfig` reference. Modules whose
 * `caseListConfig` slot is `undefined` need a defined config to
 * surface to consumers; a single shared module-level constant
 * gives the empty arms a stable identity. Without this, the
 * `?? { columns: [], ... }` fallback would allocate a new object
 * each render and defeat the shallow comparator that
 * `useBlueprintDocShallow` applies on the returned record.
 *
 * `Object.freeze` at every layer (the wrapper + each inner array)
 * so a consumer that reaches in and tries to mutate a sub-array
 * (`config.columns.push(...)` instead of the workspace's
 * spread-and-replace mutator contract) throws at runtime rather
 * than silently corrupting the shared sentinel and leaking the
 * mutation across modules. The cast adapts the deeply-readonly
 * frozen shape back to the schema's mutable element types — the
 * sentinel is read-only by contract, so the cast is a one-way
 * labelling step that never sees a write.
 */
const EMPTY_CONFIG: CaseListConfig = Object.freeze({
	columns: Object.freeze([]),
	sort: Object.freeze([]),
	calculatedColumns: Object.freeze([]),
	searchInputs: Object.freeze([]),
}) as unknown as CaseListConfig;

// ── Public types ──────────────────────────────────────────────────

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
 * Extended summary returned by `useCaseListWorkspaceState`. Adds
 * the `config` reference + sort + with-default-values primitives
 * the workspace shell needs but that the lighter `CaseListSummary`
 * surfaces don't. `firstSortKey` and `config` carry structural-
 * shared identity from Immer; the shallow comparator skips re-
 * renders unless the underlying entries change.
 */
export interface CaseListWorkspaceState extends CaseListSummary {
	readonly config: CaseListConfig;
	readonly sortKeyCount: number;
	readonly firstSortKey: SortKey | undefined;
	readonly searchInputDefaultCount: number;
	/** The active filter predicate, or `undefined` when the slot is
	 *  empty. Surfaced separately from the `hasFilter` flag so the
	 *  workspace can drive condition-count derivation off the AST. */
	readonly filter: Predicate | undefined;
}

// ── Hooks ─────────────────────────────────────────────────────────

/**
 * Compact summary hook. Returns the four primitives a status-line
 * surface needs to render at-a-glance counts for a module's case
 * list — column count (plain + calculated, since both render rows
 * in the runtime case list), filter presence flag, and search-input
 * count.
 */
export function useCaseListSummary(moduleUuid: Uuid): CaseListSummary {
	return useBlueprintDocShallow((s) => {
		const mod = s.modules[moduleUuid];
		const config = mod?.caseListConfig;
		return {
			caseType: mod?.caseType,
			// Plain + calculated columns both render rows in the case
			// list display; the count is the union.
			columnCount: config
				? config.columns.length + config.calculatedColumns.length
				: 0,
			hasFilter: config?.filter !== undefined,
			searchInputCount: config?.searchInputs.length ?? 0,
		};
	});
}

/**
 * Extended workspace state hook. Used by `CaseListWorkspace`'s
 * shell to render its three section headers + thread the live
 * `CaseListConfig` down to the inner sections in one subscription.
 *
 * Returns the empty-config sentinel for never-configured modules
 * so the workspace's render doesn't need a defensive branch
 * when `caseListConfig` is `undefined` on the doc.
 */
export function useCaseListWorkspaceState(
	moduleUuid: Uuid,
): CaseListWorkspaceState {
	return useBlueprintDocShallow((s) => {
		const mod = s.modules[moduleUuid];
		const config = mod?.caseListConfig ?? EMPTY_CONFIG;
		return {
			caseType: mod?.caseType,
			config,
			columnCount: config.columns.length + config.calculatedColumns.length,
			hasFilter: config.filter !== undefined,
			filter: config.filter,
			searchInputCount: config.searchInputs.length,
			sortKeyCount: config.sort.length,
			firstSortKey: config.sort[0],
			searchInputDefaultCount: config.searchInputs.filter(
				(i) => i.default !== undefined,
			).length,
		};
	});
}
