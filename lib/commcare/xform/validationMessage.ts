// lib/commcare/xform/validationMessage.ts
//
// Which of a form's questions hold a validation message the XForm writes.
// The builder writes a question's message (its `jr:constraintMsg`, its
// `<alert>` and its itext entry) only where the question's bind carries a
// constraint (`constraintMessage.ts::bindCarriesConstraint`), and the case
// name or external id check that can be that constraint depends on where the
// form's case change is kept (`placement.ts::placedBasic`). Preview's text
// table and the gate's refusal of a read of an unwritten message read this one
// answer, so neither decides it again.

import { descendantFieldUuids } from "@/lib/doc/fieldWalk";
import type { BlueprintDoc } from "@/lib/domain/blueprint";
import { caseScalarTextGuards } from "@/lib/domain/caseScalarTextGuard";
import { expressionSlotValue } from "@/lib/domain/referenceSlots";
import type { Uuid } from "@/lib/domain/uuid";
import { placedBasic } from "../placement";
import { bindCarriesConstraint } from "./constraintMessage";

const carriers = new WeakMap<BlueprintDoc, Map<Uuid, ReadonlySet<Uuid>>>();

/**
 * The questions of `formUuid` whose bind carries a constraint: their own
 * validation condition, or the check of a case name or an external id a basic
 * or an advanced action reads from them, with the guards the builder reads.
 * Only these write a validation message, so only their message is a text a
 * `jr:itext` read finds on a device; a read of any other question's message
 * finds no entry and shows `[itext:<id>]` (commcare-core
 * `FormDef.java::initEvalContext`). Made once per document object.
 */
export function constraintCarryingQuestions(
	doc: BlueprintDoc,
	formUuid: Uuid,
): ReadonlySet<Uuid> {
	let forms = carriers.get(doc);
	if (forms === undefined) {
		forms = new Map();
		carriers.set(doc, forms);
	}
	const known = forms.get(formUuid);
	if (known !== undefined) return known;
	const guards = caseScalarTextGuards(doc, formUuid, {
		placedBasic: placedBasic(doc, formUuid),
	});
	const result = new Set<Uuid>();
	for (const uuid of descendantFieldUuids(doc, formUuid)) {
		const field = doc.fields[uuid];
		if (field === undefined) continue;
		const validate = expressionSlotValue(doc, {
			entity: "field",
			uuid,
			slot: "validate",
		});
		if (bindCarriesConstraint(field.kind, validate, guards.get(uuid)))
			result.add(uuid);
	}
	forms.set(formUuid, result);
	return result;
}
