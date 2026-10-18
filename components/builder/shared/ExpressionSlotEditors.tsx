"use client";

import type { ComponentProps } from "react";
import {
	type ExpressionSlotCandidate,
	useExpressionSlotContext,
} from "@/lib/doc/hooks/useExpressionSlotContext";
import type { ExpressionSlotRef } from "@/lib/domain/expression";
import { ExpressionCardEditor } from "./ExpressionCardEditor";
import { PredicateWorkbench } from "./PredicateWorkbench";

interface SlotOwner {
	readonly slot: ExpressionSlotRef;
	readonly candidate?: ExpressionSlotCandidate;
}

export function ExpressionSlotEditor({
	slot,
	candidate,
	...props
}: SlotOwner &
	Omit<ComponentProps<typeof ExpressionCardEditor>, "expressionContext">) {
	const expressionContext = useExpressionSlotContext(slot, candidate);
	if (expressionContext === undefined)
		return <p role="status">This expression's owner is no longer available.</p>;
	return (
		<ExpressionCardEditor {...props} expressionContext={expressionContext} />
	);
}

export function ConditionSlotEditor({
	slot,
	candidate,
	...props
}: SlotOwner &
	Omit<ComponentProps<typeof PredicateWorkbench>, "expressionContext">) {
	const expressionContext = useExpressionSlotContext(slot, candidate);
	if (expressionContext === undefined)
		return <p role="status">This condition's owner is no longer available.</p>;
	return (
		<PredicateWorkbench {...props} expressionContext={expressionContext} />
	);
}
