/**
 * Named hook — subscribe to the app-level logo asset id.
 *
 * The doc's `logo` slot is `assetIdSchema.optional()`, which infers as a
 * bare `string | undefined` (the `AssetId` brand is compile-time only and
 * not re-applied by the Zod inference), so this hook returns the same
 * shape `SingleAssetSlot.value` consumes. Selecting a string primitive
 * means the default `Object.is` comparison inside `useBlueprintDoc` is
 * sufficient — no shallow wrapper. `setAppLogo` is the only mutation that
 * touches `logo`, so consumers stay quiet for every unrelated edit.
 */

"use client";

import { useBlueprintDoc } from "./useBlueprintDoc";

export function useAppLogo(): string | undefined {
	return useBlueprintDoc((s) => s.logo);
}
