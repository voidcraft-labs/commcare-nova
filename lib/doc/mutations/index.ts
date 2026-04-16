/**
 * Mutation dispatcher. Every way the doc can change flows through here.
 *
 * Sub-files (`app.ts`, `modules.ts`, `forms.ts`, `fields.ts`) each
 * handle a related family of mutations. This top-level switch routes
 * on `kind` and delegates.
 *
 * `applyMutation` operates on an Immer draft — call sites wrap it in
 * `produce()` or let the Zustand store's Immer middleware handle the
 * drafting. Returns metadata for `moveField` and `renameField`
 * mutations (used by `applyWithResult` on the store); returns `undefined`
 * for all other mutation kinds.
 *
 * `applyMutations` is a batched convenience for the agent stream
 * (Phase 4) and for restoring a doc from a mutation log.
 */

import type { Draft } from "immer";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import { applyAppMutation } from "./app";
import {
	applyFieldMutation,
	type FieldRenameMeta,
	type MoveFieldResult,
	// Legacy aliases kept until Phase 21 consumers are renamed.
	type MoveQuestionResult,
	type QuestionRenameMeta,
} from "./fields";
import { applyFormMutation } from "./forms";
import { assertNever } from "./helpers";
import { applyModuleMutation } from "./modules";

// Legacy re-exports for consumers that haven't been renamed yet.
export type {
	FieldRenameMeta,
	MoveFieldResult,
	MoveQuestionResult,
	QuestionRenameMeta,
};

/**
 * Apply a single mutation to an Immer draft and return any metadata the
 * reducer produces. `moveField` returns `MoveFieldResult`;
 * `renameField` returns `FieldRenameMeta`; all others return `undefined`.
 */
export function applyMutation(
	draft: Draft<BlueprintDoc>,
	mut: Mutation,
): MoveFieldResult | FieldRenameMeta | undefined {
	switch (mut.kind) {
		case "setAppName":
		case "setConnectType":
		case "setCaseTypes":
			applyAppMutation(draft, mut);
			break;
		case "addModule":
		case "removeModule":
		case "moveModule":
		case "renameModule":
		case "updateModule":
			applyModuleMutation(draft, mut);
			break;
		case "addForm":
		case "removeForm":
		case "moveForm":
		case "renameForm":
		case "updateForm":
		case "replaceForm":
			applyFormMutation(draft, mut);
			break;
		case "addField":
		case "removeField":
		case "moveField":
		case "renameField":
		case "duplicateField":
		case "updateField":
			return applyFieldMutation(draft, mut);
		default:
			assertNever(mut);
	}
}

/** Apply a batch of mutations to a single Immer draft. */
export function applyMutations(
	draft: Draft<BlueprintDoc>,
	muts: Mutation[],
): void {
	for (const mut of muts) applyMutation(draft, mut);
}
