// lib/domain/plainText.ts
//
// The one reader of "as typed": whether a text writes no formatted copy
// (`<value form="markdown">`). A form's `plainText` turns formatting off for
// every label, choice and help text in it; otherwise each text follows its
// own setting, `plainLabel` on a label or a choice and `plainHelp` on a help
// text. A text's own setting is kept while the form's switch is on and
// takes effect again when the switch goes off. The emitter, Preview and the
// builder read these two.

import type { BlueprintDoc } from "./blueprint";
import { inlineOptionsOf } from "./fields/selectOptionsSource";
import type { Form } from "./forms";
import { effectiveAppLocalization } from "./localization";
import type { ProseTemplate } from "./prose";
import {
	snapshotTranslationUnits,
	storedTranslationValue,
	type TranslationUnitRole,
} from "./translationUnits";
import type { Uuid } from "./uuid";

/** Whether a label or a choice writes no formatted copy: its form's switch, or its own setting. */
export function labelShowsAsTyped(
	form: Pick<Form, "plainText">,
	owner: { plainLabel?: true },
): boolean {
	return form.plainText === true || owner.plainLabel === true;
}

/** Whether a help text writes no formatted copy: its form's switch, or its own setting. */
export function helpShowsAsTyped(
	form: Pick<Form, "plainText">,
	field: { plainHelp?: true },
): boolean {
	return form.plainText === true || field.plainHelp === true;
}

/** The texts a form's switch reaches: labels, choices and help texts. A hint
 *  and a validation message write no formatted copy either way. */
const SWITCHED_ROLES: ReadonlySet<TranslationUnitRole> = new Set([
	"field-label",
	"select-option-label",
	"field-help",
]);

/** The form's switch as it reads while formatting is on. */
const SWITCH_ON: Pick<Form, "plainText"> = {};

/** Whether a unit's own setting already shows it as typed with the form's
 *  switch on: a label's or a container's `plainLabel`, a choice's
 *  `plainLabel`, a help text's `plainHelp`. */
function ownSettingShowsAsTyped(
	doc: BlueprintDoc,
	owner: { fieldUuid: Uuid; optionUuid?: Uuid },
	role: TranslationUnitRole,
): boolean {
	const field = doc.fields[owner.fieldUuid];
	if (field === undefined) return false;
	if (owner.optionUuid !== undefined) {
		if (!("optionsSource" in field) || field.optionsSource === undefined)
			return false;
		const option = inlineOptionsOf(field.optionsSource)?.find(
			(candidate) => candidate.uuid === owner.optionUuid,
		);
		return option !== undefined && labelShowsAsTyped(SWITCH_ON, option);
	}
	if (role === "field-help")
		return helpShowsAsTyped(SWITCH_ON, "plainHelp" in field ? field : {});
	return labelShowsAsTyped(SWITCH_ON, "plainLabel" in field ? field : {});
}

/**
 * Every text a form's text formatting switch changes, as each of the app's
 * languages holds it: each question's, container's and section's label, each
 * inline choice's label and each help text, less those whose own setting
 * already shows them as typed (workers see their symbols either way). The
 * builder reads it to ask before turning formatting off for a form where some
 * text uses it.
 */
export function formSwitchedTexts(
	doc: BlueprintDoc,
	formUuid: Uuid,
): ProseTemplate[] {
	const languages = effectiveAppLocalization(doc.localization).languageOrder;
	const out: ProseTemplate[] = [];
	for (const unit of snapshotTranslationUnits(doc).values()) {
		const owner = unit.owner;
		if (owner.kind !== "field" && owner.kind !== "select-option") continue;
		if (owner.formUuid !== formUuid || !SWITCHED_ROLES.has(unit.role)) continue;
		if (ownSettingShowsAsTyped(doc, owner, unit.role)) continue;
		for (const language of languages) {
			const value = storedTranslationValue(doc, language, unit);
			if (typeof value === "object" && value !== null) out.push(value);
		}
	}
	return out;
}
