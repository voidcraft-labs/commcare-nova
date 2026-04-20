/**
 * Named hook — boolean "does this form have at least one question?".
 *
 * Replaces inline selectors like
 * `useBlueprintDoc((s) => (s.fieldOrder[uuid]?.length ?? 0) > 0)` used
 * by form cards to toggle the empty-state placeholder. Selector returns
 * a boolean primitive, so the default `Object.is` comparison suffices —
 * the caller re-renders only when the "has/doesn't have" answer flips,
 * not on every field edit inside the form.
 *
 * Accepts `Uuid | undefined` so call sites deriving the form uuid from
 * an optional URL selection don't need to guard the hook call. Returns
 * `false` when the uuid is missing or unknown.
 */

import type { Uuid } from "@/lib/doc/types";
import { useBlueprintDoc } from "./useBlueprintDoc";

export function useHasFieldsInForm(formUuid: Uuid | undefined): boolean {
	return useBlueprintDoc((s) =>
		formUuid ? (s.fieldOrder[formUuid]?.length ?? 0) > 0 : false,
	);
}
