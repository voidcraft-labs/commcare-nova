import "server-only";
import type { CommCareApiError, CommCareCredentials } from "./http";
import {
	type HqLocation,
	type HqLocationType,
	listHqLocationObservations,
	listHqLocationTypes,
	releaseLocationInventory,
} from "./locations";

export type HqPlaceInventory =
	| {
			kind: "read";
			levels: readonly HqLocationType[];
			places: readonly HqLocation[];
	  }
	| { kind: "inconsistent" }
	| {
			kind: "failed";
			error: CommCareApiError;
			request: "locations" | "location-types";
	  };

export function completePlaceHierarchy(
	levels: readonly HqLocationType[],
	places: readonly HqLocation[],
): boolean {
	const codes = new Set(levels.map((level) => level.code));
	const byId = new Map(places.map((place) => [place.locationId, place]));
	const complete = new Set<string>();
	for (const place of places) {
		if (!codes.has(place.locationTypeCode)) return false;
		const path = new Set<string>();
		let id: string | null = place.locationId;
		while (id !== null && !complete.has(id)) {
			const item = byId.get(id);
			if (!item || path.has(id)) return false;
			path.add(id);
			id = item.parentLocationId;
		}
		for (const member of path) complete.add(member);
	}
	return true;
}

/** Re-read all three inventories together when a link straddles a change. */
export async function readHqPlaceInventory(
	creds: CommCareCredentials,
	domain: string,
	cancel?: AbortSignal,
): Promise<HqPlaceInventory> {
	for (let attempt = 0; attempt < 2; attempt++) {
		const levels = await listHqLocationTypes(creds, domain, { cancel });
		if ("success" in levels) {
			if (levels.cause === "moved") continue;
			return { kind: "failed", error: levels, request: "location-types" };
		}
		const places = await listHqLocationObservations(
			creds,
			domain,
			levels,
			cancel,
		);
		if ("success" in places) {
			releaseLocationInventory(levels);
			if (places.cause === "moved") continue;
			return { kind: "failed", error: places, request: "locations" };
		}
		if (completePlaceHierarchy(levels, places))
			return { kind: "read", levels, places };
		releaseLocationInventory(places);
		releaseLocationInventory(levels);
	}
	return { kind: "inconsistent" };
}
