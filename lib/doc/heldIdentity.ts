/**
 * Whether a document, or one of its forms, holds an identity a publish
 * recorded: a case operation's placement, a form's own close placement, a
 * query repeat's placement, or a menu's held kind. Most apps hold none, and every reader that
 * pays for held identities (the move planners, the whole-module validation
 * scope) asks here first. One walk per document object, memoized: documents
 * are replaced, never changed in place.
 */

import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { formOfField } from "@/lib/domain/fieldForm";

const heldFormsByDoc = new WeakMap<BlueprintDoc, ReadonlySet<Uuid>>();

/** Every form that holds a placement of its own or of one of its query
 *  repeats. */
function formsHoldingPlacement(doc: BlueprintDoc): ReadonlySet<Uuid> {
	const known = heldFormsByDoc.get(doc);
	if (known !== undefined) return known;
	const held = new Set<Uuid>();
	for (const form of Object.values(doc.forms)) {
		if (
			form.ownClosePlacement !== undefined ||
			(form.caseOperations ?? []).some((op) => op.placement !== undefined)
		)
			held.add(form.uuid);
	}
	for (const field of Object.values(doc.fields)) {
		if (
			field.kind !== "repeat" ||
			field.repeat_mode !== "query_bound" ||
			field.placement === undefined
		)
			continue;
		const formUuid = formOfField(doc, field.uuid);
		if (formUuid !== undefined) held.add(formUuid);
	}
	heldFormsByDoc.set(doc, held);
	return held;
}

/** Whether `formUuid` holds a placement: an operation's, its own close's, or
 *  one of its query repeats'. */
export function formHoldsPlacement(doc: BlueprintDoc, formUuid: Uuid): boolean {
	return formsHoldingPlacement(doc).has(formUuid);
}

/** Whether the document holds any placement or any menu's kind. */
export function documentHoldsIdentity(doc: BlueprintDoc): boolean {
	return (
		formsHoldingPlacement(doc).size > 0 ||
		Object.values(doc.modules).some((module) => module.heldKind !== undefined)
	);
}
