import type { BlueprintDoc } from "@/lib/domain";

/** `buildLintContext` reads only these field slots. A scalar edit to case
 * storage, validation, defaults, media, or choice configuration cannot change
 * a reference's path, display label, or value-producing kind. */
function referenceFieldsChanged(
	current: BlueprintDoc["fields"],
	previous: BlueprintDoc["fields"],
): boolean {
	if (current === previous) return false;
	const currentEntries = Object.entries(current);
	if (currentEntries.length !== Object.keys(previous).length) return true;
	for (const [uuid, field] of currentEntries) {
		const before = previous[uuid];
		if (
			before === undefined ||
			field.id !== before.id ||
			field.kind !== before.kind ||
			("label" in field ? field.label : undefined) !==
				("label" in before ? before.label : undefined)
		) {
			return true;
		}
	}
	return false;
}

function referenceFormsChanged(
	current: BlueprintDoc["forms"],
	previous: BlueprintDoc["forms"],
): boolean {
	if (current === previous) return false;
	const currentEntries = Object.entries(current);
	if (currentEntries.length !== Object.keys(previous).length) return true;
	return currentEntries.some(
		([uuid, form]) => previous[uuid]?.type !== form.type,
	);
}

function referenceModulesChanged(
	current: BlueprintDoc["modules"],
	previous: BlueprintDoc["modules"],
): boolean {
	if (current === previous) return false;
	const currentEntries = Object.entries(current);
	if (currentEntries.length !== Object.keys(previous).length) return true;
	return currentEntries.some(
		([uuid, module]) => previous[uuid]?.caseType !== module.caseType,
	);
}

export function referenceContextChanged(
	current: BlueprintDoc,
	previous: BlueprintDoc,
): boolean {
	return (
		current.fieldOrder !== previous.fieldOrder ||
		current.formOrder !== previous.formOrder ||
		current.caseTypes !== previous.caseTypes ||
		current.userProperties !== previous.userProperties ||
		referenceFieldsChanged(current.fields, previous.fields) ||
		referenceFormsChanged(current.forms, previous.forms) ||
		referenceModulesChanged(current.modules, previous.modules)
	);
}
