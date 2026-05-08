// components/builder/case-search-config/ClaimSection.tsx
//
// Composes the case-search authoring surface's Claim section. Owns
// three independent slots on `caseSearchConfig` that together author
// what happens when a user picks a case from search results:
//
//   1. `claimCondition: Predicate?` — when present, the runtime
//      claims a case only if the predicate evaluates true; absent ≡
//      "always claim on selection." Edited via `PredicateCardEditor`.
//   2. `dontClaimAlreadyOwned: boolean` — when true, the runtime
//      skips the claim step on cases the user already owns (avoids
//      a redundant claim API call when re-opening an owned case
//      from search results).
//   3. `blacklistedOwnerIds: ValueExpression?` — when present,
//      evaluates to a space-separated list of owner IDs whose cases
//      are excluded from search results. Rare in practice; the
//      affordance collapses closed by default so it doesn't crowd
//      the section.
//
// `caseSearchConfig` itself is OPTIONAL on the Module schema — a
// module without search authored omits the slot entirely. The first
// edit through this section seeds the slot with the schema's
// required default `{ dontClaimAlreadyOwned: false }` plus whatever
// the user changed. Subsequent edits compose against the existing
// slot.
//
// Validity propagation. Two of the three sub-controls have their
// own validity (the predicate via the type checker; the value
// expression via the type checker). The toggle is structurally
// always-valid (boolean values can't fail validation). The section
// reports `valid: true` when both sub-control verdicts are true (or
// trivially true when their slots are absent) and `false` otherwise.
// Slot-presence short-circuits — both for the predicate and the
// blacklist — defend against stale `false` shadows leaking past a
// clear, mirroring the FiltersSection contract.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import tablerFilterPlus from "@iconify-icons/tabler/filter-plus";
import tablerFilterX from "@iconify-icons/tabler/filter-x";
import tablerForbid from "@iconify-icons/tabler/forbid";
import tablerHandStop from "@iconify-icons/tabler/hand-stop";
import tablerUserShield from "@iconify-icons/tabler/user-shield";
import { useState } from "react";
import { useValidityPropagator } from "@/components/builder/case-list-config/useInnerValidityShadow";
import type { CaseSearchConfig, CaseType } from "@/lib/domain";
import {
	literal,
	matchAll,
	type Predicate,
	type SearchInputDecl,
	term,
	type ValueExpression,
} from "@/lib/domain/predicate";
import { Toggle } from "../../ui/Toggle";
import { ExpressionCardEditor } from "../case-list-config/ExpressionCardEditor";
import { PredicateCardEditor } from "../case-list-config/PredicateCardEditor";

// ── Public types ──────────────────────────────────────────────────

export interface ClaimSectionProps {
	/** Current case-search configuration. `undefined` means the
	 *  module has no caseSearchConfig authored yet — first edit
	 *  through this section seeds the slot with
	 *  `{ dontClaimAlreadyOwned: false }` plus the changed sub-slot. */
	readonly value: CaseSearchConfig | undefined;
	/** Fired with the next configuration. The parent applies the
	 *  next config to its source-of-truth (the doc store's module
	 *  `caseSearchConfig` slot). The callback is fired with a fully-
	 *  formed `CaseSearchConfig` (the seed pattern lives inside this
	 *  section's mutators); the parent never has to materialize the
	 *  required `dontClaimAlreadyOwned` default itself. */
	readonly onChange: (next: CaseSearchConfig) => void;
	/** Blueprint case-type definitions — drives the property pickers
	 *  inside the predicate and expression editors. */
	readonly caseTypes: readonly CaseType[];
	/** The case-type the search runs against. Property references in
	 *  the claim condition and the blacklist expression resolve
	 *  against this scope; relation walks inside `exists`/`missing`
	 *  flip the destination scope as authored. */
	readonly currentCaseType: string;
	/** Search-input declarations from the parent screen. Threaded
	 *  into the predicate / expression editors so an `input(...)`
	 *  term resolves the binding name. The case-search-config panel
	 *  draws these from `mod.caseListConfig?.searchInputs ?? []`. */
	readonly knownInputs?: readonly SearchInputDecl[];
	/** Aggregated validity verdict. `true` when both sub-control
	 *  verdicts are true (or trivially true when their slots are
	 *  absent). The parent gates its save affordance on this. */
	readonly onValidityChange?: (valid: boolean) => void;
}

