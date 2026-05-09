// components/builder/case-search-config/AdvancedSection.tsx
//
// Composes the case-search authoring surface's Advanced section. Holds
// niche search-side filters — affordances most authors never reach for
// but a small subset depend on. Today the section hosts a single slot;
// the section name is intentionally abstract so future advanced
// filters can land here without a rename.
//
// Slot inventory:
//
//   - `blacklistedOwnerIds: ValueExpression?` — when present, evaluates
//     to a space-separated list of owner ids whose cases are excluded
//     from the search-results scope. The runtime applies this exclusion
//     before paging the results back to the search screen, so a row
//     owned by a blacklisted user never surfaces — distinct from a
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
// is defined (the collapse only toggles visibility), so a backend-
// loaded invalid expression keeps surfacing its verdict even on a
// default-collapsed mount — without that contract, the parent's
// save gate would silently un-block on a closed-collapse load.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerChevronDown from "@iconify-icons/tabler/chevron-down";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import tablerForbid from "@iconify-icons/tabler/forbid";
import tablerPlus from "@iconify-icons/tabler/plus";
import tablerX from "@iconify-icons/tabler/x";
import { useState } from "react";
import { ExpressionCardEditor } from "@/components/builder/shared/ExpressionCardEditor";
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
 * Renders one collapsible sub-control today (`blacklistedOwnerIds`);
 * named for the role, not the contents.
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
			{/* ── Blacklisted owner IDs sub-control ──
			    Collapsed by default. The header doubles as the collapse
			    trigger — clicking anywhere on the header row toggles
			    `blacklistOpen`. The add/clear affordances live inside
			    the body so the header stays a single control.

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
						Exclude cases owned by these users from search results
					</h3>
					<span className="ml-1 text-[10px] text-nova-text-muted/70">
						{blacklistPresent
							? "Cases owned by these IDs are hidden from search results."
							: "Optional. Hide cases owned by specific user IDs from search results."}
					</span>
				</button>

				{blacklist !== undefined ? (
					// Defined slot: editor stays mounted unconditionally.
					// `hidden` swaps the visual presentation while
					// preserving the editor's mount state so its validity
					// verdict keeps reaching the section across collapse
					// toggles.
					//
					// `expectedType="text"` narrows the type checker's
					// top-level expectation to text. The value is
					// interpreted as a space-separated list of owner
					// IDs, so a non-text expression is rejected at
					// authoring time rather than at the validator pass.
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
							expectedType="text"
							onValidityChange={setExpressionValid}
						/>
						<div className="flex justify-end">
							<button
								type="button"
								onClick={clearBlacklist}
								className="inline-flex items-center gap-1 px-2 py-1 text-[10px] rounded-md text-nova-text-muted/70 hover:text-nova-error hover:bg-nova-error/10 transition-colors cursor-pointer"
								aria-label="Clear blacklisted owner IDs"
							>
								<Icon icon={tablerX} width="11" height="11" />
								<span>Clear</span>
							</button>
						</div>
					</div>
				) : blacklistOpen ? (
					// Undefined slot, body open: surface the add affordance.
					// The collapsed-undefined state shows only the header —
					// the section's "set this slot" surface lives behind
					// the deliberate collapse expand.
					<button
						type="button"
						onClick={addBlacklist}
						className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2.5 text-[11px] rounded-md border border-dashed border-white/[0.10] text-nova-text-muted/80 hover:text-nova-violet-bright hover:border-nova-violet/30 transition-colors cursor-pointer"
						aria-label="Add blacklisted owner IDs"
					>
						<Icon icon={tablerPlus} width="12" height="12" />
						<span>Add blacklisted owner IDs</span>
					</button>
				) : null}
			</div>
		</div>
	);
}
