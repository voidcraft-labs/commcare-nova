/**
 * Mutation dispatcher. Every way the doc can change flows through here.
 *
 * Sub-files (`app.ts`, `modules.ts`, `forms.ts`, `questions.ts`) each
 * handle a related family of mutations. This top-level switch routes
 * on `kind` and delegates.
 *
 * `applyMutation` operates on an Immer draft — call sites wrap it in
 * `produce()` or let the Zustand store's Immer middleware handle the
 * drafting. `applyMutations` is a batched convenience for the agent
 * stream (Phase 4) and for restoring a doc from a mutation log.
 */

import type { Draft } from "immer";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import { applyAppMutation } from "./app";
import { applyFormMutation } from "./forms";
import { assertNever } from "./helpers";
import { applyModuleMutation } from "./modules";
import { applyQuestionMutation } from "./questions";

export function applyMutation(draft: Draft<BlueprintDoc>, mut: Mutation): void {
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
		case "addQuestion":
		case "removeQuestion":
		case "moveQuestion":
		case "renameQuestion":
		case "duplicateQuestion":
		case "updateQuestion":
			applyQuestionMutation(draft, mut);
			break;
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
