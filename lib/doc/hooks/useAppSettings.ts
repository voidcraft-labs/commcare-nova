/**
 * Named hook — subscribe to the app's settings (`BlueprintDoc.appSettings`).
 *
 * Selects the settings object itself. The reducer replaces it only when
 * `setAppSettings` changes a key, so the default `Object.is` comparison inside
 * `useBlueprintDoc` keeps consumers quiet for every unrelated edit.
 */

"use client";

import type { AppSettings } from "@/lib/domain";
import { useBlueprintDoc } from "./useBlueprintDoc";

export function useAppSettings(): AppSettings {
	return useBlueprintDoc((s) => s.appSettings);
}
