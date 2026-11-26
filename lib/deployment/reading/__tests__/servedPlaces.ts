/**
 * The organization levels and places of `locationOwnerFixture` as CommCare
 * HQ's location resources serve them to the fixture's project space: the
 * levels by `LocationTypeResource`, each place by `LocationResource` v2 (the
 * inventory) and v1 (its external id), in one page each.
 */

import type { MockAgent } from "undici";
import { LOCATION_LEVELS } from "@/lib/commcare/locations/__tests__/locationOwnerFixture";
import { FIXTURE_DOMAIN, serveAnswer } from "./adoptionFixture";

const LEVELS_PATH = `/a/${FIXTURE_DOMAIN}/api/location_type/v1/?limit=1000`;
const PLACES_PATH = `/a/${FIXTURE_DOMAIN}/api/location/v2/?limit=5000`;
const PLACES_V1_PATH = `/a/${FIXTURE_DOMAIN}/api/location/v1/?limit=1000`;

/** The levels `locationOwnerFixture` holds, region over district over clinic, each sharing
 *  cases, as `LocationTypeResource` serves them, `times` times. */
export function serveLocationLevels(peer: MockAgent, times = 1): void {
	const parentOf = (index: number) =>
		index === 0 ? null : `/a/${FIXTURE_DOMAIN}/api/location_type/v1/${index}/`;
	serveAnswer(
		peer,
		LEVELS_PATH,
		{
			status: 200,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				meta: { next: null, total_count: LOCATION_LEVELS.length },
				objects: LOCATION_LEVELS.map((level, index) => ({
					id: index + 1,
					name: level.name,
					code: level.code,
					parent: parentOf(index),
					administrative: false,
					shares_cases: true,
					view_descendants: false,
				})),
			}),
		},
		times,
	);
}

/** One place as `LocationResource` v2 serves it. */
export function hqPlace(
	siteCode: string,
	level: string,
	parent: string | null,
): Record<string, unknown> {
	return {
		domain: FIXTURE_DOMAIN,
		last_modified: "2026-10-05T10:02:16",
		latitude: null,
		location_data: {},
		location_id: `${siteCode}-id`,
		location_type_code: level,
		location_type_name: level,
		longitude: null,
		name: siteCode,
		parent_location_id: parent === null ? "" : `${parent}-id`,
		site_code: siteCode,
	};
}

/** The place list, one page of each resource, `meta` changed where given, `times` times. */
export function serveHqPlaces(
	peer: MockAgent,
	places: readonly Record<string, unknown>[],
	meta: Record<string, unknown> = {},
	times = 1,
): void {
	const details = places.map((place) => ({
		...place,
		external_id: null,
		location_type: `/a/${FIXTURE_DOMAIN}/api/location_type/v1/${LOCATION_LEVELS.findIndex((level) => level.code === place.location_type_code) + 1}/`,
		parent: place.parent_location_id
			? `/a/${FIXTURE_DOMAIN}/api/location/v1/${place.parent_location_id}/`
			: null,
	}));
	serveAnswer(
		peer,
		PLACES_V1_PATH,
		{
			status: 200,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				meta: { next: null, total_count: details.length, ...meta },
				objects: details,
			}),
		},
		times,
	);
	serveAnswer(
		peer,
		PLACES_PATH,
		{
			status: 200,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				meta: {
					limit: 1000,
					next: null,
					offset: 0,
					previous: null,
					total_count: places.length,
					...meta,
				},
				objects: places,
			}),
		},
		times,
	);
}
