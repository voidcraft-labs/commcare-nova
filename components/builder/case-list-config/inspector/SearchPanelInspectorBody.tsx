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
import { Icon } from "@iconify/react/offline";
import tablerChevronRight from "@iconify-icons/tabler/chevron-right";
import { type ReactNode, useState } from "react";
import { OptionalMarkdownRow } from "@/components/builder/inspector/OptionalMarkdownRow";
import { OptionalTextRow } from "@/components/builder/inspector/OptionalTextRow";
import { ExpressionCardEditor } from "@/components/builder/shared/ExpressionCardEditor";
import { OptionalSlotCard } from "@/components/builder/shared/OptionalSlotCard";
import { PredicateSlotCard } from "@/components/builder/shared/PredicateSlotCard";
import { setOptionalSlot } from "@/components/builder/shared/setOptionalSlot";
import type { CaseSearchConfig, CaseType } from "@/lib/domain";
import {
	compatibleTypesFor,
	literal,
	type Predicate,
	type SearchInputDecl,
	type SlotConstraint,
	term,
	type ValueExpression,
} from "@/lib/domain/predicate";
import { NO_SEARCH_INPUTS } from "../searchInputResolution";

/** The excluded-owners expression resolves to a space-separated owner-
 *  id list — a text value. Module-const so the constraint identity
 *  stays stable across renders. */
const EXCLUDED_OWNERS_CONSTRAINT: SlotConstraint = {
	accepts: compatibleTypesFor("text"),
};

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
	/** False for filter-only automatic search, whose screen copy never renders. */
	readonly hasVisibleSearchScreen?: boolean;
}

export function SearchPanelInspectorBody({
	value,
	onChange,
	caseTypes,
	currentCaseType,
	knownInputs = [],
	hasVisibleSearchScreen = true,
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
	const advancedIsActive =
		value?.searchButtonDisplayCondition !== undefined ||
		value?.excludedOwnerIds !== undefined;

	return (
		<>
			{hasVisibleSearchScreen ? (
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
				</>
			) : (
				<p className="rounded-lg border border-white/[0.07] bg-white/[0.025] px-3 py-3 text-[12px] leading-relaxed text-nova-text-secondary">
					People go straight to Results, so there is no title or button to
					customize. These rules still shape the automatic search.
				</p>
			)}

			<AdvancedSearchSettings
				active={advancedIsActive}
				label={hasVisibleSearchScreen ? "Advanced" : "Automatic search rules"}
				defaultOpen={!hasVisibleSearchScreen}
			>
				<PredicateSlotCard
					title={
						hasVisibleSearchScreen
							? "Conditional button"
							: "Run automatic search conditionally"
					}
					description={
						hasVisibleSearchScreen
							? "Only show the search button when a particular condition is met."
							: "Go straight to filtered Results only when a particular condition is met."
					}
					addLabel="Add a condition"
					clearLabel="Clear"
					clearAriaLabel={
						hasVisibleSearchScreen
							? "Clear the search button condition"
							: "Clear the automatic search condition"
					}
					value={value?.searchButtonDisplayCondition}
					onChange={setDisplayCondition}
					caseTypes={caseTypes}
					currentCaseType={currentCaseType}
					// Forbids input refs — runs on the case list before search.
					// See NO_SEARCH_INPUTS.
					knownInputs={NO_SEARCH_INPUTS}
				/>

				<OptionalSlotCard<ValueExpression>
					title="Ownership exclusions"
					description="For rare workflows: keep cases assigned to particular owners out of the results."
					addLabel="Choose cases to exclude"
					clearLabel="Clear"
					clearAriaLabel="Clear ownership exclusions"
					value={value?.excludedOwnerIds}
					onChange={setExcludedOwners}
					// Empty-string seed — the editor body renders a text
					// literal input the author fills with the space-separated
					// owner ids.
					addSeed={term(literal(""))}
					renderEditor={(expression, onExpressionChange, onValidityChange) => (
						// The text constraint narrows the editor's kind menu +
						// value sources to text-producing shapes, so a
						// non-text expression is unauthorable rather than
						// rejected at the validator pass.
						<ExpressionCardEditor
							value={expression}
							onChange={onExpressionChange}
							caseTypes={caseTypes}
							currentCaseType={currentCaseType}
							knownInputs={knownInputs}
							constraint={EXCLUDED_OWNERS_CONSTRAINT}
							onValidityChange={onValidityChange}
						/>
					)}
				/>
			</AdvancedSearchSettings>
		</>
	);
}

function AdvancedSearchSettings({
	active,
	label,
	defaultOpen,
	children,
}: {
	readonly active: boolean;
	readonly label: string;
	readonly defaultOpen: boolean;
	readonly children: ReactNode;
}) {
	const [open, setOpen] = useState(active || defaultOpen);
	return (
		<section className="border-t border-white/[0.06] pt-1">
			<button
				type="button"
				onClick={() => setOpen((current) => !current)}
				aria-expanded={open}
				className="group flex min-h-11 w-full cursor-pointer items-center gap-2 text-left"
			>
				<Icon
					icon={tablerChevronRight}
					width="13"
					height="13"
					className={`shrink-0 text-nova-text-muted transition-transform ${open ? "rotate-90" : ""}`}
				/>
				<span className="text-[12px] font-medium text-nova-text-secondary transition-colors group-hover:text-nova-text">
					{label}
				</span>
				{active && (
					<span className="ml-auto text-[11px] text-nova-violet-bright">
						Settings in use
					</span>
				)}
			</button>
			{open && <div className="space-y-5 pb-2 pt-2">{children}</div>}
		</section>
	);
}
