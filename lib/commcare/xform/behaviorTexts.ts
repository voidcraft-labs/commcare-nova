import { deepEqual } from "@/lib/doc/deepEqual";
import {
	type BlueprintDoc,
	behaviorTextUnits,
	caseScalarTextGuards,
	type Field,
	type FormBehaviorRole,
	formBehaviorRoles,
	helpShowsAsTyped,
	labelShowsAsTyped,
	projectProseTemplate,
	proseTemplateIsEmpty,
	type Uuid,
} from "@/lib/domain";
import { formStructure } from "@/lib/domain/expression/formStructure";
import type { ItextUnit } from "@/lib/domain/expression/types";
import {
	itextUnitTranslationId,
	snapshotTranslationUnits,
} from "@/lib/domain/translationUnits";
import { commCareLocalization } from "../localization";
import type { FormBehaviorTextIssue } from "./behaviorTextCopy";
import {
	bindCarriesConstraint,
	constraintMessageNeedsProtection,
} from "./constraintMessage";
import { behaviorWireIds, ordinaryFormItextUnits } from "./itextIds";

/** Presence is tested after HQ fills translations and normalizes equal text
 * groups (`XForm.normalize_itext` keeps the lexically first id of each group
 * of equal texts and repoints the rest), so an earlier equal id consumes the
 * setting and all its references. */
export function formBehaviorTextIssue(
	doc: BlueprintDoc,
	formUuid: Uuid,
): FormBehaviorTextIssue | undefined {
	const form = doc.forms[formUuid];
	if (!form || !formBehaviorRoles.some((role) => form[role])) return undefined;
	const structure = formStructure(doc, formUuid);
	if (!structure) return undefined;
	const ordinary = ordinaryFormItextUnits(structure);
	const units = snapshotTranslationUnits(doc);
	const localization = commCareLocalization(doc);
	const guards = caseScalarTextGuards(doc, formUuid);
	const declared = new Set([...ordinary.values()].map(itextUnitTranslationId));
	const describe = (unit: ItextUnit) =>
		units.get(itextUnitTranslationId(unit))?.breadcrumb.join(" / ") ??
		"a removed text";
	const signature = (unit: ItextUnit, id: string) => {
		const key = itextUnitTranslationId(unit);
		const field: Field | undefined = doc.fields[unit.field];
		if (
			!field ||
			!declared.has(key) ||
			!units.has(key) ||
			field.kind === "hidden"
		)
			return;
		const option =
			unit.role === "select-option-label" &&
			"optionsSource" in field &&
			field.optionsSource?.kind === "inline"
				? field.optionsSource.options.find(
						(value) => value.uuid === unit.option,
					)
				: undefined;
		const media =
			unit.role === "field-label" && "label_media" in field
				? field.label_media
				: unit.role === "field-help" && "help_media" in field
					? field.help_media
					: option?.media;
		const values = localization.languages.map((code) =>
			localization.prose(code, key),
		);
		if (
			!option &&
			!media?.image &&
			!media?.audio &&
			!media?.video &&
			values.every(proseTemplateIsEmpty)
		)
			return;
		if (
			unit.role === "field-validation-message" &&
			!bindCarriesConstraint(
				field.kind,
				"validate" in field ? field.validate : undefined,
				guards.get(field.uuid),
			)
		)
			return;
		const markdown =
			unit.role === "field-label"
				? !labelShowsAsTyped(form, "plainLabel" in field ? field : {})
				: unit.role === "select-option-label"
					? !labelShowsAsTyped(form, option ?? {})
					: unit.role === "field-help" &&
						!helpShowsAsTyped(form, "plainHelp" in field ? field : {});
		return {
			values,
			media: [media?.image, media?.audio, media?.video],
			markdown,
			protectedId:
				unit.role === "field-validation-message" &&
				constraintMessageNeedsProtection(values)
					? id
					: undefined,
		};
	};
	const assigned = new Map<string, FormBehaviorRole>();
	for (const role of formBehaviorRoles) {
		const behavior = form[role];
		if (!behavior) continue;
		for (const member of behaviorTextUnits(behavior)) {
			const key = itextUnitTranslationId(member);
			const previous = assigned.get(key);
			if (previous)
				return previous === role
					? { reason: "chosen-twice", role, text: describe(member) }
					: {
							reason: "held-by-another",
							role,
							heldBy: previous,
							text: describe(member),
						};
			assigned.set(key, role);
		}
	}
	for (const role of formBehaviorRoles) {
		const behavior = form[role];
		if (!behavior) continue;
		const id = behaviorWireIds[role];
		const value = signature(behavior.carrier, id);
		if (!value) return { reason: "text-missing", role, formName: form.name };
		for (const alias of behavior.alsoUsedBy ?? []) {
			if (!deepEqual(value, signature(alias, id)))
				return {
					reason: "shared-text-differs",
					role,
					text: describe(alias),
					carrier: describe(behavior.carrier),
				};
		}
		for (const [ordinaryId, other] of ordinary) {
			const otherRole = assigned.get(itextUnitTranslationId(other));
			const otherId = otherRole ? behaviorWireIds[otherRole] : ordinaryId;
			if (otherId >= id) continue;
			if (deepEqual(value, signature(other, otherId)))
				return {
					reason: "merged-away",
					role,
					text: describe(other),
					carrier: describe(behavior.carrier),
				};
		}
	}
	return undefined;
}

const CHOICE_ROLE_WORDS: Record<ItextUnit["role"], string> = {
	"field-label": "label",
	"field-hint": "hint",
	"field-help": "help",
	"field-validation-message": "validation message",
	"field-first-add-label": "first add button",
	"field-add-label": "add button",
	"select-option-label": "choice",
};

export interface FormBehaviorTextChoice {
	readonly unit: ItextUnit;
	/** The text's translation unit id, unique within the app. */
	readonly key: string;
	/** HQ's Case List editor offers a clickable icon only forms whose
	 *  automatic submission sits on a leaf question's label
	 *  (`FormBase.is_auto_submitting_form`: a question with
	 *  `label_ref == 'Pragma-Submit-Automatically'`). */
	readonly questionLabel: boolean;
	readonly label: string;
}

/** Every text in the form that can carry a form behavior: a question's or
 *  choice's own written text, never a Hidden Value's or a blank one. */
export function formBehaviorTextChoices(
	doc: BlueprintDoc,
	formUuid: Uuid,
): FormBehaviorTextChoice[] {
	const structure = formStructure(doc, formUuid);
	if (!structure) return [];
	const translations = snapshotTranslationUnits(doc);
	return [...ordinaryFormItextUnits(structure).values()].flatMap((unit) => {
		const key = itextUnitTranslationId(unit);
		const translation = translations.get(key);
		const field = doc.fields[unit.field];
		if (!translation || !field || field.kind === "hidden") return [];
		const text =
			typeof translation.source === "string"
				? translation.source
				: projectProseTemplate(translation.source, doc).text;
		if (!text.trim()) return [];
		return [
			{
				unit,
				key,
				questionLabel:
					unit.role === "field-label" &&
					field.kind !== "group" &&
					field.kind !== "repeat",
				label: `${text.trim()} · ${CHOICE_ROLE_WORDS[unit.role]} of ${field.id}`,
			},
		];
	});
}
