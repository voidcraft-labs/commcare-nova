/**
 * Reconstruct the nested `BlueprintForm` shape for a single form.
 *
 * Used by consumers that predate the normalized doc model — the expander,
 * the XForms compiler, the form preview renderer. Memoized so the
 * reconstruction runs only when the form's entity or question subtree
 * changes.
 */

import { useMemo } from "react";
import type { BlueprintDoc, QuestionEntity, Uuid } from "@/lib/doc/types";
import type { BlueprintForm, Question } from "@/lib/schemas/blueprint";
import { assembleFormFields } from "@/lib/services/normalizedState";
import { useBlueprintDocShallow } from "./useBlueprintDoc";

export function useAssembledForm(formUuid: Uuid): BlueprintForm | undefined {
	const { form, questions, questionOrder } = useBlueprintDocShallow((s) => ({
		form: s.forms[formUuid],
		questions: s.questions,
		questionOrder: s.questionOrder,
	}));

	return useMemo(() => {
		if (!form) return undefined;
		// Use the shared camel→snake assembler so the returned BlueprintForm
		// has wire-format field names (close_condition, post_submit, etc.).
		// Cast through `unknown` to bridge the branded Uuid vs plain string gap.
		return {
			...assembleFormFields(
				form as unknown as Parameters<typeof assembleFormFields>[0],
			),
			questions: assembleQuestionTree(formUuid, questions, questionOrder),
		};
	}, [form, formUuid, questions, questionOrder]);
}

/**
 * Recursively rebuild the nested question tree for a single parent.
 *
 * Mirrors the `assembleQuestions` function in `converter.ts` but operates
 * on the flat entity maps rather than the full `BlueprintDoc`. Groups and
 * repeats include a `children` array; leaf questions omit it entirely.
 */
function assembleQuestionTree(
	parentUuid: Uuid,
	questions: BlueprintDoc["questions"],
	questionOrder: BlueprintDoc["questionOrder"],
): Question[] {
	const order = questionOrder[parentUuid] ?? [];
	return order
		.map((uuid) => {
			const q = questions[uuid];
			if (!q) return undefined;
			const nested = questionOrder[uuid];
			return nested !== undefined
				? {
						...(q as QuestionEntity),
						children: assembleQuestionTree(uuid, questions, questionOrder),
					}
				: (q as Question);
		})
		.filter((q): q is Question => q !== undefined);
}
