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
 *   [moduleUuid, "results"]         → case-results authoring
 *   [moduleUuid, "cases", caseId]   → case detail
 *   [moduleUuid, "search"]          → case-search authoring
 *   [moduleUuid, "details"]         → case-details authoring
 *   [moduleUuid, "condition"]       → module display condition
 *   [formUuid]                      → form
 *   [formUuid, "condition"]         → form display condition
 *   [formUuid, fieldUuid]        → form + selected field
 *
 * Entity disambiguation: all UUIDs are globally unique. A single-segment
 * path checks `doc.modules[uuid]` first, then `doc.forms[uuid]`, then
 * `doc.fields[uuid]` (deriving the parent form from ordering maps).
 */

import type { BlueprintDoc, Uuid } from "@/lib/doc/types";
import {
	APP_SETUP_SECTIONS,
	type AppSetupSection,
	DEFAULT_APP_SETUP_SECTION,
	type Location,
} from "@/lib/routing/types";

/** The reserved first path segment the App setup workspace owns. */
const APP_SETUP_SEGMENT = "setup";

function isAppSetupSection(value: string): value is AppSetupSection {
	return (APP_SETUP_SECTIONS as readonly string[]).includes(value);
}

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
		case "app-setup":
			return [APP_SETUP_SEGMENT, loc.section];
		case "module":
			return [loc.moduleUuid];
		case "cases":
			/* Case ids are opaque text — `/`, `%`, `:`, and spaces are all
			 * legal — so the segment is percent-encoded on write and decoded
			 * in `parsePathToLocation`, keeping the round-trip symmetric. */
			return loc.caseId !== undefined
				? [loc.moduleUuid, "cases", encodeURIComponent(loc.caseId)]
				: [loc.moduleUuid, "results"];
		case "search-config":
			return [loc.moduleUuid, "search"];
		case "detail-config":
			return [loc.moduleUuid, "details"];
		case "data-review":
			return [loc.moduleUuid, "data-review"];
		case "module-condition":
			return [loc.moduleUuid, "condition"];
		case "form-condition":
			/* Anchored on the FORM uuid, not the module's — the same flat
			 * shape a selected field uses, so the parser resolves the owner
			 * by a doc lookup rather than a positional convention. */
			return [loc.formUuid, "condition"];
		case "form-navigation":
			return [loc.formUuid, "navigation"];
		case "form":
			/* A selected field is serialized as a single UUID — the parser
			 * resolves it to its parent form via findFormForField. This
			 * keeps URLs flat: /build/{appId}/{fieldUuid} instead of
			 * /build/{appId}/{formUuid}/{fieldUuid}. */
			return loc.selectedUuid !== undefined
				? [loc.selectedUuid]
				: [loc.formUuid];
	}
}

/**
 * Decode one percent-encoded path segment. A raw `%` that is not part
 * of a valid escape (a hand-typed or pre-encoding URL) throws in
 * `decodeURIComponent`; the segment is then taken verbatim — for a
 * case id that at worst reads as a missing case, never a crash.
 */
