// components/builder/case-list-config/CaseListWorkspace.tsx
//
// Single-scroll three-section authoring workspace for the case-list
// configuration. Mounts at the existing /build/[id]/{moduleUuid}/cases
// URL in edit mode (PreviewShell dispatches on edit-mode + cases
// location) and stacks the three sections — Display / Filter / Search
// — vertically inside violet-railed sticky section headers.
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
// derived caching, no `useMemo` on simple counts. The workspace
// itself owns no transient state for static counts; edits flow
// through `useBlueprintMutations().updateModule(...)` against the
// module's `caseListConfig` slot. The filter section header is the
// one exception: live filter-preview match counts come from
// FiltersPreview's existing Server Action load, threaded up via
// the `onPreviewStats` callback so the header doesn't fire a
// duplicate query.
//
// Section composition. DisplaySection / FiltersSection /
// SearchInputsSection retain their internal layouts; the workspace
// is the shell that mounts them inside its magazine layout. Each
// section's `value: CaseListConfig` + `onChange: (next) => ...`
// contract composes against the same source-of-truth — the
// module's `caseListConfig` slot — so per-slot edits compose
// cleanly without the workspace needing to merge.

"use client";

import { Icon, type IconifyIcon } from "@iconify/react/offline";
import tablerColumns from "@iconify-icons/tabler/columns";
import tablerFilter from "@iconify-icons/tabler/filter";
import tablerSearch from "@iconify-icons/tabler/search";
import { useCallback, useState } from "react";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useCaseListWorkspaceState } from "@/lib/doc/hooks/useCaseListSummary";
import { useCaseTypes } from "@/lib/doc/hooks/useCaseTypes";
import type { Uuid } from "@/lib/doc/types";
import {
	type CaseListConfig,
	plainColumn,
	type SearchInputDef,
	searchInputDef,
} from "@/lib/domain";
import { matchAll } from "@/lib/domain/predicate";
import { useAppId } from "@/lib/session/hooks";
import { CaseListSectionHeader } from "./CaseListSectionHeader";
import { DisplaySection } from "./DisplaySection";
import type { FilterPreviewStats } from "./FiltersPreview";
import { FiltersSection } from "./FiltersSection";
import { SearchInputsSection } from "./SearchInputsSection";

// ── Public types ──────────────────────────────────────────────────

export interface CaseListWorkspaceProps {
	/** The module whose case list is being authored. The workspace
	 *  reads this module's `caseListConfig` from the doc store and
	 *  routes section edits back through `updateModule(...)`. */
	readonly moduleUuid: Uuid;
}

// ── Top-level component ───────────────────────────────────────────

/**
 * Three-section single-scroll workspace. The component body is a
 * vertical stack — header / body / hairline / header / body /
 * hairline / header / body — with each header pinning to the
 * shared scroll container's top via `position: sticky`. Section
 * bodies have no outer chrome; the inner editor layouts ARE the
 * chrome.
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

	// Live filter-preview stats. The FiltersPreview embedded inside
	// FiltersSection runs the existing `loadFilterPreviewAction`
	// Server Action and emits the success-state `totalCount` via the
	// `onPreviewStats` callback. The header's status line reads from
	// this state so the header + the body show the same live count
	// without firing a duplicate query.
	const [filterStats, setFilterStats] = useState<FilterPreviewStats | null>(
		null,
	);

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

	// Empty-state CTAs construct the first row's seed inline and
	// route it through `handleConfigChange`, matching the seed shape
	// the inner sections' own add-affordances produce. The user gets
	// a single-click path from "section is empty" to "section has a
	// row authored against the case type's first property" without
	// scrolling past the workspace's section header to find the
	// inner section's add button.
	const ct = caseTypes.find((c) => c.name === caseType);
	const firstProperty = ct?.properties[0]?.name ?? "";
	const handleAddFirstColumn = useCallback(() => {
		handleConfigChange({
			...config,
			columns: [...config.columns, plainColumn(firstProperty, "")],
		});
	}, [handleConfigChange, config, firstProperty]);
	const handleAddFirstFilter = useCallback(() => {
		handleConfigChange({ ...config, filter: matchAll() });
	}, [handleConfigChange, config]);
	const handleAddFirstSearchInput = useCallback(() => {
		const seed: SearchInputDef = searchInputDef("input_1", "", "text", {
			property: firstProperty,
		});
		handleConfigChange({
			...config,
			searchInputs: [...config.searchInputs, seed],
		});
	}, [handleConfigChange, config, firstProperty]);

	// Status-line text. Direct calls — no `useMemo` on simple counts
	// per the spec's status-line precision rule. Strings prop-compare
	// by value; the section header re-renders when the text changes,
	// not when the parent re-renders.
	const displayStatus = buildDisplayStatus({
		columnCount,
		sortKeyCount,
		firstSortKey,
	});
	const filterStatus = buildFilterStatus({ hasFilter, filterStats });
	const searchStatus = buildSearchStatus({
		searchInputCount,
		searchInputDefaultCount,
	});

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
				<div className="px-8 pt-24 pb-16 space-y-6">
					{columnCount === 0 ? (
						<EmptyStateCard
							icon={tablerColumns}
							title="Add columns to define what users see in the case list."
							ctaLabel="Add column"
							onCtaClick={handleAddFirstColumn}
						/>
					) : null}
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
			 * Owns the filter slot. The status line reports filter
			 * presence + live match count via the onPreviewStats
			 * callback, which the embedded FiltersPreview fires once
			 * the Server Action's success arm resolves.
			 */}
			<section>
				<CaseListSectionHeader title="Filter" status={filterStatus} />
				<div className="px-8 pt-24 pb-16 space-y-6">
					{!hasFilter ? (
						<EmptyStateCard
							icon={tablerFilter}
							title="Add a filter to narrow which cases appear in the list."
							ctaLabel="Add filter"
							onCtaClick={handleAddFirstFilter}
						/>
					) : null}
					<FiltersSection
						value={config}
						onChange={handleConfigChange}
						caseTypes={caseTypes}
						currentCaseType={caseType}
						knownInputs={config.searchInputs}
						appId={appId}
						onPreviewStats={setFilterStats}
					/>
				</div>
			</section>

			<div className="border-t border-nova-violet/[0.15]" aria-hidden="true" />

			{/*
			 * Section: Search.
			 *
			 * Owns the searchInputs slot.
			 */}
			<section>
				<CaseListSectionHeader title="Search" status={searchStatus} />
				<div className="px-8 pt-24 pb-16 space-y-6">
					{searchInputCount === 0 ? (
						<EmptyStateCard
							icon={tablerSearch}
							title="Add search inputs so users can find specific cases."
							ctaLabel="Add search input"
							onCtaClick={handleAddFirstSearchInput}
						/>
					) : null}
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

