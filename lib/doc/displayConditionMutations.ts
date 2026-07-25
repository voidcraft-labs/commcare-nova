// lib/doc/displayConditionMutations.ts
//
// The one place a module's or a form's navigation display condition is
// written, including the removal.
//
// Removal is the interesting half, and the reason is worth stating
// exactly rather than approximately.
//
// `updateModule` / `updateForm` apply their patch key-by-key and delete
// the slot on `null` OR `undefined`, so both spellings work in memory.
// They diverge the moment a mutation object is itself the DURABLE event:
// the SSE `data-mutations` frame and the persisted jsonb are both
// `JSON.stringify`, which drops an `undefined`-valued key, turning the
// clear into "no change" for every receiver. That is why the patch
// schemas make each `.optional()` slot null-accepting
// (`clearablePartialPatch` in `types.ts`).
//
// The builder does not take that road today — `useBlueprintMutations`
// applies the mutation locally and the reconciler persists a document
// DIFF, and `diffDocsToMutations` independently spells an absent slot as
// `null`. So both roads already end at `null`, and these planners are
// what make the mutation OBJECT correct on its own: a durable emitter of
// these events (the SA and MCP tools) inherits the right spelling
// instead of rediscovering it.
//
// `displayCondition` qualifies for null-as-delete because every reader
// treats absent and `null` identically — the validator rules
// short-circuit on `=== undefined`, and
// `effectiveDisplayConditionForEmission` folds absent to no wire
// attribute. Verify that per slot rather than assuming it; a slot whose
// readers distinguish the two (`setConnectType`, whose `null` is a
// stored value) must not reuse this.

import type { Uuid } from "@/lib/domain";
import type { Predicate } from "@/lib/domain/predicate";
import { updateModuleMutation } from "./addModuleMutation";
import type { Mutation } from "./types";

/**
 * Set or remove a module's display condition. Pass `undefined` to
 * remove it; the emitted patch carries the durable `null`.
 */
export function setModuleDisplayConditionMutation(
	uuid: Uuid,
	next: Predicate | undefined,
): Mutation {
	return updateModuleMutation(uuid, { displayCondition: next ?? null });
}

/**
 * Set or remove a form's display condition. Pass `undefined` to remove
 * it; the emitted patch carries the durable `null`.
 *
 * The `patch`-only shape is deliberate: `caseOperationChange` is the
 * form's other semantic axis and the two never travel together, so a
 * condition edit carries no operation state for a peer to misapply.
 */
export function setFormDisplayConditionMutation(
	uuid: Uuid,
	next: Predicate | undefined,
): Mutation {
	return {
		kind: "updateForm",
		uuid,
		patch: { displayCondition: next ?? null },
	};
}
