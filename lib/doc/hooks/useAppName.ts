/**
 * Named hook — subscribe to the app's display name.
 *
 * Selects a string primitive, so the default `Object.is` comparison
 * inside `useBlueprintDoc` is sufficient (no shallow wrapper needed).
 * Re-renders only when `appName` itself changes reference — `setAppName`
 * is the only mutation that touches it, so consumers stay quiet for
 * every unrelated edit.
 */

import { useBlueprintDoc } from "./useBlueprintDoc";

export function useAppName(): string {
	return useBlueprintDoc((s) => s.appName);
}
