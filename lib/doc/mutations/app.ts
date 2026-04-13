import type { Draft } from "immer";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";

/**
 * App-level mutations: name, connect mode, case type catalog. Each is
 * a single-field assignment with no cascading side effects — they can't
 * orphan entities or desync order maps.
 */
export function applyAppMutation(
	draft: Draft<BlueprintDoc>,
	mut: Extract<
		Mutation,
		{ kind: "setAppName" | "setConnectType" | "setCaseTypes" }
	>,
): void {
	switch (mut.kind) {
		case "setAppName":
			draft.appName = mut.name;
			return;
		case "setConnectType":
			draft.connectType = mut.connectType;
			return;
		case "setCaseTypes":
			draft.caseTypes = mut.caseTypes;
			return;
	}
}
