// components/builder/shared/PredicateSlotCard.tsx
//
// Optional-Predicate slot card. Thin specialization of the generic
// `OptionalSlotCard<T>` primitive, fixing `T` to `Predicate` and
// supplying:
//
//   - The `matchAll()` add-seed — the canonical "always true"
//     sentinel for an optional Predicate slot. `match-all()` mounts
//     as a sentinel card whose kind-replace menu lets the author
//     swap in any concrete operator on first interaction without
//     seeing a false-error state pre-emptively (a comparison-card
//     scaffold would surface `valid: false` immediately because the
//     literal-vs-property type-check hasn't been satisfied; match-
//     all stays `valid: true`).
//   - A `renderEditor` wrapping `<PredicateCardEditor>` with the
//     inner-validity callback piped to the primitive's shadow.
//
// The card does NOT enable collapse — when the slot is defined, the
// editor mounts and stays mounted until the consumer's
// `onChange(undefined)` flips it. Consumers that need a collapse
// affordance specialize `OptionalSlotCard` directly instead of
// reaching for this card.

"use client";
import type { CaseType } from "@/lib/domain";
import type { SearchInputDecl } from "@/lib/domain/predicate";
import { matchAll, type Predicate } from "@/lib/domain/predicate";
import { OptionalSlotCard } from "./OptionalSlotCard";
import { PredicateCardEditor } from "./PredicateCardEditor";

// ── Public types ──────────────────────────────────────────────────

export interface PredicateSlotCardProps {
	/** Header title — short label rendered as the section's etched
	 *  console eyebrow. */
	readonly title: string;
	/** Header hint — single-line description below the title that
	 *  tells the author what the slot does. */
	readonly description: string;
	/** Empty-state CTA label — visible button text + `aria-label`. */
	readonly addLabel: string;
	/** Header "Clear ..." label — visible button text + `aria-label`. */
	readonly clearLabel: string;
	/** Current Predicate slot value. `undefined` ≡ slot empty. */
	readonly value: Predicate | undefined;
	/** Fired when the slot transitions. Receives `undefined` on Clear;
	 *  receives a `Predicate` on Add (seeded with `matchAll()`) and on
	 *  every inner edit. */
	readonly onChange: (next: Predicate | undefined) => void;
	/** Blueprint case-type definitions — drives the property pickers
	 *  inside the predicate editor. */
	readonly caseTypes: readonly CaseType[];
	/** The case-type the predicate runs against. Property references
	 *  resolve against this scope; relation walks inside
	 *  `exists`/`missing` flip the destination scope as authored. */
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
 * Optional-Predicate slot card. Specializes `OptionalSlotCard<Predicate>`
 * with the `matchAll()` add-seed and a `<PredicateCardEditor>` body.
 * No collapse — the editor mounts when the slot is defined and stays
 * mounted until cleared.
 */
export function PredicateSlotCard({
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
	return (
		<OptionalSlotCard<Predicate>
			title={title}
			description={description}
			addLabel={addLabel}
			clearLabel={clearLabel}
			value={value}
			onChange={onChange}
			addSeed={matchAll()}
			renderEditor={(predicate, onPredicateChange, onValidityChangeInner) => (
				<PredicateCardEditor
					value={predicate}
					onChange={onPredicateChange}
					caseTypes={caseTypes}
					currentCaseType={currentCaseType}
					knownInputs={knownInputs}
					onValidityChange={onValidityChangeInner}
				/>
			)}
			onValidityChange={onValidityChange}
		/>
	);
}
