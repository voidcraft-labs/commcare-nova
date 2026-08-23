import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { ownRecordValue } from "@/lib/domain";

/** A UUID-backed form choice labelled exactly as HQ's published-form picker. */
export interface AutomationFormChoice {
	readonly uuid: Uuid;
	readonly label: string;
}

/**
 * Project the normalized module/form topology into published picker paths.
 *
 * The UUID remains the canonical authored reference. The label is derived from
 * current names so app, module, and form renames regenerate both Builder
 * choices and setup guidance without rewriting the stored automation.
 */
export function automationFormChoices(
	doc: Pick<
		BlueprintDoc,
		"appName" | "modules" | "forms" | "moduleOrder" | "formOrder"
	>,
): readonly AutomationFormChoice[] {
	return doc.moduleOrder.flatMap((moduleUuid) => {
		const module = ownRecordValue(doc.modules, moduleUuid);
		if (module === undefined) return [];
		const parent =
			module.parentModuleUuid === undefined
				? undefined
				: ownRecordValue(doc.modules, module.parentModuleUuid);
		const modulePath = parent ? `${parent.name} > ${module.name}` : module.name;
		return (doc.formOrder[moduleUuid] ?? []).flatMap((formUuid) => {
			const form = ownRecordValue(doc.forms, formUuid);
			return form === undefined
				? []
				: [
						{
							uuid: form.uuid,
							label: `${doc.appName} > ${modulePath} > ${form.name}`,
						},
					];
		});
	});
}

export function automationFormChoice(
	doc: BlueprintDoc,
	formUuid: Uuid,
): AutomationFormChoice | undefined {
	return automationFormChoices(doc).find((choice) => choice.uuid === formUuid);
}
