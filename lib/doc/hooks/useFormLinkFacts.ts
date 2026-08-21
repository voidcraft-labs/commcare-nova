// lib/doc/hooks/useFormLinkFacts.ts
//
// The small document facts the after-submit surfaces read without the
// whole doc: how many links a form has, one link by identity, and the
// after-submit plan (what runs when nothing matched). Named hooks rather
// than selectors at the call site — selector-accepting store hooks are
// lib-private — and each one narrow, so a settings row showing a count
// does not re-render on every unrelated edit.

"use client";

import { useMemo } from "react";
import type { FormLink } from "@/lib/domain";
import { type AfterSubmitPlan, afterSubmitPlan } from "../formLinkMutations";
import type { Uuid } from "../types";
import { useBlueprintDoc, useBlueprintDocApi } from "./useBlueprintDoc";

/** How many after-submit links this form checks. */
export function useFormLinkCount(formUuid: Uuid): number {
	return useBlueprintDoc(
		(state) => state.forms[formUuid]?.formLinks?.length ?? 0,
	);
}

/** One link by identity, or `undefined` once it is gone. */
export function useFormLink(
	formUuid: Uuid | undefined,
	linkUuid: Uuid | undefined,
): FormLink | undefined {
	return useBlueprintDoc((state) =>
		formUuid === undefined || linkUuid === undefined
			? undefined
			: state.forms[formUuid]?.formLinks?.find(
					(candidate) => candidate.uuid === linkUuid,
				),
	);
}

/**
 * What happens after this form is submitted. Recomputed only when the
 * form's links, type, or stored destination change: the plan reads
 * condition text through the document, so it is keyed on the exact slots
 * it depends on rather than on the whole doc.
 */
export function useAfterSubmitPlan(
	formUuid: Uuid,
): AfterSubmitPlan | undefined {
	const links = useBlueprintDoc((state) => state.forms[formUuid]?.formLinks);
	const formType = useBlueprintDoc((state) => state.forms[formUuid]?.type);
	const postSubmit = useBlueprintDoc(
		(state) => state.forms[formUuid]?.postSubmit,
	);
	/* The doc is read imperatively at memo time rather than subscribed to:
	 * a whole-doc subscription would re-render on every unrelated edit for
	 * a plan keyed on three slots. */
	const api = useBlueprintDocApi();
	// biome-ignore lint/correctness/useExhaustiveDependencies: the narrow slots are the memo key; the doc is read for printing only.
	return useMemo(
		() => afterSubmitPlan(api.getState(), formUuid),
		[api, links, formType, postSubmit, formUuid],
	);
}
