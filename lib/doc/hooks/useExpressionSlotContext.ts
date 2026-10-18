"use client";

import { useCallback, useMemo } from "react";
import type {
	BlueprintDoc,
	CaseOperation,
	Column,
	Field,
	FormLink,
	SearchInputDef,
} from "@/lib/domain";
import { slotContext } from "@/lib/domain/expression/context";
import type { ExpressionSlotRef } from "@/lib/domain/expression/types";
import { lookupTypeIndex } from "../commitVerdicts";
import { useLookupCommitState } from "../lookupCommitContext";
import { useBlueprintDoc, useBlueprintDocApi } from "./useBlueprintDoc";

/** A whole pending entity; partial source/type patches cannot invent context. */
export type ExpressionSlotCandidate =
	| { readonly entity: "field"; readonly value: Field }
	| { readonly entity: "search-input"; readonly value: SearchInputDef }
	| { readonly entity: "column"; readonly value: Column }
	| { readonly entity: "case-operation"; readonly value: CaseOperation }
	| { readonly entity: "form-link"; readonly value: FormLink };

/** Keep the real owner and siblings while substituting one complete candidate. */
export function expressionCandidateDoc(
	doc: BlueprintDoc,
	slot: ExpressionSlotRef,
	candidate?: ExpressionSlotCandidate,
): BlueprintDoc | undefined {
	if (candidate === undefined) return doc;
	const value = candidate.value;
	if (candidate.entity === "field") {
		if (
			slot.entity !== "field" ||
			slot.uuid !== value.uuid ||
			doc.fields[slot.uuid] === undefined
		)
			return undefined;
		return { ...doc, fields: { ...doc.fields, [slot.uuid]: candidate.value } };
	}
	if (candidate.entity === "column" || candidate.entity === "search-input") {
		if (slot.entity !== "module" || !("member" in slot)) return undefined;
		const module = doc.modules[slot.uuid];
		const config = module?.caseListConfig;
		if (config === undefined) return undefined;
		if (candidate.entity === "column") {
			if (
				!("columnUuid" in slot.member) ||
				slot.member.columnUuid !== value.uuid ||
				!config.columns.some((item) => item.uuid === value.uuid)
			)
				return undefined;
			return {
				...doc,
				modules: {
					...doc.modules,
					[slot.uuid]: {
						...module,
						caseListConfig: {
							...config,
							columns: config.columns.map((item) =>
								item.uuid === value.uuid ? candidate.value : item,
							),
						},
					},
				},
			};
		}
		if (
			!("searchInputUuid" in slot.member) ||
			slot.member.searchInputUuid !== value.uuid ||
			!config.searchInputs?.some((item) => item.uuid === value.uuid)
		)
			return undefined;
		return {
			...doc,
			modules: {
				...doc.modules,
				[slot.uuid]: {
					...module,
					caseListConfig: {
						...config,
						searchInputs: config.searchInputs.map((item) =>
							item.uuid === value.uuid ? candidate.value : item,
						),
					},
				},
			},
		};
	}
	if (slot.entity !== "form" || !("member" in slot)) return undefined;
	const form = doc.forms[slot.uuid];
	if (form === undefined) return undefined;
	if (candidate.entity === "case-operation") {
		if (
			!("operationUuid" in slot.member) ||
			slot.member.operationUuid !== value.uuid ||
			!form.caseOperations?.some((item) => item.uuid === value.uuid)
		)
			return undefined;
		return {
			...doc,
			forms: {
				...doc.forms,
				[slot.uuid]: {
					...form,
					caseOperations: form.caseOperations.map((item) =>
						item.uuid === value.uuid ? candidate.value : item,
					),
				},
			},
		};
	}
	if (
		!("linkUuid" in slot.member) ||
		slot.member.linkUuid !== value.uuid ||
		!form.formLinks?.some((item) => item.uuid === value.uuid)
	)
		return undefined;
	return {
		...doc,
		forms: {
			...doc.forms,
			[slot.uuid]: {
				...form,
				formLinks: form.formLinks.map((item) =>
					item.uuid === value.uuid ? candidate.value : item,
				),
			},
		},
	};
}

/** Missing owners after a concurrent deletion render no editor context. */
export function useExpressionSlotContext(
	slot: ExpressionSlotRef | undefined,
	candidate?: ExpressionSlotCandidate,
) {
	const doc = useBlueprintDoc((current) => current);
	const { lookupContext } = useLookupCommitState();
	const tables = useMemo(() => lookupTypeIndex(lookupContext), [lookupContext]);
	return useMemo(() => {
		if (slot === undefined) return undefined;
		const candidateDoc = expressionCandidateDoc(doc, slot, candidate);
		return candidateDoc === undefined
			? undefined
			: slotContext(candidateDoc, slot, tables);
	}, [doc, slot, candidate, tables]);
}

/** Callback-time context uses the newest committed document and lookup snapshot. */
export function useExpressionSlotContextBuilder() {
	const api = useBlueprintDocApi();
	const { lookupContext } = useLookupCommitState();
	const tables = useMemo(() => lookupTypeIndex(lookupContext), [lookupContext]);
	return useCallback(
		(slot: ExpressionSlotRef, candidate?: ExpressionSlotCandidate) => {
			const candidateDoc = expressionCandidateDoc(
				api.getState(),
				slot,
				candidate,
			);
			return candidateDoc === undefined
				? undefined
				: slotContext(candidateDoc, slot, tables);
		},
		[api, tables],
	);
}

/** Current Project lookup types for consumers holding an explicit document. */
export function useExpressionLookupTypes() {
	const { lookupContext } = useLookupCommitState();
	return useMemo(() => lookupTypeIndex(lookupContext), [lookupContext]);
}
