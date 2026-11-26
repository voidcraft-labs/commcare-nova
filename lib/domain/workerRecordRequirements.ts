import type { BlueprintDoc } from "./blueprint";
import { isExpression } from "./expression/types";
import { walkExpressionTerms } from "./expression/walk";
import type { Form } from "./forms";
import { isProseTemplate } from "./prose";
import {
	FORM_REFERENCE_SLOTS,
	fieldReferenceSlotsFor,
	MODULE_REFERENCE_SLOTS,
	readSlotValues,
	translatedFieldProse,
} from "./referenceSlots";

/** One form that reads or saves to the worker's own record. */
export interface WorkerRecordRequirement {
	readonly formUuid: string;
	/** The form's name, trimmed, or its id where the name is blank. */
	readonly name: string;
	readonly reads: boolean;
	readonly writes: boolean;
}

/**
 * Whether a slot value reads the worker's own record: a worker-record read
 * in an expression, or a prose reference to worker information.
 */
export function readsWorkerRecord(value: unknown): boolean {
	if (isProseTemplate(value))
		return value.parts.some(
			(part) =>
				part.kind === "user-ref" ||
				part.kind === "user-property-ref" ||
				(part.kind === "value" && readsWorkerRecord(part.expression)),
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
 * form order. A form's XPath and prose read it, in any language's
 * translation that shows values of its own as well, its form links' conditions
 * and link datums among them; an update of the worker's record among its case
 * operations saves to it. A property explicitly read from the worker's record also counts in a
 * navigation expression.
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
					) ||
				/* A translation that shows values of its own reads them in its
				 * language, where the source may read none. */
				translatedFieldProse(doc.localization, field).some(({ template }) =>
					readsWorkerRecord(template),
				) ||
				fieldsRead(uuid)
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

/** Navigation, list columns and filters can read a restored worker record
 * before a form opens. Include an entirely formless case list as its own use. */
export function menusUsingWorkerRecord(doc: BlueprintDoc) {
	return doc.moduleOrder.flatMap((uuid) => {
		const mod = doc.modules[uuid];
		if (!mod) return [];
		const readsColumn = mod.caseListConfig?.columns.some(
			(column) => "readFrom" in column && column.readFrom === "worker-record",
		);
		const readsExpression = MODULE_REFERENCE_SLOTS.some(
			(slot) =>
				slot.kind === "expression" &&
				readSlotValues(mod, slot.path).some(({ value }) => readsWorkerRecord(value)),
		);
		return readsColumn || readsExpression
			? [{ uuid, name: mod.name.trim() || mod.id, reads: true, writes: false }]
			: [];
	});
}
