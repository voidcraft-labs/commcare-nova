// components/builder/case-list-config/cards/IsBlankCard.tsx
//
// Renders the `is-blank` predicate (absent or empty string). The
// portable absent-or-empty operator — emits cleanly on every CCHQ
// dialect.

"use client";
import { isBlank, type Predicate, prop } from "@/lib/domain/predicate";
import { useEditorErrorsAt, usePredicateEditContext } from "../editorContext";
import type { PredicateEditContext } from "../editorSchemas";
import { appendSlot, type EditorPath } from "../path";
import { InlineError } from "../primitives/CardShell";
import { PropertyPicker } from "../primitives/PropertyPicker";

export function isBlankDefault(
	ctx: PredicateEditContext,
): Extract<Predicate, { kind: "is-blank" }> {
	const ct = ctx.caseTypes.find((c) => c.name === ctx.currentCaseType);
	const property = ct?.properties[0];
	const propName = property?.name ?? "";
	return isBlank(prop(ctx.currentCaseType, propName));
}

interface IsBlankCardProps {
	readonly value: Extract<Predicate, { kind: "is-blank" }>;
	readonly onChange: (next: Predicate) => void;
	readonly path: EditorPath;
}

export function IsBlankCard({ value, onChange, path }: IsBlankCardProps) {
	const ctx = usePredicateEditContext();
	const leftErrors = useEditorErrorsAt(appendSlot(path, "left"));

	const propertyName =
		value.left.kind === "term" && value.left.term.kind === "prop"
			? value.left.term.property
			: undefined;

	const setProperty = (next: string) => {
		onChange(isBlank(prop(ctx.currentCaseType, next)));
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
				Matches when the property is missing or set to the empty string.
			</div>
		</div>
	);
}
