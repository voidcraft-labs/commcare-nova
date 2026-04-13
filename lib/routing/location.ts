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

import type { BlueprintDoc, Uuid } from "@/lib/doc/types";
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

/**
 * Parse `URLSearchParams` into a `Location`. Always returns a valid Location
 * — malformed or missing required params collapse to `{ kind: "home" }`.
 *
 * This "degrade to home" behavior is intentional: a user landing on a
 * malformed URL (deleted entity, stale bookmark) sees the app's home screen
 * rather than a broken state. Phase 2 adds a separate `isValidLocation`
 * pass against the live doc to additionally strip references to UUIDs that
 * used to exist but no longer do.
 *
 * Accepts either a standard `URLSearchParams` or Next.js's
 * `ReadonlyURLSearchParams` (structurally compatible — same read-only API).
 */
export function parseLocation(
	searchParams: Pick<URLSearchParams, "get">,
): Location {
	const screen = searchParams.get(LOCATION_PARAM.screen);
	const moduleUuidRaw = searchParams.get(LOCATION_PARAM.module);

	switch (screen) {
		case SCREEN_KIND.module: {
			if (!moduleUuidRaw) return { kind: "home" };
			return {
				kind: "module",
				moduleUuid: moduleUuidRaw as Uuid,
			};
		}
		case SCREEN_KIND.cases: {
			if (!moduleUuidRaw) return { kind: "home" };
			const caseId = searchParams.get(LOCATION_PARAM.caseId);
			return caseId === null
				? { kind: "cases", moduleUuid: moduleUuidRaw as Uuid }
				: {
						kind: "cases",
						moduleUuid: moduleUuidRaw as Uuid,
						caseId,
					};
		}
		case SCREEN_KIND.form: {
			const formUuidRaw = searchParams.get(LOCATION_PARAM.form);
			if (!moduleUuidRaw || !formUuidRaw) return { kind: "home" };
			const selectedRaw = searchParams.get(LOCATION_PARAM.selected);
			return selectedRaw === null
				? {
						kind: "form",
						moduleUuid: moduleUuidRaw as Uuid,
						formUuid: formUuidRaw as Uuid,
					}
				: {
						kind: "form",
						moduleUuid: moduleUuidRaw as Uuid,
						formUuid: formUuidRaw as Uuid,
						selectedUuid: selectedRaw as Uuid,
					};
		}
		default:
			return { kind: "home" };
	}
}

/**
 * Check that every UUID referenced by the location exists in the current
 * doc. Returns `true` for `home` regardless of doc state.
 *
 * Phase 2 uses this on every URL change: if the result is `false`, a root
 * effect calls `router.replace()` with the location stripped of dangling
 * references (usually falling back to home). This keeps selection-after-
 * deletion and stale-bookmark scenarios from ever rendering a broken UI.
 */
export function isValidLocation(loc: Location, doc: BlueprintDoc): boolean {
	switch (loc.kind) {
		case "home":
			return true;
		case "module":
			return doc.modules[loc.moduleUuid] !== undefined;
		case "cases":
			// `caseId` is free-form from the user — we can't validate it
			// against the doc. Only the module reference matters here.
			return doc.modules[loc.moduleUuid] !== undefined;
		case "form": {
			if (doc.modules[loc.moduleUuid] === undefined) return false;
			if (doc.forms[loc.formUuid] === undefined) return false;
			if (
				loc.selectedUuid !== undefined &&
				doc.questions[loc.selectedUuid] === undefined
			) {
				return false;
			}
			return true;
		}
	}
}
