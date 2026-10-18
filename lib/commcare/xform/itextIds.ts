import type { BlueprintDoc } from "@/lib/domain/blueprint";
import {
	type FormStructure,
	formFieldPath,
	formStructure,
} from "@/lib/domain/expression/formStructure";
import type { ItextUnit, ProseSlotRef } from "@/lib/domain/expression/types";
import {
	makeTranslationUnitId,
	type TranslationUnitId,
} from "@/lib/domain/localization";
import type { Uuid } from "@/lib/domain/uuid";

const roles = [
	["label", "field-label", "label"],
	["hint", "field-hint", "hint"],
	["help", "field-help", "help"],
	["validate_msg", "field-validation-message", "constraintMsg"],
] as const;

/** Logical ancestry, without generated query-repeat item nodes. */
export function fieldItextKey(
	form: FormStructure,
	fieldUuid: Uuid,
): string | undefined {
	return formFieldPath(form, fieldUuid)?.join("-");
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
		for (const [slot, role, suffix] of roles) {
			if (field.proseSlots?.includes(slot))
				units.set(`${key}-${suffix}`, { field: field.uuid, role });
		}
		if (field.choices?.kind === "inline") {
			field.choices.options.forEach((option, index) => {
				units.set(`${key}-opt${index}-label`, {
					field: field.uuid,
					option: option.uuid,
					role: "select-option-label",
				});
			});
		}
	}
	indexes.set(form, units);
	return units;
}

export function itextTranslationUnitId(unit: ItextUnit): TranslationUnitId {
	if (unit.role === "select-option-label")
		return makeTranslationUnitId("field", unit.field, "option", unit.option);
	const slot = roles.find(([, role]) => role === unit.role)?.[0];
	if (slot === undefined)
		throw new Error("Unknown field translation unit role.");
	return makeTranslationUnitId("field", unit.field, slot);
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
	let id: string;
	if (unit.role === "select-option-label") {
		const choices = form.fields.get(unit.field)?.choices;
		if (choices?.kind !== "inline") return undefined;
		const index = choices.options.findIndex(
			(option) => option.uuid === unit.option,
		);
		if (index < 0) return undefined;
		id = `${key}-opt${index}-label`;
	} else {
		const suffix = roles.find(([, role]) => role === unit.role)?.[2];
		if (suffix === undefined) return undefined;
		id = `${key}-${suffix}`;
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
