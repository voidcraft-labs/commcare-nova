/** Real HTTP requests and decoded location contracts, verified against HQ's
 * LocationTypeV0_5Test / LocationV0_6Test and LocationResource._update. */
import { afterEach, expect, it, vi } from "vitest";
import {
	readHttpRequestBody,
	withHttpPeer,
} from "@/__tests__/helpers/httpPeer";
import {
	listHqLocations,
	listHqLocationTypes,
	patchHqLocations,
} from "../hq/locations";

const CREDS = {
	username: "account",
	apiKey: "fixture-key",
	server: "india",
} as const;
const HOST = "https://india.commcarehq.org",
	DOMAIN = "clinic";
const TYPES = "/a/clinic/api/location_type/v1/?limit=1000";
const PLACES = "/a/clinic/api/location/v2/?limit=1000";
const PATCH = "/a/clinic/api/location/v2/";
const AUTH = { authorization: "ApiKey account:fixture-key" };
const region = {
	id: 7,
	code: "region",
	name: "Region",
	parent: null,
	administrative: true,
	shares_cases: false,
	view_descendants: false,
};
const district = {
	id: 8,
	code: "district",
	name: "District",
	parent: `${HOST}/a/clinic/api/location_type/v1/7/`,
	administrative: false,
	shares_cases: true,
	view_descendants: true,
};
const root = {
	location_id: "hq-region",
	name: "North",
	site_code: "north",
	location_type_code: "region",
	parent_location_id: "",
	location_data: {},
};
const child = {
	location_id: "hq-district",
	name: "Central",
	site_code: "central",
	location_type_code: "district",
	parent_location_id: "hq-region",
	location_data: {
		population: "715,522",
		external_count: 3,
		external_policy: { flags: [true, null] },
	},
};
const CREATE = {
	name: "Central",
	siteCode: "central",
	locationTypeCode: "district",
	parentLocationId: "hq-region",
};

it("resolves level parents across pages independent of response order", async () => {
	await withHttpPeer(async (peer) => {
		peer
			.get(HOST)
			.intercept({ path: TYPES, method: "GET", headers: AUTH })
			.reply(200, {
				meta: { next: "?limit=1000&offset=1000" },
				objects: [district],
			});
		peer
			.get(HOST)
			.intercept({
				path: "/a/clinic/api/location_type/v1/?limit=1000&offset=1000",
				method: "GET",
				headers: AUTH,
			})
			.reply(200, { meta: { next: null }, objects: [region] });
		expect(await listHqLocationTypes(CREDS, DOMAIN)).toEqual([
			{
				id: "8",
				code: "district",
				name: "District",
				parentCode: "region",
				administrative: false,
				sharesCases: true,
				viewDescendants: true,
			},
			{
				id: "7",
				code: "region",
				name: "Region",
				parentCode: null,
				administrative: true,
				sharesCases: false,
				viewDescendants: false,
			},
		]);
		expect(
			peer
				.getCallHistory()
				?.calls()
				.map((call) => call.fullUrl),
		).toEqual([
			HOST + TYPES,
			`${HOST}/a/clinic/api/location_type/v1/?limit=1000&offset=1000`,
		]);
	});
});

it("reads every place and preserves complete target metadata for an eventual shallow replacement", async () => {
	await withHttpPeer(async (peer) => {
		peer
			.get(HOST)
			.intercept({ path: PLACES, method: "GET", headers: AUTH })
			.reply(200, {
				meta: { next: "?limit=1000&offset=1000" },
				objects: [root],
			});
		peer
			.get(HOST)
			.intercept({
				path: "/a/clinic/api/location/v2/?limit=1000&offset=1000",
				method: "GET",
				headers: AUTH,
			})
			.reply(200, { meta: { next: null }, objects: [child] });
		expect(await listHqLocations(CREDS, DOMAIN)).toEqual([
			{
				locationId: "hq-region",
				name: "North",
				siteCode: "north",
				locationTypeCode: "region",
				parentLocationId: null,
				values: {},
			},
			{
				locationId: "hq-district",
				name: "Central",
				siteCode: "central",
				locationTypeCode: "district",
				parentLocationId: "hq-region",
				values: {
					population: "715,522",
					external_count: 3,
					external_policy: { flags: [true, null] },
				},
			},
		]);
	});
});

