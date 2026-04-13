import type { Draft } from "immer";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";

/** Question mutations are filled in by later tasks. */
export function applyQuestionMutation(
	_draft: Draft<BlueprintDoc>,
	_mut: Extract<
		Mutation,
		{
			kind:
				| "addQuestion"
				| "removeQuestion"
				| "moveQuestion"
				| "renameQuestion"
				| "duplicateQuestion"
				| "updateQuestion";
		}
	>,
): void {
	throw new Error("applyQuestionMutation not implemented");
}
