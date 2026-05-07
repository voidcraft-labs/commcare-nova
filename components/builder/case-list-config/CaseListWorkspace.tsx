// components/builder/case-list-config/CaseListWorkspace.tsx
//
// Single-scroll three-section authoring workspace for the case-list
// configuration. Mounts at the existing /build/[id]/{moduleUuid}/cases
// URL in edit mode (PreviewShell dispatches on edit-mode + cases
// location) and stacks the three previously-isolated sections —
// DisplaySection / FiltersSection / SearchInputsSection — vertically
// inside violet-railed sticky section headers.
//
// Layout choice. Single-scroll magazine: every section is always
// visible; the user moves between them by scrolling. No tabs, no
// accordion, no mode pickers — case-list authoring is one
// continuous narrative ("define what shows → narrow what shows →
// let the user filter further"), and the layout mirrors that.
// Pinning the section headers keeps the user oriented even when
// they're deep inside a section's body.
//
// Status density per section is bound LIVE to the doc store via
// shallow selectors. Counts and presence flags update in the same
// render pass as any blueprint mutation — no debouncing, no
// derived caching. The workspace itself owns no transient state;
// edits flow through `useBlueprintMutations().updateModule(...)`
// against the module's `caseListConfig` slot.
//
// Inner sections are unchanged from Tasks 6/7/8. Their
// `value: CaseListConfig` + `onChange: (next) => ...` contract
// is composed against the same source-of-truth: the module's
// `caseListConfig`. Each section only mutates its own slots; the
// other slots flow through verbatim, so all three compose cleanly
// against one shared config.

"use client";

import type { ReactNode } from "react";
import { useCallback, useMemo } from "react";
import { useBlueprintDocShallow } from "@/lib/doc/hooks/useBlueprintDoc";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useCaseTypes } from "@/lib/doc/hooks/useCaseTypes";
import type { Uuid } from "@/lib/doc/types";
import type { CaseListConfig } from "@/lib/domain";
import { useAppId } from "@/lib/session/hooks";
import { CaseListSectionHeader } from "./CaseListSectionHeader";
import { DisplaySection } from "./DisplaySection";
import { FiltersSection } from "./FiltersSection";
import { SearchInputsSection } from "./SearchInputsSection";

// ── Public types ──────────────────────────────────────────────────

export interface CaseListWorkspaceProps {
	/** The module whose case list is being authored. The workspace
	 *  reads this module's `caseListConfig` from the doc store and
	 *  routes section edits back through `updateModule(...)`. */
	readonly moduleUuid: Uuid;
}

// ── Empty-config sentinel ─────────────────────────────────────────

/**
 * Shared empty `CaseListConfig`. The doc-store `caseListConfig`
 * slot is optional, so sections need a defined config to render
 * against — a frozen module-level constant gives the empty arms
 * a stable identity (no `[] !== []` selector churn) while
 * preserving the wire-shape parity needed when the user adds a
 * column to a never-configured case list.
 */
const EMPTY_CONFIG: CaseListConfig = Object.freeze({
	columns: Object.freeze([]) as never,
	sort: Object.freeze([]) as never,
	calculatedColumns: Object.freeze([]) as never,
	searchInputs: Object.freeze([]) as never,
}) as CaseListConfig;

// ── Doc-store-shallow selector hooks for status density ──────────

/**
 * Status-density slice for a module's case-list config. The hook
 * reads only the fields the section headers display, via
 * `useBlueprintDocShallow` so unrelated doc edits don't trigger
 * a re-render of this surface.
 *
 * Each entry is read to a primitive (count, presence flag) so the
 * shallow comparator can short-circuit cleanly. The full
 * `caseListConfig` is also returned so the workspace can pass it
 * down to the sections.
 */
