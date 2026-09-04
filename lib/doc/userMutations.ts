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

import type { Mutation } from "@/lib/doc/types";
import {
	asUuid,
	type BlueprintDoc,
	hasOwnRecordKey,
	ownRecordValue,
	type Persona,
	personasOf,
	recordWithoutKey,
	recordWithValue,
	type UserDataValues,
	type UserProperty,
	type UserType,
	type Uuid,
	userPropertiesOf,
	userPropertyTargetKey,
	userTypesOf,
} from "@/lib/domain";
import { referencingSlotsOf } from "./referenceIndex";

type UserEntityPatch<T> = {
	[K in Exclude<keyof T, "uuid">]?: T[K] | null;
};

/**
 * Where a new flat entity goes: at the end, named by the uuid it follows.
 *
 * Placement is the author's intent — "after this one" — not a value computed
 * from the sequence. A computed position is a pure function of the sequence its
 * author could see, so two people adding from the same document compute the
 * SAME position, and nothing sorts between two equal positions. Naming a
 * neighbour by identity has no such collision: the reducer resolves it against
 * whatever the collection holds when the mutation actually applies.
 *
 * `null` means "first", which is also what an empty collection gets.
 */
function appendAfter(order: readonly Uuid[] | undefined): Uuid | null {
	const sequence = order ?? [];
	return sequence.at(-1) ?? null;
}

/** Mint the `addUserProperty` for a new piece of worker information. */
export function addUserPropertyMutations(
	doc: BlueprintDoc,
	uuid: Uuid,
	property: Omit<UserProperty, "uuid">,
): Mutation[] {
	return [
		{
			kind: "addUserProperty",
			property: { ...property, uuid },
			after: appendAfter(doc.userPropertyOrder),
		},
	];
}

/** Mint the `addUserType` for a new role. */
export function addUserTypeMutations(
	doc: BlueprintDoc,
	uuid: Uuid,
	userType: Omit<UserType, "uuid">,
): Mutation[] {
	return [
		{
			kind: "addUserType",
			userType: { ...userType, uuid },
			after: appendAfter(doc.userTypeOrder),
		},
	];
}

/** Mint the `addPersona` for a new preview actor. */
export function addPersonaMutations(
	doc: BlueprintDoc,
	uuid: Uuid,
	persona: Omit<Persona, "uuid">,
): Mutation[] {
	return [
		{
			kind: "addPersona",
			persona: { ...persona, uuid },
			after: appendAfter(doc.personaOrder),
		},
	];
}

function userDataValueMutations(
	kind: "updateUserType" | "updatePersona",
	uuid: Uuid,
	before: UserDataValues | undefined,
	after: UserDataValues | undefined,
): Mutation[] {
	const mutations: Mutation[] = [];
	const keys = [
		...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]),
	].sort();
	for (const propertyUuid of keys) {
		const beforeHas = hasOwnRecordKey(before, propertyUuid);
		const afterHas = hasOwnRecordKey(after, propertyUuid);
		const beforeValue = ownRecordValue(before, propertyUuid);
		const afterValue = ownRecordValue(after, propertyUuid);
		if (beforeHas === afterHas && beforeValue === afterValue) continue;
		mutations.push({
			kind,
			uuid,
			patch: {},
			valuePatch: {
				userPropertyUuid: asUuid(propertyUuid),
				value: afterHas ? (afterValue as string) : null,
			},
		});
	}
	return mutations;
}

/** Plan a role update, splitting each value-key edit into its own mutation. */
export function updateUserTypeMutations(
	doc: BlueprintDoc,
	uuid: Uuid,
	patch: UserEntityPatch<UserType>,
): Mutation[] {
	const current = ownRecordValue(userTypesOf(doc), uuid);
	if (current === undefined) return [];
	const { values, ...metadata } = patch;
	const mutations: Mutation[] =
		Object.keys(metadata).length === 0
			? []
			: [{ kind: "updateUserType", uuid, patch: metadata }];
	if (values !== undefined) {
		mutations.push(
			...userDataValueMutations(
				"updateUserType",
				uuid,
				current.values,
				values === null ? undefined : values,
			),
		);
	}
	return mutations;
}

/** Plan a persona update, splitting each override-key edit into its own event. */
export function updatePersonaMutations(
	doc: BlueprintDoc,
	uuid: Uuid,
	patch: UserEntityPatch<Persona>,
): Mutation[] {
	const current = ownRecordValue(personasOf(doc), uuid);
	if (current === undefined) return [];
	const { values, ...metadata } = patch;
	const mutations: Mutation[] =
		Object.keys(metadata).length === 0
			? []
			: [{ kind: "updatePersona", uuid, patch: metadata }];
	if (values !== undefined) {
		mutations.push(
			...userDataValueMutations(
				"updatePersona",
				uuid,
				current.values,
				values === null ? undefined : values,
			),
		);
	}
	return mutations;
}

/** Plan one role default edit without constructing a stale whole value bag. */
export function updateUserTypeValueMutations(
	doc: BlueprintDoc,
	uuid: Uuid,
	propertyUuid: Uuid,
	value: string | undefined,
): Mutation[] {
	const current = ownRecordValue(userTypesOf(doc), uuid);
	if (current === undefined) return [];
	const next =
		value === undefined
			? recordWithoutKey(current.values, propertyUuid)
			: recordWithValue(current.values, propertyUuid, value);
	return userDataValueMutations("updateUserType", uuid, current.values, next);
}

