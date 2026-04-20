/**
 * Named hook — subscribe to the app's display name.
 *
 * Replaces inline `useBlueprintDoc((s) => s.appName)` call sites (header
 * title, breadcrumb, save-indicator label, HQ upload dialog). Re-renders
 * only when `appName` changes reference — `setAppName` is the only
 * mutation that touches it, so components using this hook stay quiet for
 * every unrelated edit.
 *
 * No shallow wrapper needed: `appName` is a string primitive, so the
 * default `Object.is` comparison inside `useBlueprintDoc` is sufficient.
 */

import { useBlueprintDoc } from "./useBlueprintDoc";

export function useAppName(): string {
	return useBlueprintDoc((s) => s.appName);
}
