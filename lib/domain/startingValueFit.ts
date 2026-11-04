/**
 * Which values a question can open on.
 *
 * A question's starting value is a setvalue, which casts the text the value
 * gives through the question's own answer class as the form opens
 * (`SetValueAction.java::processAction`). An integer question's class reads
 * it with `Integer.parseInt` (`IntegerData.java::cast`), which throws on
 * `2.5` and stops the form. A choice question with written choices then
 * attaches the text to one of them (`Selection.java::attachChoice`, which
 * Web Apps calls from `PromptToJson.java::parseQuestionAnswer`), and throws
 * where the text names no choice. A property's agreed type says what its
 * values can be whichever writer saved them, since an integer writer and a
 * decimal one agree on `decimal`, and a choice writer and a text one on
 * `text` (`expression/ruleSets.ts::agreedStorageType`).
 *
 * On a follow-up or close form that opens one case, a question that saves
 * to that case opens on its value (`casePreload.ts::writerOffersPreload`),
 * and starting it blank instead is no remedy: a blank answer is saved as
 * blank and clears the case's value (`caseBlocks.ts::updateBlock`, HQ's
 * `XFormCaseBlock.add_case_updates`, Core's `CaseXmlParser.updateCase`).
 */

import type { PersistableDoc } from "./blueprint";
import type { CasePropertyDataType } from "./casePropertyTypes";
import { inferExpressionTypes } from "./expression/inference";
import type { Field } from "./fields";

/** Whether a question of `field`'s kind would stop the form opening on a
 *  value of type `type`: a whole-number question on a decimal one. */
export function wholeNumberStartsOnDecimal(
	field: Pick<Field, "kind">,
	type: string | undefined,
): boolean {
	return field.kind === "int" && type === "decimal";
}

/**
 * Whether a choice question with written choices could open on a value of
 * type `type` that is none of its choices: a type that can hold values
 * outside any choices, such as text, and for a single-choice question also
 * a multiple-choice one, whose `a b` attaches to no one choice. A
 * multiple-choice question opens on a single choice as a selection of one.
 * Which choices two questions saving to one choice-typed property may offer
 * is a design question of its own (issue #856), so choice sets are not
 * compared here.
 */
export function choiceStartsOutsideItsChoices(
	field: Field,
	type: CasePropertyDataType | undefined,
): boolean {
	if (field.kind !== "single_select" && field.kind !== "multi_select")
		return false;
	if (field.optionsSource.kind !== "inline" || type === undefined) return false;
	if (field.kind === "single_select") return type !== "single_select";
	return type !== "single_select" && type !== "multi_select";
}

/** Why a question can't open on a property's value. */
export type StartingValueMisfit =
	| { readonly kind: "whole-number-on-decimal" }
	| { readonly kind: "outside-choices"; readonly type: CasePropertyDataType };

/** Why `field` can't open on the value of `caseType`'s `property`, as its
 *  agreed type says; undefined where it can. */
export function startingValueMisfit(
	doc: PersistableDoc,
	field: Field,
	caseType: string,
	property: string,
): StartingValueMisfit | undefined {
	// A property nothing types holds no opinion.
	const type = propertyAgreedType(doc, caseType, property);
	if (type === undefined) return undefined;
	if (wholeNumberStartsOnDecimal(field, type))
		return { kind: "whole-number-on-decimal" };
	if (choiceStartsOutsideItsChoices(field, type))
		return { kind: "outside-choices", type };
	return undefined;
}

/** The type a property's values can be: its declaration, else the one its
 *  writers agree on; undefined where nothing types it. */
export function propertyAgreedType(
	doc: PersistableDoc,
	caseType: string,
	property: string,
): CasePropertyDataType | undefined {
	return inferExpressionTypes(doc).propertyTypes.get(caseType)?.get(property)
		?.type;
}
