"use client";

import { useMemo } from "react";
import { formLinkTargetChoices } from "@/lib/doc/formLinkTargetChoices";
import {
	type FormLink,
	type FormLinkTarget,
	formLinkDestination,
	projectXPath,
	type Uuid,
	xpathPrintContext,
} from "@/lib/domain";
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

/** Resolve a link's identities and expressions against the current document. */
export function useFormLinkProjection() {
	const doc = useBlueprintDoc((state) => state);
	return useMemo(
		() => ({
			destinationOf: (target: FormLinkTarget) =>
				formLinkDestination(doc, target),
			conditionText: (link: FormLink) =>
				link.condition === undefined
					? ""
					: projectXPath(link.condition, xpathPrintContext(doc)).text,
		}),
		[doc],
	);
}
