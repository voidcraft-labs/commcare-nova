import {
	ancestorLevels,
	type BlueprintDoc,
	type LocationProperty,
	levelOwnsCases,
	type OrganizationLevel,
	orderedOrganizationLevels,
	organizationLevelsOf,
} from "@/lib/domain";

export const PERSONA_LOCATION_PAGE_SIZE = 50;

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
	/** Request-local branch key; never persisted as identity. */
	readonly key: string;
	/** null means the root place authored beside these rows. */
	readonly parentKey: string | null;
	readonly level: OrganizationLevel;
	readonly depth: number;
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

	const out: RequiredReverseHopDescendant[] = [];
	let nextKey = 1;
	const visit = (
		sourceLevelUuid: string,
		parentKey: string | null,
		depth: number,
	): void => {
		for (const destination of destinationsBySource.get(sourceLevelUuid) ?? []) {
			const key = `required-${nextKey++}`;
			out.push({ key, parentKey, level: destination, depth });
			visit(destination.uuid, key, depth + 1);
		}
	};
	visit(rootLevelUuid, null, 0);
	return out;
}
