/**
 * Where a form's source holds what is no question of the form and no
 * generated node beside one: the case region (each authored scope's
 * `nova_operations`, `nova_subcases` and `nova_selected_cases` containers,
 * whose blocks, condition groups, keyed repeats and clock nodes are compared
 * as the case blocks they hold) and the Connect blocks at the data root. Each
 * is an absolute data path whose subtree the region covers.
 */
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { formConnectIds } from "@/lib/domain/connectIds";
import { collectFieldLocations } from "../caseOps";
import { descendFormPathIntoField, FormPath } from "../formPath";
import { planGeneratedNodes } from "../generatedNodes";

export function regionRoots(
	doc: BlueprintDoc,
	formUuid: Uuid,
): readonly string[] {
	const plan = planGeneratedNodes(doc, formUuid);
	const scopes = [FormPath.root()];
	for (const [uuid, location] of collectFieldLocations(doc, formUuid)) {
		const field = doc.fields[uuid];
		if (field?.kind === "repeat")
			scopes.push(descendFormPathIntoField(field, location.path));
	}
	return [
		...scopes.flatMap((scope) => [
			scope.child(plan.operations(scope)).toXPath(),
			scope.child(plan.subcases(scope)).toXPath(),
			scope.child(plan.selectedCases(scope)).toXPath(),
		]),
		...[...formConnectIds(doc, formUuid)].map((id) =>
			FormPath.root().child(id).toXPath(),
		),
	];
}

/** Whether `path` stands at or under one of `roots`. */
export function inRegion(path: string, roots: readonly string[]): boolean {
	return roots.some((root) => path === root || path.startsWith(`${root}/`));
}
