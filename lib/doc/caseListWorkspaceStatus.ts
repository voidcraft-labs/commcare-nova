/**
 * Pure derivations for the case-list workspace's three section
 * status lines. Inputs are the primitives `useCaseListWorkspaceState`
 * emits from the doc store; outputs are the display strings each
 * section header renders.
 *
 * Lives in `lib/doc/` (not `components/builder/`) so the derivation
 * is the state-model layer — the workspace's view is a deterministic
 * projection of these strings, not a separate testable concern.
 *
 * The three builders and the predicate `countConditions` helper are
 * exported individually so each can be tested in isolation against
 * primitive inputs. Empty-state CTA gating + seed builders live here
 * too because they are pure functions of the same primitives.
 */

import type { FilterPreviewStats } from "@/components/builder/case-list-config/FiltersPreview";
import type { Uuid } from "@/lib/doc/types";
import {
	type CaseListConfig,
	type Column,
	plainColumn,
	type SearchInputDef,
	simpleSearchInputDef,
} from "@/lib/domain";
import { matchAll, type Predicate } from "@/lib/domain/predicate";

export type { FilterPreviewStats };

// ── Display status ────────────────────────────────────────────────

export interface DisplayStatusInput {
	readonly columnCount: number;
	readonly sortedColumnCount: number;
	readonly firstSortedColumn: Column | undefined;
}

/**
 * Display section status line. Empty case is verbose-guidance shape
 * so the user immediately knows the section's purpose without needing
 * the empty-state card to appear in the section header itself.
 * Populated case mirrors "{N} columns · sorted by {summary}".
 */
export function buildDisplayStatus(input: DisplayStatusInput): string {
	if (input.columnCount === 0) {
		return "No columns yet — add columns to define what users see in the case list.";
	}
	const columnText = `${input.columnCount} ${input.columnCount === 1 ? "column" : "columns"}`;
	if (input.sortedColumnCount === 0 || !input.firstSortedColumn) {
		return `${columnText} · no sort`;
	}
	const sortLabel = describeSortedColumn(input.firstSortedColumn);
	const tieBreakers =
		input.sortedColumnCount > 1
			? ` (+${input.sortedColumnCount - 1} tiebreaker${input.sortedColumnCount > 2 ? "s" : ""})`
			: "";
	return `${columnText} · sorted by ${sortLabel}${tieBreakers}`;
}

/**
 * Compact one-line description for the primary-sort column. Calculated
 * columns surface their header (the only authored identity); other
 * kinds prefer their field name (the wire-form property the sort
 * comparator binds to).
 */
export function describeSortedColumn(column: Column): string {
	const sourceLabel =
		column.kind === "calculated" ? column.header || "calculated" : column.field;
	const direction = column.sort?.direction ?? "asc";
	const directionGlyph = direction === "asc" ? "↑" : "↓";
	return `${sourceLabel} ${directionGlyph}`;
}

// ── Filter status ─────────────────────────────────────────────────

export interface FilterStatusInput {
	readonly hasFilter: boolean;
	readonly conditionCount: number;
	readonly filterStats: FilterPreviewStats | null;
}

/**
 * Count user-meaningful conditions in a filter predicate. Sentinels
 * (`match-all` / `match-none`) count zero (no user-meaningful condition;
 * they're identity / absorbing elements of the boolean algebra).
 * `and` / `or` count their direct clauses (each is one condition the
 * user authored). Every other operator (eq / between / exists / …)
 * counts as one. Shallow walk — nested predicates inside an `and`
 * clause stay attributed to their outer clause.
 */
export function countConditions(filter: Predicate | undefined): number {
	if (!filter) return 0;
	if (filter.kind === "match-all" || filter.kind === "match-none") return 0;
	if (filter.kind === "and" || filter.kind === "or") {
		return filter.clauses.length;
	}
	return 1;
}

/**
 * Filter section status line. Three states: no filter slot ("No
 * filter — …"), filter present but preview not yet resolved ("{N}
 * condition(s) · …"), filter + preview resolved ("{N} condition(s) ·
 * {M} cases match"). The em-dash placeholder keeps the line stable
 * while the Server Action is in flight.
 */
export function buildFilterStatus(input: FilterStatusInput): string {
	if (!input.hasFilter) return "No filter — all cases shown.";
	const conditionWord = input.conditionCount === 1 ? "condition" : "conditions";
	const conditionText = `${input.conditionCount} ${conditionWord}`;
	if (input.filterStats === null) return `${conditionText} · …`;
	const { totalCount } = input.filterStats;
	const caseWord = totalCount === 1 ? "case" : "cases";
	const verb = totalCount === 1 ? "matches" : "match";
	return `${conditionText} · ${totalCount} ${caseWord} ${verb}`;
}

// ── Search status ─────────────────────────────────────────────────

export interface SearchStatusInput {
	readonly searchInputCount: number;
	readonly searchInputDefaultCount: number;
}

/**
 * Search section status line. When inputs are present, append a tally
 * of those carrying a default-value expression — defaults are visible
 * in the runtime widget on first render and so are worth surfacing.
 */
export function buildSearchStatus(input: SearchStatusInput): string {
	if (input.searchInputCount === 0) {
		return "No search inputs — list-only view (no inline search bar).";
	}
	const inputText = `${input.searchInputCount} ${input.searchInputCount === 1 ? "input" : "inputs"}`;
	if (input.searchInputDefaultCount === 0) return inputText;
	const valueWord = input.searchInputDefaultCount === 1 ? "value" : "values";
	return `${inputText} · ${input.searchInputDefaultCount} with default ${valueWord}`;
}

// ── Seed builders for empty-state CTAs ────────────────────────────
//
// Pure transitions: take the current config + the case type's first
// property + a fresh uuid; return the next config. The workspace
// composes these inside click handlers; the seed shape itself stays
// testable in isolation.

/**
 * Append a plain-column seed to `config.columns`. Column kind is
 * `plain`; field defaults to the case type's first property name;
 * header stays empty so the user names it inline post-add.
 */
export function appendPlainColumnSeed(
	config: CaseListConfig,
	firstProperty: string,
	uuid: Uuid,
): CaseListConfig {
	return {
		...config,
		columns: [...config.columns, plainColumn(uuid, firstProperty, "")],
	};
}

/**
 * Set the filter slot to `matchAll()` — the always-true sentinel.
 * Used by the Add filter CTA so the user gets a stable starting point
 * the inner predicate editor can then refine.
 */
export function seedMatchAllFilter(config: CaseListConfig): CaseListConfig {
	return { ...config, filter: matchAll() };
}

/**
 * Append a text-typed simple search-input seed bound to the case
 * type's first property. The input id `"input_1"` matches the inner
 * SearchInputsSection's own first-add seed shape.
 */
export function appendSearchInputSeed(
	config: CaseListConfig,
	firstProperty: string,
	uuid: Uuid,
): CaseListConfig {
	const seed: SearchInputDef = simpleSearchInputDef(
		uuid,
		"input_1",
		"",
		"text",
		firstProperty,
	);
	return { ...config, searchInputs: [...config.searchInputs, seed] };
}
