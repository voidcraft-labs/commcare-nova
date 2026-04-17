/**
 * Builder URL location — path serializer, parser, validator, and recovery.
 *
 * Pure functions only. No React, no browser APIs. Every function is
 * deterministic and free of side effects so it can be unit tested without
 * a DOM or router.
 *
 * URL layout (path segments after /build/{appId}/):
 *
 *   []                              → home
 *   [moduleUuid]                    → module
 *   [moduleUuid, "cases"]           → case list
 *   [moduleUuid, "cases", caseId]   → case detail
 *   [formUuid]                      → form
 *   [formUuid, questionUuid]        → form + selected question
 *
 * Entity disambiguation: all UUIDs are globally unique. A single-segment
 * path checks `doc.modules[uuid]` first, then `doc.forms[uuid]`, then
 * `doc.fields[uuid]` (deriving the parent form from ordering maps).
 */

import type { BlueprintDoc, Uuid } from "@/lib/doc/types";
import type { Location } from "@/lib/routing/types";

/**
 * Minimal doc subset for validation and recovery — only needs entity
 * existence checks (no ordering). Used by `isValidLocation` and
 * `recoverLocation`.
 */
export type LocationDoc = Pick<BlueprintDoc, "modules" | "forms" | "fields">;

/**
 * Extended doc subset for path parsing — includes ordering maps needed
 * to disambiguate UUIDs and derive parent relationships.
 *
 * `formOrder` maps module UUIDs to their form UUID arrays.
 * `fieldOrder` maps form/group UUIDs to their child field UUID arrays.
 */
export type LocationParseDoc = LocationDoc &
	Pick<BlueprintDoc, "formOrder" | "fieldOrder">;

/**
 * Convert a `Location` into path segments after `/build/{appId}/`.
 *
 * For `home`, we return an empty array — the builder route itself
 * (no extra path segments) encodes home.
 */
export function serializePath(loc: Location): string[] {
	switch (loc.kind) {
		case "home":
			return [];
		case "module":
			return [loc.moduleUuid];
		case "cases":
			return loc.caseId !== undefined
				? [loc.moduleUuid, "cases", loc.caseId]
				: [loc.moduleUuid, "cases"];
		case "form":
			/* A selected question is serialized as a single UUID — the parser
			 * resolves it to its parent form via findFormForQuestion. This
			 * keeps URLs flat: /build/{appId}/{questionUuid} instead of
			 * /build/{appId}/{formUuid}/{questionUuid}. */
			return loc.selectedUuid !== undefined
				? [loc.selectedUuid]
				: [loc.formUuid];
	}
}

/**
 * Build a full URL path from a base path and a Location.
 *
 * Centralizes the `basePath + segments.join("/")` pattern used by every
 * navigation call site. `basePath` is `/build/{appId}` (no trailing slash).
 */
export function buildUrl(basePath: string, loc: Location): string {
	const segments = serializePath(loc);
	return segments.length > 0 ? `${basePath}/${segments.join("/")}` : basePath;
}

/**
 * Find the parent form and module UUIDs for a field UUID by walking
 * the doc's ordering maps.
 *
 * `fieldOrder` keys are either form UUIDs (top-level fields) or
 * group/repeat field UUIDs (nested children). A field might be nested
 * arbitrarily deep inside groups, so we walk upward: find which parent
 * contains the UUID, then check whether that parent is itself a field
 * (group/repeat) and recurse, or whether it's a form.
 */
function findFormForQuestion(
	uuid: Uuid,
	doc: LocationParseDoc,
): { formUuid: Uuid; moduleUuid: Uuid } | undefined {
	/* Walk upward from the field to find the owning form. The parent
	 * could be a form UUID or a group field UUID. */
	let currentUuid = uuid;
	const maxDepth = 20; // guard against malformed data

	for (let depth = 0; depth < maxDepth; depth++) {
		/* Find which parent's children list contains currentUuid. */
		let parentUuid: Uuid | undefined;
		for (const [key, children] of Object.entries(doc.fieldOrder)) {
			if (children.includes(currentUuid)) {
				parentUuid = key as Uuid;
				break;
			}
		}

		if (parentUuid === undefined) return undefined;

		/* If the parent is a form, we've found it. */
		if (doc.forms[parentUuid] !== undefined) {
			/* Now find which module owns this form. */
			for (const [moduleUuid, formUuids] of Object.entries(doc.formOrder)) {
				if (formUuids.includes(parentUuid)) {
					return { formUuid: parentUuid, moduleUuid: moduleUuid as Uuid };
				}
			}
			return undefined;
		}

		/* The parent is a group/repeat field — continue walking up. */
		if (doc.fields[parentUuid] !== undefined) {
			currentUuid = parentUuid;
			continue;
		}

		/* Parent is neither a form nor a field — malformed data. */
		return undefined;
	}

	return undefined;
}

