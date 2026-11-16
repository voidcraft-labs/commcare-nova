/**
 * Named hook: a stable getter for every text a form's text formatting switch
 * changes (`lib/domain/plainText.ts::formSwitchedTexts`), read from the live
 * document when it is called. The form's switch asks it only when someone
 * turns formatting off, so the form's editor does not re-render on every
 * edit of a text it does not show.
 */

"use client";

import { useCallback } from "react";
import { formSwitchedTexts, type ProseTemplate, type Uuid } from "@/lib/domain";
import { useBlueprintDocApi } from "./useBlueprintDoc";

export function useFormSwitchedTexts(
	formUuid: Uuid,
): () => readonly ProseTemplate[] {
	const api = useBlueprintDocApi();
	return useCallback(
		() => formSwitchedTexts(api.getState(), formUuid),
		[api, formUuid],
	);
}
