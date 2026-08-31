import { deepEqual } from "@/lib/doc/deepEqual";
import type { Mutation } from "@/lib/doc/types";
import type { CaseSelection, Module } from "@/lib/domain";

export type CaseSelectionChangePlan =
	| {
			readonly ok: true;
			readonly mutations: readonly Mutation[];
			readonly clearsPersistentTile: boolean;
	  }
	| {
			readonly ok: false;
			readonly reason: "missing-case-list";
	  };

/**
 * Plan the one canonical selection edit shared by Builder, SA, and MCP.
 *
 * `undefined` means the ordinary one-case flow and is emitted as an explicit
 * `null` clear so it survives both JSON wires. Enabling multiple selection
 * also removes only `tile.persistOnForms`: that presentation requires a
 * scalar selected case, while the tile itself and any grouping remain valid.
 * Every other compatibility rule stays in the absolute document gate, so a
 * caller receives the same findings on all three authoring surfaces.
 */
export function planCaseSelectionChange(
	module: Pick<Module, "uuid" | "caseListConfig">,
	selection: CaseSelection | undefined,
): CaseSelectionChangePlan {
	const config = module.caseListConfig;
	if (config === undefined) {
		return { ok: false, reason: "missing-case-list" };
	}

	const clearsPersistentTile =
		selection?.kind === "multiple" && config.tile?.persistOnForms === true;
	const selectionChanged = !deepEqual(config.selection, selection);
	if (!selectionChanged && !clearsPersistentTile) {
		return { ok: true, mutations: [], clearsPersistentTile: false };
	}

	const patch: Extract<Mutation, { kind: "setCaseListMeta" }>["patch"] = {};
	if (selectionChanged) {
		patch.selection = selection ?? null;
	}
	if (clearsPersistentTile) {
		const { persistOnForms: _persistOnForms, ...retainedTile } =
			config.tile ?? {};
		patch.tile = structuredClone(retainedTile);
	}

	return {
		ok: true,
		mutations: [{ kind: "setCaseListMeta", uuid: module.uuid, patch }],
		clearsPersistentTile,
	};
}
