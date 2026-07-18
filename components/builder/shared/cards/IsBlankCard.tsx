// components/builder/shared/cards/IsBlankCard.tsx
//
// Renders the `is-blank` predicate (absent or empty string). The
// portable absent-or-empty operator — emits cleanly on every CCHQ
// dialect.

"use client";
import { canonicalCasePropertyName } from "@/lib/domain";
import {
	absenceSubjectConstraint,
	isBlank,
	type Predicate,
	prop,
} from "@/lib/domain/predicate";
import type { PredicateEditContext } from "../editorSchemas";
import { appendSlot, type EditorPath } from "../path";
import { ExpressionPicker } from "../primitives/ExpressionPicker";
import { PredicateVerbMenu } from "./PredicateVerbMenu";

export function isBlankDefault(
	ctx: PredicateEditContext,
): Extract<Predicate, { kind: "is-blank" }> {
	const ct = ctx.caseTypes.find((c) => c.name === ctx.currentCaseType);
	const property = ct?.properties[0];
	const propName = canonicalCasePropertyName(property?.name ?? "");
	return isBlank(prop(ctx.currentCaseType, propName));
}

interface IsBlankCardProps {
	readonly value: Extract<Predicate, { kind: "is-blank" }>;
	readonly onChange: (next: Predicate) => void;
	readonly path: EditorPath;
}

export function IsBlankCard({ value, onChange, path }: IsBlankCardProps) {
	return (
		<div className="space-y-2">
			<div className="grid grid-cols-1 @md:grid-cols-[1.4fr_auto] gap-2 items-start">
				<ExpressionPicker
					value={value.left}
					onChange={(left) => onChange(isBlank(left))}
					path={appendSlot(path, "left")}
					constraint={absenceSubjectConstraint()}
					presentation="subject"
					variant="nested"
				/>
				<PredicateVerbMenu value={value} onChange={onChange} />
			</div>
			<div className="text-[13px] leading-relaxed text-nova-text-muted">
				Matches when this information is blank or hasn’t been recorded
			</div>
		</div>
	);
}
