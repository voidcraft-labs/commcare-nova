"use client";

import { useMemo } from "react";
import type { Uuid } from "@/lib/domain";
import {
	type FormBehaviorTextChoice,
	formBehaviorTextChoices,
} from "../formBehaviorTexts";
import { useBlueprintDoc } from "./useBlueprintDoc";

/** The form's texts that can hold one of its behaviors, recomputed when the
 *  document changes. */
export function useFormBehaviorTextChoices(
	formUuid: Uuid,
): readonly FormBehaviorTextChoice[] {
	const doc = useBlueprintDoc((state) => state);
	return useMemo(() => formBehaviorTextChoices(doc, formUuid), [doc, formUuid]);
}
