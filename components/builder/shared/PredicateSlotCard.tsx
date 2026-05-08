// components/builder/shared/PredicateSlotCard.tsx
//
// Optional-Predicate slot card. Composes the chrome that several
// authoring surfaces share when authoring a single optional
// `Predicate` slot:
//
//   1. A section header — violet rail + per-consumer icon + title +
//      hint line, plus a "Clear" affordance on the right when the
//      slot is defined.
//   2. The body switch — `<PredicateCardEditor>` when the slot is
//      defined; a dashed "Add ..." CTA when the slot is undefined.
//   3. The validity contract — when the slot is undefined the card
//      reports `valid: true` (slot-presence short-circuit);
//      otherwise it forwards the predicate editor's verdict.
//
// Today's consumers:
//
//   - `FiltersSection` (case-list-config) — `caseListConfig.filter`.
//     The wrapping section adds a live preview panel beneath this
//     card; the card owns only the editor + chrome.
//   - `ClaimSection` (case-search-config) — `caseSearchConfig.claimCondition`.
//     The wrapping section composes the toggle + blacklist
//     sub-controls beside this card.
//
// The card hard-codes the add-affordance seed to `matchAll()` — the
// canonical "always true" sentinel for an optional Predicate slot.
// `match-all()` mounts as a sentinel card whose kind-replace menu
// lets the author swap in any concrete operator on first interaction
// without seeing a false-error state pre-emptively (a comparison-
// card scaffold would surface `valid: false` immediately because
// the literal-vs-property type-check hasn't been satisfied; match-
// all stays `valid: true`).
//
// The card does NOT collapse the editor visually — the editor mounts
// when the slot is defined and stays mounted until the consumer's
// `onChange(undefined)` flips the slot. Consumers that need a
// collapse affordance compose around the card; the card itself does
// not implement collapse so that the slot-presence short-circuit
// stays the only validity gate.

"use client";
import { Icon, type IconifyIcon } from "@iconify/react/offline";
import tablerFilterPlus from "@iconify-icons/tabler/filter-plus";
import tablerFilterX from "@iconify-icons/tabler/filter-x";
import { useState } from "react";
import { PredicateCardEditor } from "@/components/builder/case-list-config/PredicateCardEditor";
import { useValidityPropagator } from "@/components/builder/shared/useInnerValidityShadow";
import type { CaseType } from "@/lib/domain";
import type { SearchInputDecl } from "@/lib/domain/predicate";
import { matchAll, type Predicate } from "@/lib/domain/predicate";

// ── Public types ──────────────────────────────────────────────────

export interface PredicateSlotCardProps {
	/** Header icon — chosen by the consumer to match the surface
	 *  (e.g., `tabler/filter` for the case-list filter, `tabler/hand-stop`
	 *  for the search claim condition). */
	readonly icon: IconifyIcon;
	/** Header title — short uppercase label (e.g., "Filter",
	 *  "Claim condition"). */
	readonly title: string;
	/** Header hint — single-line description below the title that
	 *  tells the author what the slot does. */
	readonly description: string;
	/** Empty-state CTA label. Used for both the dashed "Add ..."
	 *  button (when the slot is undefined) and as the seed for the
	 *  `aria-label`, so the consumer's authored copy reads
	 *  consistently in screen readers. */
	readonly addLabel: string;
	/** Header "Clear ..." label — used as both the visible button
	 *  text AND the `aria-label` so screen readers and visual
	 *  readers see the same words. Consumers can choose a tight
	 *  visible label (e.g., "Clear") and the same string flows to
	 *  the accessible name. */
	readonly clearLabel: string;
	/** Current Predicate slot value. `undefined` ≡ slot empty (the
	 *  card surfaces the dashed add affordance and reports
	 *  trivially-valid). */
	readonly value: Predicate | undefined;
	/** Fired when the slot transitions. Receives `undefined` on
	 *  Clear; receives a `Predicate` on Add (seeded with `matchAll()`)
	 *  and on every inner edit. The consumer routes this back into
	 *  its source-of-truth (the doc store's slot). */
	readonly onChange: (next: Predicate | undefined) => void;
	/** Blueprint case-type definitions — drives the property pickers
	 *  inside the predicate editor. */
	readonly caseTypes: readonly CaseType[];
	/** The case-type the predicate runs against. Property
	 *  references resolve against this scope; relation walks
	 *  inside `exists`/`missing` flip the destination scope as
	 *  authored. */
	readonly currentCaseType: string;
	/** Search-input declarations from the parent screen. Threaded
	 *  into the predicate editor so `input(...)` terms resolve. */
	readonly knownInputs?: readonly SearchInputDecl[];
	/** Aggregated validity verdict. `true` when the slot is
	 *  undefined OR the predicate type-checks; `false` when a
	 *  defined predicate fails its type-check pass. */
	readonly onValidityChange?: (valid: boolean) => void;
}

