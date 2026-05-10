// components/builder/case-search-config/AdvancedSection.tsx
//
// Composes the case-search authoring surface's Advanced section. Holds
// niche search-side filters — affordances most authors never reach for
// but a small subset depend on. The section name is intentionally
// abstract: it scopes the section to the cluster's role (niche
// filters), not its contents.
//
// Slot inventory:
//
//   - `blacklistedOwnerIds: ValueExpression?` — when present, evaluates
//     to a space-separated list of owner ids whose cases are excluded
//     from the search-results scope. The runtime applies this exclusion
//     before paging the results back to the search screen, so a row
//     owned by an excluded user never surfaces — distinct from a
//     case-by-case filter, which would suppress rows post-paging. The
//     affordance collapses closed by default so it doesn't crowd the
//     section.
//
// `caseSearchConfig` itself is OPTIONAL on the Module schema — a
// module without search authored omits the slot entirely. The first
// edit through this section seeds the slot as an empty object plus
// whatever the user changed; subsequent edits compose against the
// existing slot.
//
// Validity propagation. The blacklist expression has its own validity
// via the type checker. The section reports `valid: true` when the
// slot is absent (slot-presence short-circuit) and `valid: false`
// when the slot is present and the expression's type-check verdict
// is `false`. The expression editor stays mounted whenever the slot
// is defined (the collapse only toggles visibility), so the editor's
// type-check verdict keeps reaching the section's validity aggregate
// regardless of collapse state.
//
// Header chrome composes through the shared `SlotCardHeader`
// primitive — the same primitive `PredicateSlotCard` consumes — so
// every slot-card consumer's header reads as a sibling. The Clear
// affordance lives in the header at `ml-auto`, surfacing whenever
// the slot is defined regardless of collapse state. The collapse
// toggle is opt-in via the primitive's `collapse` prop and controls
// only the body's visibility — Clear stays reachable in one click
// whenever the slot is present. The chevron's `aria-controls` points
// at the disclosed body's `id` so the screen-reader contract names
// the toggle ↔ region relationship per the W3C disclosure pattern.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerForbid from "@iconify-icons/tabler/forbid";
import tablerPlus from "@iconify-icons/tabler/plus";
import { useId, useState } from "react";
import { ExpressionCardEditor } from "@/components/builder/shared/ExpressionCardEditor";
import { SlotCardHeader } from "@/components/builder/shared/SlotCardHeader";
import { useValidityPropagator } from "@/components/builder/shared/useInnerValidityShadow";
import type { CaseSearchConfig, CaseType } from "@/lib/domain";
import {
	literal,
	type SearchInputDecl,
	term,
	type ValueExpression,
} from "@/lib/domain/predicate";

// ── Public types ──────────────────────────────────────────────────

export interface AdvancedSectionProps {
	/** Current case-search configuration. `undefined` means the
	 *  module has no caseSearchConfig authored yet — first edit
	 *  through this section seeds the slot with the changed sub-slot
	 *  on top of an otherwise-empty config. */
	readonly value: CaseSearchConfig | undefined;
	/** Fired with the next configuration. The parent applies the
	 *  next config to its source-of-truth (the doc store's module
	 *  `caseSearchConfig` slot). */
	readonly onChange: (next: CaseSearchConfig) => void;
	/** Blueprint case-type definitions — drives the property pickers
	 *  inside the expression editor. */
	readonly caseTypes: readonly CaseType[];
	/** The case-type the search runs against. Property references in
	 *  the blacklist expression resolve against this scope; relation
	 *  walks inside the expression flip the destination scope as
	 *  authored. */
	readonly currentCaseType: string;
	/** Search-input declarations from the parent screen. Threaded
	 *  into the expression editor so an `input(...)` term resolves
	 *  the binding name. The case-search-config panel draws these
	 *  from `mod.caseListConfig?.searchInputs ?? []`. */
	readonly knownInputs?: readonly SearchInputDecl[];
	/** Aggregated validity verdict. `true` when the blacklist slot is
	 *  absent OR its expression type-checks. The parent gates its
	 *  save affordance on this. */
	readonly onValidityChange?: (valid: boolean) => void;
}

// ── Top-level component ───────────────────────────────────────────

/**
 * Composes the advanced cluster of the case-search authoring surface.
 * Renders the `blacklistedOwnerIds` slot as a single collapsible
 * sub-control inside the section's chrome.
 */
