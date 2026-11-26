"use client";
import type { Uuid } from "@/lib/domain";
import { moduleCaseTypeForActions } from "@/lib/domain/basicCaseSlots";
import { useBlueprintDocShallow } from "./useBlueprintDoc";

export function useCaseFormContextMenus(owner: Uuid) {
	return useBlueprintDocShallow((doc) => {
		const caseType = moduleCaseTypeForActions(doc, owner);
		return doc.moduleOrder.flatMap((uuid) => {
			const menu = doc.modules[uuid];
			return uuid !== owner &&
				caseType &&
				menu?.caseListConfig?.tile &&
				moduleCaseTypeForActions(doc, uuid) === caseType
				? [menu]
				: [];
		});
	});
}