// ── Empty-state card ─────────────────────────────────────────────

interface EmptyStateCardProps {
	readonly icon: IconifyIcon;
	readonly title: string;
	readonly ctaLabel: string;
	readonly onCtaClick: () => void;
}

/**
 * Violet-tinted glass card surfaced at the top of an empty
 * section's body. Carries section-specific guidance + a single
 * CTA that seeds the section's first row through the workspace's
 * shared mutator. The inner section's own dashed-gray empty hint
 * stays below this card, providing a fallback affordance once the
 * user has scrolled past the workspace-level guidance.
 *
 * Glass-on-card pattern: this card is in flow (not a Base UI
 * popover positioner), so the "glass on positioner not popup"
 * compositing rule that applies to Base UI surfaces doesn't bind
 * here — the violet-tinted background + backdrop-blur land on the
 * card directly.
 */
function EmptyStateCard({
	icon,
	title,
	ctaLabel,
	onCtaClick,
}: EmptyStateCardProps) {
	return (
		<div
			data-empty-state-card
			className="rounded-lg border border-nova-violet/[0.18] bg-nova-violet/[0.05] backdrop-blur-md px-5 py-4 flex items-center gap-4"
		>
			<div className="p-2 rounded-md bg-nova-violet/[0.15] border border-nova-violet/[0.3] shrink-0">
				<Icon
					icon={icon}
					width="18"
					height="18"
					className="text-nova-violet-bright"
				/>
			</div>
			<div className="flex-1 min-w-0">
				<p className="text-sm text-nova-text">{title}</p>
			</div>
			<button
				type="button"
				onClick={onCtaClick}
				className="px-3 py-1.5 rounded-md text-[12px] font-medium bg-nova-violet/[0.18] hover:bg-nova-violet/[0.28] border border-nova-violet/[0.35] hover:border-nova-violet/[0.55] text-nova-violet-bright transition-colors cursor-pointer shrink-0"
			>
				{ctaLabel}
			</button>
		</div>
	);
}

// ── Status-line builders ──────────────────────────────────────────
//
// Pure helpers that turn doc-store-shallow primitives into the
// status text each section header displays. Defined outside the
// component so reordering / adding a section doesn't require
// editing the render body twice. The builders return strings, so
// prop-comparison handles re-render avoidance — no memoization
// per the workspace's status-line precision rule.

interface DisplayStatusInput {
	readonly columnCount: number;
	readonly sortKeyCount: number;
	readonly firstSortKey: CaseListConfig["sort"][number] | undefined;
}

/**
 * Display section status line. Empty case is verbose-guidance
 * shape so the user immediately knows the section's purpose
 * without needing the empty-state card to appear in the section
 * header itself. Populated case mirrors
 * "{N} columns · sorted by {summary}".
 */
function buildDisplayStatus(input: DisplayStatusInput): string {
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

interface FilterStatusInput {
	readonly hasFilter: boolean;
	readonly filterStats: FilterPreviewStats | null;
}

/**
 * Filter section status line. Three states:
 *
 *   - No filter slot configured → "No filter — all cases shown."
 *   - Filter present, preview load not yet resolved → "1 filter · …"
 *     (em-dash placeholder so the line doesn't flicker on every
 *     load tick).
 *   - Filter present, preview load resolved → "1 filter · {N} cases match".
 *
 * `LoadFilterPreviewResult.totalCount` is the count of cases
 * passing the active filter — the same value the FiltersPreview
 * body's count card surfaces, sourced from the same Server Action
 * call.
 */
function buildFilterStatus(input: FilterStatusInput): string {
	if (!input.hasFilter) return "No filter — all cases shown.";
	if (input.filterStats === null) return "1 filter · …";
	const { totalCount } = input.filterStats;
	const caseWord = totalCount === 1 ? "case" : "cases";
	return `1 filter · ${totalCount} ${caseWord} match`;
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
function buildSearchStatus(input: SearchStatusInput): string {
	if (input.searchInputCount === 0) {
		return "No search inputs — list-only view (no inline search bar).";
	}
	const inputText = `${input.searchInputCount} ${input.searchInputCount === 1 ? "input" : "inputs"}`;
	if (input.searchInputDefaultCount === 0) return inputText;
	const valueWord = input.searchInputDefaultCount === 1 ? "value" : "values";
	return `${inputText} · ${input.searchInputDefaultCount} with default ${valueWord}`;
}
