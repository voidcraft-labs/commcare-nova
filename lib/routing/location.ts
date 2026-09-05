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
 *   ["project-data"]                → Project data workspace
 *   ["project-data", tableId]       → one Project data table
 *   [moduleUuid]                    → module
 *   [moduleUuid, "results"]         → case-results authoring
 *   [moduleUuid, "cases", caseId]   → case detail
 *   [moduleUuid, "search"]          → case-search authoring
 *   [moduleUuid, "details"]         → case-details authoring
 *   [moduleUuid, "condition"]       → module display condition
 *   [formUuid]                      → form
 *   [formUuid, "condition"]         → form display condition
 *   [formUuid, "operations"]        → form case operations
 *   [formUuid, "operations", opUuid] → …with one selected
 *   [formUuid, "links"]             → form after-submit links
 *   [formUuid, "links", linkUuid]   → …with one selected
 *   [formUuid, fieldUuid]        → form + selected field
 *
 * Entity disambiguation: all UUIDs are globally unique. A single-segment
 * path checks `doc.modules[uuid]` first, then `doc.forms[uuid]`, then
 * `doc.fields[uuid]` (deriving the parent form from ordering maps).
 */

import type { BlueprintDoc, Uuid } from "@/lib/doc/types";
import { uuidSchema } from "@/lib/domain";
import { lookupTableIdSchema } from "@/lib/domain/lookupIds";
import {
	APP_SETUP_SECTIONS,
	type AppSetupSection,
	DEFAULT_APP_SETUP_SECTION,
	type Location,
} from "@/lib/routing/types";

/** The two reserved first path segments, each owned by a configuration
 *  workspace and each matched before any uuid lookup. */
const APP_SETUP_SEGMENT = "setup";
const PROJECT_DATA_SEGMENT = "project-data";

/**
 * Retired two-segment authoring URLs. They intentionally neither parse nor
 * redirect: old bookmarks stop resolving under the direct cutover, while
 * `cases/{caseId}` remains the distinct record deep link.
 */
