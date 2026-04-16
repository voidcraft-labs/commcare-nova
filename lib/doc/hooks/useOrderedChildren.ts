/**
 * Return the ordered child fields of a form or group/repeat.
 *
 * Uses the two-tier subscription pattern: shallow-select the specific
 * order array and the fields map, then memoize the derivation. The
 * returned array is reference-stable when neither the parent's ordering
 * nor any contained field entity has changed.
 */

import { useMemo } from "react";
import type { QuestionEntity, Uuid } from "@/lib/doc/types";
import { useBlueprintDocShallow } from "./useBlueprintDoc";

export function useOrderedChildren(parentUuid: Uuid): QuestionEntity[] {
	const { order, fields } = useBlueprintDocShallow((s) => ({
		order: s.fieldOrder[parentUuid],
		fields: s.fields,
	}));
	return useMemo(
		() =>
			(order ?? [])
				.map((uuid) => fields[uuid])
				.filter((f): f is QuestionEntity => f !== undefined),
		[order, fields],
	);
}
