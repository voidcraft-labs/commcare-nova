/**
 * Shared hook for saving a single question field. Used by all contextual
 * editor sections (UI, Logic, Data, Footer) to avoid duplicating the same
 * mutation + notify boilerplate. Converts empty strings to null (removal).
 */

import { useCallback } from "react";
import type { Builder } from "@/lib/services/builder";

export function useSaveQuestion(
	builder: Builder,
): (field: string, value: string | null) => void {
	const selected = builder.selected!;
	const mb = builder.mb!;
	return useCallback(
		(field: string, value: string | null) => {
			if (selected.formIndex === undefined || !selected.questionPath) return;
			mb.updateQuestion(
				selected.moduleIndex,
				selected.formIndex,
				selected.questionPath,
				{
					[field]: value === "" ? null : value,
				},
			);
			builder.notifyBlueprintChanged();
		},
		[
			mb,
			selected.moduleIndex,
			selected.formIndex,
			selected.questionPath,
			builder,
		],
	);
}
