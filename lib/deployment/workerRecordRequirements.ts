import type { BlueprintDoc } from "@/lib/domain";
import {
	deriveCaseWriteInventory,
	FORM_REFERENCE_SLOTS,
	fieldReferenceSlotsFor,
	isProseTemplate,
	isXPathExpression,
	readSlotValues,
} from "@/lib/domain";

function readsWorkerRecord(value: unknown): boolean {
	return (
		(isXPathExpression(value) || isProseTemplate(value)) &&
		value.parts.some(
			(part) => part.kind === "user-ref" || part.kind === "user-property-ref",
		)
	);
}

/** Form XPath and prose read the worker record. Record-scope predicates read
 * session data instead and must not acquire this deployment prerequisite. */
export function workerRecordRequirements(doc: BlueprintDoc) {
	const requirements: Array<{
		formUuid: string;
		name: string;
		reads: boolean;
		writes: boolean;
	}> = [];
	function fieldsRead(parentUuid: string): boolean {
		return (doc.fieldOrder[parentUuid] ?? []).some((uuid) => {
			const field = doc.fields[uuid];
			if (!field) return false;
			return (
				fieldReferenceSlotsFor(
					field.kind,
					field.kind === "repeat" ? field.repeat_mode : undefined,
				)
					.filter((slot) => slot.kind === "xpath-ast" || slot.kind === "prose")
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
				FORM_REFERENCE_SLOTS.filter((slot) => slot.kind === "xpath-ast").some(
					(slot) =>
						readSlotValues(form, slot.path).some(({ value }) =>
							readsWorkerRecord(value),
						),
				);
			const writes = deriveCaseWriteInventory(
				doc,
				formUuid,
				module,
				form.type,
			).buckets.some((bucket) => bucket.kind === "usercase");
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

export const workerRecordSetup = {
	title: "The worker's own record",
	detail:
		"These forms need the worker's own CommCare record. The target project must include user cases, and each worker must sync their record before using the forms. Nova cannot verify that setup here.",
	consequences:
		"Without that record, reads can be blank and forms that save to it cannot open. Preview supplies the record and does not establish that it exists on a device.",
};
