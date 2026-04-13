import type { Draft } from "immer";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";

/** Module mutations are filled in by later tasks. */
export function applyModuleMutation(
	_draft: Draft<BlueprintDoc>,
	_mut: Extract<
		Mutation,
		{
			kind:
				| "addModule"
				| "removeModule"
				| "moveModule"
				| "renameModule"
				| "updateModule";
		}
	>,
): void {
	throw new Error("applyModuleMutation not implemented");
}
