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
 *     primitives plus `sortedColumnCount` / `firstSortedColumn` /
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
 * primitives change reference. `firstSortedColumn` and `config`
 * are structural-shared by Immer in the underlying store, so an
 * edit to a different module produces the same references and the
 * comparator skips the re-render.
 */

"use client";

import { useBlueprintDocShallow } from "@/lib/doc/hooks/useBlueprintDoc";
import type { Uuid } from "@/lib/doc/types";
import type { CaseListConfig, Column } from "@/lib/domain";
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
 *
 * The `filter` slot is optional on `caseListConfig` and omitted
 * here; an unset filter is the canonical "no filter applied"
 * shape, identical to a freshly-authored case-less module.
 */
const EMPTY_CONFIG: CaseListConfig = Object.freeze({
	columns: Object.freeze([]),
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
 * surfaces don't. `firstSortedColumn` and `config` carry
 * structural-shared identity from Immer; the shallow comparator
 * skips re-renders unless the underlying entries change.
 *
 * `sortedColumnCount` counts columns with a non-`undefined` `sort`
 * slot — every column kind (including `calculated`) participates in
 * column-level sort, so the count is the union across all kinds.
 *
 * `firstSortedColumn` is the column with the lowest non-`undefined`
 * `sort.priority`. Two columns at the same priority tie-break to
 * column display order in `caseListConfig.columns` — the lower
 * index wins. Uniform across saga / preview / wire layers per the
 * tie-break rule the schema documents.
 */
export interface CaseListWorkspaceState extends CaseListSummary {
	readonly config: CaseListConfig;
	readonly sortedColumnCount: number;
	readonly firstSortedColumn: Column | undefined;
	readonly searchInputDefaultCount: number;
	/** The active filter predicate, or `undefined` when the slot is
	 *  empty. Surfaced separately from `hasFilter` so consumers can
	 *  derive AST-shaped state without re-reading the config slot. */
	readonly filter: Predicate | undefined;
}

// ── Hooks ─────────────────────────────────────────────────────────

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

/**
 * Resolve the column with the lowest non-`undefined` `sort.priority`
 * among `columns`. Two columns at the same priority tie-break to
 * column display order — the column appearing earlier in the array
 * wins. Returns `undefined` when no column carries a sort slot.
 *
 * Single-pass scan with index-based tie-break: the iteration order
 * matches the array's index, so the FIRST column at the running
 * minimum priority wins automatically — a later column at the same
 * priority can't displace it. No explicit secondary sort needed.
 */
function findFirstSortedColumn(columns: readonly Column[]): Column | undefined {
	let best: Column | undefined;
	let bestPriority = Number.POSITIVE_INFINITY;
	for (const column of columns) {
		const priority = column.sort?.priority;
		if (priority === undefined) continue;
		if (priority < bestPriority) {
			best = column;
			bestPriority = priority;
		}
	}
	return best;
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
			columnCount: config.columns.length,
			hasFilter: config.filter !== undefined,
			filter: config.filter,
			searchInputCount: config.searchInputs.length,
			sortedColumnCount: config.columns.filter((c) => c.sort !== undefined)
				.length,
			firstSortedColumn: findFirstSortedColumn(config.columns),
			searchInputDefaultCount: config.searchInputs.filter(
				(i) => i.default !== undefined,
			).length,
		};
	});
}