export function AdvancedSection({
	value,
	onChange,
	caseTypes,
	currentCaseType,
	knownInputs = [],
	onValidityChange,
}: AdvancedSectionProps) {
	// Inner verdict. Default `true` — when the slot is undefined the
	// section's slot-presence short-circuit drops the verdict from the
	// aggregate anyway. The editor stays mounted whenever the slot is
	// defined (the collapse only toggles visibility), so the verdict
	// fires on initial mount regardless of collapse state.
	const [expressionValid, setExpressionValid] = useState(true);

	// Blacklist collapse — closed by default. Niche affordance, so the
	// body hides until the author opens it. Header click flips the
	// state; collapsed view shows only the header chrome.
	const [blacklistOpen, setBlacklistOpen] = useState(false);

	// DOM id for the disclosed region — the chevron toggle's
	// `aria-controls` points at this id so the screen-reader contract
	// names the toggle ↔ region relationship (W3C disclosure pattern).
	// `useId` produces a stable per-instance id that survives re-renders.
	const blacklistRegionId = useId();

	const blacklist = value?.blacklistedOwnerIds;
	const blacklistPresent = blacklist !== undefined;

	// Slot-presence short-circuit. When the slot is undefined the
	// editor isn't mounted (and never was), so `expressionValid`'s
	// stash is meaningless — drop it from the aggregate. When the
	// slot is defined the editor is mounted unconditionally and its
	// verdict carries.
	const sectionValid = !blacklistPresent || expressionValid;
	useValidityPropagator({ isValid: sectionValid, onValidityChange });

	// ── Blacklist mutators ──
	const setBlacklist = (next: ValueExpression | undefined) => {
		onChange({ ...(value ?? {}), blacklistedOwnerIds: next });
	};
	const addBlacklist = () => {
		// Empty-string seed: `term(literal(""))`. The editor body
		// renders the literal-text input which the author fills in
		// with the space-separated owner ID list. Open the body when
		// adding so the freshly-mounted input is immediately visible.
		setBlacklist(term(literal("")));
		setBlacklistOpen(true);
	};
	const clearBlacklist = () => {
		setBlacklist(undefined);
	};

	return (
		<div className="space-y-6">
			{/* ── Excluded owners sub-control ──
			    Collapsed by default. The shared `SlotCardHeader`
			    primitive owns the header chrome; the chevron toggle
			    threads in via its `collapse` prop (carrying the
			    disclosed body's `id` so `aria-controls` resolves) and
			    the Clear button via the grouped `clear` prop, so the
			    affordances surface whenever the slot is defined
			    regardless of collapse state. The Add affordance lives
			    inside the body (only shown when the body is open and
			    the slot is undefined).

			    Collapse is a VISIBILITY toggle, not a mount toggle —
			    when the slot is defined, `ExpressionCardEditor` stays
			    mounted regardless of collapse state so its type-check
			    verdict keeps reaching the section's validity aggregate
			    on every render pass. */}
			<div className="space-y-3">
				<SlotCardHeader
					icon={tablerForbid}
					title="Excluded owners"
					description="Hide cases owned by specific user IDs."
					collapse={{
						isOpen: blacklistOpen,
						onToggle: () => setBlacklistOpen((prev) => !prev),
						expandLabel: "Expand excluded owners",
						collapseLabel: "Collapse excluded owners",
						controlsId: blacklistRegionId,
					}}
					clear={
						blacklistPresent
							? {
									onClick: clearBlacklist,
									label: "Clear excluded owners",
								}
							: undefined
					}
				/>

				{/* Disclosed region — wrapper carries the id the chevron's
				    `aria-controls` points at, so the W3C disclosure
				    relationship resolves uniformly across all four
				    (collapsed/open × undefined/defined) states.
				    `hidden={!blacklistOpen}` puts the visibility toggle on
				    the wrapper, not on the inner conditional, so a
				    closed-undefined render keeps the region present in the
				    DOM (empty body, but resolvable via `aria-controls`). */}
				<div id={blacklistRegionId} hidden={!blacklistOpen}>
					{blacklist !== undefined ? (
						// Defined slot: editor stays mounted unconditionally.
						// `hidden` on the wrapper swaps the visual
						// presentation while preserving the editor's mount
						// state so its validity verdict keeps reaching the
						// section across collapse toggles.
						//
						// `expectedType="text"` narrows the type checker's
						// top-level expectation to text. The value is
						// interpreted as a space-separated list of owner
						// IDs, so a non-text expression is rejected at
						// authoring time rather than at the validator pass.
						<div className="rounded-md border border-white/[0.04] bg-nova-surface/30 p-3">
							<ExpressionCardEditor
								value={blacklist}
								onChange={(next) => setBlacklist(next)}
								caseTypes={caseTypes}
								currentCaseType={currentCaseType}
								knownInputs={knownInputs}
								expectedType="text"
								onValidityChange={setExpressionValid}
							/>
						</div>
					) : (
						// Undefined slot: surface the add affordance inside
						// the disclosed region. The chevron's
						// `aria-controls` points at the wrapper above, so
						// expanding reveals the Add button as the disclosed
						// content.
						<button
							type="button"
							onClick={addBlacklist}
							className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2.5 text-[11px] rounded-md border border-dashed border-white/[0.10] text-nova-text-muted/80 hover:text-nova-violet-bright hover:border-nova-violet/30 transition-colors cursor-pointer"
							aria-label="Add excluded owners"
						>
							<Icon icon={tablerPlus} width="12" height="12" />
							<span>Add excluded owners</span>
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
