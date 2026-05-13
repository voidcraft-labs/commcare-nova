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
import { ExpressionCardEditor } from "@/components/builder/shared/ExpressionCardEditor";
import { OptionalSlotCard } from "@/components/builder/shared/OptionalSlotCard";
import { setOptionalSlot } from "@/components/builder/shared/setOptionalSlot";
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
	const setExcludedOwners = (next: ValueExpression | undefined) => {
		onChange(setOptionalSlot(value, "excludedOwnerIds", next));
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
		</div>
	);
}
