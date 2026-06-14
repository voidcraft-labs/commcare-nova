// components/builder/shared/cards/IsBlankCard.tsx
//
// Renders the `is-blank` predicate (absent or empty string). The
// portable absent-or-empty operator — emits cleanly on every CCHQ
// dialect.

"use client";
import { isBlank, type Predicate, prop } from "@/lib/domain/predicate";
import { useEditorErrorsAt } from "../editorContext";
import type { PredicateEditContext } from "../editorSchemas";
import { appendSlot, type EditorPath } from "../path";
import { InlineError } from "../primitives/CardShell";
import { PropertyRefPicker } from "../primitives/PropertyRefPicker";
import { PredicateVerbMenu } from "./PredicateVerbMenu";

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
	const leftErrors = useEditorErrorsAt(appendSlot(path, "left"));

	return (
		<div className="space-y-2">
			<div className="grid grid-cols-1 @md:grid-cols-[1.4fr_auto] gap-2 items-start">
				<div>
					<PropertyRefPicker
						mode="left"
						value={value.left}
						onChange={(left) => onChange(isBlank(left))}
						invalid={leftErrors.length > 0}
						ariaLabel="Property"
					/>
					<InlineError errors={leftErrors} />
				</div>
				<PredicateVerbMenu value={value} onChange={onChange} />
			</div>
			<div className="text-[11px] text-nova-text-muted/70 leading-snug">
				Matches when the property is missing or set to the empty string.
			</div>
		</div>
	);
}
