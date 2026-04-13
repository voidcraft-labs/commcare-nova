/**
 * Builder state re-architecture — URL location parser/serializer/validator.
 *
 * Pure functions only. No React, no browser APIs beyond the standard
 * `URLSearchParams` class (which is available in Node and browsers). Every
 * function is deterministic and free of side effects so it can be unit
 * tested without a DOM or router.
 *
 * Phase 2 wires these into `useLocation`, `useNavigate`, and `useSelect`
 * hooks that subscribe to Next.js's `useSearchParams` and call
 * `router.push`/`router.replace`.
 */

import type { Uuid } from "@/lib/doc/types";
import {
	LOCATION_PARAM,
	type Location,
	SCREEN_KIND,
} from "@/lib/routing/types";

/**
 * Convert a `Location` into `URLSearchParams`. The returned params are in
 * insertion order; callers that care about a stable serialization should
 * pass the result through `toString()` of a `new URLSearchParams([...pairs])`
 * if they need a specific order.
 *
 * For `home`, we return empty params — the builder route itself (no query
 * string) encodes home.
 */
export function serializeLocation(loc: Location): URLSearchParams {
	const params = new URLSearchParams();
	switch (loc.kind) {
		case "home":
			// No query params. Defaults to home on the client.
			return params;
		case "module":
			params.set(LOCATION_PARAM.screen, SCREEN_KIND.module);
			params.set(LOCATION_PARAM.module, loc.moduleUuid);
			return params;
		case "cases":
			params.set(LOCATION_PARAM.screen, SCREEN_KIND.cases);
			params.set(LOCATION_PARAM.module, loc.moduleUuid);
			if (loc.caseId !== undefined) {
				params.set(LOCATION_PARAM.caseId, loc.caseId);
			}
			return params;
		case "form":
			params.set(LOCATION_PARAM.screen, SCREEN_KIND.form);
			params.set(LOCATION_PARAM.module, loc.moduleUuid);
			params.set(LOCATION_PARAM.form, loc.formUuid);
			if (loc.selectedUuid !== undefined) {
				params.set(LOCATION_PARAM.selected, loc.selectedUuid);
			}
			return params;
	}
}
