// components/builder/shared/primitives/PropertyRefPicker.tsx
//
// Single primitive that owns ALL property picking across the
// predicate card editor. Two slot vocabularies need property
// pickers; both flow through this file so the bug class
// "rebuild-drops-original-shape" is structurally impossible at
// the call sites:
//
//   1. **Property-only slots** — `match.property`,
//      `multi-select-contains.property`, `within-distance.property`.
//      The schema constrains these slots to `propertyRefSchema`
//      directly. Mode `"property-only"`. Value type: `PropertyRef`.
//   2. **Left ValueExpression slots** — `compare.left`, `in.left`,
//      `between.left`, `is-null.left`, `is-blank.left`. The schema
//      admits any `ValueExpression`; this picker EDITS only the
//      canonical `term(prop(currentCaseType, name))` shape and
//      routes everything else (higher-order ValueExpression arms,
//      Term-arm Terms that aren't prop refs, prop refs carrying
//      non-self `via` walks) through a read-only badge with an
//      explicit Replace affordance. Mode `"left"`. Value type:
//      `ValueExpression`.
//
// Round-trip contract (BOTH modes):
//   - `via: RelationPath` is preserved verbatim across property
//     name changes. The picker's `setProperty` callback rebuilds
//     via `prop(caseType, name, via)` (three-arg builder), so a
//     saved relation walk doesn't disappear on the user's first
//     dropdown click. Property refs with non-self `via` show the
//     read-only "Property via relation walk" badge — the picker
//     UI doesn't surface a relation editor inline; authoring a
//     non-self walk goes through the SA tool surface or the
//     `exists` / `missing` cards' relation builder.
//   - Non-canonical input shapes route through the
//     `HigherOrderBadge` with the matching `BadgeKind`. No
//     `onChange` fires until the user explicitly clicks Replace.
//
// `isCanonicalPropertyRef` is the strict type guard — verifies
// `via === undefined || via.kind === "self"` so the canonical
// branch's narrowed type matches what the rebuild path produces.
// The TypeScript narrowing in the canonical branch reads through
// the runtime guarantee the guard provides.

"use client";
import { type CaseProperty, canonicalCasePropertyName } from "@/lib/domain";
import {
	type PropertyRef,
	prop,
	type ValueExpression,
	term as wrapTerm,
} from "@/lib/domain/predicate";
import { usePredicateEditContext } from "../editorContext";
import { type BadgeKind, HigherOrderBadge } from "./HigherOrderBadge";
import { PropertyPicker } from "./PropertyPicker";

/** Discriminated mode + per-mode value/onChange contract. The
 *  primitive's body branches on `mode` to wrap / unwrap the
 *  canonical property reference into the surrounding envelope
 *  the slot expects. */
type PropertyRefPickerProps =
	| ({
			readonly mode: "property-only";
			readonly value: PropertyRef;
			readonly onChange: (next: PropertyRef) => void;
	  } & PropertyRefPickerSharedProps)
	| ({
			readonly mode: "left";
			readonly value: ValueExpression;
			readonly onChange: (next: ValueExpression) => void;
	  } & PropertyRefPickerSharedProps);

interface PropertyRefPickerSharedProps {
	/** Optional property filter narrowing the dropdown's content
	 *  (e.g. multi_select-only for `multi-select-contains`,
	 *  ordered-only for `between`). When undefined, every
	 *  property shows. */
	readonly filter?: (property: CaseProperty) => boolean;
	/** Accessibility label for the dropdown trigger / replace button. */
	readonly ariaLabel?: string;
	/** Surfaces the picker in an error state when the surrounding
	 *  card's validity index has errors at this slot. */
	readonly invalid?: boolean;
}

/** Strict type guard — `value` IS a PropertyRef carrying either no
 *  `via` slot OR a `via.kind === "self"` slot (semantically
 *  equivalent to no walk). Both shapes round-trip through the
 *  picker's edit surface; everything else routes through the
 *  badge. */
function isCanonicalPropertyRef(value: PropertyRef): value is PropertyRef & {
	via?: { kind: "self" };
} {
	return value.via === undefined || value.via.kind === "self";
}

/** Detect what the LEFT-slot value looks like and produce either
 *  the underlying `PropertyRef` (for the editing surface) or the
 *  badge kind that names the non-canonical shape. Mirrors the
 *  PropertyRef-side guard above; the badge kinds are the
 *  exhaustive set of round-trip-preservation shapes. */
type LeftClassification =
	| { readonly kind: "canonical"; readonly propRef: PropertyRef }
	| { readonly kind: "badge"; readonly badge: BadgeKind };

