/** Text projections and parse callbacks for one actual expression slot. */
"use client";

import { useCallback, useMemo } from "react";
import { buildExpressionEditorContext } from "@/lib/codemirror/expressionEditorContext";
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

function useProjection(
	expression: Expression | undefined,
	slot: ExpressionSlotRef | undefined,
	candidate: ExpressionSlotCandidate | undefined,
	form: FormStructure | undefined,
	layout: boolean,
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
			{ form, layout },
		);
		return { ...projection, ok: projection.unresolved.length === 0 };
	}, [doc, slot, expression, candidate, lookupContext, form, layout]);
}

/** The stored expression as an editor shows it: the canonical print, on
 * one line when it fits the printer's width, else laid out over lines. An
 * editor closes onto this after a save, so what a person sees is always
 * what was stored. */
export function useExpressionProjection(
	expression: Expression | undefined,
	slot: ExpressionSlotRef | undefined,
	candidate?: ExpressionSlotCandidate,
	form?: FormStructure,
) {
	return useProjection(expression, slot, candidate, form, true);
}

/** The stored expression's canonical print on one line, for surfaces that
 * show it inline rather than in an editor. */
export function useFormExpressionText(
	expression: Expression | undefined,
	slot: ExpressionSlotRef | undefined,
	candidate?: ExpressionSlotCandidate,
	form?: FormStructure,
): string {
	return useProjection(expression, slot, candidate, form, false).text;
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

/** The slot's editor context, built from the current document on each call. */
export function useExpressionEditorContext(
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
			: buildExpressionEditorContext(doc, slot, lookupContext, { form });
	}, [api, slot, candidate, lookupContext, form]);
}

/** A value that changes whenever what an open expression editor's
 * identities resolve against changes: the document or the Project's lookup
 * definitions. An editor reconciles its draft when it changes, because a
 * peer's rename can change a draft's spelling without changing the stored
 * expression's own text. */
export function useExpressionScopeRevision(): object {
	const doc = useBlueprintDoc((current) => current);
	const { lookupContext } = useLookupCommitState();
	return useMemo(() => ({ doc, lookupContext }), [doc, lookupContext]);
}
