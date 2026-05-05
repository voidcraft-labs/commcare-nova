// lib/case-store/sample/pools/geopoints.ts
//
// City-cluster geopoint generator. Real-world coordinates clustered
// near major city centers across continents so search-by-location
// demos exhibit recognizable geography rather than uniform-random
// noise across the globe.
//
// Wire format: CCHQ's geopoint shape is four space-separated decimals
// — `latitude longitude altitude accuracy`. The generator emits this
// exact shape so the JSON Schema validator
// (`lib/domain/predicate/jsonSchema.ts`'s GEOPOINT_PATTERN) accepts
// the value at insert time. Altitude and accuracy default to a
// plausible-low value because the case-property surface treats them
// as supplementary metadata; a sample-data demo doesn't need varied
// altitudes.
//
// Coordinates are perturbed off the city center within a small
// radius (~0.05 degrees, roughly 5 km) so a 30-row cluster spreads
// visibly across a city map without scattering across continents.

/**
 * Major city centers the generator clusters around. Each entry pairs
 * a name (for documentation; not emitted) with a `(latitude,
 * longitude)` pair the generator perturbs off of. Mixed across
 * continents so a 30-row sample exhibits global variety.
 */
export const CITY_CENTERS: readonly {
	name: string;
	latitude: number;
	longitude: number;
}[] = [
	{ name: "New York", latitude: 40.7128, longitude: -74.006 },
	{ name: "Lagos", latitude: 6.5244, longitude: 3.3792 },
	{ name: "Mumbai", latitude: 19.076, longitude: 72.8777 },
	{ name: "São Paulo", latitude: -23.5505, longitude: -46.6333 },
	{ name: "Nairobi", latitude: -1.2921, longitude: 36.8219 },
	{ name: "Tokyo", latitude: 35.6762, longitude: 139.6503 },
	{ name: "Cairo", latitude: 30.0444, longitude: 31.2357 },
	{ name: "Mexico City", latitude: 19.4326, longitude: -99.1332 },
	{ name: "Jakarta", latitude: -6.2088, longitude: 106.8456 },
	{ name: "London", latitude: 51.5074, longitude: -0.1278 },
];

import type { SeededPrng } from "../prng";

/**
 * Pick a city-clustered geopoint and emit it in CCHQ's wire shape.
 *
 * The PRNG drives two independent kinds of read:
 *
 *   - one indexed pick over `CITY_CENTERS` to choose the cluster
 *     center
 *   - two `pickFloat` reads to perturb latitude / longitude inside
 *     the cluster radius
 *
 * The `prng` argument is the generator's seeded instance, so all
 * randomness flows through one source — the determinism contract
 * holds because every pool call threads through the same PRNG.
 *
 * Wire shape: `latitude longitude altitude accuracy` matches the
 * GEOPOINT_PATTERN at `lib/domain/predicate/jsonSchema.ts`. Altitude
 * defaults to 0 and accuracy to a plausible 5 (meters); both are
 * supplementary metadata the case-property surface stores but
 * neither matters for the search-by-distance demo path.
 */
export function pickCityClusteredGeopoint(prng: SeededPrng): string {
	const center = CITY_CENTERS[prng.pickIndex(CITY_CENTERS.length)];
	if (center === undefined) {
		// Defensive: CITY_CENTERS is statically non-empty, so this
		// arm is unreachable. The throw exists to surface the
		// invariant if a future edit empties the array.
		throw new Error(
			"pickCityClusteredGeopoint: CITY_CENTERS is empty; the static pool must carry at least one center.",
		);
	}
	// Perturbation radius: ~0.05 degrees ≈ 5 km at the equator.
	// `pickFloat()` returns a uniform [0, 1) value; centering at -0.05
	// produces a [-0.05, 0.05) offset, keeping the cluster tight
	// around the center.
	const latitude = center.latitude + (prng.pickFloat() - 0.5) * 0.1;
	const longitude = center.longitude + (prng.pickFloat() - 0.5) * 0.1;
	// Format with fixed decimal precision so the wire shape is
	// stable across rows. Six decimals ≈ 0.1 m precision, more than
	// enough for the demo path.
	return `${latitude.toFixed(6)} ${longitude.toFixed(6)} 0 5`;
}
