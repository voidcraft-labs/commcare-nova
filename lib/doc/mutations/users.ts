import type { Draft } from "immer";
import { spliceAfter } from "@/lib/doc/mutations/sequence";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import {
	ownRecordValue,
	recordWithoutKey,
	recordWithValue,
} from "@/lib/domain";
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
			draft.userProperties = recordWithValue(
				draft.userProperties,
				mut.property.uuid,
				// Cloned: `update*` patches the stored entity in place, and a batch is
				// applied more than once per save against a frozen produced state.
				structuredClone(mut.property),
			);
			draft.userPropertyOrder = spliceAfter(
				draft.userPropertyOrder,
				mut.property.uuid,
				mut.after,
			);
			return;
		case "updateUserProperty":
			applyPatch(ownRecordValue(draft.userProperties, mut.uuid), mut.patch);
			return;
		case "removeUserProperty":
			dropEntry(draft, "userProperties", mut.uuid);
			return;
		case "addUserType":
			draft.userTypes = recordWithValue(
				draft.userTypes,
				mut.userType.uuid,
				// Cloned: `update*` patches the stored entity in place, and a batch is
				// applied more than once per save against a frozen produced state.
				structuredClone(mut.userType),
			);
			draft.userTypeOrder = spliceAfter(
				draft.userTypeOrder,
				mut.userType.uuid,
				mut.after,
			);
			return;
		case "updateUserType":
			applyUserDataPatch(
				ownRecordValue(draft.userTypes, mut.uuid),
				mut.patch,
				mut.valuePatch,
			);
			return;
		case "removeUserType":
			dropEntry(draft, "userTypes", mut.uuid);
			return;
		case "addPersona":
			draft.personas = recordWithValue(
				draft.personas,
				mut.persona.uuid,
				// Cloned: `update*` patches the stored entity in place, and a batch is
				// applied more than once per save against a frozen produced state.
				structuredClone(mut.persona),
			);
			draft.personaOrder = spliceAfter(
				draft.personaOrder,
				mut.persona.uuid,
				mut.after,
			);
			return;
		case "updatePersona":
			applyUserDataPatch(
				ownRecordValue(draft.personas, mut.uuid),
				mut.patch,
				mut.valuePatch,
			);
			return;
		case "removePersona":
			dropEntry(draft, "personas", mut.uuid);
			return;
		default:
			assertNever(mut, "applyUserMutation");
	}
}

/**
 * Apply an entity patch carrying the rolling-compatible representation of one
 * value edit. A current receiver ignores the whole-bag fallback and changes
 * only `valuePatch.userPropertyUuid`; an older receiver strips `valuePatch`
 * while parsing and applies the cumulative `patch.values` snapshot.
 */
function applyUserDataPatch(
	entity:
		| Draft<{
				values?: Record<string, string>;
		  }>
		| undefined,
	patch: Record<string, unknown>,
	valuePatch: { userPropertyUuid: string; value: string | null } | undefined,
): void {
	if (entity === undefined) return;
	if (valuePatch === undefined) {
		applyPatch(entity as Record<string, unknown>, patch);
		return;
	}

	const metadataPatch = Object.fromEntries(
		Object.entries(patch).filter(([key]) => key !== "values"),
	);
	applyPatch(entity as Record<string, unknown>, metadataPatch);
	const nextValues =
		valuePatch.value === null
			? recordWithoutKey(entity.values, valuePatch.userPropertyUuid)
			: recordWithValue(
					entity.values,
					valuePatch.userPropertyUuid,
					valuePatch.value,
				);
	if (Object.keys(nextValues).length === 0) {
		delete entity.values;
	} else {
		entity.values = nextValues;
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
/** Which membership array carries each flat collection's sequence. */
const ORDER_SLOT = {
	userProperties: "userPropertyOrder",
	userTypes: "userTypeOrder",
	personas: "personaOrder",
} as const;

/**
 * Place `uuid` immediately after `after` — `null` meaning first, and an anchor
 * that is no longer present meaning append.
 *
 * TOTAL by construction, because historical replay must never block: a batch
 * whose anchor a peer removed still applies, landing the entity at the end
 * rather than throwing. The authoritative commit guard is what rejects a batch
 * whose anchor genuinely vanished; this reducer only has to stay reducible.
 *
 * Idempotent on the uuid: an entity already in the sequence is moved rather
 * than duplicated, so replaying a batch twice cannot double an entry.
 */
function dropEntry(
	draft: Draft<BlueprintDoc>,
	slot: "userProperties" | "userTypes" | "personas",
	uuid: string,
): void {
	// The sequence loses the entity whether or not the record did — an array
	// naming an entity the record no longer holds is exactly the disagreement
	// `assembleBlueprint` refuses to persist.
	const orderSlot = ORDER_SLOT[slot];
	const sequence = (draft as unknown as Record<string, string[] | undefined>)[
		orderSlot
	];
	if (sequence !== undefined) {
		const remaining = sequence.filter((entry) => entry !== uuid);
		(draft as unknown as Record<string, string[] | undefined>)[orderSlot] =
			remaining.length === 0 ? undefined : remaining;
		if (remaining.length === 0) {
			delete (draft as unknown as Record<string, unknown>)[orderSlot];
		}
	}

	const collections = draft as unknown as Record<
		typeof slot,
		Record<string, unknown> | undefined
	>;
	const collection = collections[slot];
	if (collection === undefined) return;
	if (ownRecordValue(collection, uuid) === undefined) return;
	const remaining = recordWithoutKey(collection, uuid);
	// `delete`, not `= undefined`: an explicitly-undefined key still shows up
	// in `Object.keys`, so the in-memory doc would carry a slot that every
	// reader treats as absent and every serializer drops — a difference with
	// no meaning that a future equality check would nonetheless see.
	if (Object.keys(remaining).length === 0) {
		delete collections[slot];
	} else {
		collections[slot] = remaining;
	}
}
