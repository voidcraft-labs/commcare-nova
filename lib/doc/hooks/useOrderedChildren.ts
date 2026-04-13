/**
 * Return the ordered child questions of a form or group/repeat.
 *
 * Uses the two-tier subscription pattern: shallow-select the specific
 * order array and the questions map, then memoize the derivation. The
 * returned array is reference-stable when neither the parent's ordering
 * nor any contained question entity has changed.
 */

import { useMemo } from "react";
import type { QuestionEntity, Uuid } from "@/lib/doc/types";
import { useBlueprintDocShallow } from "./useBlueprintDoc";

export function useOrderedChildren(parentUuid: Uuid): QuestionEntity[] {
	const { order, questions } = useBlueprintDocShallow((s) => ({
		order: s.questionOrder[parentUuid],
		questions: s.questions,
	}));
	return useMemo(
		() =>
			(order ?? [])
				.map((uuid) => questions[uuid])
				.filter((q): q is QuestionEntity => q !== undefined),
		[order, questions],
	);
}
