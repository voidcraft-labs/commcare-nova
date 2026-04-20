/**
 * useParent — reverse-parent lookup from the fieldParent index.
 *
 * The `fieldParent` map is a derived (non-persisted) reverse index rebuilt
 * after every structural mutation (add / remove / move). It maps each field
 * uuid to the uuid of its parent container (a form or group/repeat field).
 *
 * Returns null when:
 *   - the field is at the top level of a form (parent IS the form uuid, but
 *     forms are not fields — callers that need the containing form should use
 *     `useForm` with the parent result)
 *   - the field does not exist in the doc (orphan guard)
 *
 * Reads a single key from `fieldParent` so this re-renders only when that
 * specific field's parent changes, not on every structural mutation.
 */

"use client";

import type { Uuid } from "@/lib/doc/types";
import { useBlueprintDoc } from "./useBlueprintDoc";

/** Returns the parent uuid of `fieldUuid` (form or container), or null. */
export function useParent(fieldUuid: Uuid): Uuid | null {
	return useBlueprintDoc((s) => s.fieldParent[fieldUuid] ?? null);
}
