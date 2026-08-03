/**
 * Batch-building planners for the organization's shape and for a persona's
 * place in it.
 *
 * Every add lands its entity complete, and every remove carries whatever
 * document cleanup its removal implies — as explicit granular mutations, never
 * as a reducer side effect. Same discipline as `userMutations.ts` and
 * `caseTypeRetirement.ts`, buying the same two things: an old removal event
 * replays to the doc it always did, and a peer's concurrent edit to a
 * different collection merges instead of being clobbered.
 *
 * **Where the cascades are NOT.** Removing a level while places still stand at
 * it, and shedding a removed property's values from those places, are both
 * settled inside the commit transaction (`lib/organization/commitIntegrity.ts`)
 * — they are questions about rows, and a document-time answer would already be
 * stale by the time it was acted on. What lives here is the document half: the
 * references one level holds to another, and the values a persona holds.
 *
 * The removal planners take an optional `occupiedLevelUuids`, which a caller
 * holding the organization snapshot passes so the refusal can name the places
 * before a round trip. That is optimistic client feedback over a revisioned
 * snapshot; the server's transactional check is what actually decides.
 */

import type { Mutation } from "@/lib/doc/types";
import {
	assignedLocationUuids,
	type BlueprintDoc,
	entityTargetKey,
	type LocationProperty,
	locationPropertiesOf,
	type OrganizationLevel,
	organizationLevelsOf,
	type PersonaLocations,
	personasOf,
	type Uuid,
} from "@/lib/domain";
import { referencingCarrierUuids } from "./referenceIndex";

function appendAfter(order: readonly Uuid[] | undefined): Uuid | null {
	return order?.at(-1) ?? null;
}

/** Mint the `addOrganizationLevel` for a new rung. */
export function addOrganizationLevelMutations(
	doc: BlueprintDoc,
	uuid: Uuid,
	level: Omit<OrganizationLevel, "uuid">,
): Mutation[] {
	return [
		{
			kind: "addOrganizationLevel",
			level: { ...level, uuid },
			after: appendAfter(doc.organizationLevelOrder),
		},
	];
}

/** Mint the `addLocationProperty` for a new piece of information about a place. */
export function addLocationPropertyMutations(
	doc: BlueprintDoc,
	uuid: Uuid,
	property: Omit<LocationProperty, "uuid">,
): Mutation[] {
	return [
		{
			kind: "addLocationProperty",
			property: { ...property, uuid },
			after: appendAfter(doc.locationPropertyOrder),
		},
	];
}

/** Whether a level can be removed, and what to say when it cannot. */
export type RemoveOrganizationLevelPlan =
	| { ok: true; mutations: Mutation[] }
	| { ok: false; userMessage: string };

/**
 * Plan a level removal.
 *
 * Three things can block it, and each is refused with what to do rather than
 * silently repaired:
 *
 *   - **Places still stand at it.** Refused with the count when the caller
 *     supplies the snapshot; refused by the commit regardless. Silently
 *     archiving them would destroy work in the name of tidiness.
 *   - **Another level sits under it.** Removing it would strand that level's
 *     parentage. Re-parenting the orphan to its grandparent is a decision
 *     about the shape of the organization, and that belongs to the author.
 *   - **Another level's settings name it** — a depth cap, a shared-branch
 *     starting point, an address-book allowlist. Those are refused rather than
 *     rewritten because each one encodes an intent that has no automatic
 *     substitute.
 *
 * A location property that applies only to the removed level IS a blocker.
 * Empty scope has no stored spelling, while absent scope means every level;
 * silently clearing the singleton would therefore broaden it globally.
 */
