/**
 * Named hook — `true` when the given parent uuid (form, group, or
 * repeat) has at least one direct child field. The "InForm" name is
 * historical; the hook reads `fieldOrder[parentUuid]` and works
 * identically for any container, not just forms. Used by form cards
 * and group/repeat shells to toggle the empty-state placeholder.
 *
 * Selector returns a boolean primitive, so the default `Object.is`
 * comparison suffices — the caller re-renders only when the
 * "has/doesn't have" answer flips, not on every field edit inside the
 * container.
 *
 * Accepts `Uuid | undefined` so call sites deriving the parent uuid
 * from an optional URL selection don't need to guard the hook call.
 * Returns `false` when the uuid is missing or unknown.
 */

"use client";

import type { Uuid } from "@/lib/doc/types";
import { useBlueprintDoc } from "./useBlueprintDoc";

export function useHasFieldsInForm(parentUuid: Uuid | undefined): boolean {
	return useBlueprintDoc((s) =>
		parentUuid ? (s.fieldOrder[parentUuid]?.length ?? 0) > 0 : false,
	);
}
