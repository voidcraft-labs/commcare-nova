/**
 * The child case types a Details tab of a `caseType` menu can read, sorted: the
 * ones a form of a menu of that case type adds, which the gate admits and
 * CommCare HQ's Case Detail page keeps (`commitVerdicts.ts::detailTabChildTypeChoices`).
 * The selector answers one string, so an unchanged answer keeps its identity.
 */

"use client";

import { useMemo } from "react";
import { detailTabChildTypeChoices } from "../commitVerdicts";
import { useBlueprintDoc } from "./useBlueprintDoc";

export function useDetailTabChildTypes(
	caseType: string | undefined,
): readonly string[] {
	const text = useBlueprintDoc((s) => detailTabChildTypeChoices(s, caseType));
	return useMemo(() => (text === "" ? [] : text.split("\n")), [text]);
}
