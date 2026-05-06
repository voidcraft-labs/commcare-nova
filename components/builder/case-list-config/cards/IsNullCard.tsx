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
import { useEditorErrorsAt } from "../editorContext";
import type { PredicateEditContext } from "../editorSchemas";
import { appendSlot, type EditorPath } from "../path";
import { InlineError } from "../primitives/CardShell";
import { LeftPropertyPicker } from "../primitives/LeftPropertyPicker";

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
	const leftErrors = useEditorErrorsAt(appendSlot(path, "left"));

	return (
		<div className="space-y-2">
			<div>
				<LeftPropertyPicker
					value={value.left}
					onChange={(left) => onChange(isNull(left))}
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
