"use client";
import { useCallback } from "react";
import type { BlueprintDocState } from "@/lib/doc/store";
import type { LanguageTag, Uuid } from "@/lib/domain";
import { resolveAppLanguage } from "@/lib/domain";
import { projectWorkerModule } from "@/lib/preview/workerModule";
import { useBlueprintDocEq } from "./useBlueprintDoc";

/** Two projections of one module hold the same worker module. */
function sameWorkerModule(a: unknown, b: unknown): boolean {
	return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The module as the worker reads it in a language. The projection is a new
 * object each time it runs, so the selector keeps one identity for a module
 * and a language: the store's selector cache then hands every render of one
 * document the same projection, a render React repeats before it commits
 * included, and a screen that adjusts its own state during render to what
 * the module holds sees it change only when the module does.
 */
export function useWorkerModule(language: LanguageTag, uuid: Uuid | undefined) {
	const select = useCallback(
		(doc: BlueprintDocState) =>
			uuid === undefined
				? undefined
				: projectWorkerModule(
						doc,
						resolveAppLanguage(doc.localization, language),
						uuid,
					),
		[language, uuid],
	);
	return useBlueprintDocEq(select, sameWorkerModule);
}
