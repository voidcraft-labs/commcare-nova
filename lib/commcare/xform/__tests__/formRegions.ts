/**
 * Where a form's source holds what is no question of the form and no
 * generated node beside one: the case region (each authored scope's
 * `nova_operations`, `nova_subcases` and `nova_selected_cases` containers,
 * whose blocks, condition groups, keyed repeats and clock nodes are compared
 * as the case blocks they hold) and the submitted Connect activities where they occur. Each
 * is an absolute data path whose subtree the region covers.
 */
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { collectFieldLocations } from "../caseOps";
import { descendFormPathIntoField, FormPath } from "../formPath";
import { planGeneratedNodes } from "../generatedNodes";

export function regionRoots(
	doc: BlueprintDoc,
	formUuid: Uuid,
): readonly string[] {
	const plan = planGeneratedNodes(doc, formUuid);
	const scopes = [FormPath.root()];
	const activities: string[] = [];
	for (const [uuid, location] of collectFieldLocations(doc, formUuid)) {
		const field = doc.fields[uuid];
		if (field?.kind === "connect_activity")
			activities.push(location.path.toXPath());
		if (field?.kind === "repeat")
			scopes.push(descendFormPathIntoField(field, location.path));
	}
	return [
		...scopes.flatMap((scope) => [
			scope.child(plan.operations(scope)).toXPath(),
			scope.child(plan.subcases(scope)).toXPath(),
			scope.child(plan.selectedCases(scope)).toXPath(),
		]),
		...activities,
	];
}

/** Whether `path` stands at or under one of `roots`. */
export function inRegion(path: string, roots: readonly string[]): boolean {
	return roots.some((root) => path === root || path.startsWith(`${root}/`));
}
