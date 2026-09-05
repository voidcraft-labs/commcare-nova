import { z } from "zod";
import type { BlueprintDoc } from "./blueprint";
import { uniqueSlug } from "./idSlug";
import { ownRecordValue } from "./records";
import { uuidSchema } from "./uuid";

export const entryPointIdSchema = z
	.string()
	.regex(
		/^[a-z0-9_-]+$/,
		"Use lowercase letters, numbers, underscores, or hyphens.",
	);
export const entryPointSchema = z
	.object({ uuid: uuidSchema, id: entryPointIdSchema })
	.strict();
export const formEntryPointSchema = entryPointSchema.extend({
	ignoreDisplayConditions: z.literal(true).optional(),
});
export const entryPointTargetSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("module"), moduleUuid: uuidSchema }).strict(),
	z.object({ kind: z.literal("case-list"), moduleUuid: uuidSchema }).strict(),
	z
		.object({
			kind: z.literal("form"),
			moduleUuid: uuidSchema,
			formUuid: uuidSchema,
		})
		.strict(),
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
