import type { BlueprintDoc } from "@/lib/domain/blueprint";
import {
	type FormStructure,
	formFieldPath,
	formStructure,
} from "@/lib/domain/expression/formStructure";
import type { ItextUnit, ProseSlotRef } from "@/lib/domain/expression/types";
import {
	behaviorTextUnits,
	type FormBehaviorRole,
	formBehaviorRoles,
} from "@/lib/domain/forms";
import type { TranslationUnitId } from "@/lib/domain/localization";
import { itextUnitTranslationId } from "@/lib/domain/translationUnits";
import type { Uuid } from "@/lib/domain/uuid";

const roles = [
	["label", "field-label", "label"],
	["hint", "field-hint", "hint"],
	["help", "field-help", "help"],
	["validate_msg", "field-validation-message", "constraintMsg"],
	["addFirstLabel", "field-first-add-label", "add-empty-caption"],
	["addLabel", "field-add-label", "add-caption"],
] as const;

/** Logical ancestry, without generated query-repeat item nodes. A hyphen an id
 * holds is written twice, so the single hyphen between two ids and before a
 * role stays a separator and two fields never share a key. */
export function fieldItextKey(
	form: FormStructure,
	fieldUuid: Uuid,
): string | undefined {
	return formFieldPath(form, fieldUuid)
		?.map((segment) => segment.replaceAll("-", "--"))
		.join("-");
}

export const behaviorWireIds = {
	automaticSubmissionText: "Pragma-Submit-Automatically",
	skipAutomaticSyncText: "Pragma-Suppress-Autosync",
	validateChangedAnswersText: "Pragma-Skip-Full-Form-Validation",
	activityKeyText: "Pragma-Volatility-Key",
	activityTitleText: "Pragma-Volatility-Entity-Title",
	activityWindowText: "Pragma-Volatility-Window",
	savedFormDescriptorText: "Pragma-Form-Descriptor",
} as const satisfies Record<FormBehaviorRole, string>;
export const AUTOMATIC_SUBMISSION_TEXT_ID =
	behaviorWireIds.automaticSubmissionText;

/** The wire id for a text slot, whether the slot names a form behavior or
 * follows the field path and choice order. Each exporter and XPath binding
 * asks this same function. */
export function fieldTextIds(form: FormStructure, field: Uuid) {
	const key = fieldItextKey(form, field);
	if (!key) throw new Error("The form text has no field in this form.");
	const suffixes = new Map<string, string>();
	for (const role of formBehaviorRoles) {
		const selected = form[role];
		if (!selected) continue;
		const id = behaviorWireIds[role];
		for (const unit of behaviorTextUnits(selected)) {
			if (unit.field !== field) continue;
			if (unit.role === "select-option-label") {
				const choices = form.fields.get(field)?.choices;
				const index =
					choices?.kind === "inline"
						? choices.options.findIndex((option) => option.uuid === unit.option)
						: -1;
				if (index >= 0) suffixes.set(`opt${index}-label`, id);
			} else {
				const ending = roles.find(([, role]) => role === unit.role)?.[2];
				if (ending) suffixes.set(ending, id);
			}
		}
	}
	return (suffix: string): string => suffixes.get(suffix) ?? `${key}-${suffix}`;
}

const indexes = new WeakMap<FormStructure, ReadonlyMap<string, ItextUnit>>();

/** Source-declared units only. Rendering still decides whether an entry has
 * text or media in an exported locale; this index does not change that gate. */
export function formItextUnits(
	form: FormStructure,
): ReadonlyMap<string, ItextUnit> {
	const previous = indexes.get(form);
	if (previous !== undefined) return previous;
	const units = new Map<string, ItextUnit>();
	for (const field of form.fields.values()) {
		const key = fieldItextKey(form, field.uuid);
		if (key === undefined) continue;
		const textId = fieldTextIds(form, field.uuid);
		for (const [slot, role, suffix] of roles) {
			if (field.proseSlots?.includes(slot))
				units.set(textId(suffix), { field: field.uuid, role });
		}
		if (field.choices?.kind === "inline") {
			field.choices.options.forEach((option, index) => {
				units.set(textId(`opt${index}-label`), {
					field: field.uuid,
					option: option.uuid,
					role: "select-option-label",
				});
			});
		}
	}
	for (const role of formBehaviorRoles) {
		const selected = form[role];
		if (selected && units.has(behaviorWireIds[role]))
			units.set(behaviorWireIds[role], selected.carrier);
	}
	indexes.set(form, units);
	return units;
}

/** Every ordinary field and option id, including all aliases of a shared behavior text. */
export function ordinaryFormItextUnits(form: FormStructure) {
	const ordinary = { ...form };
	for (const role of formBehaviorRoles) delete ordinary[role];
	return formItextUnits(ordinary);
}

/** The translation unit an itext entry renders; the mapping is the domain's. */
export function itextTranslationUnitId(unit: ItextUnit): TranslationUnitId {
	return itextUnitTranslationId(unit);
}

export function itextProseSlot(unit: ItextUnit): ProseSlotRef {
	if (unit.role === "select-option-label")
		return {
			entity: "field",
			uuid: unit.field,
			slot: "option_label",
			member: { optionUuid: unit.option },
		};
	const slot = roles.find(([, role]) => role === unit.role)?.[0];
	if (slot === undefined)
		throw new Error("Unknown field translation unit role.");
	return { entity: "field", uuid: unit.field, slot };
}

function owningStructure(
	doc: BlueprintDoc,
	field: Uuid,
): FormStructure | undefined {
	for (const moduleUuid of doc.moduleOrder) {
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			const form = formStructure(doc, formUuid);
			if (form?.fields.has(field)) return form;
		}
	}
	return undefined;
}

/** The prepared view supplies current names and option order during atomic
 * authoring, before those declarations exist in the committed document. */
export function itextIdFor(
	doc: BlueprintDoc,
	unit: ItextUnit,
	prepared?: FormStructure,
): string | undefined {
	const form = prepared ?? owningStructure(doc, unit.field);
	if (form === undefined) return undefined;
	const key = fieldItextKey(form, unit.field);
	if (key === undefined) return undefined;
	const textId = fieldTextIds(form, unit.field);
	let id: string;
	if (unit.role === "select-option-label") {
		const choices = form.fields.get(unit.field)?.choices;
		if (choices?.kind !== "inline") return undefined;
		const index = choices.options.findIndex(
			(option) => option.uuid === unit.option,
		);
		if (index < 0) return undefined;
		id = textId(`opt${index}-label`);
	} else {
		const suffix = roles.find(([, role]) => role === unit.role)?.[2];
		if (suffix === undefined) return undefined;
		id = textId(suffix);
	}
	return formItextUnits(form).has(id) ? id : undefined;
}

export function itextUnitForId(
	doc: BlueprintDoc,
	formUuid: Uuid,
	id: string,
	prepared?: FormStructure,
): ItextUnit | undefined {
	const form = prepared ?? formStructure(doc, formUuid);
	return form?.formUuid === formUuid ? formItextUnits(form).get(id) : undefined;
}