/** Plan one persona override edit without constructing a stale whole bag. */
export function updatePersonaValueMutations(
	doc: BlueprintDoc,
	uuid: Uuid,
	propertyUuid: Uuid,
	value: string | undefined,
): Mutation[] {
	const current = ownRecordValue(personasOf(doc), uuid);
	if (current === undefined) return [];
	const next =
		value === undefined
			? recordWithoutKey(current.values, propertyUuid)
			: recordWithValue(current.values, propertyUuid, value);
	return userDataValueMutations("updatePersona", uuid, current.values, next);
}

function describeUserPropertyReference(
	doc: BlueprintDoc,
	carrierUuid: string,
	slot: string,
): string {
	const field = ownRecordValue(doc.fields, carrierUuid);
	if (field !== undefined) {
		const setting: Readonly<Record<string, string>> = {
			relevant: "relevant condition",
			validate: "validation condition",
			calculate: "calculation",
			default_value: "default value",
			required: "required condition",
			repeat_count: "repeat count",
			ids_query: "lookup row query",
			lookup_options_source: "lookup choice filter",
		};
		return `${setting[slot] ?? `saved ${slot.replaceAll("_", " ")}`} on “${field.id}”`;
	}
	const form = ownRecordValue(doc.forms, carrierUuid);
	if (form !== undefined) {
		const setting: Readonly<Record<string, string>> = {
			form_display_condition: "display condition",
			form_link_condition: "form link condition",
			form_link_datum_xpath: "form link value",
			assessment_user_score: "assessment score",
			deliver_entity_id: "delivery entity ID",
			deliver_entity_name: "delivery entity name",
			case_operation_target_expression: "case target calculation",
			case_operation_condition: "case operation condition",
			case_operation_name: "case name calculation",
			case_operation_owner: "case owner calculation",
			case_operation_write_value: "case property calculation",
			case_operation_write_condition: "case property condition",
			case_operation_link_target_expression: "linked-case target calculation",
		};
		return `${setting[slot] ?? `saved ${slot.replaceAll("_", " ")}`} on form “${form.name}”`;
	}
	const module = ownRecordValue(doc.modules, carrierUuid);
	if (module !== undefined) {
		const setting: Partial<Record<string, string>> = {
			case_list_column_expression: "calculated value",
			case_list_filter: "Cases available condition",
			search_input_default: "search field starting value",
			search_input_predicate: "search field condition",
			search_input_options: "search field choice filter",
			search_input_required_when: "search field required condition",
			search_input_validation_rule: "search field check",
			search_input_hidden_value: "hidden search value",
			search_button_display_condition: "Search button condition",
			excluded_owner_ids: "Assigned cases setting",
			module_display_condition: "display condition",
		};
		return `${setting[slot] ?? "condition"} in module “${module.name}”`;
	}
	return `saved ${slot.replaceAll("_", " ")}`;
}

export type RemoveUserPropertyPlan =
	| { ok: true; mutations: Mutation[] }
	| {
			ok: false;
			referenceCount: number;
			references: readonly string[];
			userMessage: string;
	  };

/**
 * Plan property removal. Identity-backed XPath and Predicate references are
 * never cascaded or converted back to mutable text: the author must update
 * those conditions/calculations first. Only an unreferenced property reaches
 * value cleanup construction.
 */
export function removeUserPropertyPlan(
	doc: BlueprintDoc,
	uuid: Uuid,
): RemoveUserPropertyPlan {
	const references: Array<{
		carrierUuid: string;
		slot: string;
		description: string;
	}> = [];
	for (const [carrierUuid, slots] of referencingSlotsOf(
		doc,
		userPropertyTargetKey(uuid),
	)) {
		for (const slot of slots) {
			references.push({
				carrierUuid,
				slot,
				description: describeUserPropertyReference(doc, carrierUuid, slot),
			});
		}
	}
	if (references.length > 0) {
		const property = ownRecordValue(userPropertiesOf(doc), uuid);
		const name = property?.label ?? "This worker information";
		const locations = references
			.sort((a, b) => {
				for (const [left, right] of [
					[a.description, b.description],
					[a.carrierUuid, b.carrierUuid],
					[a.slot, b.slot],
				] as const) {
					if (left < right) return -1;
					if (left > right) return 1;
				}
				return 0;
			})
			.map(({ description }) => description);
		return {
			ok: false,
			referenceCount: locations.length,
			references: locations,
			userMessage: `${name} is used by ${locations.length} saved ${
				locations.length === 1 ? "setting" : "settings"
			}: ${locations.join("; ")}. Update or remove ${
				locations.length === 1 ? "that reference" : "those references"
			} before removing the worker information.`,
		};
	}

	const mutations: Mutation[] = [];
	for (const type of Object.values(userTypesOf(doc))) {
		if (!hasOwnRecordKey(type.values, uuid)) continue;
		mutations.push(
			...updateUserTypeValueMutations(doc, type.uuid, uuid, undefined),
		);
	}
	for (const persona of Object.values(personasOf(doc))) {
		if (!hasOwnRecordKey(persona.values, uuid)) continue;
		mutations.push(
			...updatePersonaValueMutations(doc, persona.uuid, uuid, undefined),
		);
	}
	mutations.push({ kind: "removeUserProperty", uuid });
	return { ok: true, mutations };
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
