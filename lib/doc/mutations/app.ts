import type { Draft } from "immer";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";

/** App-level mutations are filled in by the next task. */
export function applyAppMutation(
	_draft: Draft<BlueprintDoc>,
	_mut: Extract<
		Mutation,
		{ kind: "setAppName" | "setConnectType" | "setCaseTypes" }
	>,
): void {
	throw new Error("applyAppMutation not implemented");
}