function useCaseListWorkspaceState(moduleUuid: Uuid): {
	readonly caseType: string | undefined;
	readonly config: CaseListConfig;
	readonly columnCount: number;
	readonly sortKeyCount: number;
	readonly firstSortKey: CaseListConfig["sort"][number] | undefined;
	readonly hasFilter: boolean;
	readonly searchInputCount: number;
	readonly searchInputDefaultCount: number;
} {
	return useBlueprintDocShallow((s) => {
		const mod = s.modules[moduleUuid];
		const config = mod?.caseListConfig ?? EMPTY_CONFIG;
		return {
			caseType: mod?.caseType,
			config,
			// Plain + calculated columns both render rows in the case
			// list display; the section header counts the union.
			columnCount: config.columns.length + config.calculatedColumns.length,
			sortKeyCount: config.sort.length,
			firstSortKey: config.sort[0],
			hasFilter: config.filter !== undefined,
			searchInputCount: config.searchInputs.length,
			searchInputDefaultCount: config.searchInputs.filter(
				(i) => i.default !== undefined,
			).length,
		};
	});
}

// ── Top-level component ───────────────────────────────────────────

/**
 * Three-section single-scroll workspace. The component body is a
 * vertical stack — header / body / hairline / header / body /
 * hairline / header / body — with each header pinning to the
 * shared scroll container's top via `position: sticky`. Section
 * bodies have no outer chrome; the inner editor layouts from
 * Tasks 6/7/8 ARE the chrome.
 */
export function CaseListWorkspace({ moduleUuid }: CaseListWorkspaceProps) {
	const {
		caseType,
		config,
		columnCount,
		sortKeyCount,
		firstSortKey,
		hasFilter,
		searchInputCount,
		searchInputDefaultCount,
	} = useCaseListWorkspaceState(moduleUuid);
	const caseTypes = useCaseTypes();
	const appId = useAppId() ?? "";
	const { updateModule } = useBlueprintMutations();

	// Single-shot mutator. Each section emits a fresh
	// `CaseListConfig` reflecting its slot edit; the workspace
	// routes that through `updateModule(uuid, { caseListConfig })`.
	// Sections only mutate their own slots, so config-slot composition
	// is structurally clean — the workspace doesn't need to merge.
	const handleConfigChange = useCallback(
		(next: CaseListConfig) => {
			updateModule(moduleUuid, { caseListConfig: next });
		},
		[updateModule, moduleUuid],
	);

	// Memoize per-section status nodes so the section header
	// re-renders only when its specific status payload changes.
	const displayStatus = useMemo<ReactNode>(
		() => buildDisplayStatus({ columnCount, sortKeyCount, firstSortKey }),
		[columnCount, sortKeyCount, firstSortKey],
	);
	const filterStatus = useMemo<ReactNode>(
		() => buildFilterStatus(hasFilter),
		[hasFilter],
	);
	const searchStatus = useMemo<ReactNode>(
		() => buildSearchStatus({ searchInputCount, searchInputDefaultCount }),
		[searchInputCount, searchInputDefaultCount],
	);

	// `currentCaseType` is a required prop on each inner section.
	// When the module has no case type set we render nothing — a
	// case-listless module shouldn't surface this URL, but we
	// guard defensively so a deletion-in-flight URL doesn't crash.
	if (!caseType) return null;

	return (
		<div className="case-list-workspace max-w-5xl mx-auto pb-32">
			{/*
			 * Section: Display.
			 *
			 * Owns columns / calculatedColumns / sort. The status
			 * line summarizes total column count + the primary sort.
			 */}
			<section>
				<CaseListSectionHeader title="Display" status={displayStatus} />
				<div className="px-8 pt-24 pb-16">
					<DisplaySection
						value={config}
						onChange={handleConfigChange}
						caseTypes={caseTypes}
						currentCaseType={caseType}
						knownInputs={config.searchInputs}
						appId={appId}
					/>
				</div>
			</section>

			{/*
			 * Section divider — the hairline reads as the seam
			 * between the previous section's body and the next
			 * section's pinned header.
			 */}
			<div className="border-t border-nova-violet/[0.15]" aria-hidden="true" />

			{/*
			 * Section: Filter.
			 *
			 * Owns the filter slot. The status line reports
			 * filter presence (live match counts already render
			 * inside FiltersSection's own preview panel below).
			 */}
			<section>
				<CaseListSectionHeader title="Filter" status={filterStatus} />
				<div className="px-8 pt-24 pb-16">
					<FiltersSection
						value={config}
						onChange={handleConfigChange}
						caseTypes={caseTypes}
						currentCaseType={caseType}
						knownInputs={config.searchInputs}
						appId={appId}
					/>
				</div>
			</section>

			<div className="border-t border-nova-violet/[0.15]" aria-hidden="true" />

			{/*
			 * Section: Search.
			 *
			 * Owns the searchInputs slot. The section body uses
			 * `SearchInputsSection`'s readonly-array contract; we
			 * route slot edits back through `handleSearchInputs`
			 * which builds a fresh CaseListConfig with the new
			 * inputs and forwards to the workspace mutator.
			 */}
			<section>
				<CaseListSectionHeader title="Search" status={searchStatus} />
				<div className="px-8 pt-24 pb-16">
					<SearchInputsSection
						value={config.searchInputs}
						onChange={(nextInputs) =>
							/* `SearchInputsSection.onChange` emits a `readonly`
							 * array; `CaseListConfig.searchInputs` is mutable.
							 * The spread copy converts the readonly view back
							 * to the schema's writable shape — round-trip
							 * through `caseListConfigSchema` accepts both. */
							handleConfigChange({
								...config,
								searchInputs: [...nextInputs],
							})
						}
						caseTypes={caseTypes}
						currentCaseType={caseType}
					/>
				</div>
			</section>
		</div>
	);
}

