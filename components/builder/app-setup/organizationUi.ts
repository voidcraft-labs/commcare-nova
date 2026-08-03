import type { LocationProperty } from "@/lib/domain";

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
