"use client";

import { useMemo } from "react";
import { projectFormExpression } from "@/lib/doc/expressionText";
import { formLinkTargetChoices } from "@/lib/doc/formLinkTargetChoices";
import { lookupExpressionDefinitions } from "@/lib/doc/lookupExpressionContext";
import {
	type FormLink,
	type FormLinkEntry,
	type FormLinkTarget,
	guardedLinkDatums,
	type Uuid,
} from "@/lib/domain";
import { formLinkDestination } from "@/lib/domain/formLinkTargets";
import { useLookupCommitState } from "../lookupCommitContext";
import { useBlueprintDoc } from "./useBlueprintDoc";

/** A link as its projection reads it: a destination, or the otherwise link,
 *  which has no condition. */
type ProjectedLink = FormLinkEntry["link"] & {
	readonly condition?: FormLink["condition"];
};

/** A link can point at any menu or form, and whether HQ offers a menu reads
 *  every menu's parent and case type, so the choices read the whole doc. */
export function useFormLinkTargetChoices(formUuid: Uuid) {
	const doc = useBlueprintDoc((state) => state);
	return useMemo(
		() => ({
			choices: formLinkTargetChoices(doc, formUuid),
			nameOf: (uuid: Uuid) => doc.forms[uuid]?.name,
		}),
		[doc, formUuid],
	);
}

const EMPTY_FORM_LINK_PROJECTION = {
	destinationOf: (_target: FormLinkTarget) => undefined,
	conditionText: (_link: ProjectedLink) => "",
	carriesHeldCase: (_link: ProjectedLink) => false,
};

/** Resolve a link against its owning form, or stay empty off a form route. */
export function useFormLinkProjection(formUuid: Uuid | undefined) {
	const { lookupContext } = useLookupCommitState();
	const doc = useBlueprintDoc((state) => state);
	return useMemo(() => {
		if (formUuid === undefined || doc.forms[formUuid] === undefined)
			return EMPTY_FORM_LINK_PROJECTION;
		return {
			destinationOf: (target: FormLinkTarget) =>
				formLinkDestination(doc, formUuid, target),
			/* Whether the held-case guard covers one of the link's carried
			 * values, so it runs only while that case is on the device. */
			carriesHeldCase: (link: ProjectedLink) =>
				guardedLinkDatums(doc, formUuid, link).length > 0,
			conditionText: (link: ProjectedLink) =>
				link.condition === undefined
					? ""
					: projectFormExpression(
							doc,
							{
								entity: "form",
								uuid: formUuid,
								slot: "form_link_condition",
								member: { linkUuid: link.uuid },
							},
							link.condition,
							lookupExpressionDefinitions(lookupContext),
						).text,
		};
	}, [doc, formUuid, lookupContext]);
}
