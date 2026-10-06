"use client";

import { useStoreWithEqualityFn } from "zustand/traditional";
import {
	useBlueprintDocApi,
	useBlueprintDocEq,
} from "@/lib/doc/hooks/useBlueprintDoc";
import type { BlueprintDocState } from "@/lib/doc/store";
import type { Uuid } from "@/lib/domain";
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

/** Admission keeps a sectioned root homogeneous; its first field decides
 * the rendered page branch for the currently published presentation. */
export function usePresentationFormIsSectioned(
	formUuid: Uuid | undefined,
): boolean {
	return usePresentationSelector((doc) => {
		const first =
			formUuid === undefined ? undefined : doc.fieldOrder[formUuid]?.[0];
		return first !== undefined && doc.fields[first]?.kind === "section";
	});
}