// ── Component ─────────────────────────────────────────────────────

/**
 * Optional-Predicate slot card. Owns the section-header chrome +
 * add/clear affordance + slot-presence body switch + validity
 * propagation contract that authoring surfaces share when
 * presenting a single optional `Predicate` slot.
 *
 * Validity contract: when `value === undefined` the card reports
 * `valid: true` regardless of any stale inner shadow. The
 * slot-presence short-circuit defends against a verdict left behind
 * by a cleared editor leaking past the clear — without it, the next
 * Add would flash invalid for one frame on the editor's mount.
 */
export function PredicateSlotCard({
	icon,
	title,
	description,
	addLabel,
	clearLabel,
	value,
	onChange,
	caseTypes,
	currentCaseType,
	knownInputs = [],
	onValidityChange,
}: PredicateSlotCardProps) {
	// Inner predicate-editor verdict shadow. Default `true` — when
	// the slot is undefined, the editor is unmounted and the verdict
	// stays trivially valid. When the slot is defined, the editor's
	// `onValidityChange` overrides this on its first effect tick.
	const [predicateValid, setPredicateValid] = useState(true);

	const slotPresent = value !== undefined;
	// When the slot is undefined the card is trivially valid
	// regardless of `predicateValid`'s stash. Without the slot-
	// presence guard, a stale `false` left behind by a cleared
	// predicate would leak past the clear.
	const isValid = !slotPresent || predicateValid;

	useValidityPropagator({ isValid, onValidityChange });

	// ── Mutators ──
	const handleAdd = () => {
		// `matchAll()` seed — the canonical "always true" sentinel.
		// The kind-replace menu inside `PredicateCardEditor` lets
		// the author swap in any concrete operator on first
		// interaction. Routes through the typed builder so the
		// constructed shape stays in lockstep with the schema.
		onChange(matchAll());
	};
	const handleClear = () => {
		onChange(undefined);
	};

	return (
		<div className="space-y-3">
			{/* Section header. Violet rail + icon + title + hint line +
			    Clear button on the right when the slot is defined. */}
			<header className="flex items-baseline gap-2">
				<div className="w-0.5 h-3 rounded-full bg-nova-violet/40 self-center" />
				<Icon
					icon={icon}
					width="14"
					height="14"
					className="text-nova-violet-bright/80 self-center"
				/>
				<h3 className="text-[11px] font-semibold uppercase tracking-widest text-nova-text/90">
					{title}
				</h3>
				<span className="ml-1 text-[10px] text-nova-text-muted/70">
					{description}
				</span>
				<div className="ml-auto">
					{slotPresent ? (
						<button
							type="button"
							onClick={handleClear}
							className="inline-flex items-center gap-1 px-2 py-1 text-[10px] rounded-md text-nova-text-muted/70 hover:text-nova-error hover:bg-nova-error/10 transition-colors cursor-pointer"
							aria-label={clearLabel}
						>
							<Icon icon={tablerFilterX} width="11" height="11" />
							<span>{clearLabel}</span>
						</button>
					) : null}
				</div>
			</header>

			{/* Body — predicate editor when the slot is defined; the
			    dashed empty-state CTA when undefined. The two arms are
			    mutually exclusive. */}
			{value !== undefined ? (
				<div className="rounded-md border border-white/[0.04] bg-nova-surface/30 p-3">
					<PredicateCardEditor
						value={value}
						onChange={(next) => onChange(next)}
						caseTypes={caseTypes}
						currentCaseType={currentCaseType}
						knownInputs={knownInputs}
						onValidityChange={setPredicateValid}
					/>
				</div>
			) : (
				<button
					type="button"
					onClick={handleAdd}
					className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2.5 text-[11px] rounded-md border border-dashed border-white/[0.10] text-nova-text-muted/80 hover:text-nova-violet-bright hover:border-nova-violet/30 transition-colors cursor-pointer"
					aria-label={addLabel}
				>
					<Icon icon={tablerFilterPlus} width="12" height="12" />
					<span>{addLabel}</span>
				</button>
			)}
		</div>
	);
}
