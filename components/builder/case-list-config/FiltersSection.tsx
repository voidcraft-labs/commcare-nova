// components/builder/case-list-config/FiltersSection.tsx
//
// Composes the case-list authoring surface's Filters section. Owns
// the always-on filter slot of the `CaseListConfig` (`filter:
// Predicate?`) — when present, the predicate narrows every read of
// the case list at the wire layer. The section mounts:
//
//   1. The `PredicateCardEditor` for the active filter.
//   2. An "Add filter" affordance when the slot is undefined.
//   3. A "Clear filter" affordance when the slot is defined.
//   4. The `FiltersPreview` panel below — sampled rows + total
//      matching count.
//
// Symmetric with the Display section: this section accepts the
// FULL `CaseListConfig` and only mutates the `filter` slot; every
// other slot flows through unchanged. A parent composing the full
// panel mounts both sections against the same `CaseListConfig`
// source-of-truth so each section's edits compose cleanly.
//
// Default predicate for the "Add filter" affordance is
// `match-all()` — surfaces immediately as a "always true" sentinel
// card with the kind-replacement menu in its kebab so the user's
// first interaction is "what kind of filter do I want?" rather
// than "fill in this comparison." A comparison-card scaffold
// would surface `valid: false` immediately because the literal-
// vs-property type-check hasn't been satisfied; match-all stays
// `valid: true` so the user can switch to the operator they want
// without seeing a false-error state pre-emptively.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerEye from "@iconify-icons/tabler/eye";
import tablerFilter from "@iconify-icons/tabler/filter";
import tablerFilterPlus from "@iconify-icons/tabler/filter-plus";
import tablerFilterX from "@iconify-icons/tabler/filter-x";
import { useEffect, useRef, useState } from "react";
import type { CaseListConfig, CaseType } from "@/lib/domain";
import type { SearchInputDecl } from "@/lib/domain/predicate";
import { matchAll, type Predicate } from "@/lib/domain/predicate";
import { type FilterPreviewStats, FiltersPreview } from "./FiltersPreview";
import { PredicateCardEditor } from "./PredicateCardEditor";

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
 * Composes the case-list Filters section. Renders the section
 * header (with the "Add filter" / "Clear filter" affordance), the
 * active filter editor when present, and the live-preview panel.
 *
 * Validity contract: when `value.filter === undefined`, the section
 * reports `valid: true` (no filter ≡ always true ≡ trivially
 * valid). When the slot is defined, the section forwards the
 * predicate editor's verdict verbatim. The transition (defined →
 * undefined via "Clear filter") explicitly resets the inner
 * verdict to `true` so a stale `false` from the prior predicate
 * doesn't leak past the clear.
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
	// Inner predicate-editor verdict. Default `true` — when
	// `value.filter` is undefined, the editor is unmounted and the
	// verdict stays trivially true. When the slot is defined, the
	// editor's onValidityChange overrides this.
	const [predicateValid, setPredicateValid] = useState(true);

	const filterPresent = value.filter !== undefined;
	// When the slot is undefined, the section is trivially valid
	// regardless of `predicateValid`'s stash. When the slot is
	// defined, defer to `predicateValid`. Without the slot-presence
	// short-circuit, a stale `false` left behind by a cleared
	// predicate would leak past the clear.
	const isValid = !filterPresent || predicateValid;

	// Same ref-stash pattern as the sub-editors — keeps a fresh-each-
	// render parent callback from tripping the effect on
	// non-transitions.
	const onValidityChangeRef = useRef(onValidityChange);
	onValidityChangeRef.current = onValidityChange;
	useEffect(() => {
		onValidityChangeRef.current?.(isValid);
	}, [isValid]);

	// ── Per-slot mutators ──
	const setFilter = (next: Predicate | undefined) => {
		onChange({ ...value, filter: next });
	};
	const addFilter = () => {
		// Default seed: `match-all()` sentinel. The kind-replacement
		// menu inside `PredicateCardEditor` (via `ChildPredicateEditor`)
		// lets the user swap in any concrete operator on first
		// interaction. Routes through the `matchAll` builder rather
		// than constructing the AST literal by hand — every domain
		// mutation in the codebase flows through builders so the
		// constructed shape stays in lockstep with the schema.
		setFilter(matchAll());
	};
	const clearFilter = () => {
		// The structural defense for the cleared-state validity
		// verdict is the `!filterPresent || predicateValid` short-
		// circuit in `isValid` above — when the slot is undefined
		// the section reports `valid: true` regardless of the inner
		// `predicateValid` shadow. The next "Add filter" mount
		// starts with a `match-all()` seed which type-checks as
		// valid; the inner editor's first verdict overrides any
		// stale shadow before the mount-time `useEffect` fires.
		setFilter(undefined);
	};

	return (
		<div className="space-y-3">
			{/* Section header. Renders the section's title + the
			    add/clear affordance on the right. The header chrome
			    mirrors the Display section's sub-section shape so the
			    Filters section sits visually parallel with the
			    Display section's sub-sections in the case-list-config
			    panel. */}
			<header className="flex items-baseline gap-2">
				<div className="w-0.5 h-3 rounded-full bg-nova-violet/40 self-center" />
				<Icon
					icon={tablerFilter}
					width="14"
					height="14"
					className="text-nova-violet-bright/80 self-center"
				/>
				<h3 className="text-[11px] font-semibold uppercase tracking-widest text-nova-text/90">
					Filter
				</h3>
				<span className="ml-1 text-[10px] text-nova-text-muted/70">
					Always-on predicate that narrows the case list at the wire layer.
				</span>
				<div className="ml-auto">
					{filterPresent ? (
						<button
							type="button"
							onClick={clearFilter}
							className="inline-flex items-center gap-1 px-2 py-1 text-[10px] rounded-md text-nova-text-muted/70 hover:text-nova-error hover:bg-nova-error/10 transition-colors cursor-pointer"
							aria-label="Clear filter"
						>
							<Icon icon={tablerFilterX} width="11" height="11" />
							<span>Clear filter</span>
						</button>
					) : null}
				</div>
			</header>

			{/* Editor body — either the predicate editor (slot
			    defined) or the empty-state add affordance (slot
			    undefined). The two arms are mutually exclusive. */}
			{value.filter !== undefined ? (
				<div className="rounded-md border border-white/[0.04] bg-nova-surface/30 p-3">
					<PredicateCardEditor
						value={value.filter}
						onChange={(next) => setFilter(next)}
						caseTypes={caseTypes}
						currentCaseType={currentCaseType}
						knownInputs={knownInputs}
						onValidityChange={setPredicateValid}
					/>
				</div>
			) : (
				<button
					type="button"
					onClick={addFilter}
					className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2.5 text-[11px] rounded-md border border-dashed border-white/[0.10] text-nova-text-muted/80 hover:text-nova-violet-bright hover:border-nova-violet/30 transition-colors cursor-pointer"
					aria-label="Add filter"
				>
					<Icon icon={tablerFilterPlus} width="12" height="12" />
					<span>Add filter</span>
				</button>
			)}

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