it.each([
	{ path: TYPES, read: listHqLocationTypes },
	{ path: PLACES, read: listHqLocations },
])(
	"refuses incomplete inventories and foreign cursors for $path",
	async ({ path, read }) => {
		const bodies: unknown[] = [
			null,
			[],
			{},
			{ objects: [] },
			{ objects: [], meta: {} },
			{ objects: [null], meta: { next: null } },
			{ objects: [{}], meta: { next: null } },
		];
		for (const next of [
			"",
			7,
			"http://[",
			"https://outside.invalid/",
			"/a/other/api/location/v2/",
			path === TYPES ? PLACES : TYPES,
		])
			bodies.push({ objects: [], meta: { next } });
		await withHttpPeer(async (peer) => {
			for (const data of bodies)
				peer
					.get(HOST)
					.intercept({ path, method: "GET" })
					.reply(200, JSON.stringify(data));
			peer
				.get(HOST)
				.intercept({ path, method: "GET" })
				.reply(200, { objects: [], meta: { next: null } });
			for (const data of bodies)
				expect(await read(CREDS, DOMAIN), JSON.stringify(data)).toEqual({
					success: false,
					status: 502,
				});
			expect(await read(CREDS, DOMAIN)).toEqual([]);
			expect(
				peer
					.getCallHistory()
					?.calls()
					.map((call) => call.fullUrl),
			).toEqual(Array(bodies.length + 1).fill(HOST + path));
		});
	},
);

it("does not turn an unresolvable parent into a root or accept contradictory level identity", async () => {
	const invalid = [
		[
			{ ...district, parent: `${HOST}/a/clinic/api/location_type/v1/999/` },
			region,
		],
		[
			{ ...district, parent: `${HOST}/a/other/api/location_type/v1/7/` },
			region,
		],
		[{ ...district, parent: 7 }, region],
		[{ ...region, id: null }],
		[region, { ...district, id: 7 }],
		[region, { ...district, code: "region" }],
		[{ ...region, parent: `${HOST}/a/clinic/api/location_type/v1/7/` }],
	];
	await withHttpPeer(async (peer) => {
		for (const objects of invalid)
			peer
				.get(HOST)
				.intercept({ path: TYPES, method: "GET" })
				.reply(200, { objects, meta: { next: null } });
		for (const objects of invalid)
			expect(
				await listHqLocationTypes(CREDS, DOMAIN),
				JSON.stringify(objects),
			).toEqual({ success: false, status: 502 });
	});
});

it.each([
	{ path: TYPES, read: listHqLocationTypes },
	{ path: PLACES, read: listHqLocations },
])(
	"keeps permission, transport and malformed replies distinct and follows no redirect for $path",
	async ({ path, read }) => {
		await withHttpPeer(async (peer) => {
			for (const status of [403, 503, 302])
				peer
					.get(HOST)
					.intercept({ path, method: "GET" })
					.reply(status, "Refused", {
						headers: { location: "/a/other/api/location/v2/" },
					});
			peer
				.get(HOST)
				.intercept({ path, method: "GET" })
				.reply(200, "<html>Sign in</html>");
			peer
				.get(HOST)
				.intercept({ path, method: "GET" })
				.replyWithError(new Error("connection lost"));
			for (const status of [403, 503, 302])
				expect(await read(CREDS, DOMAIN)).toEqual({
					success: false,
					status,
					edgeRefusal: false,
				});
			for (const status of [502, 503])
				expect(await read(CREDS, DOMAIN)).toEqual({ success: false, status });
			expect(
				peer
					.getCallHistory()
					?.calls()
					.map((call) => call.fullUrl),
			).toEqual(Array(5).fill(HOST + path));
		});
	},
);

it("transmits exact create/update objects and preserves positional identities from an atomic batch", async () => {
	await withHttpPeer(async (peer) => {
		const bodies: unknown[] = [];
		peer
			.get(HOST)
			.intercept({
				path: PATCH,
				method: "PATCH",
				headers: { ...AUTH, "content-type": "application/json" },
			})
			.reply(async (opts) => {
				bodies.push(JSON.parse((await readHttpRequestBody(opts)).toString()));
				return {
					statusCode: 202,
					data: JSON.stringify(["hq-district", "hq-region"]),
				};
			});
		expect(
			await patchHqLocations(CREDS, DOMAIN, [
				CREATE,
				{
					locationId: "hq-region",
					name: "Renamed North",
					siteCode: "north",
					locationTypeCode: "region",
					latitude: "11.1234567891",
					longitude: "10.1234567891",
					locationData: { phone: "001" },
				},
			]),
		).toEqual({ ids: ["hq-district", "hq-region"] });
		expect(bodies).toEqual([
			{
				objects: [
					{
						name: "Central",
						site_code: "central",
						location_type_code: "district",
						parent_location_id: "hq-region",
					},
					{
						location_id: "hq-region",
						name: "Renamed North",
						site_code: "north",
						location_type_code: "region",
						latitude: "11.1234567891",
						longitude: "10.1234567891",
						location_data: { phone: "001" },
					},
				],
			},
		]);
	});
});

it("rejects short, duplicate, blank and mismatched update acknowledgements", async () => {
	const replies = [
		["one"],
		["one", "one"],
		["one", " "],
		["one", "wrong-update"],
		null,
		{ objects: ["one", "hq-region"] },
	];
	await withHttpPeer(async (peer) => {
		for (const reply of replies)
			peer
				.get(HOST)
				.intercept({ path: PATCH, method: "PATCH" })
				.reply(202, JSON.stringify(reply));
		for (const reply of replies)
			expect(
				await patchHqLocations(CREDS, DOMAIN, [
					CREATE,
					{ ...CREATE, locationId: "hq-region", siteCode: "north" },
				]),
				JSON.stringify(reply),
			).toEqual({
				success: false,
				status: 502,
				message: "",
				mayHaveLanded: true,
			});
	});
});

