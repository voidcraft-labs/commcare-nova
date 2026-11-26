/**
 * Named hook — subscribe to the app's settings (`BlueprintDoc.appSettings`).
 *
 * Selects the settings object itself. The reducer replaces it only when
 * `setAppSettings` changes a key, so the default `Object.is` comparison inside
 * `useBlueprintDoc` keeps consumers quiet for every unrelated edit.
 */

"use client";

import type { AppSettings } from "@/lib/domain";
import { projectSearchDependencies } from "@/lib/domain/projectSearches";
import { useBlueprintDoc } from "./useBlueprintDoc";

export function useAppSettings(): AppSettings {
	return useBlueprintDoc((s) => s.appSettings);
}

/** Opening the publish dialog requires a specific destination when a menu
 * sends searches to that project space. */
export function useNeedsProjectSearchDestination(): boolean {
	return useBlueprintDoc((doc) => projectSearchDependencies(doc).size > 0);
}
