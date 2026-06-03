import type { Draft } from "immer";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";

/**
 * App-level mutations: name, connect mode, case type catalog, logo. Each
 * is a single-field assignment with no cascading side effects — they
 * can't orphan entities or desync order maps.
 */
export function applyAppMutation(
	draft: Draft<BlueprintDoc>,
	mut: Extract<
		Mutation,
		{ kind: "setAppName" | "setConnectType" | "setCaseTypes" | "setAppLogo" }
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
		case "setAppLogo":
			// The doc's `logo` slot is `.optional()`, not `.nullable()`, so
			// a cleared logo must drop off the doc — not persist as a
			// literal `null` the schema would reject. The payload carries
			// `null` to mean "clear"; map it to `undefined` so Immer's
			// assignment removes the key. An asset id sets it verbatim.
			draft.logo = mut.logo ?? undefined;
			return;
	}
}
