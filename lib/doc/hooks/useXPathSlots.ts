/** Text projections and parse callbacks for one actual expression slot. */
"use client";

import { useCallback, useMemo } from "react";
import { buildExpressionLintContext } from "@/lib/codemirror/buildLintContext";
import {
	parseFormExpressionForSlot,
	projectFormExpression,
} from "@/lib/doc/expressionText";
import { lookupExpressionDefinitions } from "@/lib/doc/lookupExpressionContext";
import type { FormStructure } from "@/lib/domain/expression/formStructure";
import type {
	Expression,
	ExpressionSlotRef,
} from "@/lib/domain/expression/types";
import { useLookupCommitState } from "../lookupCommitContext";
import { useBlueprintDoc, useBlueprintDocApi } from "./useBlueprintDoc";
import {
	type ExpressionSlotCandidate,
	expressionCandidateDoc,
} from "./useExpressionSlotContext";

export function useFormExpressionProjection(
	expression: Expression | undefined,
	slot: ExpressionSlotRef | undefined,
	candidate?: ExpressionSlotCandidate,
	form?: FormStructure,
) {
	const doc = useBlueprintDoc((current) => current);
	const { lookupContext } = useLookupCommitState();
	return useMemo(() => {
		if (expression === undefined) return { ok: true, text: "" };
		const current =
			slot === undefined
				? undefined
				: expressionCandidateDoc(doc, slot, candidate);
		if (current === undefined || slot === undefined)
			return { ok: false, text: "Unresolved expression" };
		const projection = projectFormExpression(
			current,
			slot,
			expression,
			lookupExpressionDefinitions(lookupContext),
			{ form },
		);
		return { ...projection, ok: projection.unresolved.length === 0 };
	}, [doc, slot, expression, candidate, lookupContext, form]);
}

export function useFormExpressionText(
	expression: Expression | undefined,
	slot: ExpressionSlotRef | undefined,
	candidate?: ExpressionSlotCandidate,
	form?: FormStructure,
): string {
	return useFormExpressionProjection(expression, slot, candidate, form).text;
}

/** Missing context or invalid source refuses the save; text never becomes stored fallback. */
export function useParseFormExpression(
	slot: ExpressionSlotRef | undefined,
	candidate?: ExpressionSlotCandidate,
	form?: FormStructure,
): (text: string) => Expression {
	const api = useBlueprintDocApi();
	const { lookupContext } = useLookupCommitState();
	return useCallback(
		(text: string) => {
			const doc =
				slot === undefined
					? undefined
					: expressionCandidateDoc(api.getState(), slot, candidate);
			if (doc === undefined || slot === undefined)
				throw new Error(
					"This expression's place in the app changed. Reopen it to use the latest version.",
				);
			const parsed = parseFormExpressionForSlot(
				doc,
				slot,
				text,
				lookupExpressionDefinitions(lookupContext),
				{ form },
			);
			if (!parsed.ok)
				throw new Error(parsed.issues.map((issue) => issue.message).join(" "));
			if (parsed.expression === undefined)
				throw new Error("Enter an expression before saving.");
			return parsed.expression;
		},
		[api, slot, candidate, lookupContext, form],
	);
}

export function useFormExpressionLintContext(
	slot: ExpressionSlotRef | undefined,
	candidate?: ExpressionSlotCandidate,
	form?: FormStructure,
) {
	const api = useBlueprintDocApi();
	const { lookupContext } = useLookupCommitState();
	return useCallback(() => {
		const doc =
			slot === undefined
				? undefined
				: expressionCandidateDoc(api.getState(), slot, candidate);
		return doc === undefined || slot === undefined
			? undefined
			: buildExpressionLintContext(doc, slot, lookupContext, { form });
	}, [api, slot, candidate, lookupContext, form]);
}
