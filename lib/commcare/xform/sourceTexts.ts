/**
 * The authored text a form's source holds as plain text: outside itext and
 * outside a formula, where no element can stand inside it.
 *
 * `builder.ts::buildXFormSource` writes three such kinds of text. A Connect
 * block's name and description are text nodes of the form's data
 * (`builder.ts::buildConnectBlocks`), which CommCare Connect and HQ's form
 * builder read as the element's own text. The form's name in the app's
 * default language is the text of `<h:title>` and the data root's `name`
 * attribute (`dataRootAttributes.ts`), which HQ's form builder writes again on
 * every save. A choice's value is the text of an `<item>`'s `<value>`, and
 * it is not listed: a value CommCare HQ reads as an instance is refused by
 * the value's own grammar (`lib/domain/selectOptionValue.ts`, `instance-read`),
 * which the builder's editor and the tools' schemas apply before the gate.
 * Every other text the source holds is itext, or a composed validation
 * message's escaped pieces (`constraintMessage.ts`).
 *
 * This module imports the domain alone, so the validator, which also runs in
 * the browser, reads it without the emitter.
 */

import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { formWireName } from "@/lib/domain/formWireName";

export type FormSourceTextSite =
	| "form-name"
	| "learn-module-name"
	| "learn-module-description"
	| "deliver-unit-name"
	| "task-name"
	| "task-description";

/** A Connect block's text, as a person names it: "learn module's name". */
export const CONNECT_SOURCE_TEXT_WORDS: Readonly<
	Record<Exclude<FormSourceTextSite, "form-name">, string>
> = {
	"learn-module-name": "learn module's name",
	"learn-module-description": "learn module's description",
	"deliver-unit-name": "deliver unit's name",
	"task-name": "task's name",
	"task-description": "task's description",
};

export interface FormSourceText {
	readonly site: FormSourceTextSite;
	readonly text: string;
}

/** Every authored text a form's source holds as plain text: outside itext and outside a formula. */
export function formSourceTexts(
	doc: BlueprintDoc,
	formUuid: Uuid,
): readonly FormSourceText[] {
	const form = doc.forms[formUuid];
	if (form === undefined)
		throw new Error(
			`formSourceTexts was asked for form ${formUuid}, which the document does not hold.`,
		);
	const texts: FormSourceText[] = [
		{ site: "form-name", text: formWireName(doc, formUuid) },
	];
	const connect = form.connect;
	if (connect === undefined) return texts;
	if ("learn_module" in connect && connect.learn_module !== undefined) {
		texts.push(
			{ site: "learn-module-name", text: connect.learn_module.name },
			{
				site: "learn-module-description",
				text: connect.learn_module.description,
			},
		);
	}
	if ("deliver_unit" in connect && connect.deliver_unit !== undefined)
		texts.push({ site: "deliver-unit-name", text: connect.deliver_unit.name });
	if ("task" in connect && connect.task !== undefined) {
		texts.push(
			{ site: "task-name", text: connect.task.name },
			{ site: "task-description", text: connect.task.description },
		);
	}
	return texts;
}
