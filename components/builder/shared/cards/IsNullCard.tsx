// components/builder/shared/cards/IsNullCard.tsx
//
// Renders the `is-null` predicate (strict-absent). The common property
// subject stays compact, while every checker-valid runtime expression
// remains directly editable through the recursive expression editor.
//
// `is-null` is the strict-absent operator (key not present in the
// JSONB document). `is-blank` is the wider absent-or-empty operator
// authoring surfaces default to; the two are distinct kinds in the
// AST so persisted predicates carry the strict semantic explicitly.

"use client";
import { canonicalCasePropertyName } from "@/lib/domain";
import {
	absenceSubjectConstraint,
	isNull,
	type Predicate,
	prop,
} from "@/lib/domain/predicate";
import type { PredicateEditContext } from "../editorSchemas";
import { appendSlot, type EditorPath } from "../path";
import { ExpressionPicker } from "../primitives/ExpressionPicker";
import { PredicateVerbMenu } from "./PredicateVerbMenu";

export function isNullDefault(
	ctx: PredicateEditContext,
): Extract<Predicate, { kind: "is-null" }> {
	const ct = ctx.caseTypes.find((c) => c.name === ctx.currentCaseType);
	const property = ct?.properties[0];
	const propName = canonicalCasePropertyName(property?.name ?? "");
	return isNull(prop(ctx.currentCaseType, propName));
}

interface IsNullCardProps {
	readonly value: Extract<Predicate, { kind: "is-null" }>;
	readonly onChange: (next: Predicate) => void;
	readonly path: EditorPath;
}

export function IsNullCard({ value, onChange, path }: IsNullCardProps) {
	return (
		<div className="space-y-2">
			<div className="grid grid-cols-1 @md:grid-cols-[1.4fr_auto] gap-2 items-start">
				<ExpressionPicker
					value={value.left}
					onChange={(left) => onChange(isNull(left))}
					path={appendSlot(path, "left")}
					constraint={absenceSubjectConstraint()}
					presentation="subject"
					variant="nested"
				/>
				<PredicateVerbMenu value={value} onChange={onChange} />
			</div>
			<div className="text-[13px] leading-relaxed text-nova-text-muted">
				Matches only when this information has never been recorded. A blank
				value still counts as recorded
			</div>
		</div>
	);
}
