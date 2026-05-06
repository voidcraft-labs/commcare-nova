// components/builder/case-list-config/cards/IsNullCard.tsx
//
// Renders the `is-null` predicate (strict-absent). Property picker
// only — the AST schema accepts any non-literal Term (property
// ref, search-input ref, session ref); this card narrows authoring
// to property refs as the dominant case-list authoring shape.
//
// `is-null` is the strict-absent operator (key not present).
// Distinct from `is-blank` per the spec's locked invariant — see
// `lib/domain/predicate/CLAUDE.md` for the full rationale.

"use client";
import { isNull, type Predicate, prop } from "@/lib/domain/predicate";
import { useEditorErrorsAt, usePredicateEditContext } from "../editorContext";
import type { PredicateEditContext } from "../editorSchemas";
import { appendSlot, type EditorPath } from "../path";
import { InlineError } from "../primitives/CardShell";
import { PropertyPicker } from "../primitives/PropertyPicker";

export function isNullDefault(
	ctx: PredicateEditContext,
): Extract<Predicate, { kind: "is-null" }> {
	const ct = ctx.caseTypes.find((c) => c.name === ctx.currentCaseType);
	const property = ct?.properties[0];
	const propName = property?.name ?? "";
	return isNull(prop(ctx.currentCaseType, propName));
}

interface IsNullCardProps {
	readonly value: Extract<Predicate, { kind: "is-null" }>;
	readonly onChange: (next: Predicate) => void;
	readonly path: EditorPath;
}

export function IsNullCard({ value, onChange, path }: IsNullCardProps) {
	const ctx = usePredicateEditContext();
	const leftErrors = useEditorErrorsAt(appendSlot(path, "left"));

	const propertyName =
		value.left.kind === "term" && value.left.term.kind === "prop"
			? value.left.term.property
			: undefined;

	const setProperty = (next: string) => {
		onChange(isNull(prop(ctx.currentCaseType, next)));
	};

	return (
		<div className="space-y-2">
			<div>
				<PropertyPicker
					value={propertyName}
					onChange={setProperty}
					invalid={leftErrors.length > 0}
					ariaLabel="Property"
				/>
				<InlineError errors={leftErrors} />
			</div>
			<div className="text-[11px] text-nova-text-muted/70 leading-snug">
				Matches only when the property has never been written. The empty string
				is treated as a value, not absence.
			</div>
		</div>
	);
}
