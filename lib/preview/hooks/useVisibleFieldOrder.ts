"use client";

import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { useBlueprintDocShallow } from "@/lib/doc/hooks/useBlueprintDoc";
import type { Uuid } from "@/lib/domain";
import { DEFAULT_RUNTIME_STATE } from "../engine/engineController";
import { useEngineController } from "./useEngineController";

/** Rendered sibling order. Concrete paths preserve each repeat instance's
 * relevance; value-only changes leave this shallow UUID sequence unchanged. */
export function useVisibleFieldOrder(
	parentUuid: Uuid,
	prefix: string,
): readonly Uuid[] {
	const fields = useBlueprintDocShallow((doc) =>
		(doc.fieldOrder[parentUuid] ?? []).flatMap((uuid) => {
			const field = doc.fields[uuid];
			return field && field.kind !== "hidden" ? [field] : [];
		}),
	);
	const controller = useEngineController();
	return useStore(
		controller.store,
		useShallow((state) =>
			fields
				.filter((field) => {
					const path = `${prefix}/${field.id}`;
					const key = path.includes("[") ? path : field.uuid;
					return (state[key] ?? DEFAULT_RUNTIME_STATE).visible;
				})
				.map((field) => field.uuid),
		),
	);
}
