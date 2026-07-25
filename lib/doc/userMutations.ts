/**
 * Batch-building planners for the three user collections.
 *
 * Every add lands its entity complete, and every remove carries whatever
 * cleanup its removal implies — as explicit granular mutations, never as a
 * reducer side effect. That is the same discipline `caseTypeRetirement.ts`
 * follows and it buys the same two things: an old removal event replays to
 * the doc it always did, and a peer's concurrent edit to a different
 * collection merges instead of being clobbered.
 *
 * Two removals are more than a delete:
 *
 *   - Removing a PROPERTY strands every value bag that names it. The plan
 *     rewrites each affected role and persona in the same batch, so the
 *     document never passes through a state where a value points at
 *     nothing.
 *   - Removing a ROLE that personas still hold is refused rather than
 *     silently unassigning them. Naming the personas is what lets the
 *     author decide; quietly clearing their role would look like the app
 *     losing their identity.
 */

import { appendOrderKey } from "@/lib/doc/order/append";
import type { Mutation } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	type Persona,
	personasOf,
	type UserDataValues,
	type UserProperty,
	type UserType,
	type Uuid,
	userPropertiesOf,
	userTypesOf,
} from "@/lib/domain";

/** Sort-key order for an entity appended to one of the flat collections. */
function nextOrderKey(collection: Record<string, { order?: string }>): string {
	return appendOrderKey(Object.values(collection));
}

/** Mint the `addUserProperty` for a new piece of worker information. */
export function addUserPropertyMutations(
	doc: BlueprintDoc,
	uuid: Uuid,
	property: Omit<UserProperty, "uuid" | "order">,
): Mutation[] {
	return [
		{
			kind: "addUserProperty",
			property: {
				...property,
				uuid,
				order: nextOrderKey(userPropertiesOf(doc)),
			},
		},
	];
}

/** Mint the `addUserType` for a new role. */
export function addUserTypeMutations(
	doc: BlueprintDoc,
	uuid: Uuid,
	userType: Omit<UserType, "uuid" | "order">,
): Mutation[] {
	return [
		{
			kind: "addUserType",
			userType: { ...userType, uuid, order: nextOrderKey(userTypesOf(doc)) },
		},
	];
}

/** Mint the `addPersona` for a new preview actor. */
export function addPersonaMutations(
	doc: BlueprintDoc,
	uuid: Uuid,
	persona: Omit<Persona, "uuid" | "order">,
): Mutation[] {
	return [
		{
			kind: "addPersona",
			persona: { ...persona, uuid, order: nextOrderKey(personasOf(doc)) },
		},
	];
}

/** A value bag with one key dropped, or `undefined` when nothing changes. */
function withoutKey(
	values: UserDataValues | undefined,
	propertyUuid: Uuid,
): UserDataValues | undefined {
	if (values === undefined || values[propertyUuid] === undefined) {
		return undefined;
	}
	const next = { ...values };
	delete next[propertyUuid];
	return next;
}

/**
 * Remove a property and every value recorded against it.
 *
 * The rewritten bags travel as whole `values` objects rather than per-key
 * clears: a concrete object survives JSON intact, so omitting a key from
 * the rebuilt bag IS the clear, with no `null` sentinel needed. An
 * emptied bag is sent as `null`, which the patch reducer treats as a
 * delete — the shape a bag-less role or persona already has.
 */
export function removeUserPropertyMutations(
	doc: BlueprintDoc,
	uuid: Uuid,
): Mutation[] {
	const mutations: Mutation[] = [];
	for (const type of Object.values(userTypesOf(doc))) {
		const next = withoutKey(type.values, uuid);
		if (next === undefined) continue;
		mutations.push({
			kind: "updateUserType",
			uuid: type.uuid,
			patch: { values: Object.keys(next).length > 0 ? next : null },
		});
	}
	for (const persona of Object.values(personasOf(doc))) {
		const next = withoutKey(persona.values, uuid);
		if (next === undefined) continue;
		mutations.push({
			kind: "updatePersona",
			uuid: persona.uuid,
			patch: { values: Object.keys(next).length > 0 ? next : null },
		});
	}
	mutations.push({ kind: "removeUserProperty", uuid });
	return mutations;
}

/** Whether a role can be removed, and what to say when it cannot. */
export type RemoveUserTypePlan =
	| { ok: true; mutations: Mutation[] }
	| { ok: false; personaNames: string[]; userMessage: string };

/**
 * Plan a role removal. A role personas still hold is refused with those
 * personas named, because the alternative — quietly unassigning them —
 * changes who those personas are without saying so.
 */
export function removeUserTypePlan(
	doc: BlueprintDoc,
	uuid: Uuid,
): RemoveUserTypePlan {
	const holders = Object.values(personasOf(doc))
		.filter((persona) => persona.userTypeUuid === uuid)
		.map((persona) => persona.name);
	if (holders.length > 0) {
		const list = holders.join(", ");
		return {
			ok: false,
			personaNames: holders,
			userMessage:
				holders.length === 1
					? `${list} has this role. Give them a different role, or remove them, before removing the role itself.`
					: `${list} have this role. Give them different roles, or remove them, before removing the role itself.`,
		};
	}
	return { ok: true, mutations: [{ kind: "removeUserType", uuid }] };
}

/**
 * Remove a preview actor.
 *
 * Nothing in the blueprint references a persona, so this is the whole
 * batch. Case rows the persona owns are deliberately left alone: their
 * `owner_id` keeps naming it.
 *
 * That is Nova's rule rather than HQ parity, because HQ has two different
 * answers. DEACTIVATING a worker closes their usercase and leaves their
 * cases untouched (`sync_usercase.py::_get_sync_usercase_helper`), while
 * DELETING one soft-deletes every case they own
 * (`users/models.py::CommCareUser.retire` → `::delete_user_data`). A
 * persona is a design and test actor, not a person who left an
 * organization, and the cases it created are the author's own test data —
 * so neither answer transfers, and destroying that data on a delete would
 * be a surprise. The confirmation states the row count instead.
 */
export function removePersonaMutations(uuid: Uuid): Mutation[] {
	return [{ kind: "removePersona", uuid }];
}
