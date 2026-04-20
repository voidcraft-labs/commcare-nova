/**
 * Named hook — return the module + form order arrays together as a
 * shallow-stable pair.
 *
 * Tree renderers, keyboard navigation, and structural sanity checks
 * need both sequences in sync. An inline selector returning
 * `{ moduleOrder: s.moduleOrder, formOrder: s.formOrder }` allocates a
 * new object each store tick — the default `Object.is` comparison fails
 * and the caller re-renders on every unrelated edit. Using
 * `useBlueprintDocShallow` skips the re-render when both slices are
 * reference-equal, which Immer guarantees whenever no mutation touched
 * either order.
 *
 * Consumers should NOT wrap the return value in `useMemo` — it is
 * already reference-stable courtesy of shallow equality + Immer
 * structural sharing.
 */

"use client";

import type { Uuid } from "@/lib/doc/types";
import { useBlueprintDocShallow } from "./useBlueprintDoc";

/** Shape of `useAppStructure()` output — the two top-level order arrays. */
export interface AppStructure {
	moduleOrder: readonly Uuid[];
	formOrder: Readonly<Record<Uuid, readonly Uuid[]>>;
}

export function useAppStructure(): AppStructure {
	return useBlueprintDocShallow((s) => ({
		moduleOrder: s.moduleOrder,
		formOrder: s.formOrder,
	}));
}
