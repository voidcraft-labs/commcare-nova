/**
 * useDocRevision — a value that changes on every committed document state.
 *
 * For work that must run again whenever anything in the app changes, such as
 * a Preview screen the running app refused: any edit can be the one that
 * fixes it. Compare it by identity; never read the document through it.
 */

"use client";

import { useBlueprintDoc } from "./useBlueprintDoc";

export function useDocRevision(): unknown {
	return useBlueprintDoc((state) => state);
}