export function removeOrganizationLevelPlan(
	doc: BlueprintDoc,
	uuid: Uuid,
	occupiedLevelUuids?: ReadonlySet<string>,
): RemoveOrganizationLevelPlan {
	const levels = organizationLevelsOf(doc);
	const level = levels[uuid];
	if (level === undefined) return { ok: true, mutations: [] };

	if (occupiedLevelUuids?.has(uuid) === true) {
		return {
			ok: false,
			userMessage: `"${level.name}" still has places in it. Move or archive those places first, then remove the level.`,
		};
	}

	const children = Object.values(levels).filter(
		(candidate) => candidate.parentLevelUuid === uuid,
	);
	if (children.length > 0) {
		const names = children.map((child) => child.name).join(", ");
		return {
			ok: false,
			userMessage: `${names} ${children.length === 1 ? "sits" : "sit"} under "${level.name}". Move ${children.length === 1 ? "it" : "them"} somewhere else first, then remove the level.`,
		};
	}

	const referrers = Object.values(levels).filter(
		(candidate) => candidate.uuid !== uuid && levelReferences(candidate, uuid),
	);
	if (referrers.length > 0) {
		const names = referrers.map((referrer) => referrer.name).join(", ");
		return {
			ok: false,
			userMessage: `${names} ${referrers.length === 1 ? "uses" : "use"} "${level.name}" in ${referrers.length === 1 ? "its" : "their"} settings. Change ${referrers.length === 1 ? "that" : "those"} first, then remove the level.`,
		};
	}

	const indexedReferrers = referencingCarrierUuids(doc, entityTargetKey(uuid));
	if (indexedReferrers.some((carrier) => doc.forms[carrier] !== undefined)) {
		return {
			ok: false,
			userMessage: `A case-owner rule uses "${level.name}". Choose a different destination in that rule first, then remove the level.`,
		};
	}

	const mutations: Mutation[] = [];
	for (const property of Object.values(locationPropertiesOf(doc))) {
		if (property.levelUuids === undefined) continue;
		if (!property.levelUuids.includes(uuid)) continue;
		const remaining = property.levelUuids.filter(
			(levelUuid) => levelUuid !== uuid,
		);
		if (remaining.length === 0) {
			return {
				ok: false,
				userMessage: `The place-information field "${property.label}" applies only to "${level.name}". Change or remove that field before removing the level.`,
			};
		}
		mutations.push({
			kind: "updateLocationProperty",
			uuid: property.uuid,
			patch: { levelUuids: remaining },
		});
	}
	mutations.push({ kind: "removeOrganizationLevel", uuid });
	return { ok: true, mutations };
}

/** Whether one level's settings name another. */
function levelReferences(level: OrganizationLevel, target: string): boolean {
	const flow = level.caseFlow;
	if (
		flow.workers === "assigned" &&
		flow.descendantCases.kind === "down-to" &&
		flow.descendantCases.levelUuid === target
	) {
		return true;
	}
	const book = level.addressBook;
	if (book.reach === "own-branch-limited") {
		if (book.levelUuids.some((levelUuid) => levelUuid === target)) return true;
	} else if (book.downToLevelUuid === target) {
		return true;
	}
	if (book.reach === "shared-branch" && book.fromLevelUuid === target) {
		return true;
	}
	return (
		(book.reach === "own-branch" || book.reach === "own-branch-limited") &&
		book.alsoIncludeTopDownToLevelUuid === target
	);
}

/**
 * Remove a location property.
 *
 * Nothing in the DOCUMENT references one — the values live on location rows,
 * which the commit sheds in the same transaction — so this is the whole batch.
 */
export function removeLocationPropertyMutations(uuid: Uuid): Mutation[] {
	return [{ kind: "removeLocationProperty", uuid }];
}

/**
 * Set where a persona works.
 *
 * The primary is always first and never repeated among the others, which is
 * the shape HQ's `CommCareUserResource` requires and the shape the validator
 * enforces. Passing an empty list clears the assignment entirely, which is
 * how "assigned nowhere" is spelled — and exactly when the session block omits
 * all three `commcare_location_*` keys.
 */
export function setPersonaLocationsMutations(
	personaUuid: Uuid,
	locationIds: readonly string[],
): Mutation[] {
	const unique: string[] = [];
	for (const id of locationIds) {
		if (!unique.includes(id)) unique.push(id);
	}
	if (unique.length === 0) {
		return [
			{
				kind: "updatePersona",
				uuid: personaUuid,
				patch: { locations: null },
			},
		];
	}
	const [primaryUuid, ...additionalUuids] = unique as [Uuid, ...Uuid[]];
	return [
		{
			kind: "updatePersona",
			uuid: personaUuid,
			patch: {
				locations: {
					primaryUuid,
					...(additionalUuids.length > 0 && { additionalUuids }),
				},
			},
		},
	];
}

/**
 * Every place any persona stands on, for a caller that needs to know which
 * rows are spoken for before offering to archive one.
 */
export function assignedLocationIds(doc: BlueprintDoc): ReadonlySet<string> {
	const assigned = new Set<string>();
	for (const persona of Object.values(personasOf(doc))) {
		for (const id of assignedLocationUuids(persona.locations)) assigned.add(id);
	}
	return assigned;
}

/** The personas standing on a given place, by name. */
export function personasAtLocation(
	doc: BlueprintDoc,
	locationId: string,
): string[] {
	return Object.values(personasOf(doc))
		.filter((persona) =>
			assignedLocationUuids(persona.locations).includes(locationId),
		)
		.map((persona) => persona.name);
}

export type { PersonaLocations };
