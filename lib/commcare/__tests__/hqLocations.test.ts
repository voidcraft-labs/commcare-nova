/**
 * Fetch-level tests for the CommCare HQ locations driver
 * (`lib/commcare/hq/locations.ts`).
 *
 * Every wire fact asserted here was read in HQ's own source or pinned by
 * HQ's own tests, not inferred from Nova's side:
 *
 *   - the paths are `/a/{domain}/api/location_type/v1/` and
 *     `/a/{domain}/api/location/v2/` (`api/urls.py`, resource-first
 *     versioning over `locations/resources/v0_5.py` and `v0_6.py`);
 *   - a level's parent serializes under `parent`, as a resource URI
 *     ending in the parent's primary key, because
 *     `v0_5.py::LocationTypeResource` declares
 *     `parent = fields.ForeignKey('self', 'parent_type')`
 *     (`locations/tests/test_api_resources.py::LocationTypeV0_5Test.test_location_type_serialization`
 *     asserts the whole document);
 *   - a place at the top of the tree carries `parent_location_id: ""`
 *     rather than null (`v0_6.py::LocationResource.dehydrate`, pinned by
 *     `::LocationV0_6Test.test_list`);
 *   - a PATCH answers **202** with a BARE ARRAY of ids in request order
 *     (`api/resources/__init__.py::patch_list_replica` serializes
 *     `[bundle.data['_id'] for bundle in bundles_seen]`, and
 *     `::test_successful_patch_list` asserts the 202);
 *   - and a `LocationAPIError` is a tastypie `BadRequest`, so the whole
 *     `@atomic` batch rolls back and the answer is 400 with
 *     `{"error": "..."}` (`::test_patch_list_is_atomic`,
 *     `::test_name_unique_among_siblings`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	HQ_LOCATION_PATCH_LIMIT,
	listHqLocations,
	listHqLocationTypes,
	patchHqLocations,
} from "../hq/locations";

const CREDS = {
	username: "user@example.org",
	apiKey: "abc123",
	server: "production",
} as const;
const DOMAIN = "myproject";
const BASE = "https://www.commcarehq.org";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("listHqLocationTypes", () => {
	let fetchMock: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		fetchMock = vi.spyOn(globalThis, "fetch");
	});
	afterEach(() => {
		fetchMock.mockRestore();
	});

	it("reads the v1 path and resolves each parent URI to a code", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({
				meta: { next: null },
				objects: [
					{
						id: 7,
						name: "State",
						code: "state",
						parent: null,
						administrative: true,
						shares_cases: false,
						view_descendants: false,
					},
					{
						id: 8,
						name: "City",
						code: "city",
						parent: `${BASE}/a/${DOMAIN}/api/location_type/v1/7/`,
						administrative: true,
						shares_cases: true,
						view_descendants: true,
					},
				],
			}),
		);

		const result = await listHqLocationTypes(CREDS, DOMAIN);
		expect(result).toEqual([
			{
				id: "7",
				name: "State",
				code: "state",
				parentCode: null,
				administrative: true,
				sharesCases: false,
				viewDescendants: false,
			},
			{
				id: "8",
				name: "City",
				code: "city",
				parentCode: "state",
				administrative: true,
				sharesCases: true,
				viewDescendants: true,
			},
		]);
		const call = fetchMock.mock.calls.at(-1) as [string, RequestInit];
		expect(String(call[0])).toBe(
			`${BASE}/a/${DOMAIN}/api/location_type/v1/?limit=1000`,
		);
		expect((call[1].headers as Record<string, string>).Authorization).toBe(
			`ApiKey ${CREDS.username}:${CREDS.apiKey}`,
		);
	});

	it("refuses rather than reporting an empty level set", async () => {
		// The Organizations privilege gate answers a bodyless 403
		// (`v0_5.py::BaseLocationsResource.dispatch`). Reading that as "there
		// are no levels" would report every place as standing at a level the
		// project space does not have.
		fetchMock.mockResolvedValue(new Response("", { status: 403 }));

		const result = await listHqLocationTypes(CREDS, DOMAIN);
		expect(result).toEqual({
			success: false,
			status: 403,
			edgeRefusal: false,
		});
	});

	it("will not follow a next page off CommCare HQ", async () => {
		fetchMock.mockResolvedValueOnce(
			jsonResponse({
				meta: { next: "https://evil.example.com/steal/" },
				objects: [],
			}),
		);

		const result = await listHqLocationTypes(CREDS, DOMAIN);
		expect(result).toEqual({ success: false, status: 502 });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe("listHqLocations", () => {
	let fetchMock: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		fetchMock = vi.spyOn(globalThis, "fetch");
	});
	afterEach(() => {
		fetchMock.mockRestore();
	});

	it("reads the v2 path and normalizes the empty root parent", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({
				meta: { next: null },
				objects: [
					{
						location_id: "1",
						name: "Colorado",
						site_code: "colorado",
						location_type_code: "state",
						parent_location_id: "",
						location_data: {},
					},
					{
						location_id: "2",
						name: "Denver",
						site_code: "denver",
						location_type_code: "city",
						parent_location_id: "1",
						location_data: { population: "715,522", stale: 3 },
					},
				],
			}),
		);

		const result = await listHqLocations(CREDS, DOMAIN);
		expect(result).toEqual([
			{
				locationId: "1",
				name: "Colorado",
				siteCode: "colorado",
				locationTypeCode: "state",
				parentLocationId: null,
				values: {},
			},
			{
				locationId: "2",
				name: "Denver",
				siteCode: "denver",
				locationTypeCode: "city",
				parentLocationId: "1",
				// The non-string value is dropped: `metadata` is a plain JSON
				// blob, and Nova must not echo back something it could not
				// have written.
				values: { population: "715,522" },
			},
		]);
		expect(String((fetchMock.mock.calls.at(-1) as [string])[0])).toBe(
			`${BASE}/a/${DOMAIN}/api/location/v2/?limit=1000`,
		);
	});

	it("follows meta.next until the pages run out", async () => {
		fetchMock
			.mockResolvedValueOnce(
				jsonResponse({
					meta: {
						next: `/a/${DOMAIN}/api/location/v2/?limit=1000&offset=1000`,
					},
					objects: [
						{
							location_id: "1",
							name: "Colorado",
							site_code: "colorado",
							location_type_code: "state",
							parent_location_id: "",
						},
					],
				}),
			)
			.mockResolvedValueOnce(
				jsonResponse({
					meta: { next: null },
					objects: [
						{
							location_id: "2",
							name: "Denver",
							site_code: "denver",
							location_type_code: "city",
							parent_location_id: "1",
						},
					],
				}),
			);

		const result = await listHqLocations(CREDS, DOMAIN);
		expect(
			Array.isArray(result) && result.map((place) => place.siteCode),
		).toEqual(["colorado", "denver"]);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});

describe("patchHqLocations", () => {
	let fetchMock: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		fetchMock = vi.spyOn(globalThis, "fetch");
	});
	afterEach(() => {
		fetchMock.mockRestore();
	});

	const CREATE = {
		name: "Denver",
		siteCode: "denver",
		locationTypeCode: "city",
		parentLocationId: "1",
	} as const;

	it("sends the objects envelope and reads the bare id array", async () => {
		fetchMock.mockResolvedValue(jsonResponse(["2"], 202));

		const result = await patchHqLocations(CREDS, DOMAIN, [CREATE]);
		expect(result).toEqual({ ids: ["2"] });

		const call = fetchMock.mock.calls.at(-1) as [string, RequestInit];
		expect(String(call[0])).toBe(`${BASE}/a/${DOMAIN}/api/location/v2/`);
		expect(call[1].method).toBe("PATCH");
		expect(JSON.parse(String(call[1].body))).toEqual({
			objects: [
				{
					name: "Denver",
					site_code: "denver",
					location_type_code: "city",
					parent_location_id: "1",
				},
			],
		});
	});

	it("sends location_id only for an update, and never an empty parent", async () => {
		// `_update` looks a parent UP by id, so `""` would 400 the batch;
		// and `obj_update` pops `location_id`, so its presence is the whole
		// create-or-update switch.
		fetchMock.mockResolvedValue(jsonResponse(["1"], 202));

		await patchHqLocations(CREDS, DOMAIN, [
			{
				locationId: "1",
				name: "Colorado",
				siteCode: "colorado",
				locationTypeCode: "state",
			},
		]);
		const body = JSON.parse(
			String((fetchMock.mock.calls.at(-1) as [string, RequestInit])[1].body),
		);
		expect(body.objects[0]).toEqual({
			location_id: "1",
			name: "Colorado",
			site_code: "colorado",
			location_type_code: "state",
		});
		expect("parent_location_id" in body.objects[0]).toBe(false);
	});

	it("always sends the site code, so a rename cannot regenerate it", async () => {
		// `_update` calls `generate_site_code` whenever `name` is present and
		// `site_code` is not, which would repoint the key every bulk upload
		// and worker assignment matches on.
		fetchMock.mockResolvedValue(jsonResponse(["2"], 202));

		await patchHqLocations(CREDS, DOMAIN, [
			{ ...CREATE, locationId: "2", name: "New Denver" },
		]);
		const body = JSON.parse(
			String((fetchMock.mock.calls.at(-1) as [string, RequestInit])[1].body),
		);
		expect(body.objects[0].site_code).toBe("denver");
	});

	it("passes CommCare HQ's own refusal through, verbatim", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse(
				{
					error:
						"Location with same name and parent already exists. Location site code: second_denver.",
				},
				400,
			),
		);

		const result = await patchHqLocations(CREDS, DOMAIN, [CREATE]);
		expect(result).toEqual({
			success: false,
			status: 400,
			message:
				"Location with same name and parent already exists. Location site code: second_denver.",
		});
	});

	it("refuses an answer it cannot match up with what it sent", async () => {
		// Position is the only link between an id and the place it belongs
		// to, so a short answer cannot be read at all: recording the wrong
		// remote id would make the next publish update somebody else's place.
		fetchMock.mockResolvedValue(jsonResponse(["2"], 202));

		const result = await patchHqLocations(CREDS, DOMAIN, [
			CREATE,
			{ ...CREATE, name: "Boulder", siteCode: "boulder" },
		]);
		expect(result).toEqual({ success: false, status: 502, message: "" });
	});

	it("refuses a batch over the atomic limit without asking", async () => {
		const places = Array.from(
			{ length: HQ_LOCATION_PATCH_LIMIT + 1 },
			(_, i) => ({
				...CREATE,
				name: `Place ${i}`,
				siteCode: `place_${i}`,
			}),
		);

		const result = await patchHqLocations(CREDS, DOMAIN, places);
		expect(result).toEqual({ success: false, status: 400, message: "" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("asks nothing for an empty batch", async () => {
		expect(await patchHqLocations(CREDS, DOMAIN, [])).toEqual({ ids: [] });
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
