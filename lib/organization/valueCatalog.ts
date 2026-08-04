import { type BlueprintDoc, locationPropertiesOf } from "@/lib/domain";

/**
 * Return the first reason a place's complete value bag does not satisfy the
 * candidate blueprint catalog. Shared by location writes and blueprint
 * commits so neither side of the two-store boundary can create a state the
 * other side refuses.
 */
export function locationValueCatalogIssue(
	doc: BlueprintDoc,
	levelUuid: string,
	values: Readonly<Record<string, string>>,
): string | undefined {
	return locationValueCatalogIssueForProperties(
		Object.values(locationPropertiesOf(doc)),
		levelUuid,
		values,
	);
}

export function locationValueCatalogIssueForProperties(
	properties: readonly ReturnType<typeof locationPropertiesOf>[string][],
	levelUuid: string,
	values: Readonly<Record<string, string>>,
): string | undefined {
	const byUuid = new Map<string, (typeof properties)[number]>(
		properties.map((property) => [property.uuid, property]),
	);

	for (const [uuid, value] of Object.entries(values)) {
		const property = byUuid.get(uuid);
		if (property === undefined) {
			return "This place carries information that is no longer part of the app. Reload to get the latest place information, then try again.";
		}
		if (
			property.levelUuids !== undefined &&
			!property.levelUuids.some((applicable) => applicable === levelUuid)
		) {
			return `"${property.label}" doesn't apply to places at this level, so it can't be recorded here.`;
		}
		// Empty text is a legitimate unset optional value. A closed choice list
		// constrains only text that is actually present.
		if (
			value !== "" &&
			property.choices !== undefined &&
			!property.choices.includes(value)
		) {
			return `"${value}" isn't one of the accepted values for "${property.label}".`;
		}
	}

	for (const property of properties) {
		if (property.required !== true) continue;
		if (
			property.levelUuids !== undefined &&
			!property.levelUuids.some((applicable) => applicable === levelUuid)
		) {
			continue;
		}
		const value = values[property.uuid];
		if (value === undefined || value === "") {
			return `"${property.label}" is required for places at this level.`;
		}
	}

	return undefined;
}
