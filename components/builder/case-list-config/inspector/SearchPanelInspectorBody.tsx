// components/builder/case-list-config/inspector/SearchPanelInspectorBody.tsx
//
// Properties for the search panel itself — what the search canvas's
// panel chrome selects. Owns every `caseSearchConfig` slot:
//
//   1. `searchScreenTitle` — title above the search inputs.
//   2. `searchScreenSubtitle` — markdown subtitle below the title.
//   3. `searchButtonLabel` — label on the search button.
//   4. `searchButtonDisplayCondition` — optional predicate gating the
//      button's visibility at runtime.
//   5. `excludedOwnerIds` — expression resolving to a space-separated
//      owner-id list whose cases are hidden from search results
//      before paging (collapsed by default; niche).
//
// `caseSearchConfig` is OPTIONAL on the Module schema. A module
// without case-search authored receives an empty config the moment
// any slot takes its first value; the per-slot mutators route through
// the shared `setOptionalSlot` helper so untouched siblings flow
// through unchanged AND a clear emits a destructured drop (the slot
// key is absent on the next config, not a `key: undefined` assignment
// that would land as an own enumerable property under
// `Object.assign(mod, patch)`).

"use client";
import { ExpressionCardEditor } from "@/components/builder/shared/ExpressionCardEditor";
import { OptionalSlotCard } from "@/components/builder/shared/OptionalSlotCard";
import { PredicateSlotCard } from "@/components/builder/shared/PredicateSlotCard";
import { setOptionalSlot } from "@/components/builder/shared/setOptionalSlot";
import type { CaseSearchConfig, CaseType } from "@/lib/domain";
import {
	literal,
	type Predicate,
	type SearchInputDecl,
	term,
	type ValueExpression,
} from "@/lib/domain/predicate";
import { OptionalMarkdownRow } from "./OptionalMarkdownRow";
import { OptionalTextRow } from "./OptionalTextRow";

export interface SearchPanelInspectorBodyProps {
	/** Current case-search configuration. `undefined` means the module
	 *  has no caseSearchConfig authored yet — first edit seeds the slot
	 *  with the changed sub-slot on top of an otherwise-empty config. */
	readonly value: CaseSearchConfig | undefined;
	readonly onChange: (next: CaseSearchConfig) => void;
	readonly caseTypes: readonly CaseType[];
	readonly currentCaseType: string;
	/** Search-input declarations — lets the excluded-owners expression
	 *  reference `input(...)` bindings (wrapped in a when-input-present
	 *  envelope). The show-when condition does NOT: it evaluates on the
	 *  case list before search, so it forbids input refs entirely. */
	readonly knownInputs?: readonly SearchInputDecl[];
}

export function SearchPanelInspectorBody({
	value,
	onChange,
	caseTypes,
	currentCaseType,
	knownInputs = [],
}: SearchPanelInspectorBodyProps) {
	const setTitle = (next: string | undefined) =>
		onChange(setOptionalSlot(value, "searchScreenTitle", next));
	const setSubtitle = (next: string | undefined) =>
		onChange(setOptionalSlot(value, "searchScreenSubtitle", next));
	const setButtonLabel = (next: string | undefined) =>
		onChange(setOptionalSlot(value, "searchButtonLabel", next));
	const setDisplayCondition = (next: Predicate | undefined) =>
		onChange(setOptionalSlot(value, "searchButtonDisplayCondition", next));
	const setExcludedOwners = (next: ValueExpression | undefined) =>
		onChange(setOptionalSlot(value, "excludedOwnerIds", next));

	return (
		<>
			<OptionalTextRow
				label="Title"
				hint="Shown above the search inputs."
				value={value?.searchScreenTitle}
				onCommit={setTitle}
				placeholder="Find a patient"
			/>

			<OptionalMarkdownRow
				label="Subtitle"
				hint="Shown below the title."
				value={value?.searchScreenSubtitle}
				onCommit={setSubtitle}
			/>

			<OptionalTextRow
				label="Search button label"
				hint="Label on the search button."
				value={value?.searchButtonLabel}
				onCommit={setButtonLabel}
				placeholder="Search"
			/>

			<PredicateSlotCard
				title="Show when"
				description="Show the search button only when this condition is met."
				addLabel="Add a Condition"
				clearLabel="Clear"
				clearAriaLabel="Clear the show-when condition"
				value={value?.searchButtonDisplayCondition}
				onChange={setDisplayCondition}
				caseTypes={caseTypes}
				currentCaseType={currentCaseType}
				// No search inputs offered: this condition runs on the case
				// list before search, so an `input(...)` ref always resolves
				// to empty and the gate (forbids-input-ref) rejects it.
				knownInputs={[]}
			/>

			<OptionalSlotCard<ValueExpression>
				title="Excluded owners"
				description="Hide cases that belong to particular owner ids — they never appear in results."
				addLabel="Add Excluded Owners"
				clearLabel="Clear"
				clearAriaLabel="Clear the excluded owners"
				value={value?.excludedOwnerIds}
				onChange={setExcludedOwners}
				// Empty-string seed — the editor body renders a text
				// literal input the author fills with the space-separated
				// owner ids.
				addSeed={term(literal(""))}
				renderEditor={(expression, onExpressionChange, onValidityChange) => (
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
						onValidityChange={onValidityChange}
					/>
				)}
				collapse={{
					defaultOpen: false,
					expandLabel: "Expand excluded owners",
					collapseLabel: "Collapse excluded owners",
				}}
			/>
		</>
	);
}