function classifyLeft(value: ValueExpression): LeftClassification {
	if (value.kind !== "term") {
		return { kind: "badge", badge: value.kind };
	}
	if (value.term.kind !== "prop") {
		return { kind: "badge", badge: "term-non-prop" };
	}
	if (!isCanonicalPropertyRef(value.term)) {
		return { kind: "badge", badge: "term-prop-with-via" };
	}
	return { kind: "canonical", propRef: value.term };
}

/**
 * Property picker that round-trips every authored shape the
 * predicate AST admits at property / left slots — including
 * `prop` references carrying optional `via: RelationPath` walks,
 * higher-order ValueExpression arms, and non-property Term arms.
 *
 * See file-level JSDoc for the contract. The body's branching is
 * driven by the `mode` discriminator; the canonical edit surface
 * is identical between modes (a `PropertyPicker` bound to the
 * caller's filter), and the round-trip preservation flows through
 * `prop()`'s three-arg form so `via` survives every edit.
 */
export function PropertyRefPicker(props: PropertyRefPickerProps) {
	const ctx = usePredicateEditContext();
	const { filter, ariaLabel = "Property", invalid = false } = props;

	if (props.mode === "property-only") {
		const propRef = props.value;
		if (!isCanonicalPropertyRef(propRef)) {
			return (
				<HigherOrderBadge
					kind="term-prop-with-via"
					ariaLabel={ariaLabel}
					onReplace={() => {
						const next = replacementPropRef(
							ctx.caseTypes,
							ctx.currentCaseType,
							filter,
						);
						props.onChange(next);
					}}
				/>
			);
		}
		// Canonical property-only — render the editor.
		return (
			<PropertyPicker
				value={propRef.property || undefined}
				onChange={(name) => {
					// Preserve `caseType` and (self-shaped) `via` from
					// the source ref; only the property name changes.
					// Three-arg `prop()` keeps the `via` slot intact.
					props.onChange(
						propRef.via === undefined
							? prop(propRef.caseType, name)
							: prop(propRef.caseType, name, propRef.via),
					);
				}}
				filter={filter}
				invalid={invalid}
				ariaLabel={ariaLabel}
				displayLabels
			/>
		);
	}

	// LEFT mode — value is a wider ValueExpression.
	const classification = classifyLeft(props.value);
	if (classification.kind === "badge") {
		return (
			<HigherOrderBadge
				kind={classification.badge}
				ariaLabel={ariaLabel}
				onReplace={() => {
					// Replace the slot with a canonical
					// `term(prop(currentCaseType, firstApplicable))` —
					// no `via`, since the badge path is the only path
					// that produces a fresh prop ref and the dropdown
					// only edits canonical refs.
					const next = replacementPropRef(
						ctx.caseTypes,
						ctx.currentCaseType,
						filter,
					);
					props.onChange(wrapTerm(next));
				}}
			/>
		);
	}
	// Canonical left — render the editor; preserve `via` across
	// property name changes via three-arg `prop()`.
	const propRef = classification.propRef;
	return (
		<PropertyPicker
			value={propRef.property || undefined}
			onChange={(name) => {
				const nextPropRef =
					propRef.via === undefined
						? prop(propRef.caseType, name)
						: prop(propRef.caseType, name, propRef.via);
				props.onChange(wrapTerm(nextPropRef));
			}}
			filter={filter}
			invalid={invalid}
			ariaLabel={ariaLabel}
			displayLabels
		/>
	);
}

/** Build the canonical replacement `PropertyRef` produced when the
 *  user clicks Replace on the badge. Picks the first property
 *  matching the caller's filter (or the first property at all when
 *  no filter applies); falls back to an empty name when no
 *  property qualifies, matching the default-value factories'
 *  behavior on a property-less case type.
 *
 *  Replace-contract reset: the result rebases BOTH structural
 *  attributes to canonical scope —
 *    - `caseType: currentCaseType` (the editor's current scope,
 *      which can differ from the source ref's `caseType` when the
 *      source carried a non-self `via` walk; canonical refs
 *      satisfy `caseType === currentCaseType`).
 *    - `via: undefined` (no walk; canonical refs either omit `via`
 *      or carry `via.kind === "self"`, and the picker emits the
 *      omitted form for replacement).
 *
 *  Authors who want a relation walk re-author through the SA tool
 *  surface or the `exists` / `missing` cards' relation builder. */
function replacementPropRef(
	caseTypes: ReturnType<typeof usePredicateEditContext>["caseTypes"],
	currentCaseType: string,
	filter: ((property: CaseProperty) => boolean) | undefined,
): PropertyRef {
	const ct = caseTypes.find((c) => c.name === currentCaseType);
	const property = ct?.properties.find((p) => (filter ? filter(p) : true));
	const propName = canonicalCasePropertyName(property?.name ?? "");
	return prop(currentCaseType, propName);
}
