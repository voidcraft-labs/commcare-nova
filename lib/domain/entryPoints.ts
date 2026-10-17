import { z } from "zod";
import type { BlueprintDoc } from "./blueprint";
import { type FreeNameOffer, freeNameClause, uniqueSlug } from "./idSlug";
import { ownRecordValue } from "./records";
import { uuidSchema } from "./uuid";

export const entryPointIdSchema = z
	.string()
	.regex(
		/^[a-z0-9_-]+$/,
		"Use lowercase letters, numbers, underscores, or hyphens.",
	);

/**
 * The ids among those `entryPointIdSchema` admits that CommCare HQ saves as
 * written: HQ answers 400 unless an endpoint id equals Django's `slugify` of
 * itself (`views/utils.py::get_cleaned_session_endpoint_id`), which leaves an
 * id unchanged exactly when it starts and ends with a letter or digit and
 * holds no doubled hyphen. `proof/hq/test_endpoint_ids.py` holds this
 * pattern to HQ's own function.
 */
export const ENTRY_POINT_ID_PATTERN =
	/^(?!.*--)[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;

export type EntryPointIdProblem = "characters" | "edge" | "doubled-hyphen";

/** Why `id` can't be a deep link ID, or `undefined` when it can. */
export function entryPointIdProblem(
	id: string,
): EntryPointIdProblem | undefined {
	if (!/^[a-z0-9_-]+$/.test(id)) return "characters";
	if (/^[-_]|[-_]$/.test(id)) return "edge";
	if (id.includes("--")) return "doubled-hyphen";
	return undefined;
}

/**
 * The one normalizer for a deep link ID, which each refusal's offered
 * replacement uses; its result always passes
 * `entryPointIdProblem`. The caller settles a collision with
 * `suffixUntilFree`.
 */
export function editorSafeEntryPointId(id: string): string {
	const safe = id
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "_")
		.replace(/^[-_]+|[-_]+$/g, "")
		.replace(/-+/g, "-");
	return safe.length > 0 ? safe : "entry";
}

/** The sentence for each refusal of a deep link ID. */
export function entryPointIdProblemSentence(
	problem: EntryPointIdProblem,
	freeId: string,
	offer: FreeNameOffer = "free-here",
): string {
	const free = freeNameClause(freeId, offer);
	switch (problem) {
		case "characters":
			return `A deep link ID holds only lowercase letters, digits, underscores and hyphens. ${free}`;
		case "edge":
			return `A deep link ID starts and ends with a lowercase letter or a digit, because CommCare HQ won't save one that doesn't. ${free}`;
		case "doubled-hyphen":
			return `A deep link ID can't hold two hyphens in a row, because CommCare HQ won't save it. ${free}`;
	}
}

export const entryPointSchema = z.strictObject({
	uuid: uuidSchema,
	id: entryPointIdSchema,
});
export const formEntryPointSchema = entryPointSchema.extend({
	ignoreDisplayConditions: z.literal(true).optional(),
});
export const entryPointTargetSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("module"), moduleUuid: uuidSchema }),
	z.strictObject({ kind: z.literal("case-list"), moduleUuid: uuidSchema }),
	z.strictObject({
		kind: z.literal("form"),
		moduleUuid: uuidSchema,
		formUuid: uuidSchema,
	}),
]);
export type EntryPoint = z.infer<typeof entryPointSchema>;
export type FormEntryPoint = z.infer<typeof formEntryPointSchema>;
export type EntryPointTarget = z.infer<typeof entryPointTargetSchema>;
export interface EntryPointInventoryItem {
	target: EntryPointTarget;
	entryPoint: FormEntryPoint;
}
export function entryPointAt(
	doc: BlueprintDoc,
	target: EntryPointTarget,
): FormEntryPoint | undefined {
	const module = ownRecordValue(doc.modules, target.moduleUuid);
	if (!module) return;
	if (target.kind === "form")
		return doc.formOrder[target.moduleUuid]?.includes(target.formUuid)
			? ownRecordValue(doc.forms, target.formUuid)?.entryPoint
			: undefined;
	return target.kind === "module"
		? module.entryPoint
		: module.caseListEntryPoint;
}
export function entryPointInventory(
	doc: BlueprintDoc,
): EntryPointInventoryItem[] {
	const items: EntryPointInventoryItem[] = [];
	for (const moduleUuid of doc.moduleOrder) {
		const module = ownRecordValue(doc.modules, moduleUuid);
		if (!module) continue;
		if (module.entryPoint)
			items.push({
				target: { kind: "module", moduleUuid },
				entryPoint: module.entryPoint,
			});
		if (module.caseListEntryPoint)
			items.push({
				target: { kind: "case-list", moduleUuid },
				entryPoint: module.caseListEntryPoint,
			});
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			const entryPoint = ownRecordValue(doc.forms, formUuid)?.entryPoint;
			if (entryPoint)
				items.push({
					target: { kind: "form", moduleUuid, formUuid },
					entryPoint,
				});
		}
	}
	return items;
}

export function entryPointByUuid(
	doc: BlueprintDoc,
	uuid: EntryPoint["uuid"],
): EntryPointInventoryItem | undefined {
	return entryPointInventory(doc).find((item) => item.entryPoint.uuid === uuid);
}
export function entryPointTargetLabel(
	doc: BlueprintDoc,
	target: EntryPointTarget,
): string {
	const module = ownRecordValue(doc.modules, target.moduleUuid);
	if (target.kind === "form")
		return `${module?.name ?? "Module"} / ${ownRecordValue(doc.forms, target.formUuid)?.name ?? "Form"}`;
	return target.kind === "case-list"
		? `${module?.name ?? "Module"} / Case list`
		: (module?.name ?? "Module");
}
export function suggestEntryPointId(
	doc: BlueprintDoc,
	target: EntryPointTarget,
): string {
	return uniqueSlug(
		entryPointTargetLabel(doc, target),
		"entry_point",
		new Set(entryPointInventory(doc).map((item) => item.entryPoint.id)),
	);
}
