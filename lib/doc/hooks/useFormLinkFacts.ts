// lib/doc/hooks/useFormLinkFacts.ts
//
// The small document facts the after-submit surfaces read without the
// whole doc: how many destinations a form has, one destination by
// identity, its otherwise, the after-submit plan (its destinations, which
// of them may not run, its otherwise, or the after-submit of a form without
// destinations), and the built-in destinations its pickers offer: the
// after-submit choices of a form without destinations, the otherwise
// choices of a form with them. Named hooks rather than selectors at the
// call site (selector-accepting store hooks are lib-private), and each one
// narrow, so a settings row showing a count does not re-render on every
// unrelated edit.

"use client";

import { useMemo } from "react";
import {
	type BlueprintDoc,
	effectivePostSubmit,
	type FormLinkEntry,
	type FormOtherwise,
	formLinkEntries,
	type OtherwiseDestination,
	otherwiseDestinationsOffered,
	type PostSubmitDestination,
	postSubmitDestinationChoices,
	resolveFormLinkTarget,
} from "@/lib/domain";
import { type AfterSubmitPlan, afterSubmitPlan } from "../formLinkMutations";
import type { Uuid } from "../types";
import {
	useBlueprintDoc,
	useBlueprintDocApi,
	useBlueprintDocShallow,
} from "./useBlueprintDoc";

/** How many after-submit destinations this form has. */
export function useFormLinkCount(formUuid: Uuid): number {
	return useBlueprintDoc(
		(state) => state.forms[formUuid]?.formLinks?.length ?? 0,
	);
}

/** One link by identity, a destination or the otherwise link (the stored
 *  object, so the selection stays referentially stable), or `undefined` once
 *  it is gone. */
export function useFormLink(
	formUuid: Uuid | undefined,
	linkUuid: Uuid | undefined,
): FormLinkEntry["link"] | undefined {
	return useBlueprintDoc((state) => {
		if (formUuid === undefined || linkUuid === undefined) return undefined;
		const form = state.forms[formUuid];
		const destination = form?.formLinks?.find(
			(candidate) => candidate.uuid === linkUuid,
		);
		if (destination !== undefined) return destination;
		const otherwise = form?.otherwise;
		return otherwise?.kind === "link" && otherwise.uuid === linkUuid
			? otherwise
			: undefined;
	});
}

/** The form's otherwise, or `undefined` when it has none. */
export function useFormOtherwise(
	formUuid: Uuid | undefined,
): FormOtherwise | undefined {
	return useBlueprintDoc((state) =>
		formUuid === undefined ? undefined : state.forms[formUuid]?.otherwise,
	);
}

/**
 * What happens after this form is submitted (`afterSubmitPlan`). Recomputed
 * when the form's destinations, otherwise, type or stored after-submit
 * change, or when its menu's offered set or its targets' selections do:
 * which destinations may not run reads what each target selects, so the
 * plan is keyed on the form's slots and on the module and form maps rather
 * than on every field edit.
 */
export function useAfterSubmitPlan(
	formUuid: Uuid,
): AfterSubmitPlan | undefined {
	const form = useBlueprintDoc((state) => state.forms[formUuid]);
	const modules = useBlueprintDoc((state) => state.modules);
	const formOrder = useBlueprintDoc((state) => state.formOrder);
	/* The doc is read imperatively at memo time rather than subscribed to:
	 * a whole-doc subscription would re-render on every field edit for a
	 * plan keyed on the form, its menus and their membership. */
	const api = useBlueprintDocApi();
	// biome-ignore lint/correctness/useExhaustiveDependencies: the narrow slots are the memo key; the doc is read whole at memo time.
	return useMemo(
		() => afterSubmitPlan(api.getState(), formUuid),
		[api, form, modules, formOrder, formUuid],
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
 * The destinations the after-submit picker of a form without destinations
 * lists (`postSubmitDestinationChoices`): what its menu offers.
 */
export function usePostSubmitDestinationChoices(
	formUuid: Uuid,
): readonly PostSubmitDestination[] {
	return useBlueprintDocShallow((state) =>
		postSubmitDestinationChoices(state, formUuid),
	);
}

/**
 * The built-in otherwise destinations a form with destinations is offered
 * (`otherwiseDestinationsOffered`): its menu's after-submit set less the app
 * home, which an absent otherwise means.
 */
export function useOtherwiseDestinationsOffered(
	formUuid: Uuid,
): readonly OtherwiseDestination[] {
	return useBlueprintDocShallow((state) =>
		otherwiseDestinationsOffered(state, formUuid),
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

/** `FormLinkTargetVisibility` for one link of `formUuid`, a destination or
 *  the otherwise link, read from the document. `this-form` reads the form
 *  itself in its own menu. */
export function formLinkTargetVisibility(
	doc: Pick<BlueprintDoc, "forms" | "modules" | "formOrder">,
	formUuid: Uuid,
	link: FormLinkEntry["link"],
): FormLinkTargetVisibility | undefined {
	const target = resolveFormLinkTarget(doc, formUuid, link.target);
	if (target === undefined) return undefined;
	const module = doc.modules[target.moduleUuid];
	if (module === undefined) return undefined;
	if (target.type === "module") {
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
	const form = doc.forms[target.formUuid];
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
		const form = state.forms[formUuid];
		const entry =
			form === undefined
				? undefined
				: formLinkEntries(form).find(
						(candidate) => candidate.link.uuid === linkUuid,
					);
		return entry === undefined
			? undefined
			: formLinkTargetVisibility(state, formUuid, entry.link);
	});
}
