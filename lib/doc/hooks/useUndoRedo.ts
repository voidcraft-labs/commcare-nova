/**
 * Reactive undo/redo availability. Components toggle toolbar disabled states
 * off these two booleans.
 */

"use client";

import { useBlueprintDoc } from "./useBlueprintDoc";

/** `true` when there is a step the author can take back. */
export function useCanUndo(): boolean {
	return useBlueprintDoc((s) => s.canUndo);
}

/** `true` when a taken-back step can be reapplied. */
export function useCanRedo(): boolean {
	return useBlueprintDoc((s) => s.canRedo);
}