// ── Status-line builders ──────────────────────────────────────────
//
// Pure helpers that turn doc-store-shallow primitives into the
// status text each section header displays. Kept outside the
// component so the per-render cost is a memo lookup, not a
// fresh allocation per status payload.

interface DisplayStatusInput {
	readonly columnCount: number;
	readonly sortKeyCount: number;
	readonly firstSortKey: CaseListConfig["sort"][number] | undefined;
}

/**
 * Display section status line. Empty case is verbose-guidance
 * shape so the user immediately knows the section's purpose
 * without needing a separate empty-state card. Populated case
 * mirrors "{N} columns · sorted by {summary}".
 */
function buildDisplayStatus(input: DisplayStatusInput): ReactNode {
	if (input.columnCount === 0) {
		return "No columns yet — add columns to define what users see in the case list.";
	}
	const columnText = `${input.columnCount} ${input.columnCount === 1 ? "column" : "columns"}`;
	if (input.sortKeyCount === 0 || !input.firstSortKey) {
		return `${columnText} · no sort`;
	}
	const sortLabel = describeSortKey(input.firstSortKey);
	const tieBreakers =
		input.sortKeyCount > 1
			? ` (+${input.sortKeyCount - 1} tiebreaker${input.sortKeyCount > 2 ? "s" : ""})`
			: "";
	return `${columnText} · sorted by ${sortLabel}${tieBreakers}`;
}

/** Compact one-line description for a single sort key. The arrow
 *  glyph mirrors the convention used elsewhere in the editor. */
function describeSortKey(key: CaseListConfig["sort"][number]): string {
	const sourceLabel =
		key.source.kind === "property"
			? key.source.property
			: `calc:${key.source.columnId}`;
	const directionGlyph = key.direction === "asc" ? "↑" : "↓";
	return `${sourceLabel} ${directionGlyph}`;
}

/** Filter section status line. Live match counts come from the
 *  FiltersPreview body inside FiltersSection — the header reports
 *  presence + active count only. */
function buildFilterStatus(hasFilter: boolean): ReactNode {
	return hasFilter ? "1 filter active" : "No filter — all cases shown.";
}

interface SearchStatusInput {
	readonly searchInputCount: number;
	readonly searchInputDefaultCount: number;
}

/**
 * Search section status line. When inputs are present, append a
 * tally of those carrying a default-value expression — defaults
 * are visible in the runtime widget on first render and so are
 * worth surfacing in the section's at-a-glance summary.
 */
function buildSearchStatus(input: SearchStatusInput): ReactNode {
	if (input.searchInputCount === 0) {
		return "No search inputs — list-only view (no inline search bar).";
	}
	const inputText = `${input.searchInputCount} ${input.searchInputCount === 1 ? "input" : "inputs"}`;
	if (input.searchInputDefaultCount === 0) return inputText;
	const valueWord = input.searchInputDefaultCount === 1 ? "value" : "values";
	return `${inputText} · ${input.searchInputDefaultCount} with default ${valueWord}`;
}
