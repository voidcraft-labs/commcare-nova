import {
	authoredBlueprintIdentities,
	type BlueprintDoc,
	type EntryPointTarget,
	entryPointAt,
	entryPointInventory,
	entryPointSchema,
	type FormEntryPoint,
	formEntryPointSchema,
	ownRecordValue,
	type Uuid,
} from "@/lib/domain";
import type { Mutation } from "./types";
export type EntryPointCommitPlan =
	| { ok: true; mutations: readonly Mutation[] }
	| { ok: false; reason: { kind: string; message: string } };
const refuse = (kind: string, message: string): EntryPointCommitPlan => ({
	ok: false,
	reason: { kind, message },
});
export function planEntryPointAdd(
	doc: BlueprintDoc,
	target: EntryPointTarget,
	entryPoint: FormEntryPoint,
): EntryPointCommitPlan {
	if (
		!ownRecordValue(doc.modules, target.moduleUuid) ||
		(target.kind === "form" &&
			(!ownRecordValue(doc.forms, target.formUuid) ||
				!doc.formOrder[target.moduleUuid]?.includes(target.formUuid)))
	)
		return refuse(
			"target-not-found",
			"This destination is no longer available.",
		);
	if (entryPointAt(doc, target))
		return refuse(
			"already-exists",
			"This destination already has a deep link.",
		);
	if (
		!(
			target.kind === "form" ? formEntryPointSchema : entryPointSchema
		).safeParse(entryPoint).success
	)
		return refuse(
			"invalid-entry-point",
			"Use a valid deep link ID and settings.",
		);
	if (authoredBlueprintIdentities(doc).some((e) => e.uuid === entryPoint.uuid))
		return refuse("duplicate-uuid", "This deep link identity is already used.");
	if (entryPointInventory(doc).some((e) => e.entryPoint.id === entryPoint.id))
		return refuse(
			"duplicate-id",
			"Choose a deep link ID that is not already used.",
		);
	return {
		ok: true,
		mutations: [{ kind: "addEntryPoint", target, entryPoint }],
	};
}
export function planEntryPointUpdate(
	doc: BlueprintDoc,
	entryPointUuid: Uuid,
	patch: Extract<Mutation, { kind: "updateEntryPoint" }>["patch"],
): EntryPointCommitPlan {
	const item = entryPointInventory(doc).find(
		(e) => e.entryPoint.uuid === entryPointUuid,
	);
	if (!item)
		return refuse(
			"entry-point-not-found",
			"This deep link is no longer available.",
		);
	const candidate = { ...item.entryPoint, ...patch };
	if (candidate.ignoreDisplayConditions === null)
		delete candidate.ignoreDisplayConditions;
	if (
		!(
			item.target.kind === "form" ? formEntryPointSchema : entryPointSchema
		).safeParse(candidate).success
	)
		return refuse(
			"invalid-entry-point",
			"Use a valid deep link ID and settings.",
		);
	if (
		entryPointInventory(doc).some(
			(e) =>
				e.entryPoint.uuid !== entryPointUuid &&
				e.entryPoint.id === candidate.id,
		)
	)
		return refuse(
			"duplicate-id",
			"Choose a deep link ID that is not already used.",
		);
	return {
		ok: true,
		mutations: [{ kind: "updateEntryPoint", entryPointUuid, patch }],
	};
}
export function planEntryPointRemove(
	doc: BlueprintDoc,
	entryPointUuid: Uuid,
): EntryPointCommitPlan {
	if (
		!entryPointInventory(doc).some((e) => e.entryPoint.uuid === entryPointUuid)
	)
		return refuse(
			"entry-point-not-found",
			"This deep link is no longer available.",
		);
	return {
		ok: true,
		mutations: [{ kind: "removeEntryPoint", entryPointUuid }],
	};
}
