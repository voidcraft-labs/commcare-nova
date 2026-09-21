import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { writerPreloadsFromLoadedCase } from "@/lib/domain/casePreload";
import { deriveCaseWriteInventory } from "@/lib/domain/caseWriteInventory";

/** Derived effects of ordinary answers, separate from advanced operations. */
export function formAnswerWrites(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	formUuid: Uuid,
) {
	const module = doc.modules[moduleUuid];
	const form = doc.forms[formUuid];
	if (!module || !form) return [];
	return deriveCaseWriteInventory(doc, formUuid, module, form.type)
		.buckets.filter((bucket) => bucket.writers.length > 0)
		.map((bucket) => ({
			caseType: bucket.caseType,
			action: bucket.action,
			...(bucket.kind === "child" && { parentCaseType: module.caseType }),
			...(bucket.kind === "usercase" && { worker: true }),
			...(bucket.repeatUuid && { repeatFieldUuid: bucket.repeatUuid }),
			answers: bucket.writers.map((writer) => ({
				path: writer.path.map((segment) => segment.fieldId).join("/"),
				property: writer.property,
			})),
			preloadedAnswers: bucket.writers.flatMap((writer) => {
				const field = doc.fields[writer.fieldUuid];
				return field && writerPreloadsFromLoadedCase(field, module, form)
					? [writer.fieldUuid]
					: [];
			}),
		}));
}
