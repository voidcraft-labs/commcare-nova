// components/builder/case-search-config/AdvancedSection.tsx
//
// The Advanced section of the case-search authoring surface. Today
// it carries one niche affordance — `excludedOwnerIds`, an expression
// resolving to a space-separated list of owner ids whose cases are
// hidden from search results. The runtime applies the exclusion
// before paging, so excluded-owner rows never surface (distinct from
// a per-case filter, which would suppress rows after paging).
//
// First edit through the section seeds an empty `caseSearchConfig`
// plus the changed slot; subsequent edits compose against the
// existing config. Validity short-circuits to `true` when the slot
// is absent. The expression editor stays mounted across collapse
// toggles so its type-check verdict keeps reaching the section's
// aggregate.
//
// Chrome composes through the shared `OptionalSlotCard<T>` primitive
// (the same primitive `PredicateSlotCard` specializes); this
// section is the `T = ValueExpression` specialization.

"use client";
import tablerForbid from "@iconify-icons/tabler/forbid";
import { useState } from "react";
import { RejectionInline } from "@/components/builder/RejectionNotice";
import { ExpressionCardEditor } from "@/components/builder/shared/ExpressionCardEditor";
import { OptionalSlotCard } from "@/components/builder/shared/OptionalSlotCard";
import { setOptionalSlot } from "@/components/builder/shared/setOptionalSlot";
import type { CaseSearchConfig, CaseType, CommitOutcome } from "@/lib/domain";
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
	 *  `caseSearchConfig` slot) and returns the gated outcome so a
	 *  refused commit surfaces beneath the card. */
	readonly onChange: (next: CaseSearchConfig) => CommitOutcome | undefined;
	/** Blueprint case-type definitions — drives the property pickers
	 *  inside the expression editor. */
	readonly caseTypes: readonly CaseType[];
	/** The case-type the search runs against. Property references in
	 *  the excluded-owners expression resolve against this scope;
	 *  relation walks inside the expression flip the destination
	 *  scope as authored. */
	readonly currentCaseType: string;
	/** Search-input declarations from the parent screen. Threaded
	 *  into the expression editor so an `input(...)` term resolves
	 *  the binding name. The case-search-config panel draws these
	 *  from `mod.caseListConfig?.searchInputs ?? []`. */
	readonly knownInputs?: readonly SearchInputDecl[];
	/** Aggregated validity verdict. `true` when the excluded-owners
	 *  slot is absent OR its expression type-checks. The parent
	 *  gates its save affordance on this. */
	readonly onValidityChange?: (valid: boolean) => void;
}

// ── Top-level component ───────────────────────────────────────────

/**
 * The advanced cluster of the case-search authoring surface. Renders
 * `excludedOwnerIds` via `OptionalSlotCard<ValueExpression>`,
 * collapsed by default since most authors don't reach for it.
 */
export function AdvancedSection({
	value,
	onChange,
	caseTypes,
	currentCaseType,
	knownInputs = [],
	onValidityChange,
}: AdvancedSectionProps) {
	/* The slot card has no inline channel of its own, so this section
	 * holds the gate's finding and renders it beneath the card — a
	 * whole-doc refusal the expression editor's own type check can't
	 * see. Cleared on the next commit that lands. */
	const [rejection, setRejection] = useState<string | null>(null);
	const setExcludedOwners = (next: ValueExpression | undefined) => {
		const outcome = onChange(setOptionalSlot(value, "excludedOwnerIds", next));
		setRejection(outcome && !outcome.ok ? (outcome.messages[0] ?? null) : null);
	};

	return (
		<div className="space-y-6">
			<OptionalSlotCard<ValueExpression>
				icon={tablerForbid}
				title="Excluded owners"
				description="Hide cases owned by specific owner ids."
				addLabel="Add excluded owners"
				clearLabel="Clear excluded owners"
				value={value?.excludedOwnerIds}
				onChange={setExcludedOwners}
				// Empty-string seed — the editor body renders a text
				// literal input the author fills with the space-separated
				// owner ids.
				addSeed={term(literal(""))}
				renderEditor={(
					expression,
					onExpressionChange,
					onValidityChangeInner,
				) => (
					// `expectedType="text"` narrows the type checker's
					// top-level expectation. A non-text expression is
					// rejected at authoring time rather than at the
					// validator pass.
					<ExpressionCardEditor
						value={expression}
						onChange={onExpressionChange}
						caseTypes={caseTypes}
						currentCaseType={currentCaseType}
						knownInputs={knownInputs}
						expectedType="text"
						onValidityChange={onValidityChangeInner}
					/>
				)}
				collapse={{
					defaultOpen: false,
					expandLabel: "Expand excluded owners",
					collapseLabel: "Collapse excluded owners",
				}}
				onValidityChange={onValidityChange}
			/>
			{/* The gate refused the last slot commit — the card above still
			 * shows the authored expression; this names the finding. */}
			<RejectionInline message={rejection} />
		</div>
	);
}
