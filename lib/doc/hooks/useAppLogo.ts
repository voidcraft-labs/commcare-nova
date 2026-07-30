/**
 * Named hook — subscribe to the app-level logo asset id.
 *
 * The doc's `logo` slot is the strict branded `mediaAssetIdSchema`, so this hook
 * preserves that identity at the component boundary. Selecting a string primitive
 * means the default `Object.is` comparison inside `useBlueprintDoc` is
 * sufficient — no shallow wrapper. `setAppLogo` is the only mutation that
 * touches `logo`, so consumers stay quiet for every unrelated edit.
 */

"use client";

import type { MediaAssetId } from "@/lib/domain/multimedia";
import { useBlueprintDoc } from "./useBlueprintDoc";

export function useAppLogo(): MediaAssetId | undefined {
	return useBlueprintDoc((s) => s.logo);
}
