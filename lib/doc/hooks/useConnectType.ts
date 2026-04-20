/**
 * Named hooks — subscribe to the app-level `connectType` flag.
 *
 * Two call-site shapes exist across the builder UI and both are exposed
 * here so every consumer gets a named hook rather than an inline
 * selector:
 *
 * - `useConnectType()` returns `ConnectType | null` — matches the raw
 *   doc field shape (null means "no connect type chosen"). Consumers
 *   that render conditional UI for the "not connected" branch use this.
 * - `useConnectTypeOrUndefined()` coerces null → undefined at the hook
 *   boundary. Useful for consumers that pass the value into form-state
 *   wrappers, hooks expecting an optional generic (`T | undefined`),
 *   or `??` fallbacks — `undefined` triggers default-value semantics
 *   that `null` does not.
 *
 * Both hooks select a primitive (string | null or string | undefined)
 * so the default `Object.is` comparison inside `useBlueprintDoc` is
 * sufficient — no shallow wrapper needed.
 */

import type { ConnectType } from "@/lib/domain";
import { useBlueprintDoc } from "./useBlueprintDoc";

/** The raw doc-field shape: string when set, `null` when unset. */
export function useConnectType(): ConnectType | null {
	return useBlueprintDoc((s) => s.connectType);
}

/**
 * null → undefined coercion at the hook boundary.
 *
 * The doc stores `null` for "no connect type chosen", but several call
 * sites want `undefined` instead (for `??` defaults, optional form
 * wrappers, etc.). Centralizing the coercion here means callers never
 * write `useBlueprintDoc((s) => s.connectType ?? undefined)` inline.
 */
export function useConnectTypeOrUndefined(): ConnectType | undefined {
	return useBlueprintDoc((s) => s.connectType ?? undefined);
}
