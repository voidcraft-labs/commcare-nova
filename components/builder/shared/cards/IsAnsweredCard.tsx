// components/builder/shared/cards/IsAnsweredCard.tsx
//
// Renders a case change's condition on one form answer read as CommCare
// reads an answer alone, `boolean(<answer>)` (`../answeredCondition.ts`).
// The verb menu beside it switches to any other comparison of the same
// answer.

"use client";
import {
	absenceSubjectConstraint,
	type Expression,
	type ExpressionOfKind,
} from "@/lib/domain/expression";
import { isAnswered } from "../answeredCondition";
import { appendSlot, type EditorPath } from "../path";
import { ExpressionPicker } from "../primitives/ExpressionPicker";
import { PredicateVerbMenu } from "./PredicateVerbMenu";

interface IsAnsweredCardProps {
	readonly value: ExpressionOfKind<"call">;
	readonly onChange: (next: Expression) => void;
	readonly path: EditorPath;
}

export function IsAnsweredCard({ value, onChange, path }: IsAnsweredCardProps) {
	const answer = value.args[0];
	return (
		<div className="space-y-2">
			<div className="grid grid-cols-1 @md:grid-cols-[1.4fr_auto] gap-2 items-start">
				{answer !== undefined && (
					<ExpressionPicker
						value={answer}
						onChange={(next) => onChange(isAnswered(next))}
						path={appendSlot(path, "args")}
						constraint={absenceSubjectConstraint()}
						presentation="subject"
						variant="nested"
					/>
				)}
				<PredicateVerbMenu value={value} onChange={onChange} />
			</div>
			<div className="text-[13px] leading-relaxed text-nova-text-muted">
				Matches when the worker answered this question. A blank answer, or a
				number answered 0, counts as not answered.
			</div>
		</div>
	);
}
