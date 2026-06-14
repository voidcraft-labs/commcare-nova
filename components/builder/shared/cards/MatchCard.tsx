// components/builder/shared/cards/MatchCard.tsx
//
// Renders the `match` predicate. Property dropdown (text-shaped or
// — for `fuzzy-date` — date / datetime), value input (typed by
// the property), and mode dropdown (fuzzy / phonetic / fuzzy-date
// / starts-with).

"use client";
import type { CaseProperty } from "@/lib/domain";
import { isDateTyped, isTextShaped } from "@/lib/domain";
import {
	literal,
	type MatchMode,
	match,
	type Predicate,
	type PropertyRef,
	prop,
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
	const propName = property?.name ?? "";
	return match(prop(ctx.currentCaseType, propName), literal(""), "fuzzy");
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

	return (
		<div className="space-y-2">
			<div className="grid grid-cols-1 @md:grid-cols-[1.4fr_auto_1.6fr] gap-2 items-start">
				<div>
					<PropertyRefPicker
						mode="property-only"
						value={value.property}
						onChange={setProperty}
						filter={propertyFilter}
						invalid={propertyErrors.length > 0}
						ariaLabel="Property"
					/>
					<InlineError errors={propertyErrors} />
				</div>

				<PredicateVerbMenu value={value} onChange={onChange} />

				<div>
					{/* Match value routes through `ExpressionPicker` so the
					 *  full ValueExpression family is reachable at the
					 *  slot. The picker's own `CardShell` footer surfaces
					 *  inline errors at the slot path, so no parallel
					 *  `<InlineError>` is needed here.
					 *
					 *  `expectedType` mirrors the type checker's per-mode
					 *  allow-list (`MATCH_PROPERTY_TYPES_BY_MODE`) — three
					 *  modes accept text-shaped values; `fuzzy-date` widens
					 *  to date as well. The hint is a primitive type, so
					 *  it can't capture the multi-arm disjunction
					 *  precisely; passing `text` for the three text-shaped
					 *  modes and `date` for `fuzzy-date` is the closest
					 *  primitive narrowing the picker's kind menu can
					 *  surface. */}
					<ExpressionPicker
						value={value.value}
						onChange={setValue}
						path={appendSlot(path, "value")}
						expectedType={value.mode === "fuzzy-date" ? "date" : "text"}
						variant="nested"
					/>
				</div>
			</div>
		</div>
	);
}
