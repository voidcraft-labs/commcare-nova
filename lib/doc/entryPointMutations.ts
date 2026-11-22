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
import { routeContainsForm } from "@/lib/domain/listedForms";
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
				!routeContainsForm(doc, target.moduleUuid, target.formUuid)))
	)
		return refuse(
			"target-not-found",
			"This destination is no longer available.",
		);
	const route = doc.modules[target.moduleUuid];
	if (
		target.kind === "form" &&
		route.formsFromMenu &&
		entryPoint.ignoreDisplayConditions
	)
		return refuse(
			"display-conditions",
			"A link through another menu follows the form’s display conditions. Turn off the option to skip them, or link directly to the original form.",
		);
	if (target.kind === "form" && route.formsFromMenu && !route.entryPoint)
		return refuse(
			"menu-link-required",
			"Add a deep link for this menu before adding one for a form it lists.",
		);
	if (entryPointAt(doc, target))
		return refuse(
			"already-exists",
			"This destination already has a deep link.",
		);
	if (
		!(
			target.kind === "form" && !route.formsFromMenu
				? formEntryPointSchema
				: entryPointSchema
		).validate(entryPoint)
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
	if (
		item.target.kind === "form" &&
		doc.modules[item.target.moduleUuid]?.formsFromMenu &&
		patch.ignoreDisplayConditions
	)
		return refuse(
			"display-conditions",
			"A link through another menu follows the form’s display conditions. Turn off the option to skip them, or link directly to the original form.",
		);
	const candidate = { ...item.entryPoint, ...patch };
	if (candidate.ignoreDisplayConditions === null)
		delete candidate.ignoreDisplayConditions;
	if (
		!(
			item.target.kind === "form" &&
			!doc.modules[item.target.moduleUuid]?.formsFromMenu
				? formEntryPointSchema
				: entryPointSchema
		).validate(candidate)
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
