/**
 * Named hook — the first (order-zero) form under a given module.
 *
 * Used by module-card "open default form" UI and short-cut navigation
 * that want the module's lead form without enumerating every form. The
 * selector returns `s.forms[s.formOrder[moduleUuid]?.[0]]` in one
 * subscription step so the caller doesn't allocate intermediate arrays.
 *
 * Accepts `Uuid | undefined` so call sites that derive the module uuid
 * from an optional URL selection don't need to guard the hook call.
 * Returns `undefined` when the module has no forms or the uuid is
 * missing / unknown.
 *
 * Re-renders only when the lead form's entity reference changes (Immer
 * structural sharing) or when `formOrder[moduleUuid][0]` points at a
 * different uuid. Appending / rearranging forms beyond position 0 does
 * not trigger a re-render.
 */

"use client";

import type { Uuid } from "@/lib/doc/types";
import type { Form } from "@/lib/domain";
import { useBlueprintDoc } from "./useBlueprintDoc";

export function useFirstFormForModule(
	moduleUuid: Uuid | undefined,
): Form | undefined {
	return useBlueprintDoc((s) => {
		if (!moduleUuid) return undefined;
		const firstUuid = s.formOrder[moduleUuid]?.[0];
		return firstUuid ? s.forms[firstUuid] : undefined;
	});
}
