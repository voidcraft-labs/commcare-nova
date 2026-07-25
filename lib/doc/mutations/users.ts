import type { Draft } from "immer";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import { assertNever } from "@/lib/utils/assertNever";

/**
 * User-property, user-type, and persona mutations.
 *
 * Three flat UUID-keyed collections with one shape between them: add
 * writes the whole entity, update applies a patch key-by-key, remove
 * deletes the entry. Each collection's slot is optional on the doc and
 * born on first write, so an app that never touches them serializes
 * byte-identically to one authored before they existed — and dropping the
 * last entry gives the slot back rather than leaving an empty record
 * behind.
 *
 * TOTAL, like every reducer here: an update or remove naming an absent
 * uuid is a no-op rather than a throw, so a historical event whose target
 * was concurrently removed still replays. The commit gate's
 * `batchTargetsMissing` is what refuses a live edit against a
 * concurrently-removed entity; a reducer that threw would break replay
 * instead.
 *
 * Removal cascades — rewriting the value bags that referenced a removed
 * property, and refusing a user type personas still reference — are
 * planned at the batch-building layer (`lib/doc/userMutations.ts`) and
 * arrive here as their own explicit mutations. Keeping them out of the
 * reducer is what lets an old removal event replay to the same doc it
 * always did, and lets a concurrent edit to a different collection merge.
 */
export function applyUserMutation(
	draft: Draft<BlueprintDoc>,
	mut: Extract<
		Mutation,
		{
			kind:
				| "addUserProperty"
				| "updateUserProperty"
				| "removeUserProperty"
				| "addUserType"
				| "updateUserType"
				| "removeUserType"
				| "addPersona"
				| "updatePersona"
				| "removePersona";
		}
	>,
): void {
	switch (mut.kind) {
		case "addUserProperty":
			draft.userProperties ??= {};
			draft.userProperties[mut.property.uuid] = mut.property;
			return;
		case "updateUserProperty":
			applyPatch(draft.userProperties?.[mut.uuid], mut.patch);
			return;
		case "removeUserProperty":
			dropEntry(draft, "userProperties", mut.uuid);
			return;
		case "addUserType":
			draft.userTypes ??= {};
			draft.userTypes[mut.userType.uuid] = mut.userType;
			return;
		case "updateUserType":
			applyPatch(draft.userTypes?.[mut.uuid], mut.patch);
			return;
		case "removeUserType":
			dropEntry(draft, "userTypes", mut.uuid);
			return;
		case "addPersona":
			draft.personas ??= {};
			draft.personas[mut.persona.uuid] = mut.persona;
			return;
		case "updatePersona":
			applyPatch(draft.personas?.[mut.uuid], mut.patch);
			return;
		case "removePersona":
			dropEntry(draft, "personas", mut.uuid);
			return;
		default:
			assertNever(mut, "applyUserMutation");
	}
}

/**
 * Apply a patch key-by-key. `null` (the wire spelling of a clear — JSON
 * drops `undefined`, so a cleared optional slot can only cross the
 * persistence wire and the SSE stream as an explicit `null`) or
 * `undefined` deletes the slot; anything else assigns. The patch schemas
 * admit `null` only on the clearable slots, so a required one can never
 * reach here as `null` — which is why there is no whole-entity re-parse
 * afterwards.
 */
function applyPatch(
	entity: Record<string, unknown> | undefined,
	patch: Record<string, unknown>,
): void {
	if (entity === undefined) return;
	for (const [key, value] of Object.entries(patch)) {
		if (value === null || value === undefined) {
			delete entity[key];
		} else {
			entity[key] = value;
		}
	}
}

/**
 * Remove one entry, and give the whole slot back when it was the last —
 * so "this app declares no personas" is one doc shape rather than two
 * (absent, and an empty record). Every reader already treats absent as
 * empty, and the two shapes would otherwise diff as a spurious change on
 * every hydration boundary.
 */
function dropEntry(
	draft: Draft<BlueprintDoc>,
	slot: "userProperties" | "userTypes" | "personas",
	uuid: string,
): void {
	const collection = draft[slot];
	if (collection === undefined) return;
	delete collection[uuid];
	// `delete`, not `= undefined`: an explicitly-undefined key still shows up
	// in `Object.keys`, so the in-memory doc would carry a slot that every
	// reader treats as absent and every serializer drops — a difference with
	// no meaning that a future equality check would nonetheless see.
	if (Object.keys(collection).length === 0) delete draft[slot];
}
