"use client";

import { useStoreWithEqualityFn } from "zustand/traditional";
import {
	useBlueprintDocApi,
	useBlueprintDocEq,
} from "@/lib/doc/hooks/useBlueprintDoc";
import type { BlueprintDocState } from "@/lib/doc/store";
import type { Uuid } from "@/lib/domain";
import { formIsSectioned } from "@/lib/domain/fieldForm";
import { useEngineController } from "./useEngineController";

/** Runtime publication and rendered topology belong to the same snapshot.
 * The authored document stays live; only pending replacement controls retain
 * their last settled IDs, order and container membership. */
export function usePresentationSelector<T>(
	selector: (document: BlueprintDocState) => T,
	equalityFn: (left: T, right: T) => boolean = Object.is,
): T {
	const controller = useEngineController();
	const documentStore = useBlueprintDocApi();
	useBlueprintDocEq(
		(current) => selector(controller.presentationDocument ?? current),
		equalityFn,
	);
	return useStoreWithEqualityFn(
		controller.store,
		() => selector(controller.presentationDocument ?? documentStore.getState()),
		equalityFn,
	);
}

export function usePresentationHasFields(
	parentUuid: Uuid | undefined,
): boolean {
	return usePresentationSelector(
		(doc) =>
			parentUuid !== undefined && (doc.fieldOrder[parentUuid]?.length ?? 0) > 0,
	);
}

/** Read the page layout on the same revision as the rendered questions. */
export function usePresentationFormIsSectioned(
	formUuid: Uuid | undefined,
): boolean {
	return usePresentationSelector(
		(doc) => formUuid !== undefined && formIsSectioned(doc, formUuid),
	);
}
