"use client";

import { useMemo } from "react";
import { createLocalizationWorkspace } from "@/lib/doc/localizationWorkspace";
import type { LanguageTag } from "@/lib/domain";
import { useBlueprintDoc } from "./useBlueprintDoc";

/** The translation inventory spans all authored text and protected references. */
export function useLocalizationWorkspace(language: LanguageTag) {
	const doc = useBlueprintDoc((state) => state);
	return useMemo(
		() => createLocalizationWorkspace(doc, language),
		[doc, language],
	);
}
