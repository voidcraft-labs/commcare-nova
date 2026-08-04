import {
	ancestorLevels,
	type BlueprintDoc,
	LEVEL_CODE_MAX_LENGTH,
	type LocationProperty,
	levelOwnsCases,
	type OrganizationLevel,
	orderedOrganizationLevels,
	organizationLevelsOf,
} from "@/lib/domain";

export const PERSONA_LOCATION_PAGE_SIZE = 50;

/** Derive a valid, collision-free, fixed identity without exceeding HQ's cap. */
export function uniqueLevelCode(
	name: string,
	peers: readonly OrganizationLevel[],
): string {
	const taken = new Set(peers.map((peer) => peer.code));
	const derived =
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "_")
			.replace(/^_+|_+$/g, "") || "level";
	const safe = /^[a-z_]/.test(derived) ? derived : `l_${derived}`;
	const base = safe.slice(0, LEVEL_CODE_MAX_LENGTH);
	if (!taken.has(base)) return base;
	for (let number = 2; ; number++) {
		const suffix = `_${number}`;
		const candidate = `${base.slice(0, LEVEL_CODE_MAX_LENGTH - suffix.length)}${suffix}`;
		if (!taken.has(candidate)) return candidate;
	}
}

/** Keep a maximum-size persona's authored place rows bounded in the DOM. */
export function personaLocationPage(
	locationIds: readonly string[],
	requestedPage: number,
): {
	readonly ids: readonly string[];
	readonly page: number;
	readonly pageCount: number;
	readonly start: number;
} {
	const pageCount = Math.max(
		1,
		Math.ceil(locationIds.length / PERSONA_LOCATION_PAGE_SIZE),
	);
	const page = Math.min(Math.max(0, requestedPage), pageCount - 1);
	const start = page * PERSONA_LOCATION_PAGE_SIZE;
	return {
		ids: locationIds.slice(start, start + PERSONA_LOCATION_PAGE_SIZE),
		page,
		pageCount,
		start,
	};
}

/** Place-information fields that apply to one level, in authored order. */
export function propertiesForLevel(
	properties: readonly LocationProperty[],
	levelUuid: string,
): readonly LocationProperty[] {
	return properties.filter(
		(property) =>
			property.levelUuids === undefined ||
			property.levelUuids.some((uuid) => uuid === levelUuid),
	);
}

/** Keep only values the chosen level's current catalog can name. */
export function valuesForLevel(
	properties: readonly LocationProperty[],
	levelUuid: string,
	values: Readonly<Record<string, string>>,
): Record<string, string> {
	const allowed = new Set<string>(
		propertiesForLevel(properties, levelUuid).map((property) => property.uuid),
	);
	return Object.fromEntries(
		Object.entries(values).filter(([uuid]) => allowed.has(uuid)),
	);
}

/** Preserve only fields still being authored over an async per-field save. */
export function rebaseLocationValueDraft(
	authoritative: Readonly<Record<string, string>>,
	dirtyDrafts: Readonly<Record<string, string>>,
): Record<string, string> {
	return { ...authoritative, ...dirtyDrafts };
}

export interface LocationScalarDraft {
	readonly name: string;
	readonly externalId: string;
	readonly latitude: string;
	readonly longitude: string;
	readonly levelUuid: string;
	readonly parentId: string | null;
}

/** Merge a peer snapshot without turning untouched peer fields into local edits. */
export function rebaseUntouchedLocationDraft(input: {
	readonly authoritative: LocationScalarDraft;
	readonly draft: LocationScalarDraft;
	readonly dirty: Readonly<Record<keyof LocationScalarDraft, boolean>>;
}): LocationScalarDraft {
	return {
		name: input.dirty.name ? input.draft.name : input.authoritative.name,
		externalId: input.dirty.externalId
			? input.draft.externalId
			: input.authoritative.externalId,
		latitude: input.dirty.latitude
			? input.draft.latitude
			: input.authoritative.latitude,
		longitude: input.dirty.longitude
			? input.draft.longitude
			: input.authoritative.longitude,
		levelUuid: input.dirty.levelUuid
			? input.draft.levelUuid
			: input.authoritative.levelUuid,
		parentId: input.dirty.parentId
			? input.draft.parentId
			: input.authoritative.parentId,
	};
}

