"use client";
import type { LanguageTag, Uuid } from "@/lib/domain";
import { resolveAppLanguage } from "@/lib/domain";
import { projectWorkerModule } from "@/lib/preview/workerModule";
import { useBlueprintDocEq } from "./useBlueprintDoc";

export function useWorkerModule(language: LanguageTag, uuid: Uuid | undefined) {
	return useBlueprintDocEq(
		(doc) =>
			uuid === undefined
				? undefined
				: projectWorkerModule(
						doc,
						resolveAppLanguage(doc.localization, language),
						uuid,
					),
		(a, b) => a === b || JSON.stringify(a) === JSON.stringify(b),
	);
}
