// components/builder/shared/cards/ConditionChoiceCard.tsx
//
// "Depends on a condition": a runtime choice between two conditions, the
// `if` arm in a condition position. It reads "When
// [condition], use [condition], otherwise use [condition]". The deciding
// condition is usually something the device knows before the search runs,
// such as a search answer or the worker's information, so the search uses
// one condition or the other; a deciding condition that reads the case is
// still a valid rule, which CommCare evaluates for each case.
//
// Path encoding mirrors `IfCard`: the checker emits at
// `[..., "if", "cond" | "then" | "else"]`.

"use client";
import { expressionEditVerdict } from "@/lib/doc/hooks/predicateVerdicts";
import {
	type Expression,
	type ExpressionOfKind,
	ifExpr,
	input,
	isBlank,
	matchAll,
	term,
} from "@/lib/domain/expression";
import { firstConditionSeed } from "../conditionSeed";
import { useEditorErrorsAt } from "../editorContext";
import type { PredicateEditContext } from "../editorSchemas";
import { appendKind, appendKindSlot, type EditorPath } from "../path";
import { InlineError } from "../primitives/CardShell";
import { PredicateFocusBoundary } from "./ChildPredicateEditor";

/**
 * The deciding condition a new choice starts with. Both branches start as the
 * same condition, so any deciding condition keeps the rule's meaning; the
 * seed is chosen to read well and to point at the usual decider. In a slot
 * with search fields it is "<another search field> is blank", the field a
 * person most often decides by (never the field this condition belongs to,
 * which is always answered where its condition runs). Otherwise it is
 * "Always match", which reads no case and claims nothing. Each candidate is
 * kept only if the gate admits the choice it makes.
 */
export function conditionChoiceSeed(
	ctx: PredicateEditContext,
	current: Expression,
): Expression {
	const slot = ctx.expressionContext.slot;
	const own =
		"member" in slot &&
		slot.member !== undefined &&
		"searchInputUuid" in slot.member
			? slot.member.searchInputUuid
			: undefined;
	const candidates: Expression[] = [
		...ctx.knownInputs
			.filter((answer) => answer.uuid !== own)
			.map((answer) => isBlank(term(input(answer.uuid)))),
		matchAll(),
	];
	return (
		candidates.find(
			(candidate) =>
				expressionEditVerdict(
					ifExpr(candidate, current, current),
					ctx.expressionContext,
				).ok,
		) ?? matchAll()
	);
}

/** A new choice. Both branches start as the same condition, so adding the
 * choice changes nothing the rule finds until the person edits it. */
export function conditionChoiceDefault(
	ctx: PredicateEditContext,
): ExpressionOfKind<"if"> {
	const seed = firstConditionSeed(ctx) ?? matchAll();
	return ifExpr(conditionChoiceSeed(ctx, seed), seed, seed);
}

/** Wrap an existing condition in a choice: it becomes both branches, so the
 * rule keeps its meaning and its authored condition. */
export function wrapInConditionChoice(
	current: Expression,
	ctx: PredicateEditContext,
): ExpressionOfKind<"if"> {
	return ifExpr(conditionChoiceSeed(ctx, current), current, current);
}

interface ConditionChoiceCardProps {
	readonly value: ExpressionOfKind<"if">;
	readonly onChange: (next: Expression) => void;
	readonly path: EditorPath;
}

export function ConditionChoiceCard({
	value,
	onChange,
	path,
}: ConditionChoiceCardProps) {
	const operatorErrors = useEditorErrorsAt(appendKind(path, "if"));
	return (
		<div className="space-y-2">
			{operatorErrors.length > 0 && <InlineError errors={operatorErrors} />}
			<ChoiceSlot label="When">
				<PredicateFocusBoundary
					value={value.cond}
					onChange={(next) => onChange(ifExpr(next, value.then, value.else))}
					path={appendKindSlot(path, "if", "cond")}
					variant="nested"
				/>
			</ChoiceSlot>
			<ChoiceSlot label="Use">
				<PredicateFocusBoundary
					value={value.then}
					onChange={(next) => onChange(ifExpr(value.cond, next, value.else))}
					path={appendKindSlot(path, "if", "then")}
					variant="nested"
				/>
			</ChoiceSlot>
			<ChoiceSlot label="Otherwise use">
				<PredicateFocusBoundary
					value={value.else}
					onChange={(next) => onChange(ifExpr(value.cond, value.then, next))}
					path={appendKindSlot(path, "if", "else")}
					variant="nested"
				/>
			</ChoiceSlot>
		</div>
	);
}

function ChoiceSlot({
	label,
	children,
}: {
	readonly label: string;
	readonly children: React.ReactNode;
}) {
	return (
		<div className="space-y-1.5">
			<div className="text-[13px] font-medium text-nova-text-secondary">
				{label}
			</div>
			{children}
		</div>
	);
}