/**
 * Parse path segments (after `/build/{appId}/`) into a `Location` using
 * the current doc state for entity disambiguation.
 *
 * Always returns a valid Location — unrecognized or unresolvable segments
 * collapse to `{ kind: "home" }`.
 */
export function parsePathToLocation(
	segments: string[],
	doc: LocationParseDoc,
): Location {
	if (segments.length === 0) return { kind: "home" };

	const first = segments[0] as Uuid;

	if (segments.length === 1) {
		/* Single segment — could be a module, form, or question UUID. */
		if (doc.modules[first] !== undefined) {
			return { kind: "module", moduleUuid: first };
		}
		if (doc.forms[first] !== undefined) {
			/* Derive the module UUID from the doc's formOrder. */
			for (const [moduleUuid, formUuids] of Object.entries(doc.formOrder)) {
				if (formUuids.includes(first)) {
					return {
						kind: "form",
						moduleUuid: moduleUuid as Uuid,
						formUuid: first,
					};
				}
			}
			/* Form exists but isn't in any module's formOrder — shouldn't
			 * happen, but degrade gracefully. */
			return { kind: "home" };
		}
		if (doc.fields[first] !== undefined) {
			/* Field UUID as the first (and only) segment — derive the
			 * parent form and return form + selection. */
			const parent = findFormForQuestion(first, doc);
			if (parent) {
				return {
					kind: "form",
					moduleUuid: parent.moduleUuid,
					formUuid: parent.formUuid,
					selectedUuid: first,
				};
			}
		}
		return { kind: "home" };
	}

	const second = segments[1];

	if (second === "cases") {
		/* /build/{id}/{moduleUuid}/cases or /build/{id}/{moduleUuid}/cases/{caseId} */
		if (doc.modules[first] === undefined) return { kind: "home" };
		if (segments.length === 2) {
			return { kind: "cases", moduleUuid: first };
		}
		/* segments.length >= 3 — the third segment is the caseId. */
		return { kind: "cases", moduleUuid: first, caseId: segments[2] };
	}

	/* Two-segment path: /build/{id}/{formUuid}/{questionUuid} */
	const secondUuid = second as Uuid;

	if (doc.forms[first] !== undefined) {
		/* Derive module UUID for the form. */
		let moduleUuid: Uuid | undefined;
		for (const [mUuid, formUuids] of Object.entries(doc.formOrder)) {
			if (formUuids.includes(first)) {
				moduleUuid = mUuid as Uuid;
				break;
			}
		}
		if (moduleUuid === undefined) return { kind: "home" };

		if (doc.fields[secondUuid] !== undefined) {
			return {
				kind: "form",
				moduleUuid,
				formUuid: first,
				selectedUuid: secondUuid,
			};
		}
		/* Second segment doesn't resolve to a field — show the form
		 * without selection rather than degrading to home. */
		return { kind: "form", moduleUuid, formUuid: first };
	}

	return { kind: "home" };
}

/**
 * Check that every UUID referenced by the location exists in the current
 * doc. Returns `true` for `home` regardless of doc state.
 */
export function isValidLocation(loc: Location, doc: LocationDoc): boolean {
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
				doc.fields[loc.selectedUuid] === undefined
			) {
				return false;
			}
			return true;
		}
	}
}

/**
 * Reduce an invalid `Location` to the closest valid ancestor given the
 * current doc. Pure function — no hooks, no React — so it can run on
 * both the server (RSC page handler) and the client (recovery effect).
 *
 * Recovery policy (inside-out, most-specific → least-specific):
 * - Home: always valid, returned as-is.
 * - Module / cases with missing module → home.
 * - Form with missing form → parent module screen.
 * - Form with missing `selectedUuid` → same form, selection dropped.
 * - If every reference resolves, the original location is returned by
 *   identity (referential equality preserved so callers can `===` check
 *   to skip the no-op case cheaply).
 */
export function recoverLocation(loc: Location, doc: LocationDoc): Location {
	if (loc.kind === "home") return loc;

	/* Module uuid is shared by module, cases, and form screens. If the
	 * module has been deleted, nothing below it can be recovered — the
	 * user's only safe destination is the app home. */
	if (doc.modules[loc.moduleUuid] === undefined) {
		return { kind: "home" };
	}

	if (loc.kind === "module") return loc;
	if (loc.kind === "cases") return loc;

	/* loc.kind === "form" — walk inward: form, then selected question. */
	if (doc.forms[loc.formUuid] === undefined) {
		return { kind: "module", moduleUuid: loc.moduleUuid };
	}

	if (
		loc.selectedUuid !== undefined &&
		doc.fields[loc.selectedUuid] === undefined
	) {
		return {
			kind: "form",
			moduleUuid: loc.moduleUuid,
			formUuid: loc.formUuid,
		};
	}

	return loc;
}
