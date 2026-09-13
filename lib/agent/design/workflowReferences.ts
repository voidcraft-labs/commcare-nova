import type { AppDesignContract, Workflow } from "./contract";

/** Data used by the worker's task, including values shown inside its forms.
 * Planning and execution context use the same typed reference traversal. */
export function workflowDataReferences(
	contract: AppDesignContract,
	workflow: Workflow,
) {
	const recordIds = new Set<string>();
	const propertyIds = new Set<string>();
	if (workflow.contextRecordId !== undefined)
		recordIds.add(workflow.contextRecordId);
	for (const input of workflow.inputs)
		if (input.propertyId !== undefined) propertyIds.add(input.propertyId);
	for (const decision of workflow.decisions)
		for (const id of decision.inputPropertyIds) propertyIds.add(id);
	for (const effect of workflow.recordEffects) {
		recordIds.add(effect.recordId);
		if (effect.sourceRecordId !== undefined)
			recordIds.add(effect.sourceRecordId);
		for (const write of effect.writes) propertyIds.add(write.propertyId);
	}
	for (const readback of workflow.readback) {
		recordIds.add(readback.recordId);
		for (const id of readback.propertyIds) propertyIds.add(id);
	}
	for (const form of contract.formCompositions) {
		if (form.workflowId !== workflow.id) continue;
		const items =
			form.layout.kind === "flat"
				? form.layout.items
				: form.layout.sections.flatMap((section) => section.items);
		for (const item of items) {
			if (item.kind !== "record-summary") continue;
			recordIds.add(item.recordId);
			for (const id of item.propertyIds) propertyIds.add(id);
		}
	}
	for (const record of contract.records)
		if (record.properties.some((property) => propertyIds.has(property.id)))
			recordIds.add(record.id);
	return { recordIds, propertyIds };
}
