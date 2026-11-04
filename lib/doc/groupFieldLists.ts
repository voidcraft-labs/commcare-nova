/**
 * The one-screen group rule the fuzz mapping and the migration witnesses share: every
 * group whose label shows, and which holds no repeat workers add entries to
 * at any depth, takes `fieldList: true`, so it keeps showing its questions on
 * one screen on Android as it did when a label decided that. Each caller
 * passes a frozen copy of the label gate this rule replaced, so both read one
 * rule; the label predicate is the caller's, never decided here.
 *
 * A group holding a user-controlled repeat stays without the flag, because
 * the CommCare app can't add repeat entries on a shared screen. A section is
 * one screen by its kind and is never touched, and no group loses a flag it
 * already holds: the plan writes only `true`.
 *
 * Pure and deterministic: the same document plans the same mutations, in
 * document order (module, form, then each form's fields depth first), and a
 * document it has already planned over plans none.
 */

import { descendantFieldUuids, iterForms } from "./fieldWalk";
import type { BlueprintDoc, Mutation, Uuid } from "./types";

/**
 * Whether any field under `containerUuid`, at any depth, is a repeat the
 * worker grows by hand. The container itself is not counted.
 */
export function holdsUserRepeat(
	doc: BlueprintDoc,
	containerUuid: Uuid,
): boolean {
	for (const uuid of descendantFieldUuids(doc, containerUuid)) {
		const field = doc.fields[uuid];
		if (field?.kind === "repeat" && field.repeat_mode === "user_controlled") {
			return true;
		}
	}
	return false;
}

/** One `updateField` setting `fieldList: true` per group the rule names. */
export function planGroupFieldLists(
	doc: BlueprintDoc,
	labelShows: (doc: BlueprintDoc, groupUuid: Uuid) => boolean,
): Mutation[] {
	const mutations: Mutation[] = [];
	for (const { formUuid } of iterForms(doc)) {
		for (const uuid of descendantFieldUuids(doc, formUuid)) {
			const field = doc.fields[uuid];
			if (field?.kind !== "group" || field.fieldList === true) continue;
			if (!labelShows(doc, uuid) || holdsUserRepeat(doc, uuid)) continue;
			mutations.push({
				kind: "updateField",
				uuid,
				targetKind: "group",
				patch: { fieldList: true },
			});
		}
	}
	return mutations;
}