// ── Seed helper ───────────────────────────────────────────────────

/**
 * Builds the next `CaseSearchConfig` from a possibly-undefined
 * current value plus a slot patch. Pins the schema-required
 * `dontClaimAlreadyOwned` default on first edit so the parent never
 * sees a partial config that fails strict parse, and passes through
 * the existing slot when the section already has a config.
 */
function nextConfig(
	current: CaseSearchConfig | undefined,
	patch: Partial<CaseSearchConfig>,
): CaseSearchConfig {
	const base: CaseSearchConfig = current ?? { dontClaimAlreadyOwned: false };
	return { ...base, ...patch };
}

// ── Top-level component ───────────────────────────────────────────

/**
 * Composes the claim cluster of the case-search authoring surface.
 * Renders three independent sub-controls — claim condition, the
 * already-owned guard toggle, and the blacklisted-owner-IDs
 * expression — and aggregates their validity verdicts for the parent's
 * save gate.
 */
export function ClaimSection({
	value,
	onChange,
	caseTypes,
	currentCaseType,
	knownInputs = [],
	onValidityChange,
}: ClaimSectionProps) {
	// Inner verdicts. Default `true` — when the corresponding slot is
	// undefined, the matching editor is unmounted and the verdict
	// stays trivially true (the slot-presence short-circuit below
	// drops it from the section's aggregate anyway). When the slot
	// is defined, the editor's `onValidityChange` overrides this on
	// its first effect tick — for the blacklist arm this fires on
	// initial mount whether or not the collapse is open, since the
	// editor stays mounted across collapse toggles.
	const [predicateValid, setPredicateValid] = useState(true);
	const [expressionValid, setExpressionValid] = useState(true);

	// Blacklist collapse — closed by default. Spec: rare in practice,
	// so the affordance hides until the author opens it. Header click
	// flips the state; collapsed view shows only the header chrome.
	const [blacklistOpen, setBlacklistOpen] = useState(false);

	const claimCondition = value?.claimCondition;
	const dontClaimAlreadyOwned = value?.dontClaimAlreadyOwned ?? false;
	const blacklist = value?.blacklistedOwnerIds;

	const claimConditionPresent = claimCondition !== undefined;
	const blacklistPresent = blacklist !== undefined;

	// Slot-presence short-circuits — when a slot is undefined, that
	// sub-control is trivially valid regardless of the inner shadow.
	// Without the short-circuit, a stale `false` left behind by a
	// cleared editor would leak past the clear; mirrors the
	// FiltersSection contract.
	const sectionValid =
		(!claimConditionPresent || predicateValid) &&
		(!blacklistPresent || expressionValid);

	// Standardized parent-validity propagation — fires on mount + on
	// every transition, ref-stashed inside the helper against fresh-
	// each-render parent callback identity.
	useValidityPropagator({ isValid: sectionValid, onValidityChange });

	// ── Claim-condition mutators ──
	const setClaimCondition = (next: Predicate | undefined) => {
		onChange(nextConfig(value, { claimCondition: next }));
	};
	const addClaimCondition = () => {
		// `match-all()` sentinel — surfaces the kind-replacement menu
		// in the predicate card's kebab so the author's first
		// interaction picks an operator rather than filling in a
		// scaffolded comparison. Routes through the typed builder so
		// the constructed shape is in lockstep with the schema.
		setClaimCondition(matchAll());
	};
	const clearClaimCondition = () => {
		setClaimCondition(undefined);
	};

	// ── Toggle mutator ──
	const toggleAlreadyOwned = () => {
		onChange(
			nextConfig(value, { dontClaimAlreadyOwned: !dontClaimAlreadyOwned }),
		);
	};

	// ── Blacklist mutators ──
	const setBlacklist = (next: ValueExpression | undefined) => {
		onChange(nextConfig(value, { blacklistedOwnerIds: next }));
	};
	const addBlacklist = () => {
		// Empty-string seed: `term(literal(""))`. The editor body
		// renders the literal-text input which the author fills in
		// with the space-separated owner ID list. Open the body when
		// adding so the freshly-mounted input is immediately
		// visible.
		setBlacklist(term(literal("")));
		setBlacklistOpen(true);
	};
	const clearBlacklist = () => {
		setBlacklist(undefined);
	};

	return (
		<div className="space-y-6">
			{/* ── Claim condition sub-control ──
			    Header carries the title + an add/clear affordance on
			    the right. The chrome (header + add/clear + slot-
			    presence body switch) is materially identical to
			    `FiltersSection`'s — both surface a single optional
			    `Predicate` slot. A future shared "predicate slot
			    card" primitive would unify both; inlining for now
			    since refactoring `FiltersSection` is out of scope. */}
			<div className="space-y-3">
				<header className="flex items-baseline gap-2">
					<div className="w-0.5 h-3 rounded-full bg-nova-violet/40 self-center" />
					<Icon
						icon={tablerHandStop}
						width="14"
						height="14"
						className="text-nova-violet-bright/80 self-center"
					/>
					<h3 className="text-[11px] font-semibold uppercase tracking-widest text-nova-text/90">
						Claim condition
					</h3>
					<span className="ml-1 text-[10px] text-nova-text-muted/70">
						When set, the runtime claims a case only if this evaluates true.
					</span>
					<div className="ml-auto">
						{claimConditionPresent ? (
							<button
								type="button"
								onClick={clearClaimCondition}
								className="inline-flex items-center gap-1 px-2 py-1 text-[10px] rounded-md text-nova-text-muted/70 hover:text-nova-error hover:bg-nova-error/10 transition-colors cursor-pointer"
								aria-label="Clear claim condition"
							>
								<Icon icon={tablerFilterX} width="11" height="11" />
								<span>Clear</span>
							</button>
						) : null}
					</div>
				</header>

				{claimCondition !== undefined ? (
					<div className="rounded-md border border-white/[0.04] bg-nova-surface/30 p-3">
						<PredicateCardEditor
							value={claimCondition}
							onChange={(next) => setClaimCondition(next)}
							caseTypes={caseTypes}
							currentCaseType={currentCaseType}
							knownInputs={knownInputs}
							onValidityChange={setPredicateValid}
						/>
					</div>
				) : (
					<button
						type="button"
						onClick={addClaimCondition}
						className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2.5 text-[11px] rounded-md border border-dashed border-white/[0.10] text-nova-text-muted/80 hover:text-nova-violet-bright hover:border-nova-violet/30 transition-colors cursor-pointer"
						aria-label="Add claim condition"
					>
						<Icon icon={tablerFilterPlus} width="12" height="12" />
						<span>Add claim condition</span>
					</button>
				)}
			</div>

			{/* ── Don't-claim-already-owned toggle ──
			    The toggle sits in its own row; no add/clear chrome
			    because the underlying value is a pure boolean (the
			    schema requires it at all times). Clicking the row's
			    Toggle component flips the slot and seeds
			    `caseSearchConfig` on first edit if the panel hasn't
			    authored it yet. */}
			<div className="flex items-center gap-3 rounded-md border border-white/[0.04] bg-nova-surface/30 p-3">
				<Icon
					icon={tablerUserShield}
					width="14"
					height="14"
					className="text-nova-violet-bright/80"
				/>
				<div className="flex-1 min-w-0">
					<div className="text-[11px] font-semibold uppercase tracking-widest text-nova-text/90">
						Don't claim cases the user already owns
					</div>
					<div className="text-[10px] text-nova-text-muted/70 mt-0.5">
						Skips the claim step when a search result is already owned by the
						current user. Avoids a redundant claim on re-open.
					</div>
				</div>
				<Toggle enabled={dontClaimAlreadyOwned} onToggle={toggleAlreadyOwned} />
			</div>

			{/* ── Blacklisted owner IDs sub-control ──
			    Collapsed by default. The header doubles as the
			    collapse trigger — clicking anywhere on the header row
			    toggles `blacklistOpen`. The add/clear affordances live
			    inside the body so the header stays a single control.

			    Collapse is a VISIBILITY toggle, not a mount toggle —
			    when the slot is defined, `ExpressionCardEditor` stays
			    mounted regardless of collapse state so its type-check
			    pass keeps firing and the section's validity verdict
			    stays accurate even on a closed-collapse mount. Hiding
			    the editor by unmounting would lose the most-recent
			    verdict the moment a backend-loaded invalid expression
			    rendered into a default-collapsed section, and the
			    parent's save gate would silently un-block. */}
			<div className="space-y-3">
				<button
					type="button"
					onClick={() => setBlacklistOpen((prev) => !prev)}
					aria-expanded={blacklistOpen}
					className="w-full flex items-baseline gap-2 text-left cursor-pointer hover:text-nova-violet-bright transition-colors"
				>
					<Icon
						icon={blacklistOpen ? tablerChevronDown : tablerChevronRight}
						width="12"
						height="12"
						className="text-nova-text-muted/70 self-center"
					/>
					<Icon
						icon={tablerForbid}
						width="14"
						height="14"
						className="text-nova-violet-bright/80 self-center"
					/>
					<h3 className="text-[11px] font-semibold uppercase tracking-widest text-nova-text/90">
						Blacklisted owner IDs
					</h3>
					<span className="ml-1 text-[10px] text-nova-text-muted/70">
						{blacklistPresent
							? "Cases owned by these IDs are hidden from search results."
							: "Optional. Hide cases owned by specific IDs from search results."}
					</span>
				</button>

				{blacklist !== undefined ? (
					// Defined slot: editor stays mounted unconditionally.
					// `hidden` swaps the visual presentation while
					// preserving the editor's mount state so its
					// validity verdict keeps reaching the section
					// across collapse toggles.
					<div
						hidden={!blacklistOpen}
						className="rounded-md border border-white/[0.04] bg-nova-surface/30 p-3 space-y-2"
					>
						<ExpressionCardEditor
							value={blacklist}
							onChange={(next) => setBlacklist(next)}
							caseTypes={caseTypes}
							currentCaseType={currentCaseType}
							knownInputs={knownInputs}
							onValidityChange={setExpressionValid}
						/>
						<div className="flex justify-end">
							<button
								type="button"
								onClick={clearBlacklist}
								className="inline-flex items-center gap-1 px-2 py-1 text-[10px] rounded-md text-nova-text-muted/70 hover:text-nova-error hover:bg-nova-error/10 transition-colors cursor-pointer"
								aria-label="Clear blacklisted owner IDs"
							>
								<Icon icon={tablerFilterX} width="11" height="11" />
								<span>Clear</span>
							</button>
						</div>
					</div>
				) : blacklistOpen ? (
					// Undefined slot, body open: surface the add
					// affordance. The collapsed-undefined state shows
					// only the header — the section's "set this slot"
					// surface lives behind the deliberate collapse
					// expand.
					<button
						type="button"
						onClick={addBlacklist}
						className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2.5 text-[11px] rounded-md border border-dashed border-white/[0.10] text-nova-text-muted/80 hover:text-nova-violet-bright hover:border-nova-violet/30 transition-colors cursor-pointer"
						aria-label="Add blacklisted owner IDs"
					>
						<Icon icon={tablerFilterPlus} width="12" height="12" />
						<span>Add blacklisted owner IDs</span>
					</button>
				) : null}
			</div>
		</div>
	);
}