function decodePathSegment(segment: string): string {
	try {
		return decodeURIComponent(segment);
	} catch {
		return segment;
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
 * The module a form belongs to, or `undefined` when the uuid names no
 * form in the document. Every form-anchored URL resolves its owner this
 * way rather than carrying the module in the path — one uuid in the
 * segment, one lookup here.
 */
function moduleOwningForm(
	doc: LocationParseDoc,
	formUuid: Uuid,
): Uuid | undefined {
	if (doc.forms[formUuid] === undefined) return undefined;
	for (const [moduleUuid, formUuids] of Object.entries(doc.formOrder)) {
		if (formUuids.includes(formUuid)) return moduleUuid as Uuid;
	}
	return undefined;
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
function findFormForField(
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

	/* `setup` is a reserved literal, matched BEFORE any uuid lookup: a
	 * module uuid is a branded string with no format constraint, so a
	 * doc-map lookup first would let an entity named `setup` shadow the
	 * workspace. A bare `/setup` opens the default section, and a section
	 * nobody recognizes opens it too — landing on the workspace the URL
	 * clearly asked for beats bouncing to home. */
	if (segments[0] === APP_SETUP_SEGMENT) {
		const section = segments[1];
		return {
			kind: "app-setup",
			section:
				section !== undefined && isAppSetupSection(section)
					? section
					: DEFAULT_APP_SETUP_SECTION,
		};
	}

	const first = segments[0] as Uuid;

	if (segments.length === 1) {
		/* Single segment — could be a module, form, or field UUID. */
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
			const parent = findFormForField(first, doc);
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

	if (second === "results") {
		/* /build/{id}/{moduleUuid}/results — Results authoring surface. */
		if (doc.modules[first] === undefined) return { kind: "home" };
		return { kind: "cases", moduleUuid: first };
	}

	if (second === "cases") {
		/* `/cases/{caseId}` remains the running case-record deep link.
		 * The two-segment `/cases` form is a legacy Results-authoring alias;
		 * LocationRecoveryEffect replaces it with the canonical `/results`. */
		if (doc.modules[first] === undefined) return { kind: "home" };
		if (segments.length === 2) {
			return { kind: "cases", moduleUuid: first };
		}
		/* segments.length >= 3 — the third segment is the caseId,
		 * percent-encoded by `serializePath`. */
		return {
			kind: "cases",
			moduleUuid: first,
			caseId: decodePathSegment(segments[2]),
		};
	}

	if (second === "search" || second === "search-config") {
		/* `/search` is canonical; `/search-config` remains a legacy alias.
		 * The module must exist or the path falls back to home. */
		if (doc.modules[first] === undefined) return { kind: "home" };
		return { kind: "search-config", moduleUuid: first };
	}

	if (second === "details" || second === "detail-config") {
		/* `/details` is canonical; `/detail-config` remains a legacy alias.
		 * This is the third tab of the case workspace. */
		if (doc.modules[first] === undefined) return { kind: "home" };
		return { kind: "detail-config", moduleUuid: first };
	}

	if (second === "data-review") {
		/* The data review screen — a case-workspace sibling
		 * reached from the Case data popover, the conversion toast, and
		 * teammate-shared deep links. */
		if (doc.modules[first] === undefined) return { kind: "home" };
		return { kind: "data-review", moduleUuid: first };
	}

	if (second === "condition") {
		/* One noun, two carriers: the first segment names either the module
		 * whose menu tile the condition governs or the form whose menu entry
		 * it governs, and the doc lookup decides which. */
		if (doc.modules[first] !== undefined) {
			return { kind: "module-condition", moduleUuid: first };
		}
		const moduleUuid = moduleOwningForm(doc, first);
		if (moduleUuid === undefined) return { kind: "home" };
		return { kind: "form-condition", moduleUuid, formUuid: first };
	}

	if (second === "navigation") {
		/* End-of-form navigation belongs to a form alone: a module has no
		 * submission to route from. */
		const moduleUuid = moduleOwningForm(doc, first);
		if (moduleUuid === undefined) return { kind: "home" };
		return { kind: "form-navigation", moduleUuid, formUuid: first };
	}

	/* Two-segment path: /build/{id}/{formUuid}/{fieldUuid} */
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
		case "app-setup":
			/* App administration references no blueprint entity, so there is
			 * nothing for the doc to invalidate. */
			return true;
		case "module":
			return doc.modules[loc.moduleUuid] !== undefined;
		case "cases":
			// `caseId` is free-form from the user — we can't validate it
			// against the doc. Only the module reference matters here.
			return doc.modules[loc.moduleUuid] !== undefined;
		case "search-config":
		case "detail-config":
		case "data-review":
		case "module-condition":
			// The workspace's sibling screens open against the same module
			// reference shape as `cases`; only that uuid needs to resolve.
			return doc.modules[loc.moduleUuid] !== undefined;
		case "form-condition":
		case "form-navigation":
			return (
				doc.modules[loc.moduleUuid] !== undefined &&
				doc.forms[loc.formUuid] !== undefined
			);
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
	/* App setup names no entity, so it survives every doc change. This must
	 * come before the module read below — there is no `moduleUuid` to read. */
	if (loc.kind === "app-setup") return loc;

	/* Module uuid is shared by module, cases, and form screens. If the
	 * module has been deleted, nothing below it can be recovered — the
	 * user's only safe destination is the app home. */
	if (doc.modules[loc.moduleUuid] === undefined) {
		return { kind: "home" };
	}

	if (loc.kind === "module") return loc;

	/* A module's display condition needs only its module. */
	if (loc.kind === "module-condition") return loc;

	/* A form's own configuration screens degrade to the module when the
	 * form is gone — the same inward walk the form screen does. */
	if (loc.kind === "form-condition" || loc.kind === "form-navigation") {
		return doc.forms[loc.formUuid] === undefined
			? { kind: "module", moduleUuid: loc.moduleUuid }
			: loc;
	}

	/* The case-list workspace URLs (and the data review screen, which
	 * lists per case type) require a case type — the screens render
	 * nothing without one. If the module has no case type (e.g. it was
	 * cleared, which also drops the caseListOnly viewer flag), fall back to the
	 * module screen rather than stranding the user on a blank workspace. */
	if (
		loc.kind === "cases" ||
		loc.kind === "search-config" ||
		loc.kind === "detail-config" ||
		loc.kind === "data-review"
	) {
		if (doc.modules[loc.moduleUuid]?.caseType === undefined) {
			return { kind: "module", moduleUuid: loc.moduleUuid };
		}
		return loc;
	}

	/* loc.kind === "form" — walk inward: form, then selected field. */
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
