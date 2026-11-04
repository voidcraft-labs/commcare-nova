import type { BlueprintDoc } from "./blueprint";
import { isExpression } from "./expression/types";
import { walkExpressionTerms } from "./expression/walk";
import type { Form } from "./forms";
import { isProseTemplate } from "./prose";
import {
	FORM_REFERENCE_SLOTS,
	fieldReferenceSlotsFor,
	readSlotValues,
} from "./referenceSlots";

/** One form that reads or saves to the worker's own record. */
export interface WorkerRecordRequirement {
	readonly formUuid: string;
	/** The form's name, trimmed, or its id where the name is blank. */
	readonly name: string;
	readonly reads: boolean;
	readonly writes: boolean;
}

function readsWorkerRecord(value: unknown): boolean {
	if (isProseTemplate(value))
		return value.parts.some(
			(part) => part.kind === "user-ref" || part.kind === "user-property-ref",
		);
	if (!isExpression(value)) return false;
	let reads = false;
	walkExpressionTerms(value, (term) => {
		if (
			((term.kind === "session-user" ||
				term.kind === "session-user-property") &&
				term.source === "worker-record") ||
			(term.kind === "session-datum" && term.datum.kind === "worker-record")
		)
			reads = true;
	});
	return reads;
}

/** Whether one of the form's case operations saves to the worker's record. */
export function savesToWorkerRecord(
	form: Pick<Form, "caseOperations">,
): boolean {
	return (form.caseOperations ?? []).some(
		(operation) =>
			operation.action === "update" &&
			operation.target.kind === "worker-record" &&
			(operation.writes?.length ?? 0) > 0,
	);
}

/**
 * The forms that read or save to the worker's own record, in the document's
 * form order. A form's XPath and prose read it, its form links' conditions
 * and link datums among them; an update of the worker's record among its case
 * operations saves to it. Record-scope predicates read session data instead
 * and never count.
 */
export function workerRecordRequirements(
	doc: BlueprintDoc,
): WorkerRecordRequirement[] {
	const requirements: WorkerRecordRequirement[] = [];
	function fieldsRead(parentUuid: string): boolean {
		return (doc.fieldOrder[parentUuid] ?? []).some((uuid) => {
			const field = doc.fields[uuid];
			if (!field) return false;
			return (
				fieldReferenceSlotsFor(
					field.kind,
					field.kind === "repeat" ? field.repeat_mode : undefined,
				)
					.filter((slot) => slot.kind === "expression" || slot.kind === "prose")
					.some((slot) =>
						readSlotValues(field, slot.path).some(({ value }) =>
							readsWorkerRecord(value),
						),
					) || fieldsRead(uuid)
			);
		});
	}
	for (const moduleUuid of doc.moduleOrder) {
		const module = doc.modules[moduleUuid];
		if (!module) continue;
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			const form = doc.forms[formUuid];
			if (!form) continue;
			const reads =
				fieldsRead(formUuid) ||
				FORM_REFERENCE_SLOTS.filter((slot) => slot.kind === "expression").some(
					(slot) =>
						readSlotValues(form, slot.path).some(({ value }) =>
							readsWorkerRecord(value),
						),
				);
			const writes = savesToWorkerRecord(form);
			if (reads || writes)
				requirements.push({
					formUuid,
					name: form.name.trim() || form.id,
					reads,
					writes,
				});
		}
	}
	return requirements;
}