export function isRetiredAuthoringPath(segments: readonly string[]): boolean {
	return (
		segments.length === 2 &&
		(segments[1] === "cases" ||
			segments[1] === "search-config" ||
			segments[1] === "detail-config")
	);
}

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
			return loc.section === "deep-links" && loc.entryPointUuid
				? [APP_SETUP_SEGMENT, loc.section, loc.entryPointUuid]
				: [APP_SETUP_SEGMENT, loc.section];
		case "project-data":
			return loc.tableId !== undefined
				? [PROJECT_DATA_SEGMENT, loc.tableId]
				: [PROJECT_DATA_SEGMENT];
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
		case "form-operations":
			return loc.operationUuid !== undefined
				? [loc.formUuid, "operations", loc.operationUuid]
				: [loc.formUuid, "operations"];
		case "form-links":
			return loc.linkUuid !== undefined
				? [loc.formUuid, "links", loc.linkUuid]
				: [loc.formUuid, "links"];
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
				const parsed = uuidSchema.safeParse(key);
				if (!parsed.success) return undefined;
				parentUuid = parsed.data;
				break;
			}
		}

		if (parentUuid === undefined) return undefined;

		/* If the parent is a form, we've found it. */
		if (doc.forms[parentUuid] !== undefined) {
			/* Now find which module owns this form. */
			for (const [moduleUuid, formUuids] of Object.entries(doc.formOrder)) {
				if (formUuids.includes(parentUuid)) {
					const parsed = uuidSchema.safeParse(moduleUuid);
					return parsed.success
						? { formUuid: parentUuid, moduleUuid: parsed.data }
						: undefined;
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

	/* Both workspace segments are reserved literals, matched BEFORE any uuid
	 * lookup: a doc-map lookup first would otherwise give a malformed imported
	 * record a chance to shadow a whole workspace. Each also prefers its own
	 * landing screen over home when the rest of the path is unrecognized —
	 * landing on the workspace the URL clearly asked for beats discarding the
	 * whole destination. */
	if (segments[0] === APP_SETUP_SEGMENT) {
		const section = segments[1];
		const entryPoint = uuidSchema.safeParse(segments[2]);
		return {
			kind: "app-setup",
			...(section === "deep-links" && entryPoint.success
				? { entryPointUuid: entryPoint.data }
				: {}),
			section:
				section !== undefined && isAppSetupSection(section)
					? section
					: DEFAULT_APP_SETUP_SECTION,
		};
	}
	if (segments[0] === PROJECT_DATA_SEGMENT) {
		const parsedTableId = lookupTableIdSchema.safeParse(segments[1]);
		return parsedTableId.success
			? { kind: "project-data", tableId: parsedTableId.data }
			: { kind: "project-data" };
	}

	const parsedFirst = uuidSchema.safeParse(segments[0]);
	if (!parsedFirst.success) return { kind: "home" };
	const first = parsedFirst.data;

	if (segments.length === 1) {
		/* Single segment — could be a module, form, or field UUID. */
		if (doc.modules[first] !== undefined) {
			return { kind: "module", moduleUuid: first };
		}
		if (doc.forms[first] !== undefined) {
			/* Derive the module UUID from the doc's formOrder. */
			for (const [moduleUuid, formUuids] of Object.entries(doc.formOrder)) {
				if (formUuids.includes(first)) {
					const parsedModule = uuidSchema.safeParse(moduleUuid);
					if (!parsedModule.success) return { kind: "home" };
					return {
						kind: "form",
						moduleUuid: parsedModule.data,
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
		/* `/cases/{caseId}` remains the running case-record deep link. The
		 * retired two-segment `/cases` authoring token does not parse. */
		if (doc.modules[first] === undefined) return { kind: "home" };
		if (segments.length !== 3) return { kind: "home" };
		/* The third segment is the caseId,
		 * percent-encoded by `serializePath`. */
		return {
			kind: "cases",
			moduleUuid: first,
			caseId: decodePathSegment(segments[2]),
		};
	}

	if (second === "search") {
		/* The module must exist or the path falls back to home. */
		if (doc.modules[first] === undefined) return { kind: "home" };
		return { kind: "search-config", moduleUuid: first };
	}

	if (second === "details") {
		/* This is the third tab of the case workspace. */
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

	if (second === "operations") {
		/* The one form-owned configuration URL that carries a selection, so
		 * a third segment names the operation. An unresolvable one degrades
		 * to the list rather than home — the operation may simply have been
		 * removed by a peer. */
		if (doc.forms[first] === undefined) return { kind: "home" };
		for (const [moduleUuid, formUuids] of Object.entries(doc.formOrder)) {
			if (!formUuids.includes(first)) continue;
			const parsedModule = uuidSchema.safeParse(moduleUuid);
			if (!parsedModule.success) return { kind: "home" };
			const operationSegment = segments[2];
			const operationUuid =
				operationSegment === undefined
					? undefined
					: uuidSchema.safeParse(operationSegment);
			return {
				kind: "form-operations",
				moduleUuid: parsedModule.data,
				formUuid: first,
				...(operationUuid?.success && { operationUuid: operationUuid.data }),
			};
		}
		return { kind: "home" };
	}

	if (second === "links") {
		/* The form's after-submit links: the same selection-carrying shape as
		 * `operations`, for the same reason (a link has to be sendable). A
		 * third segment that no longer names a link degrades to the list. */
		if (doc.forms[first] === undefined) return { kind: "home" };
		for (const [moduleUuid, formUuids] of Object.entries(doc.formOrder)) {
			if (!formUuids.includes(first)) continue;
			const parsedModule = uuidSchema.safeParse(moduleUuid);
			if (!parsedModule.success) return { kind: "home" };
			const linkSegment = segments[2];
			const linkUuid =
				linkSegment === undefined
					? undefined
					: uuidSchema.safeParse(linkSegment);
			return {
				kind: "form-links",
				moduleUuid: parsedModule.data,
				formUuid: first,
				...(linkUuid?.success && { linkUuid: linkUuid.data }),
			};
		}
		return { kind: "home" };
	}

	if (second === "condition") {
		/* One noun, two carriers: the first segment names either the module
		 * whose menu tile the condition governs or the form whose menu entry
		 * it governs, and the doc lookup decides which. */
		if (doc.modules[first] !== undefined) {
			return { kind: "module-condition", moduleUuid: first };
		}
		if (doc.forms[first] !== undefined) {
			for (const [moduleUuid, formUuids] of Object.entries(doc.formOrder)) {
				if (formUuids.includes(first)) {
					const parsedModule = uuidSchema.safeParse(moduleUuid);
					if (!parsedModule.success) return { kind: "home" };
					return {
						kind: "form-condition",
						moduleUuid: parsedModule.data,
						formUuid: first,
					};
				}
			}
		}
		return { kind: "home" };
	}

	/* Two-segment path: /build/{id}/{formUuid}/{fieldUuid} */
	const parsedSecond = uuidSchema.safeParse(second);

	if (doc.forms[first] !== undefined) {
		/* Derive module UUID for the form. */
		let moduleUuid: Uuid | undefined;
		for (const [mUuid, formUuids] of Object.entries(doc.formOrder)) {
			if (formUuids.includes(first)) {
				const parsedModule = uuidSchema.safeParse(mUuid);
				if (!parsedModule.success) return { kind: "home" };
				moduleUuid = parsedModule.data;
				break;
			}
		}
		if (moduleUuid === undefined) return { kind: "home" };

		if (parsedSecond.success && doc.fields[parsedSecond.data] !== undefined) {
			return {
				kind: "form",
				moduleUuid,
				formUuid: first,
				selectedUuid: parsedSecond.data,
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
			return !loc.entryPointUuid || entryPointExists(doc, loc.entryPointUuid);
		case "project-data":
			/* Project data references no blueprint entity either. Its `tableId`
			 * names a Project lookup table, which lives outside the document
			 * entirely — the doc cannot prove it exists or that it is gone, so
			 * validation here would be a guess. The workspace resolves the table
			 * against the Project and owns the not-found state. */
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
		case "form-operations":
		case "form-links":
			// A selected operation or link is deliberately NOT validated here:
			// it lives inside the form record rather than a top-level entity
			// map, and `recoverLocation` drops a stale one.
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
	/* Neither configuration workspace names an entity, so both survive every
	 * doc change. This must come before the module read below — there is no
	 * `moduleUuid` on either to read. */
	if (loc.kind === "app-setup")
		return isValidLocation(loc, doc)
			? loc
			: { kind: "app-setup", section: loc.section };
	if (loc.kind === "project-data") return loc;

	/* Module uuid is shared by module, cases, and form screens. If the
	 * module has been deleted, nothing below it can be recovered — the
	 * user's only safe destination is the app home. */
	if (doc.modules[loc.moduleUuid] === undefined) {
		return { kind: "home" };
	}

	if (loc.kind === "module") return loc;

	/* A module's display condition needs only its module. */
	if (loc.kind === "module-condition") return loc;

	/* A form's display condition degrades to the module when the form is
	 * gone — the same inward walk the form screen does. */
	if (loc.kind === "form-condition") {
		return doc.forms[loc.formUuid] === undefined
			? { kind: "module", moduleUuid: loc.moduleUuid }
			: loc;
	}

	/* Operations walk inward twice: the form, then the selected operation.
	 * A removed operation leaves the list open rather than the module —
	 * losing a selection should not lose the screen. */
	if (loc.kind === "form-operations") {
		const form = doc.forms[loc.formUuid];
		if (form === undefined) {
			return { kind: "module", moduleUuid: loc.moduleUuid };
		}
		if (
			loc.operationUuid !== undefined &&
			!(form.caseOperations ?? []).some(
				(operation) => operation.uuid === loc.operationUuid,
			)
		) {
			return {
				kind: "form-operations",
				moduleUuid: loc.moduleUuid,
				formUuid: loc.formUuid,
			};
		}
		return loc;
	}

	/* After-submit links walk inward the same way: the form, then the
	 * selected link. A link a peer removed leaves the list open. */
	if (loc.kind === "form-links") {
		const form = doc.forms[loc.formUuid];
		if (form === undefined) {
			return { kind: "module", moduleUuid: loc.moduleUuid };
		}
		if (
			loc.linkUuid !== undefined &&
			!(form.formLinks ?? []).some((link) => link.uuid === loc.linkUuid)
		) {
			return {
				kind: "form-links",
				moduleUuid: loc.moduleUuid,
				formUuid: loc.formUuid,
			};
		}
		return loc;
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

function entryPointExists(doc: LocationDoc, uuid: Uuid): boolean {
	return (
		Object.values(doc.modules).some(
			(module) =>
				module.entryPoint?.uuid === uuid ||
				module.caseListEntryPoint?.uuid === uuid,
		) || Object.values(doc.forms).some((form) => form.entryPoint?.uuid === uuid)
	);
}
