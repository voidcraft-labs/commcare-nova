/** Client-safe authoring projection of entry-point eligibility. */

import {
	type BlueprintDoc,
	type EntryPointTarget,
	entryPointAt,
	isNoMatchesForm,
} from "@/lib/domain";
import {
	createEntryPointRequirements,
	type EntryPointRequirements,
	entryPointRequirements,
} from "./entryPointProjection";

export function entryPointDestination(
	doc: BlueprintDoc,
	target: EntryPointTarget,
) {
	return destinationFromRequirements(
		doc,
		target,
		entryPointRequirements(doc, target),
	);
}

function destinationFromRequirements(
	doc: BlueprintDoc,
	target: EntryPointTarget,
	projected: EntryPointRequirements,
) {
	const module = doc.modules[target.moduleUuid];
	const form = target.kind === "form" ? doc.forms[target.formUuid] : undefined;
	const label =
		target.kind === "form"
			? `${module?.name ?? "Module"} · ${form?.name ?? "Form"}`
			: `${module?.name ?? "Module"} · ${target.kind === "case-list" ? "Case list" : "Module"}`;
	let issue: string | undefined;
	const requiredSelections = projected.available
		? projected.requiredSelections
		: [];
	if (!projected.available) issue = projected.message;
	try {
		if (form && isNoMatchesForm(form))
			throw new Error("This form opens only when a search has no matches.");
	} catch (error) {
		issue =
			error instanceof Error
				? error.message
				: "This destination is unavailable.";
	}
	return {
		target,
		label,
		entryPoint: entryPointAt(doc, target),
		issue,
		requiredSelections,
	};
}
export function entryPointDestinations(doc: BlueprintDoc) {
	const requirements = createEntryPointRequirements(doc);
	const destination = (target: EntryPointTarget) =>
		destinationFromRequirements(doc, target, requirements(target));
	return doc.moduleOrder.flatMap((moduleUuid) => [
		destination({ kind: "module", moduleUuid }),
		destination({ kind: "case-list", moduleUuid }),
		...(doc.formOrder[moduleUuid] ?? []).map((formUuid) =>
			destination({ kind: "form", moduleUuid, formUuid }),
		),
	]);
}
