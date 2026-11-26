import type { Draft } from "immer";
import { type BlueprintDoc, entryPointInventory } from "@/lib/domain";
import type { Mutation } from "../types";
export function applyEntryPointMutation(
	doc: Draft<BlueprintDoc>,
	mutation: Extract<
		Mutation,
		{ kind: "addEntryPoint" | "updateEntryPoint" | "removeEntryPoint" }
	>,
): void {
	const item =
		mutation.kind === "addEntryPoint"
			? { target: mutation.target, entryPoint: mutation.entryPoint }
			: entryPointInventory(doc).find(
					(e) => e.entryPoint.uuid === mutation.entryPointUuid,
				);
	if (!item) return;
	if (item.target.kind === "form") {
		const source = doc.modules[item.target.moduleUuid]?.formsFromMenu;
		if (source) {
			const formUuid = item.target.formUuid;
			if (mutation.kind === "addEntryPoint") {
				source.entryPoints ??= [];
				source.entryPoints.push({
					formUuid,
					entryPoint: { uuid: item.entryPoint.uuid, id: item.entryPoint.id },
				});
			} else if (mutation.kind === "removeEntryPoint" && source.entryPoints) {
				const kept = source.entryPoints.filter(
					(row) => row.formUuid !== formUuid,
				);
				if (kept.length > 0) source.entryPoints = kept;
				else delete source.entryPoints;
			} else if (
				mutation.kind === "updateEntryPoint" &&
				mutation.patch.id !== undefined
			) {
				const row = source.entryPoints?.find(
					(row) => row.formUuid === formUuid,
				);
				if (row) row.entryPoint.id = mutation.patch.id;
			}
			return;
		}
	}
	const owner =
		item.target.kind === "form"
			? doc.forms[item.target.formUuid]
			: doc.modules[item.target.moduleUuid];
	if (!owner) return;
	const key =
		item.target.kind === "case-list" ? "caseListEntryPoint" : "entryPoint";
	if (mutation.kind === "addEntryPoint") {
		Object.assign(owner, { [key]: mutation.entryPoint });
		return;
	}
	if (mutation.kind === "removeEntryPoint") {
		if (key === "caseListEntryPoint" && "caseListEntryPoint" in owner)
			delete owner.caseListEntryPoint;
		else delete owner.entryPoint;
		return;
	}
	if (mutation.patch.id !== undefined) item.entryPoint.id = mutation.patch.id;
	if (mutation.patch.ignoreDisplayConditions === null)
		delete item.entryPoint.ignoreDisplayConditions;
	else if (mutation.patch.ignoreDisplayConditions === true)
		item.entryPoint.ignoreDisplayConditions = true;
}
