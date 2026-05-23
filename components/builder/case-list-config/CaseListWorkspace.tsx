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
// render pass as any blueprint mutation. The workspace itself owns
// no transient state for static counts; edits flow through
// `useBlueprintMutations().updateModule(...)` against the module's
// `caseListConfig` slot. The filter section header is the one
// exception: live filter-preview match counts come from
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
import {
	appendPlainColumnSeed,
	appendSearchInputSeed,
	buildDisplayStatus,
	buildFilterStatus,
	buildSearchStatus,
	countConditions,
	type FilterPreviewStats,
	seedMatchAllFilter,
} from "@/lib/doc/caseListWorkspaceStatus";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useCaseListWorkspaceState } from "@/lib/doc/hooks/useCaseListSummary";
import { useCaseTypes } from "@/lib/doc/hooks/useCaseTypes";
import type { Uuid } from "@/lib/doc/types";
import type { CaseListConfig } from "@/lib/domain";
import { useAppId } from "@/lib/session/hooks";
import { CaseListSectionHeader } from "./CaseListSectionHeader";
import { DisplaySection } from "./DisplaySection";
import { FiltersSection } from "./FiltersSection";
import { SearchInputsSection } from "./SearchInputsSection";
import { newUuid } from "./uuid";

// ── Public types ──────────────────────────────────────────────────

export interface CaseListWorkspaceProps {
	/** The module whose case list is being authored. The workspace
	 *  reads this module's `caseListConfig` from the doc store and
	 *  routes section edits back through `updateModule(...)`. */
	readonly moduleUuid: Uuid;
}

// ── Constants ────────────────────────────────────────────────────

/**
 * Native `title` hint surfaced on disabled empty-state CTAs whose
 * seed depends on a case-property reference (Add column /
 * Add search input). The Add filter CTA stays enabled in this state
 * because `matchAll()` is property-less and doesn't need the hint.
 */
const PROPERTYLESS_CTA_HINT = "Define case-type properties first.";

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
		sortedColumnCount,
		firstSortedColumn,
		hasFilter,
		filter,
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
		handleConfigChange(appendPlainColumnSeed(config, firstProperty, newUuid()));
	}, [handleConfigChange, config, firstProperty]);
	const handleAddFirstFilter = useCallback(() => {
		handleConfigChange(seedMatchAllFilter(config));
	}, [handleConfigChange, config]);
	const handleAddFirstSearchInput = useCallback(() => {
		handleConfigChange(appendSearchInputSeed(config, firstProperty, newUuid()));
	}, [handleConfigChange, config, firstProperty]);

	// Status-line text. Direct calls — no `useMemo` on simple counts.
	// Strings prop-compare by value; the section header re-renders
	// when the text changes, not when the parent re-renders, so
	// memoization would only displace the cost without removing it.
	const displayStatus = buildDisplayStatus({
		columnCount,
		sortedColumnCount,
		firstSortedColumn,
	});
	// Filter conditions are derived from the predicate AST — `and`
	// / `or` count their direct clauses; sentinels (`match-all` /
	// `match-none`) count zero (no user-meaningful condition); every
	// other operator counts as one. The wider FiltersPreview body
	// supplies the live `totalCount` of cases that pass the filter
	// via the `onPreviewStats` callback above.
	const conditionCount = countConditions(filter);
	const filterStatus = buildFilterStatus({
		hasFilter,
		conditionCount,
		filterStats,
	});
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
			 * Owns the unified columns array. The status line
			 * summarizes total column count + the primary sort.
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
							ctaDisabled={!firstProperty}
							ctaDisabledHint={PROPERTYLESS_CTA_HINT}
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
							ctaDisabled={!firstProperty}
							ctaDisabledHint={PROPERTYLESS_CTA_HINT}
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
	/** When `true`, the CTA button renders disabled with a native
	 *  hover hint via `title`. The button stays visible so the
	 *  affordance path is discoverable; clicking does nothing until
	 *  the precondition resolves. */
	readonly ctaDisabled?: boolean;
	/** Native `title` text rendered on the disabled CTA — surfaces
	 *  the precondition the user needs to satisfy. Has no effect
	 *  when `ctaDisabled` is `false`. */
	readonly ctaDisabledHint?: string;
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
	ctaDisabled = false,
	ctaDisabledHint,
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
				disabled={ctaDisabled}
				title={ctaDisabled ? ctaDisabledHint : undefined}
				className="px-3 py-1.5 rounded-md text-[12px] font-medium bg-nova-violet/[0.18] hover:bg-nova-violet/[0.28] border border-nova-violet/[0.35] hover:border-nova-violet/[0.55] text-nova-violet-bright transition-colors cursor-pointer shrink-0 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-nova-violet/[0.18] disabled:hover:border-nova-violet/[0.35]"
			>
				{ctaLabel}
			</button>
		</div>
	);
}
