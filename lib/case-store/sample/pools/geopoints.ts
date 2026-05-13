// lib/case-store/sample/pools/geopoints.ts
//
// Geopoints clustered ~5 km around major city centers so a 30-row
// search-by-distance demo spreads visibly on a city map rather
// than scattering across continents. Wire shape: CCHQ's
// space-separated `lat lon alt acc` per `GEOPOINT_PATTERN` at
// `lib/domain/predicate/jsonSchema.ts`. Altitude / accuracy default
// to plausible-low values; the demo path doesn't vary them.

import { compilerBugMessage } from "@/lib/domain/predicate/errors";

/** Mixed across continents for global variety. `name` is for docs only — not emitted. */
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

/** Pick a city-clustered geopoint in CCHQ's wire shape. */
export function pickCityClusteredGeopoint(prng: SeededPrng): string {
	const center = CITY_CENTERS[prng.pickIndex(CITY_CENTERS.length)];
	if (center === undefined) {
		// Defensive: `CITY_CENTERS` is statically non-empty.
		throw new Error(
			compilerBugMessage({
				where: "case-store.pickCityClusteredGeopoint",
				invariant:
					"`CITY_CENTERS` is empty; the static pool must carry at least one center for the perturbation read to land",
				detail:
					"The cluster pick reads `CITY_CENTERS[prng.pickIndex(CITY_CENTERS.length)]`. An empty array would make every index out of bounds and `pickIndex(0)` would degenerate. Reaching this throw means a future edit emptied the pool.\n\nHint: restore at least one entry in `CITY_CENTERS`.",
			}),
		);
	}
	// `(pickFloat - 0.5) * 0.1` → [-0.05, 0.05) offset, ~5 km at
	// the equator. Six-decimal precision is ~0.1 m, plenty for the
	// demo path.
	const latitude = center.latitude + (prng.pickFloat() - 0.5) * 0.1;
	const longitude = center.longitude + (prng.pickFloat() - 0.5) * 0.1;
	return `${latitude.toFixed(6)} ${longitude.toFixed(6)} 0 5`;
}