it("preserves a native atomic-batch refusal message and handles non-JSON or disconnected replies", async () => {
	await withHttpPeer(async (peer) => {
		peer.get(HOST).intercept({ path: PATCH, method: "PATCH" }).reply(400, {
			error: "Name already exists. Location site code: central.",
		});
		peer
			.get(HOST)
			.intercept({ path: PATCH, method: "PATCH" })
			.reply(202, "<html>Sign in</html>");
		peer
			.get(HOST)
			.intercept({ path: PATCH, method: "PATCH" })
			.replyWithError(new Error("connection lost"));
		expect(await patchHqLocations(CREDS, DOMAIN, [CREATE])).toEqual({
			success: false,
			status: 400,
			message: "Name already exists. Location site code: central.",
			mayHaveLanded: false,
		});
		for (const status of [502, 503])
			expect(await patchHqLocations(CREDS, DOMAIN, [CREATE])).toEqual({
				success: false,
				status,
				message: "",
				mayHaveLanded: true,
			});
	});
});

it("sends the full 100-place atomic boundary, but no empty, oversized or unroutable request", async () => {
	const places = Array.from({ length: 100 }, (_, i) => ({
		...CREATE,
		name: `Place ${i}`,
		siteCode: `place_${i}`,
	}));
	const ids = places.map((_, i) => `remote-${i}`);
	await withHttpPeer(async (peer) => {
		peer.get(HOST).intercept({ path: PATCH, method: "PATCH" }).reply(202, ids);
		expect(await patchHqLocations(CREDS, DOMAIN, places)).toEqual({ ids });
		expect(await patchHqLocations(CREDS, DOMAIN, [...places, CREATE])).toEqual({
			success: false,
			status: 400,
			message: "",
			mayHaveLanded: false,
		});
		expect(await patchHqLocations(CREDS, DOMAIN, [])).toEqual({ ids: [] });
		expect(await listHqLocations(CREDS, "../outside")).toEqual({
			success: false,
			status: 400,
		});
		expect(await listHqLocationTypes(CREDS, "../outside")).toEqual({
			success: false,
			status: 400,
		});
		expect(await patchHqLocations(CREDS, "../outside", places)).toEqual({
			success: false,
			status: 400,
			message: "",
			mayHaveLanded: false,
		});
		expect(
			peer
				.getCallHistory()
				?.calls()
				.map((call) => call.fullUrl),
		).toEqual([HOST + PATCH]);
	});
});

afterEach(() => vi.useRealTimers());
it("owns one deadline across pages and releases it after a stalled second page", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	await withHttpPeer(async (peer) => {
		const firstReached = Promise.withResolvers<void>();
		const firstRelease = Promise.withResolvers<void>();
		const secondReached = Promise.withResolvers<void>();
		const secondRelease = Promise.withResolvers<void>();
		peer
			.get(HOST)
			.intercept({ path: PLACES, method: "GET" })
			.reply(async () => {
				firstReached.resolve();
				await firstRelease.promise;
				return {
					statusCode: 200,
					data: JSON.stringify({
						objects: [root],
						meta: { next: "?offset=1000" },
					}),
				};
			});
		peer
			.get(HOST)
			.intercept({
				path: "/a/clinic/api/location/v2/?offset=1000",
				method: "GET",
			})
			.reply(async () => {
				secondReached.resolve();
				await secondRelease.promise;
				return {
					statusCode: 200,
					data: JSON.stringify({ objects: [child], meta: { next: null } }),
				};
			});
		const pending = listHqLocations(CREDS, DOMAIN);
		try {
			await firstReached.promise;
			await vi.advanceTimersByTimeAsync(20_000);
			firstRelease.resolve();
			await secondReached.promise;
			await vi.advanceTimersByTimeAsync(10_000);
			expect(await pending).toEqual({ success: false, status: 503 });
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			firstRelease.resolve();
			secondRelease.resolve();
			await pending;
		}
		expect(peer.getCallHistory()?.calls()).toHaveLength(2);
	});
});

it("requires HTTP 202 and keeps known permission refusals distinct from uncertain write outcomes", async () => {
	await withHttpPeer(async (peer) => {
		for (const status of [200, 401, 403, 500, 302]) {
			peer
				.get(HOST)
				.intercept({ path: PATCH, method: "PATCH" })
				.reply(status, ["remote-id"], {
					headers: { location: "/a/other/api/location/v2/" },
				});
			expect(await patchHqLocations(CREDS, DOMAIN, [CREATE])).toEqual({
				success: false,
				status,
				message: "",
				mayHaveLanded: ![401, 403].includes(status),
			});
		}
		expect(
			peer
				.getCallHistory()
				?.calls()
				.map((call) => call.fullUrl),
		).toEqual(Array(5).fill(HOST + PATCH));
	});
});
