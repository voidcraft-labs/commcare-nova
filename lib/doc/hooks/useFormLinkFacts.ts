// lib/doc/hooks/useFormLinkFacts.ts
//
// The small document facts the after-submit surfaces read without the
// whole doc: how many links a form has, one link by identity, and the
// after-submit plan (what runs when nothing matched), where the form goes
// after submit, and the destinations its pickers offer. Named hooks rather
// than selectors at the call site — selector-accepting store hooks are
// lib-private — and each one narrow, so a settings row showing a count
// does not re-render on every unrelated edit.

"use client";

import { useMemo } from "react";
import {
	type BlueprintDoc,
	effectivePostSubmit,
	type FormLink,
	type PostSubmitDestination,
	postSubmitDestinationChoices,
} from "@/lib/domain";
import { type AfterSubmitPlan, afterSubmitPlan } from "../formLinkMutations";
import type { Uuid } from "../types";
import {
	useBlueprintDoc,
	useBlueprintDocApi,
	useBlueprintDocShallow,
} from "./useBlueprintDoc";

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

/** Where this form goes after submit: its stored destination, else its
 *  module's default (`effectivePostSubmit`). */
export function useEffectivePostSubmit(
	formUuid: Uuid | undefined,
): PostSubmitDestination | undefined {
	return useBlueprintDoc((state) =>
		formUuid === undefined ? undefined : effectivePostSubmit(state, formUuid),
	);
}

/**
 * The destinations an after-submit picker lists for this form
 * (`postSubmitDestinationChoices`): what its module offers, plus a stored
 * fallback its links keep admitted.
 */
export function usePostSubmitDestinationChoices(
	formUuid: Uuid,
): readonly PostSubmitDestination[] {
	return useBlueprintDocShallow((state) =>
		postSubmitDestinationChoices(state, formUuid),
	);
}

/**
 * What hides a link's target from some or every worker, for the link
 * editor's line under it: `"off-the-menu"` when the target (a form, or the
 * module that holds it, or a target module) is off the menu, `"condition"`
 * when the target carries a display condition, and `undefined` when nothing
 * hides it. `targetKind` names what the line speaks of. A target that is gone
 * reads `undefined`.
 */
export interface FormLinkTargetVisibility {
	readonly targetKind: "form" | "module";
	readonly hiddenBy: "off-the-menu" | "condition" | undefined;
}

/** `FormLinkTargetVisibility` for one link, read from the document. */
export function formLinkTargetVisibility(
	doc: Pick<BlueprintDoc, "forms" | "modules">,
	link: FormLink,
): FormLinkTargetVisibility | undefined {
	const module = doc.modules[link.target.moduleUuid];
	if (module === undefined) return undefined;
	if (link.target.type === "module") {
		return {
			targetKind: "module",
			hiddenBy:
				module.hiddenFromMenu === true
					? "off-the-menu"
					: module.displayCondition !== undefined
						? "condition"
						: undefined,
		};
	}
	const form = doc.forms[link.target.formUuid];
	if (form === undefined) return undefined;
	return {
		targetKind: "form",
		hiddenBy:
			form.hiddenFromMenu === true || module.hiddenFromMenu === true
				? "off-the-menu"
				: form.displayCondition !== undefined
					? "condition"
					: undefined,
	};
}

/** The link editor's read of `formLinkTargetVisibility`. */
export function useFormLinkTargetVisibility(
	formUuid: Uuid | undefined,
	linkUuid: Uuid | undefined,
): FormLinkTargetVisibility | undefined {
	return useBlueprintDocShallow((state) => {
		if (formUuid === undefined || linkUuid === undefined) return undefined;
		const link = state.forms[formUuid]?.formLinks?.find(
			(candidate) => candidate.uuid === linkUuid,
		);
		return link === undefined
			? undefined
			: formLinkTargetVisibility(state, link);
	});
}
