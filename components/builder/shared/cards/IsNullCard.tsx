// components/builder/shared/cards/IsNullCard.tsx
//
// Renders the `is-null` predicate (strict-absent). Property picker
// only — the AST schema accepts any non-literal Term (property
// ref, search-input ref, session ref); this card narrows authoring
// to property refs as the dominant case-list authoring shape.
//
// `is-null` is the strict-absent operator (key not present in the
// JSONB document). `is-blank` is the wider absent-or-empty operator
// authoring surfaces default to; the two are distinct kinds in the
// AST so persisted predicates carry the strict semantic explicitly.

"use client";
import { isNull, type Predicate, prop } from "@/lib/domain/predicate";
import { useEditorErrorsAt } from "../editorContext";
import type { PredicateEditContext } from "../editorSchemas";
import { appendSlot, type EditorPath } from "../path";
import { InlineError } from "../primitives/CardShell";
import { PropertyRefPicker } from "../primitives/PropertyRefPicker";
import { PredicateVerbMenu } from "./PredicateVerbMenu";

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
			<div className="grid grid-cols-1 @md:grid-cols-[1.4fr_auto] gap-2 items-start">
				<div>
					<PropertyRefPicker
						mode="left"
						value={value.left}
						onChange={(left) => onChange(isNull(left))}
						invalid={leftErrors.length > 0}
						ariaLabel="Property"
					/>
					<InlineError errors={leftErrors} />
				</div>
				<PredicateVerbMenu value={value} onChange={onChange} />
			</div>
			<div className="text-[11px] text-nova-text-muted/70 leading-snug">
				Matches only when the property has never been written. The empty string
				is treated as a value, not absence.
			</div>
		</div>
	);
}
