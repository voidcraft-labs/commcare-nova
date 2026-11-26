import type { MockAgent } from "undici";

/** A peer with a caller-chosen project and state. The spelling of both versions
 * is checked against the authenticated native files by hqLocations.test.ts. */
export interface PeerPlace {
	location_id: string;
	site_code: string;
	name: string | null;
	location_type_code: string;
	parent_location_id: string;
	latitude: string | null;
	longitude: string | null;
	location_data: Record<string, unknown>;
	external_id?: string | null;
}
export const regionLevel = {
	id: 1,
	code: "region",
	name: "Region",
	parent: null,
	administrative: false,
	shares_cases: true,
	view_descendants: false,
};
export function servePlaceInventory(
	peer: MockAgent,
	domain: string,
	places: readonly PeerPlace[],
	levels: (Omit<typeof regionLevel, "parent"> & { parent: string | null })[] = [
		regionLevel,
	],
	repeat = false,
	onRead?: () => Promise<void>,
) {
	const host = "https://india.commcarehq.org";
	const base = "/a/" + domain + "/api/";
	const headers = { authorization: "ApiKey account:fixture-key" };
	const send = (path: string, body: object) => {
		const request = peer
			.get(host)
			.intercept({ path: base + path, method: "GET", headers });
		const reply =
			onRead && path.startsWith("location/v2/")
				? request.reply(async () => {
						await onRead();
						return { statusCode: 200, data: JSON.stringify(body) };
					})
				: request.reply(200, body);
		if (repeat) reply.persist();
	};
	const page = (objects: object[]) => ({
		meta: { next: null, total_count: objects.length },
		objects,
	});
	const v2 = places.map(({ external_id: _externalId, ...place }) => ({
		...place,
		domain,
		last_modified: "2026-11-01T09:00:00",
	}));
	const v1 = places.map((place) => ({
		location_id: place.location_id,
		name: place.name,
		site_code: place.site_code,
		domain,
		last_modified: "2026-11-01T09:00:00",
		external_id: place.external_id ?? null,
		parent: place.parent_location_id
			? host + base + "location/v1/" + place.parent_location_id + "/"
			: null,
		location_type:
			host +
			base +
			"location_type/v1/" +
			levels.find((level) => level.code === place.location_type_code)?.id +
			"/",
		latitude: place.latitude,
		longitude: place.longitude,
		location_data: place.location_data,
	}));
	send("location_type/v1/?limit=1000", page(levels));
	send("location/v2/?limit=5000", page(v2));
	send("location/v1/?limit=1000", page(v1));
}
