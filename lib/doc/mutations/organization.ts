import type { Draft } from "immer";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import { assertNever } from "@/lib/utils/assertNever";

/**
 * Organization-level and location-property mutations.
 *
 * Two flat UUID-keyed collections with one shape between them: add writes
 * the whole entity, update applies a patch key-by-key, remove deletes the
 * entry. Each collection's slot is optional on the doc and born on first
 * write, so an app that never declares an organization serializes
 * byte-identically to one authored before these existed — and dropping the
 * last entry gives the slot back rather than leaving an empty record
 * behind.
 *
 * TOTAL, like every reducer here: an update or remove naming an absent
 * uuid is a no-op rather than a throw, so a historical event whose target
 * was concurrently removed still replays. `batchTargetsMissing` is what
 * refuses a LIVE edit against a concurrently-removed entity; a reducer
 * that threw would break replay instead.
 *
 * Nothing here consults the locations store, and that is the whole reason
 * the two halves of the organization are stored apart. Removing a level
 * with places still standing at it is refused inside the commit
 * transaction, because only the store knows whether any exist; removing a
 * location property sheds its values from those rows in that same
 * transaction. A reducer cannot make either decision — it has no
 * database, and it must reduce identically on the client, on the server,
 * and during replay of an event written a year ago. Keeping the cascade
 * out is what lets an old removal event replay to the document it always
 * produced.
 */
export function applyOrganizationMutation(
	draft: Draft<BlueprintDoc>,
	mut: Extract<
		Mutation,
		{
			kind:
				| "addOrganizationLevel"
				| "updateOrganizationLevel"
				| "removeOrganizationLevel"
				| "addLocationProperty"
				| "updateLocationProperty"
				| "removeLocationProperty";
		}
	>,
): void {
	switch (mut.kind) {
		case "addOrganizationLevel":
			draft.organizationLevels ??= {};
			draft.organizationLevels[mut.level.uuid] = mut.level;
			return;
		case "updateOrganizationLevel":
			applyPatch(draft.organizationLevels?.[mut.uuid], mut.patch);
			return;
		case "removeOrganizationLevel":
			dropEntry(draft, "organizationLevels", mut.uuid);
			return;
		case "addLocationProperty":
			draft.locationProperties ??= {};
			draft.locationProperties[mut.property.uuid] = mut.property;
			return;
		case "updateLocationProperty":
			applyPatch(draft.locationProperties?.[mut.uuid], mut.patch);
			return;
		case "removeLocationProperty":
			dropEntry(draft, "locationProperties", mut.uuid);
			return;
		default:
			assertNever(mut, "applyOrganizationMutation");
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
 * so "this app declares no organization" is one doc shape rather than two
 * (absent, and an empty record). Every reader already treats absent as
 * empty, and the two shapes would otherwise diff as a spurious change on
 * every hydration boundary.
 */
function dropEntry(
	draft: Draft<BlueprintDoc>,
	slot: "organizationLevels" | "locationProperties",
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
