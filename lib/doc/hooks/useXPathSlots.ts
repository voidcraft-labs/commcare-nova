/** Text projections and parse callbacks for one actual expression slot. */
"use client";

import { useCallback, useMemo } from "react";
import {
	buildExpressionEditorContext,
	type ExpressionEditorContext,
} from "@/lib/codemirror/expressionEditorContext";
import {
	parseFormExpressionForSlot,
	projectFormExpression,
} from "@/lib/doc/expressionText";
import { lookupExpressionDefinitions } from "@/lib/doc/lookupExpressionContext";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc } from "@/lib/domain";
import type { FormStructure } from "@/lib/domain/expression/formStructure";
import type {
	Expression,
	ProseSlotRef,
	SlotContextRef,
} from "@/lib/domain/expression/types";
import type { ProseAtomPart, ProseValuePart } from "@/lib/domain/prose";
import { canonicalProseAtom } from "@/lib/domain/proseExpression";
import { expressionSlotKey } from "@/lib/domain/referenceSlots";
import { useLookupCommitState } from "../lookupCommitContext";
import { useBlueprintDoc, useBlueprintDocApi } from "./useBlueprintDoc";
import {
	type ExpressionSlotCandidate,
	expressionCandidateDoc,
} from "./useExpressionSlotContext";

function useProjection(
	expression: Expression | undefined,
	slot: SlotContextRef | undefined,
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
	slot: SlotContextRef | undefined,
	candidate?: ExpressionSlotCandidate,
	form?: FormStructure,
) {
	return useProjection(expression, slot, candidate, form, true);
}

/** The stored expression's canonical print on one line, for surfaces that
 * show it inline rather than in an editor. */
export function useFormExpressionText(
	expression: Expression | undefined,
	slot: SlotContextRef | undefined,
	candidate?: ExpressionSlotCandidate,
	form?: FormStructure,
): string {
	return useProjection(expression, slot, candidate, form, false).text;
}

/** A calculated value's formula on one line, as its chip shows it; undefined
 *  where the slot is gone or the expression no longer prints
 *  (`projectFormExpression` reports it unresolved). */
export function useProseValueText(
	part: ProseValuePart,
	slot: ProseSlotRef | undefined,
): string | undefined {
	const projection = useProjection(
		part.expression,
		slot,
		undefined,
		undefined,
		false,
	);
	return slot !== undefined && projection.ok ? projection.text : undefined;
}

/** Parses a formula in a prose slot and builds its part with
 *  `canonicalProseAtom`, so a formula that only reads one reference becomes
 *  that reference. `current` is the expression of the part being edited.
 *  Throws an `Error` holding the parse's sentences joined by a space, as
 *  `useParseFormExpression` does; the slot's check is the editor's lint. */
export function useParseProseValue(
	slot: ProseSlotRef | undefined,
	current?: Expression,
): (text: string) => ProseAtomPart {
	const api = useBlueprintDocApi();
	const { lookupContext } = useLookupCommitState();
	return useCallback(
		(text: string) => {
			if (slot === undefined)
				throw new Error(
					"This text's place in the app changed. Reopen it to use the latest version.",
				);
			const parsed = parseFormExpressionForSlot(
				api.getState(),
				slot,
				text,
				lookupExpressionDefinitions(lookupContext),
				current === undefined ? {} : { current },
			);
			if (!parsed.ok)
				throw new Error(parsed.issues.map((issue) => issue.message).join(" "));
			if (parsed.expression === undefined)
				throw new Error(
					"A calculated value needs a formula. You can write one here.",
				);
			return canonicalProseAtom(parsed.expression);
		},
		[api, slot, current, lookupContext],
	);
}

/** Missing context or invalid source refuses the save; text never becomes stored fallback. */
export function useParseFormExpression(
	slot: SlotContextRef | undefined,
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

interface CachedEditorContext {
	readonly candidate: ExpressionSlotCandidate | undefined;
	readonly form: FormStructure | undefined;
	/** The calculated value a prose slot's editor binds against, compared by
	 *  identity: two values of one text share a slot and differ here. */
	readonly current: Expression | undefined;
	readonly context: ExpressionEditorContext | undefined;
}

/** Built contexts by document snapshot, lookup definitions and slot. A
 * snapshot is immutable, so a context built from it never goes stale, and
 * the cache lets go of it with the snapshot. */
const editorContexts = new WeakMap<
	BlueprintDoc,
	WeakMap<LookupValidationContext, Map<string, CachedEditorContext[]>>
>();
/** Candidate and form variants kept per slot of one snapshot: an open editor
 * asks for one, a rerendered mount may briefly ask for another. */
const VARIANTS_PER_SLOT = 4;

function sameCandidate(
	a: ExpressionSlotCandidate | undefined,
	b: ExpressionSlotCandidate | undefined,
): boolean {
	return (
		a === b ||
		(a !== undefined &&
			b !== undefined &&
			a.entity === b.entity &&
			a.value === b.value)
	);
}

/**
 * The slot's editor context for one document snapshot, built once. Lint,
 * every completion source and the chips each ask for it on a keystroke, and
 * an idle display asks on every change to the document; each of those reads
 * the one context this snapshot, lookup definitions, slot, pending candidate,
 * form and, in a prose slot, the calculated value being edited produce. A
 * candidate is the same when it substitutes the same entity value, since
 * mounts rebuild the wrapper object on every render; `current` is the same
 * object or both absent.
 */
export function expressionEditorContextFor(
	doc: BlueprintDoc,
	slot: SlotContextRef,
	lookupContext: LookupValidationContext,
	candidate?: ExpressionSlotCandidate,
	form?: FormStructure,
	current?: Expression,
): ExpressionEditorContext | undefined {
	let byLookup = editorContexts.get(doc);
	if (byLookup === undefined) {
		byLookup = new WeakMap();
		editorContexts.set(doc, byLookup);
	}
	let bySlot = byLookup.get(lookupContext);
	if (bySlot === undefined) {
		bySlot = new Map();
		byLookup.set(lookupContext, bySlot);
	}
	const key = expressionSlotKey(slot);
	const variants = bySlot.get(key) ?? [];
	const hit = variants.find(
		(entry) =>
			entry.form === form &&
			entry.current === current &&
			sameCandidate(entry.candidate, candidate),
	);
	if (hit !== undefined) return hit.context;
	const candidateDoc = expressionCandidateDoc(doc, slot, candidate);
	const context =
		candidateDoc === undefined
			? undefined
			: buildExpressionEditorContext(candidateDoc, slot, lookupContext, {
					form,
					...(current === undefined ? {} : { current }),
				});
	bySlot.set(key, [
		...variants.slice(-(VARIANTS_PER_SLOT - 1)),
		{ candidate, form, current, context },
	]);
	return context;
}

/** The slot's editor context for the current document, built at most once
 * per document snapshot (`expressionEditorContextFor`). */
export function useExpressionEditorContext(
	slot: SlotContextRef | undefined,
	candidate?: ExpressionSlotCandidate,
	form?: FormStructure,
	current?: Expression,
) {
	const api = useBlueprintDocApi();
	const { lookupContext } = useLookupCommitState();
	return useCallback(
		() =>
			slot === undefined
				? undefined
				: expressionEditorContextFor(
						api.getState(),
						slot,
						lookupContext,
						candidate,
						form,
						current,
					),
		[api, slot, candidate, lookupContext, form, current],
	);
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
