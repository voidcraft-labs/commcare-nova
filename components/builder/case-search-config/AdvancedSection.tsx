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
// Header chrome + collapse + Clear/Add affordances all compose
// through the shared `OptionalSlotCard<T>` primitive — the same
// primitive `PredicateSlotCard` specializes — so every slot-card
// consumer reads as a sibling. The section's job here is the typed
// `T = ValueExpression` specialization: the `term(literal(""))`
// add-seed, the `<ExpressionCardEditor expectedType="text">` body,
// and the slot-key-asymmetric emit shape (set emits the slot as a
// real key; clear emits the config without the slot key).

"use client";
import tablerForbid from "@iconify-icons/tabler/forbid";
import { ExpressionCardEditor } from "@/components/builder/shared/ExpressionCardEditor";
import { OptionalSlotCard } from "@/components/builder/shared/OptionalSlotCard";
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
 * Renders the `blacklistedOwnerIds` slot via `OptionalSlotCard<ValueExpression>`
 * with collapse on (the niche affordance defaults to closed).
 */
export function AdvancedSection({
	value,
	onChange,
	caseTypes,
	currentCaseType,
	knownInputs = [],
	onValidityChange,
}: AdvancedSectionProps) {
	// ── Blacklist mutators ──
	//
	// Set-vs-clear branches the emitted shape so `key in config` is
	// the genuine slot-presence check on the persisted doc. Setting
	// emits the slot as a real key; clearing emits the config WITHOUT
	// the slot key (a destructured drop, not a `key: undefined`
	// assignment). The asymmetric shape matches the SA-side cluster
	// pickers in `lib/agent/tools/case-search-config/shared.ts` —
	// missing or cleared slots are TRULY absent on the persisted doc,
	// so wire-emit time can distinguish "cleared" from "leaked
	// undefined".
	const setBlacklist = (next: ValueExpression | undefined) => {
		const { blacklistedOwnerIds: _drop, ...rest } = value ?? {};
		void _drop;
		onChange(
			next === undefined ? rest : { ...rest, blacklistedOwnerIds: next },
		);
	};

	return (
		<div className="space-y-6">
			<OptionalSlotCard<ValueExpression>
				icon={tablerForbid}
				title="Excluded owners"
				description="Hide cases owned by specific owner ids."
				addLabel="Add excluded owners"
				clearLabel="Clear excluded owners"
				value={value?.blacklistedOwnerIds}
				onChange={setBlacklist}
				// Empty-string seed — the editor body renders the literal-
				// text input which the author fills in with the space-
				// separated owner ids.
				addSeed={term(literal(""))}
				renderEditor={(
					expression,
					onExpressionChange,
					onValidityChangeInner,
				) => (
					// `expectedType="text"` narrows the type checker's
					// top-level expectation to text. The value is
					// interpreted as a space-separated list of owner ids,
					// so a non-text expression is rejected at authoring
					// time rather than at the validator pass.
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
