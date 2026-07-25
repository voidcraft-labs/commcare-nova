// lib/doc/formLinkMutations.ts
//
// The one writer for a form's end-of-form links.
//
// Every edit is one identity-keyed `updateForm.formLinkChange`, never a
// wholesale `formLinks` array on the patch. Two reasons, and both are
// permanent rather than transitional:
//
//   - a wholesale array is last-write-wins over every member, which is
//     the wrong merge for a list two people can edit at once — and links
//     are ORDER-SENSITIVE, so a clobbered sequence changes which branch
//     a worker takes, not just how the list looks;
//   - a rolling receiver has to parse whatever the array carries, and a
//     link's stored shape (`uuid`, `order`, a Predicate condition) has no
//     origin-compatible spelling. Omitting `formLinks` from the patch
//     schema makes the wrong shape unrepresentable rather than merely
//     discouraged.
//
// Removal deliberately has no null-clear counterpart: `remove` names the
// link, and a form with no links left drops the slot inside the reducer.

import { appendOrderKey } from "@/lib/doc/order/append";
import { plannedMoveSlotKey } from "@/lib/doc/order/keys";
import type { FormLink, Uuid } from "@/lib/domain";
import { orderedFormLinks } from "@/lib/domain";
import type { Predicate } from "@/lib/domain/predicate";
import type { BlueprintDoc, Mutation } from "./types";

/**
 * Add a link at the end of a form's list.
 *
 * The caller mints the uuid so the mutation stays deterministic for
 * replay — a reducer that generated one would produce a different doc on
 * every run, which is exactly what
 * `assertPersistenceSafeMutationIdentities` refuses.
 */
export function addFormLinkMutation(
	doc: BlueprintDoc,
	formUuid: Uuid,
	link: Omit<FormLink, "order">,
): Mutation {
	const form = doc.forms[formUuid];
	return {
		kind: "updateForm",
		uuid: formUuid,
		patch: {},
		formLinkChange: {
			operation: "add",
			value: { ...link, order: appendOrderKey(form?.formLinks ?? []) },
		},
	};
}

/** Replace one link's content, preserving its identity and its position. */
export function updateFormLinkMutation(
	doc: BlueprintDoc,
	formUuid: Uuid,
	linkUuid: Uuid,
	patch: Partial<Omit<FormLink, "uuid" | "order">>,
): Mutation | undefined {
	const current = doc.forms[formUuid]?.formLinks?.find(
		(link) => link.uuid === linkUuid,
	);
	if (current === undefined) return undefined;
	const next: FormLink = { ...current, ...patch };
	// An explicitly absent condition is the unconditional state. Spelled
	// through `delete` rather than `undefined` so the value that reaches
	// the wire has no key at all — the same reason a clear travels as
	// `null` elsewhere, arrived at from the other direction.
	if ("condition" in patch && patch.condition === undefined) {
		delete (next as { condition?: Predicate }).condition;
	}
	return {
		kind: "updateForm",
		uuid: formUuid,
		patch: {},
		formLinkChange: { operation: "update", uuid: linkUuid, value: next },
	};
}

export function removeFormLinkMutation(
	formUuid: Uuid,
	linkUuid: Uuid,
): Mutation {
	return {
		kind: "updateForm",
		uuid: formUuid,
		patch: {},
		formLinkChange: { operation: "remove", uuid: linkUuid },
	};
}

/**
 * Move a link to the slot before `beforeUuid`, or to the end when it is
 * omitted.
 *
 * Only the fractional key is written. A reorder that rewrote the whole
 * list would clobber a co-member's concurrent edit to a link this gesture
 * never touched.
 */
export function moveFormLinkMutation(
	doc: BlueprintDoc,
	formUuid: Uuid,
	linkUuid: Uuid,
	beforeUuid: Uuid | undefined,
): Mutation | undefined {
	const form = doc.forms[formUuid];
	if (form === undefined) return undefined;
	const ordered = orderedFormLinks(form).filter(
		(link) => link.uuid !== linkUuid,
	);
	const targetIndex =
		beforeUuid === undefined
			? ordered.length
			: ordered.findIndex((link) => link.uuid === beforeUuid);
	if (targetIndex < 0) return undefined;
	const order = plannedMoveSlotKey(
		ordered.map((link) => link.order),
		targetIndex,
	);
	return {
		kind: "updateForm",
		uuid: formUuid,
		patch: {},
		formLinkChange: { operation: "move", uuid: linkUuid, order },
	};
}
