// components/builder/case-list-config/FiltersSection.tsx
//
// Composes the case-list authoring surface's Filters section. Owns
// the always-on filter slot of the `CaseListConfig` (`filter:
// Predicate?`) — when present, the predicate narrows every read of
// the case list at the wire layer. The section composes:
//
//   1. `<PredicateSlotCard>` — header chrome + add/clear affordance
//      + the predicate editor body. The shared primitive owns the
//      slot-presence body switch and the validity short-circuit.
//   2. The `FiltersPreview` panel below — sampled rows + total
//      matching count, gated on the live filter validity so the
//      preview pauses while the predicate doesn't type-check.
//
// Symmetric with the Display section: this section accepts the
// FULL `CaseListConfig` and only mutates the `filter` slot; every
// other slot flows through unchanged. A parent composing the full
// panel mounts both sections against the same `CaseListConfig`
// source-of-truth so each section's edits compose cleanly.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerEye from "@iconify-icons/tabler/eye";
import tablerFilter from "@iconify-icons/tabler/filter";
import { useState } from "react";
import { PredicateSlotCard } from "@/components/builder/shared/PredicateSlotCard";
import type { CaseListConfig, CaseType } from "@/lib/domain";
import type { Predicate, SearchInputDecl } from "@/lib/domain/predicate";
import { type FilterPreviewStats, FiltersPreview } from "./FiltersPreview";
import { useValidityPropagator } from "./useInnerValidityShadow";

// ── Public types ──────────────────────────────────────────────────

export interface FiltersSectionProps {
	/** The current full case-list configuration. The Filters section
	 *  reads `filter` and only emits changes to that slot; every
	 *  other slot flows through unchanged. */
	readonly value: CaseListConfig;
	/** Fired with the next configuration. The parent applies the
	 *  next config to its source-of-truth (typically the doc store's
	 *  module slot). */
	readonly onChange: (next: CaseListConfig) => void;
	/** Blueprint case-type definitions — drives the property pickers
	 *  inside the predicate editor. */
	readonly caseTypes: readonly CaseType[];
	/** The case-type the case list reads against. The predicate
	 *  resolves property references against this scope; relation
	 *  walks inside `exists`/`missing` clauses flip the destination
	 *  scope as authored. */
	readonly currentCaseType: string;
	/** Search-input declarations from the parent screen. Threaded
	 *  into the predicate editor so an `input(...)` term resolves
	 *  the binding name. */
	readonly knownInputs?: readonly SearchInputDecl[];
	/** The live preview's case-store query is scoped by appId. */
	readonly appId: string;
	/** Aggregated validity verdict. `true` when the slot is
	 *  undefined OR the active predicate type-checks; the parent
	 *  gates its save affordance on this. */
	readonly onValidityChange?: (valid: boolean) => void;
	/**
	 * Live filter-preview stats callback. Forwarded verbatim to
	 * the embedded `FiltersPreview` — fires with `{ totalCount }`
	 * once a successful preview load completes, fires with `null`
	 * while the preview is loading, paused, or in any error arm.
	 * Surfaces outside this section (e.g. the workspace's filter
	 * section header) read the live counts via this callback
	 * without firing a duplicate preview load.
	 */
	readonly onPreviewStats?: (stats: FilterPreviewStats | null) => void;
}

// ── Top-level component ───────────────────────────────────────────

/**
 * Composes the case-list Filters section. Renders the
 * `PredicateSlotCard` for the filter slot + the live-preview panel
 * beneath it.
 *
 * Validity contract: forwarded verbatim from the inner
 * `PredicateSlotCard` — `true` when the slot is undefined or the
 * predicate type-checks, `false` when the predicate fails its
 * type-check pass. The section caches the verdict locally so it
 * can both propagate to its parent AND gate `FiltersPreview` (the
 * preview pauses on invalid filters so it doesn't query against a
 * predicate the wire layer would reject).
 */
export function FiltersSection({
	value,
	onChange,
	caseTypes,
	currentCaseType,
	knownInputs = [],
	appId,
	onValidityChange,
	onPreviewStats,
}: FiltersSectionProps) {
	// Cached verdict from the slot card. Default `true` because the
	// card fires its first verdict on mount; before the first effect
	// tick the section hasn't seen a verdict yet, and reporting
	// invalid would briefly disable the parent's save button on an
	// empty-slot mount.
	const [isValid, setIsValid] = useState(true);

	// Forward the cached verdict to the section's parent on every
	// transition. The slot card already ref-stashes its own
	// onValidityChange via `useValidityPropagator`; this propagator
	// runs against the section's own parent callback, which lives
	// at a different identity each render.
	useValidityPropagator({ isValid, onValidityChange });

	// Routes the slot card's onChange back into the full
	// CaseListConfig — updates only the `filter` slot, every other
	// slot flows through unchanged.
	const handleFilterChange = (next: Predicate | undefined) => {
		onChange({ ...value, filter: next });
	};

	return (
		<div className="space-y-3">
			<PredicateSlotCard
				icon={tablerFilter}
				title="Filter"
				description="Always-on predicate that narrows the case list at the wire layer."
				addLabel="Add filter"
				clearLabel="Clear filter"
				value={value.filter}
				onChange={handleFilterChange}
				caseTypes={caseTypes}
				currentCaseType={currentCaseType}
				knownInputs={knownInputs}
				onValidityChange={setIsValid}
			/>

			{/* Live-preview panel. Reads the full `CaseListConfig`
			    via the shared `loadFilterPreviewAction` Server Action
			    so calculated columns / sort still apply to the row
			    sample under the filter — the user sees the final
			    visible shape, not just the filter-narrowed count. */}
			<div className="rounded-md border border-white/[0.04] bg-nova-surface/30 p-3">
				<header className="flex items-baseline gap-2 mb-2">
					<div className="w-0.5 h-3 rounded-full bg-nova-violet/40 self-center" />
					<Icon
						icon={tablerEye}
						width="14"
						height="14"
						className="text-nova-violet-bright/80 self-center"
					/>
					<h3 className="text-[11px] font-semibold uppercase tracking-widest text-nova-text/90">
						Live preview
					</h3>
					<span className="ml-1 text-[10px] text-nova-text-muted/70">
						How many cases pass the filter, plus the visible row sample.
					</span>
				</header>
				<FiltersPreview
					appId={appId}
					caseListConfig={value}
					currentCaseType={currentCaseType}
					filterValid={isValid}
					onPreviewStats={onPreviewStats}
				/>
			</div>
		</div>
	);
}
