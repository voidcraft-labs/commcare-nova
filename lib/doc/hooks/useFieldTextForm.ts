/**
 * Named hook: the text formatting switch of the form that holds a field, as
 * the `form` argument `lib/domain/plainText.ts`'s readers take.
 *
 * The selector returns one of two module constants, so the default
 * `Object.is` comparison re-renders a caller only when the form's switch
 * flips, not on every edit of the form. A field no form holds (or an absent
 * uuid) reads as formatting on.
 */

"use client";

import { type Form, formOfField, type Uuid } from "@/lib/domain";
import { useBlueprintDoc } from "./useBlueprintDoc";

const FORMATTING_OFF: Pick<Form, "plainText"> = Object.freeze({
	plainText: true,
});
const FORMATTING_ON: Pick<Form, "plainText"> = Object.freeze({});

export function useFieldTextForm(
	fieldUuid: Uuid | undefined,
): Pick<Form, "plainText"> {
	return useBlueprintDoc((doc) => {
		if (fieldUuid === undefined) return FORMATTING_ON;
		const formUuid = formOfField(doc, fieldUuid);
		return formUuid !== undefined && doc.forms[formUuid]?.plainText === true
			? FORMATTING_OFF
			: FORMATTING_ON;
	});
}
