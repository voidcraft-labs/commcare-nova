import type { LocationProperty } from "@/lib/domain";

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
