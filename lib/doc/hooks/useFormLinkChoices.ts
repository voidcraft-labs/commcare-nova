"use client";

import { useMemo } from "react";
import { projectFormExpression } from "@/lib/doc/expressionText";
import { formLinkTargetChoices } from "@/lib/doc/formLinkTargetChoices";
import { lookupExpressionDefinitions } from "@/lib/doc/lookupExpressionContext";
import {
	type FormLink,
	type FormLinkTarget,
	formLinkDestination,
	type Uuid,
} from "@/lib/domain";
import { useLookupCommitState } from "../lookupCommitContext";
import { useBlueprintDoc } from "./useBlueprintDoc";

/** Destinations can reference any module, and admission walks the link graph. */
export function useFormLinkTargetChoices(
	formUuid: Uuid,
	editing: Uuid | undefined,
) {
	const doc = useBlueprintDoc((state) => state);
	return useMemo(
		() => ({
			groups: formLinkTargetChoices(doc, formUuid, editing),
			nameOf: (uuid: Uuid) => doc.forms[uuid]?.name,
		}),
		[doc, formUuid, editing],
	);
}

const EMPTY_FORM_LINK_PROJECTION = {
	destinationOf: (_target: FormLinkTarget) => undefined,
	conditionText: (_link: FormLink) => "",
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
				formLinkDestination(doc, target),
			conditionText: (link: FormLink) =>
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
