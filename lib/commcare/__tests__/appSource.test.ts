import { beforeEach, describe, expect, it, vi } from "vitest";
import { readHqAppSourceProfile } from "../hq/appSource";

const creds = {
	username: "editor@example.com",
	apiKey: "secret",
	server: "production" as const,
};

describe("readHqAppSourceProfile", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("reads the complete profile through the API-key source endpoint", async () => {
		const profile = {
			features: { users: { active: true } },
			properties: { foreign: { value: "standing" } },
			custom_properties: {
				foreign: "kept",
				nullable: null,
				numeric: 3,
				enabled: true,
				nested: { source: "hq" },
			},
		};
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(
				new Response(JSON.stringify({ profile }), { status: 200 }),
			);

		await expect(
			readHqAppSourceProfile(creds, "clinic-space", "hq-app"),
		).resolves.toEqual({ profile });
		expect(fetchMock).toHaveBeenCalledWith(
			"https://www.commcarehq.org/a/clinic-space/apps/source/hq-app/",
			{
				headers: { Authorization: "ApiKey editor@example.com:secret" },
			},
		);
	});

	it.each([
		["missing profile", {}],
		["non-object profile", { profile: [] }],
		["non-object custom properties", { profile: { custom_properties: [] } }],
	])("refuses a %s rather than treating it as empty", async (_name, source) => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify(source), { status: 200 }),
		);

		await expect(
			readHqAppSourceProfile(creds, "clinic-space", "hq-app"),
		).resolves.toEqual({ success: false, status: 502 });
	});

	it("returns an unavailable result when HQ refuses the read", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("forbidden", { status: 403 }),
		);

		await expect(
			readHqAppSourceProfile(creds, "clinic-space", "hq-app"),
		).resolves.toMatchObject({ success: false, status: 403 });
	});

	it("rejects an invalid domain before making a request", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch");

		await expect(
			readHqAppSourceProfile(creds, "clinic/space", "hq-app"),
		).resolves.toEqual({ success: false, status: 400 });
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
