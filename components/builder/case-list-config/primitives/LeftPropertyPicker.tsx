// components/builder/case-list-config/primitives/LeftPropertyPicker.tsx
//
// Wraps `PropertyPicker` with a non-Term round-trip guard. Drives
// the LEFT slot of every Predicate operator that carries
// `left: ValueExpression` — `compare` / `in` / `between` /
// `is-null` / `is-blank`. The schema admits any `ValueExpression`
// at those slots; this composer EDITS the canonical case-property
// reference shape (`term(prop(currentCaseType, name))`) and
// renders a read-only badge for any other shape.
//
// Round-trip contract:
//   - When `value.kind === "term"` AND `value.term.kind === "prop"`,
//     the picker renders the editing surface (a `PropertyPicker`
//     bound to the optional caller-provided property filter). The
//     `onChange` fires only when the user picks a property from
//     the dropdown.
//   - When `value` is any other shape — a higher-order
//     ValueExpression arm (`arith` / `if` / `count` / etc.) OR a
//     Term-arm Term that isn't a property reference (literal,
//     search-input, session-context, session-user) — the picker
//     renders a read-only "Expression: <kind>" badge with an
//     explicit "Replace" button. Replace overwrites the slot with
//     `term(prop(currentCaseType, firstApplicable.name))`. No
//     `onChange` fires until the user clicks Replace.
//
// Authoring shape lives in one file so the five LEFT-slot cards
// can't accidentally bypass the round-trip preservation; they
// mount this primitive instead of `PropertyPicker` directly.

"use client";
import type { CaseProperty } from "@/lib/domain";
import {
	prop,
	type ValueExpression,
	term as wrapTerm,
} from "@/lib/domain/predicate";
import { usePredicateEditContext } from "../editorContext";
import { PropertyPicker } from "./PropertyPicker";
import { HigherOrderBadge } from "./ValueExpressionPicker";

interface LeftPropertyPickerProps {
	/** Current LEFT-slot value. The schema admits any
	 *  `ValueExpression`; this picker edits only the
	 *  property-reference shape and badges everything else. */
	readonly value: ValueExpression;
	/** Fired when the user picks a property from the dropdown OR
	 *  clicks Replace on the badge. Always emits a
	 *  `term(prop(...))` shape — never a higher-order expression. */
	readonly onChange: (next: ValueExpression) => void;
	/** Optional property filter narrowing the dropdown's content
	 *  (e.g. multi_select-only for `multi-select-contains`,
	 *  ordered-only for `between`). When undefined, every
	 *  property shows. */
	readonly filter?: (property: CaseProperty) => boolean;
	/** Accessibility label for the dropdown trigger / replace button. */
	readonly ariaLabel?: string;
	/** Surfaces the picker in an error state when the surrounding
	 *  card's validity index has errors at the LEFT slot. */
	readonly invalid?: boolean;
}

/** Detect the canonical "Term-arm property reference" shape. The
 *  picker renders the editing surface only for this shape; every
 *  other shape (higher-order ValueExpression OR Term-arm
 *  literal / input / session ref) routes through the badge. */
function isPropertyReference(value: ValueExpression): value is Extract<
	ValueExpression,
	{ kind: "term" }
> & {
	term: { kind: "prop"; caseType: string; property: string };
} {
	return value.kind === "term" && value.term.kind === "prop";
}

/**
 * LEFT-slot property picker with non-Term round-trip preservation.
 * See file-level JSDoc for the contract.
 */
export function LeftPropertyPicker({
	value,
	onChange,
	filter,
	ariaLabel = "Property",
	invalid = false,
}: LeftPropertyPickerProps) {
	const ctx = usePredicateEditContext();

	if (isPropertyReference(value)) {
		const propertyName = value.term.property || undefined;
		return (
			<PropertyPicker
				value={propertyName}
				onChange={(name) => {
					// Always preserve the canonical envelope —
					// `term(prop(currentCaseType, name))` — so the
					// outer card never has to second-guess the wrapping.
					onChange(wrapTerm(prop(ctx.currentCaseType, name)));
				}}
				filter={filter}
				invalid={invalid}
				ariaLabel={ariaLabel}
			/>
		);
	}

	// Non-canonical shape — read-only badge with Replace.
	// Two sub-shapes route here: higher-order ValueExpression arms
	// (`arith` / `if` / `count` / etc.) and Term-arm Terms that
	// aren't property references (literal / input / session refs).
	// Both surface as a badge to prevent silent destruction; the
	// label distinguishes them so the author sees what's there.
	const badgeKind: Exclude<ValueExpression["kind"], "term"> | "term-non-prop" =
		value.kind === "term" ? "term-non-prop" : value.kind;
	return (
		<HigherOrderBadge
			kind={badgeKind}
			ariaLabel={ariaLabel}
			onReplace={() => {
				// Replace the slot with a canonical property
				// reference. Picks the first property matching the
				// caller's filter (or the first property at all when
				// no filter applies); falls back to an empty name when
				// no property qualifies, matching the default-value
				// factories' behavior on a property-less case type.
				const ct = ctx.caseTypes.find((c) => c.name === ctx.currentCaseType);
				const property = ct?.properties.find((p) =>
					filter ? filter(p) : true,
				);
				const propName = property?.name ?? "";
				onChange(wrapTerm(prop(ctx.currentCaseType, propName)));
			}}
		/>
	);
}