/** An async scalar save may clear dirty state only for the value it submitted. */
export function scalarDraftStillMatchesSave(
	currentDraft: string,
	submittedDraft: string,
): boolean {
	return currentDraft === submittedDraft;
}

/** How an accepted custom-value response relates to a concurrent retype. */
export function localValueSaveDisposition(input: {
	readonly currentBaseLevelUuid: string;
	readonly beforeLevelUuid: string;
	readonly currentDraftLevelUuid: string;
	readonly submittedLevelUuid: string;
}): "obsolete" | "record-only" | "settle-draft" {
	if (input.currentBaseLevelUuid !== input.beforeLevelUuid) return "obsolete";
	return input.currentDraftLevelUuid === input.submittedLevelUuid
		? "settle-draft"
		: "record-only";
}

/** Preserve a newer value draft when a placement response settles first. */
export function placementSaveDraftDisposition(input: {
	readonly responseIsLatest: boolean;
	readonly levelMatches: boolean;
	readonly parentMatches: boolean;
	readonly valuesMatch: boolean;
	readonly dirtyValueCount: number;
}): { readonly current: boolean; readonly valuesNeedApply: boolean } {
	const current =
		input.responseIsLatest &&
		input.levelMatches &&
		input.parentMatches &&
		input.valuesMatch;
	return {
		current,
		valuesNeedApply: !current && input.dirtyValueCount > 0,
	};
}

/** Blank is absence in the row store, not a capacity-consuming empty value. */
export function locationValuePatch(value: string): string | null {
	return value === "" ? null : value;
}

/** Required place information is the only extra create-form completeness gate. */
export function requiredValuesPresent(
	properties: readonly LocationProperty[],
	levelUuid: string,
	values: Readonly<Record<string, string>>,
): boolean {
	return propertiesForLevel(properties, levelUuid).every(
		(property) =>
			property.required !== true || (values[property.uuid] ?? "") !== "",
	);
}

export interface RequiredReverseHopDescendant {
	/** Presentation-only path for keyed draft controls; never sent to a writer. */
	readonly uiPath: string;
	readonly level: OrganizationLevel;
	readonly depth: number;
	readonly descendants: readonly RequiredReverseHopDescendant[];
}

/**
 * Descendants a new root must carry in the SAME create transaction so every
 * authored reverse-hop case-owner rule remains total. A destination can itself
 * be the source for a deeper rule, so this is a tree rather than one flat row.
 */
export function requiredReverseHopDescendants(
	doc: BlueprintDoc,
	rootLevelUuid: string,
): readonly RequiredReverseHopDescendant[] {
	const levels = organizationLevelsOf(doc);
	const destinationUuids = new Set<string>();
	for (const form of Object.values(doc.forms)) {
		for (const operation of form.caseOperations ?? []) {
			const owner = operation.owner;
			if (
				owner?.kind === "term" &&
				owner.term.kind === "owner-location-at-level"
			) {
				destinationUuids.add(owner.term.levelUuid);
			}
		}
	}
	const destinationsBySource = new Map<string, OrganizationLevel[]>();
	for (const destination of orderedOrganizationLevels(doc)) {
		if (!destinationUuids.has(destination.uuid)) continue;
		const source = ancestorLevels(destination, levels).find(levelOwnsCases);
		if (source === undefined) continue;
		const destinations = destinationsBySource.get(source.uuid) ?? [];
		destinations.push(destination);
		destinationsBySource.set(source.uuid, destinations);
	}

	const visit = (
		sourceLevelUuid: string,
		depth: number,
		parentPath: string,
	): readonly RequiredReverseHopDescendant[] =>
		(destinationsBySource.get(sourceLevelUuid) ?? []).map(
			(destination, index) => {
				const uiPath =
					parentPath === "" ? String(index) : `${parentPath}.${index}`;
				return {
					uiPath,
					level: destination,
					depth,
					descendants: visit(destination.uuid, depth + 1, uiPath),
				};
			},
		);
	return visit(rootLevelUuid, 0, "");
}

export function flattenRequiredReverseHopDescendants(
	descendants: readonly RequiredReverseHopDescendant[],
): readonly RequiredReverseHopDescendant[] {
	const out: RequiredReverseHopDescendant[] = [];
	const visit = (entries: readonly RequiredReverseHopDescendant[]) => {
		for (const entry of entries) {
			out.push(entry);
			visit(entry.descendants);
		}
	};
	visit(descendants);
	return out;
}
