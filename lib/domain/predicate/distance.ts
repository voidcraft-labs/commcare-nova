/** Units Nova exposes for authored distance predicates. */
export const DISTANCE_UNITS = ["miles", "kilometers"] as const;
export type DistanceUnit = (typeof DISTANCE_UNITS)[number];

/**
 * One conversion table shared by schema validation, Preview SQL, on-device
 * XPath emission, and the editor. PostGIS and Core compare meters; CSQL keeps
 * the authored unit token but the same AST must still be executable by every
 * target. `1609.344` is the international mile; kilometers use exact SI.
 */
export const METERS_PER_DISTANCE_UNIT = {
	miles: 1609.344,
	kilometers: 1000,
} as const satisfies Record<DistanceUnit, number>;

export type DistanceValidationIssue = "not-positive-finite" | "meters-overflow";

/** Convert an authored radius to the meter scalar used by Core/PostGIS. */
export function distanceToMeters(distance: number, unit: DistanceUnit): number {
	return distance * METERS_PER_DISTANCE_UNIT[unit];
}

/**
 * Structural radius validity shared by the schema and editor. CommCare's
 * Elasticsearch query rejects zero/negative radii, and a finite authored
 * number can still overflow when converted to meters.
 */
export function distanceValidationIssue(
	distance: number,
	unit: DistanceUnit,
): DistanceValidationIssue | undefined {
	if (!(Number.isFinite(distance) && distance > 0)) {
		return "not-positive-finite";
	}
	return Number.isFinite(distanceToMeters(distance, unit))
		? undefined
		: "meters-overflow";
}
