import { placedBasic } from "@/lib/commcare/placement";
import { planGeneratedNodes } from "@/lib/commcare/xform/generatedNodes";
import {
	type BlueprintDoc,
	caseScalarTextGuards,
	caseSelectionCardinality,
	isContainer,
	type LanguageTag,
	moduleUuidOfForm,
	projectLocalizedFields,
	resolveAppLanguage,
	type Uuid,
} from "@/lib/domain";
import { formEntryRecord } from "@/lib/domain/advancedEntryDatums";
import { entryCaseTypes } from "@/lib/domain/effectiveCaseTypes";
import { formContentUuid } from "@/lib/domain/formEntryCases";
import { formWireName } from "@/lib/domain/formWireName";
import type { FormEngineInput } from "./formEngine";

/** The same form, localization and runtime catalogs for every engine host.
 * In a language, each field's worker-facing text is what a device shows:
 * the form builder's fill for a blank translation applied. */
export function buildEngineInput(
	doc: BlueprintDoc,
	entryUuid: Uuid,
	language: LanguageTag | null,
): FormEngineInput | undefined {
	const formUuid = formContentUuid(doc, entryUuid);
	const form = doc.forms[formUuid];
	if (!form) return;
	const moduleUuid = moduleUuidOfForm(doc, entryUuid);
	const module = moduleUuid ? doc.modules[moduleUuid] : undefined;
	const record = formEntryRecord(doc, entryUuid);
	const resolved =
		language === null
			? undefined
			: resolveAppLanguage(doc.localization, language);
	return {
		doc,
		form,
		formUuid,
		entryUuid,
		entryRecordType: record.caseType,
		requiresSelectedRecord: record.requiresCase,
		wireName: formWireName(doc, formUuid),
		repeatCountNames: repeatCountNamesOf(doc, formUuid),
		caseScalarTextGuards: Object.fromEntries(
			caseScalarTextGuards(doc, formUuid, {
				placedBasic: placedBasic(doc, formUuid),
			}),
		),
		...(resolved === undefined ? {} : { language: resolved }),
		fields:
			resolved === undefined
				? doc.fields
				: projectLocalizedFields(doc, resolved, { filled: true }),
		fieldOrder: doc.fieldOrder,
		caseTypes: entryCaseTypes(doc),
		caseSelectionCardinality: record.menu
			? caseSelectionCardinality(record.menu)
			: "single",
		userProperties: doc.userProperties,
		...(module?.caseListConfig
			? {
					searchInputs: module.caseListConfig.searchInputs.map(
						({ uuid, name }) => ({ uuid, name }),
					),
				}
			: {}),
	};
}

/** Each count-bound repeat's count node name, from the form's plan of
 * generated nodes, the allocator the emitter reads. */
export function repeatCountNamesOf(
	doc: BlueprintDoc,
	formUuid: Uuid,
): Record<string, string> {
	if (doc.forms[formUuid] === undefined) return {};
	const repeats: Uuid[] = [];
	const stack = [...(doc.fieldOrder[formUuid] ?? [])];
	for (let uuid = stack.pop(); uuid !== undefined; uuid = stack.pop()) {
		const field = doc.fields[uuid];
		if (field === undefined) continue;
		if (field.kind === "repeat" && field.repeat_mode === "count_bound")
			repeats.push(uuid);
		if (isContainer(field)) stack.push(...(doc.fieldOrder[uuid] ?? []));
	}
	if (repeats.length === 0) return {};
	const plan = planGeneratedNodes(doc, formUuid);
	return Object.fromEntries(repeats.map((uuid) => [uuid, plan.count(uuid)]));
}
