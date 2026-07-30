// components/builder/shared/cards/MatchCard.tsx
//
// Renders the `match` predicate. Property dropdown (text-shaped or
// — for `fuzzy-date` — date / datetime), value input (typed by
// the property), and mode dropdown (fuzzy / phonetic / fuzzy-date
// / starts-with).

"use client";
import { useMemo } from "react";
import {
	type CaseProperty,
	canonicalCasePropertyName,
	isDateTyped,
	isTextShaped,
} from "@/lib/domain";
import {
	formField,
	input,
	type MatchMode,
	match,
	matchValueConstraint,
	type Predicate,
	type PropertyRef,
	prop,
	sessionContext,
	term,
	type ValueExpression,
} from "@/lib/domain/predicate";
import { useEditorErrorsAt } from "../editorContext";
import type { PredicateEditContext } from "../editorSchemas";
import { appendSlot, type EditorPath } from "../path";
import { InlineError } from "../primitives/CardShell";
import { ExpressionPicker } from "../primitives/ExpressionPicker";
import { PropertyRefPicker } from "../primitives/PropertyRefPicker";
import { PredicateVerbMenu } from "./PredicateVerbMenu";

/** Module-level filters so render-time identity stays stable per
 *  match mode — `PropertyPicker`'s `useMemo` on
 *  `[caseType, filter]` invalidates on each fresh-arrow filter
 *  even when the per-mode selection rule is constant.
 *
 *  Three of the four modes (`fuzzy` / `phonetic` / `starts-with`)
 *  share the text-shaped allow-list; `fuzzy-date` widens to
 *  additionally accept date / datetime properties. The card picks
 *  one of the two filters based on the current mode without
 *  allocating a fresh closure. The shared `isTextShaped` /
 *  `isDateTyped` helpers (in `lib/domain/casePropertyTypes.ts`)
 *  consolidate the `data_type ?? "text"` fallback every consumer
 *  applies. */
const MATCH_TEXT_SHAPED_FILTER = (p: CaseProperty): boolean => isTextShaped(p);

const MATCH_FUZZY_DATE_FILTER = (p: CaseProperty): boolean =>
	isTextShaped(p) || isDateTyped(p);

const _ALL_MODES: readonly MatchMode[] = [
	"fuzzy",
	"phonetic",
	"starts-with",
	"fuzzy-date",
];

export function matchDefault(
	ctx: PredicateEditContext,
): Extract<Predicate, { kind: "match" }> {
	const ct = ctx.caseTypes.find((c) => c.name === ctx.currentCaseType);
	const property = ct?.properties.find(isTextShaped);
	const propName = canonicalCasePropertyName(property?.name ?? "");
	// `starts-with` is the only mode CommCare's own evaluator implements,
	// so it is the only one valid on every carrier. Defaulting to `fuzzy`
	// made this seed unusable anywhere a rule runs on the device — which
	// is everywhere except an advanced search input.
	return match(
		prop(ctx.currentCaseType, propName),
		matchSeedValue(ctx),
		"starts-with",
	);
}

/**
 * A match against the empty string matches nothing on every mode, so
 * the commit gate refuses it — which makes a blank seed a choice that
 * cannot be committed rather than one waiting to be filled.
 *
 * This is the FALLBACK the verb menu uses when the condition it is
 * replacing carries no value of its own (`is-blank`, `match-all`, a
 * relationship test). Those have no value input for the author to type
 * into, so refusing the switch would leave no path to a text match at
 * all; seeding something real keeps the gesture available and the
 * author replaces it in the value row that now exists. A condition that
 * DOES carry an empty value keeps it, and the verb stays disabled with
 * the reason — there the copy points at a control that is on screen.
 */
function matchSeedValue(ctx: PredicateEditContext): ValueExpression {
	const searchInput = ctx.knownInputs[0];
	if (searchInput !== undefined) return term(input(searchInput.uuid));
	const answer = ctx.formFields?.[0];
	if (answer !== undefined) return term(formField(answer.uuid));
	return term(sessionContext("username"));
}

interface MatchCardProps {
	readonly value: Extract<Predicate, { kind: "match" }>;
	readonly onChange: (next: Predicate) => void;
	readonly path: EditorPath;
}

export function MatchCard({ value, onChange, path }: MatchCardProps) {
	const propertyErrors = useEditorErrorsAt(appendSlot(path, "property"));

	const setProperty = (next: PropertyRef) => {
		onChange(match(next, value.value, value.mode));
	};

	const _setMode = (mode: MatchMode) => {
		onChange(match(value.property, value.value, mode));
	};

	const setValue = (next: Parameters<typeof match>[1]) => {
		onChange(match(value.property, next, value.mode));
	};

	// Filter the property picker to the mode's allow-list. The
	// type checker enforces the same rule; gating the picker in the
	// UI prevents the author from picking a property that would
	// immediately fail validation. Picks one of the two module-
	// level filters so render-time identity stays stable for the
	// downstream `useMemo` in `PropertyPicker`.
	const propertyFilter =
		value.mode === "fuzzy-date"
			? MATCH_FUZZY_DATE_FILTER
			: MATCH_TEXT_SHAPED_FILTER;

	// The value slot takes a non-empty term whose type the mode admits
	// — `matchValueConstraint` carries the mode's allow-list, the
	// term-only flag (the wire match emitter consumes terms), and the
	// non-empty flag (every mode collapses an empty value to a
	// non-match). Memoized on the mode so the term editor's source
	// admission doesn't recompute on every render.
	const valueConstraint = useMemo(
		() => matchValueConstraint(value.mode),
		[value.mode],
	);

	return (
		<div className="space-y-3">
			<div className="grid grid-cols-1 items-start gap-2 @sm:grid-cols-[minmax(0,1fr)_auto]">
				<div>
					<PropertyRefPicker
						mode="property-only"
						value={value.property}
						onChange={setProperty}
						filter={propertyFilter}
						invalid={propertyErrors.length > 0}
						ariaLabel="Case information"
					/>
					<InlineError errors={propertyErrors} />
				</div>

				<PredicateVerbMenu value={value} onChange={onChange} />
			</div>

			<div className="min-w-0">
				{/* Match value routes through `ExpressionPicker` so the
				 *  full Term family is reachable at the slot. The
				 *  `matchValueConstraint` is `termOnly` (the wire match
				 *  emitter consumes terms — no computed kinds offered),
				 *  `nonEmpty` (the text widget refuses to commit an
				 *  empty value), and carries the mode's allow-list so
				 *  only a value of an admitted type is authorable. The
				 *  picker's own `CardShell` footer surfaces inline errors
				 *  at the slot path, so no parallel `<InlineError>` is
				 *  needed here. */}
				<ExpressionPicker
					value={value.value}
					onChange={setValue}
					path={appendSlot(path, "value")}
					constraint={valueConstraint}
					variant="nested"
				/>
			</div>
		</div>
	);
}
