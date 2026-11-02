// lib/doc/formRecordName.ts
//
// A form's record name is the `name` of its own case: the name a
// registration gives the case it creates, or the new name a follow-up or
// close form gives the case it loaded. It is one expression slot of the own
// arm (`case_operation_name`), read and written here and nowhere else, with
// no question standing in for it: a bare read of an answer names the case
// with that answer, and any other expression is computed in the slot itself.

import type {
	BlueprintDoc,
	Expression,
	OwnCaseOperation,
	Uuid,
} from "@/lib/domain";
import {
	type FormStructure,
	formStructure,
} from "@/lib/domain/expression/formStructure";
import type { FormExpressionSlotRef } from "@/lib/domain/expression/types";
import { deepEqual } from "./deepEqual";
import { findContainingForm } from "./mutations/helpers";
import type { Mutation } from "./types";

/** The form's own case, when its type and module give it one. */
function ownCaseOf(
	doc: BlueprintDoc,
	formUuid: Uuid,
): OwnCaseOperation | undefined {
	const form = Object.hasOwn(doc.forms, formUuid)
		? doc.forms[formUuid]
		: undefined;
	if (form === undefined || form.type === "survey") return undefined;
	return form.caseOperations?.find(
		(operation): operation is OwnCaseOperation => operation.action === "own",
	);
}

/** The name the form gives its own case, when it gives one. */
export function formRecordName(
	doc: BlueprintDoc,
	formUuid: Uuid,
): Expression | undefined {
	return ownCaseOf(doc, formUuid)?.name;
}

export interface PreparedFormRecordName {
	/** The own case's name slot the edit parses in. */
	readonly slot: FormExpressionSlotRef & {
		readonly slot: "case_operation_name";
	};
	readonly form: FormStructure;
}

/** The slot and form structure a record-name edit parses in. Undefined for
 *  a form without an own case (a survey, or a form whose module has no case
 *  type). */
export function prepareFormRecordName(
	doc: BlueprintDoc,
	formUuid: Uuid,
): PreparedFormRecordName | undefined {
	const own = ownCaseOf(doc, formUuid);
	const form = formStructure(doc, formUuid);
	if (own === undefined || form === undefined) return undefined;
	return {
		slot: {
			entity: "form",
			uuid: formUuid,
			slot: "case_operation_name",
			member: { operationUuid: own.uuid },
		},
		form,
	};
}

/** Set the own case's name to `value` in one mutation, or none when it is
 *  already that name. `prepared` is the slot the edit was parsed in: an edit
 *  parsed for an own case the form no longer holds is refused rather than
 *  written to another one. */
export function formRecordNameMutations(
	doc: BlueprintDoc,
	formUuid: Uuid,
	value: Expression,
	prepared?: Pick<PreparedFormRecordName, "slot">,
): Mutation[] {
	const own = ownCaseOf(doc, formUuid);
	if (own === undefined)
		throw new Error(
			"This form has no record to name. Choose a registration, follow-up or close form with a record type.",
		);
	if (
		prepared !== undefined &&
		(prepared.slot.uuid !== formUuid ||
			prepared.slot.member.operationUuid !== own.uuid)
	)
		throw new Error(
			"The record this form names changed while you were editing. Reopen the record name to edit it again.",
		);
	if (deepEqual(own.name, value)) return [];
	if (
		value.kind === "term" &&
		value.term.kind === "field" &&
		findContainingForm(doc, value.term.uuid) !== formUuid
	)
		throw new Error("The record name must use answers from this form.");
	return [
		{
			kind: "updateForm",
			uuid: formUuid,
			patch: {},
			caseOperationPatch: {
				operation: "update",
				uuid: own.uuid,
				targetAction: "own",
				patch: { name: value },
			},
		},
	];
}
