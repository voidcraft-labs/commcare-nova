import type { Draft } from "immer";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";

/** Form mutations are filled in by later tasks. */
export function applyFormMutation(
	_draft: Draft<BlueprintDoc>,
	_mut: Extract<
		Mutation,
		{
			kind:
				| "addForm"
				| "removeForm"
				| "moveForm"
				| "renameForm"
				| "updateForm"
				| "replaceForm";
		}
	>,
): void {
	throw new Error("applyFormMutation not implemented");
}
