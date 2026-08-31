import { afterEach, describe, expect, it, vi } from "vitest";
import {
	projectSpaceAdvisoryUse,
	projectSpaceCapabilityUse,
} from "@/lib/publish/projectSpaceCompatibility";
import {
	HQ_PROJECT_SPACE_COMPATIBILITY_PROBE_TIMEOUT_MS,
	probeHqProjectSpaceCompatibility,
} from "../client";
import type { HqProjectSpaceCompatibilityProbePlan } from "../projectSpaceCompatibility";

const CREDS = {
	username: "alice@example.com",
	apiKey: "key-xyz",
	server: "production",
} as const;

const BASE_SEARCH_FLAG = {
	id: "case-search-base",
	slug: "search_claim",
	namespace: "domain",
} as const;
const ADVANCED_SEARCH_FLAG = {
	id: "advanced-case-search",
	slug: "case_search_advanced",
	namespace: "domain",
} as const;
const SEARCH_PERFORMANCE_FLAG = {
	id: "large-search-performance",
	slug: "custom_properties",
	namespace: "domain",
} as const;

function searchPlan(
	advanced = false,
	advisory = false,
): HqProjectSpaceCompatibilityProbePlan {
	return {
		capabilities: [
			{
				capability: projectSpaceCapabilityUse("case-search", [
					"The Patients module uses Search.",
				]),
				featureFlags: [
					BASE_SEARCH_FLAG,
					...(advanced ? [ADVANCED_SEARCH_FLAG] : []),
				],
				runtimeProbes: ["case-search"],
			},
		],
		advisories: advisory
			? [
					{
						advisory: projectSpaceAdvisoryUse("large-search-performance", [
							"The Patients module uses Search.",
						]),
						featureFlags: [SEARCH_PERFORMANCE_FLAG],
						runtimeProbes: [],
					},
				]
			: [],
	};
}

function response(status: number, body: unknown) {
	return {
		ok: status >= 200 && status < 300,
		status,
		body: undefined,
		json: async () => body,
		text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
	} as unknown as Response;
}

function domains(slugs: string[]) {
	return {
		// Current HQ's `DoesNothingPaginator` exposes only this count. Keeping
		// the fixture exact prevents tests from proving a response shape HQ no
		// longer sends.
		meta: { total_count: slugs.length },
		objects: slugs.map((slug) => ({
			domain_name: slug,
			project_name: slug,
		})),
	};
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("probeHqProjectSpaceCompatibility", () => {
	it("combines every applicable private Search check into one capability", async () => {
		const urls: string[] = [];
		const searchResponse = response(200, "case data is never read");
		const searchBodyRead = vi.spyOn(searchResponse, "text");
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string) => {
				urls.push(url);
				const parsed = new URL(url);
				if (parsed.pathname.endsWith("/phone/search/")) {
					return Promise.resolve(searchResponse);
				}
				const flag = parsed.searchParams.get("feature_flag");
				return Promise.resolve(
					response(
						200,
						domains(
							flag === null || flag === "search_claim" ? ["clinic-space"] : [],
						),
					),
				);
			}),
		);

		const result = await probeHqProjectSpaceCompatibility(
			CREDS,
			"clinic-space",
			searchPlan(true),
		);

		expect(result.capabilities).toMatchObject([
			{ capability: { id: "case-search" }, state: "missing" },
		]);
		expect(result.report.status).toBe("blocked");
		expect(searchBodyRead).not.toHaveBeenCalled();
		expect(urls).toHaveLength(4);
		expect(
			urls.map((url) => new URL(url).searchParams.get("feature_flag")),
		).toEqual(
			expect.arrayContaining([null, "search_claim", "case_search_advanced"]),
		);
	});

	it("treats only the exact configured-off Search response as missing", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string) => {
				const parsed = new URL(url);
				if (parsed.pathname.endsWith("/phone/search/")) {
					return Promise.resolve(
						response(404, "Case search is not enabled for this project"),
					);
				}
				return Promise.resolve(response(200, domains(["clinic-space"])));
			}),
		);

		const result = await probeHqProjectSpaceCompatibility(
			CREDS,
			"clinic-space",
			searchPlan(),
		);
		expect(result.capabilities[0]?.state).toBe("missing");
	});

	it("treats every other Search status or body as unverified", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string) => {
				const parsed = new URL(url);
				if (parsed.pathname.endsWith("/phone/search/")) {
					return Promise.resolve(response(404, "Application not found"));
				}
				return Promise.resolve(response(200, domains(["clinic-space"])));
			}),
		);

		const result = await probeHqProjectSpaceCompatibility(
			CREDS,
			"clinic-space",
			searchPlan(),
		);
		expect(result.capabilities[0]?.state).toBe("unverified");
	});

	it("diagnoses the separate connected-account permission on a Search 403", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string) => {
				const parsed = new URL(url);
				if (parsed.pathname.endsWith("/phone/search/")) {
					return Promise.resolve(response(403, "Forbidden"));
				}
				return Promise.resolve(response(200, domains(["clinic-space"])));
			}),
		);

		const result = await probeHqProjectSpaceCompatibility(
			CREDS,
			"clinic-space",
			searchPlan(),
		);

		expect(result.capabilities).toMatchObject([
			{
				capability: { id: "case-search" },
				state: "unverified",
				issue: "connected-account-permission",
			},
		]);
		expect(result.report.blockers).toMatchObject([
			{
				id: "case-search",
				state: "unverified",
				issue: "connected-account-permission",
			},
		]);
		expect(result.report.message).toContain("Mobile App Access");
		expect(result.report.message).not.toContain("access_mobile_endpoints");
		expect(result.report.status).toBe("blocked");
	});

	it("does not accept an unexpected successful Search status", async () => {
		const fetchMock = vi.fn((url: string) => {
			const parsed = new URL(url);
			return Promise.resolve(
				parsed.pathname.endsWith("/phone/search/")
					? response(201, "unexpected response")
					: response(200, domains(["clinic-space"])),
			);
		});
		vi.stubGlobal("fetch", fetchMock);

		const result = await probeHqProjectSpaceCompatibility(
			CREDS,
			"clinic-space",
			searchPlan(),
		);
		expect(result.capabilities[0]?.state).toBe("unverified");
		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining("/phone/search/"),
			expect.objectContaining({ redirect: "manual" }),
		);
	});

	it("keeps every capability unverified when the target is no longer visible", async () => {
		const fetchMock = vi.fn(() =>
			Promise.resolve(response(200, domains(["other-space"]))),
		);
		vi.stubGlobal("fetch", fetchMock);

		const result = await probeHqProjectSpaceCompatibility(
			CREDS,
			"clinic-space",
			searchPlan(),
		);
		expect(result.capabilities[0]?.state).toBe("unverified");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("treats a malformed domain-list response as unverified, never missing", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() =>
				Promise.resolve(
					response(200, {
						meta: { limit: 100, next: null, offset: 0, total_count: 1 },
						objects: [{ project_name: "Missing its domain identity" }],
					}),
				),
			),
		);

		const result = await probeHqProjectSpaceCompatibility(
			CREDS,
			"clinic-space",
			searchPlan(),
		);
		expect(result.capabilities[0]?.state).toBe("unverified");
	});

	it("reports an available performance advisory without making it required", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string) => {
				const parsed = new URL(url);
				if (parsed.pathname.endsWith("/phone/search/")) {
					return Promise.resolve(response(200, "ignored"));
				}
				return Promise.resolve(response(200, domains(["clinic-space"])));
			}),
		);

		const result = await probeHqProjectSpaceCompatibility(
			CREDS,
			"clinic-space",
			searchPlan(false, true),
		);
		expect(result.availableAdvisories).toEqual(["large-search-performance"]);
		expect(result.report.status).toBe("ready");
	});

	it("degrades a hung check to unverified within a fixed deadline", async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			"fetch",
			vi.fn(
				(_input: RequestInfo | URL, init?: RequestInit) =>
					new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener(
							"abort",
							() => reject(init.signal?.reason),
							{ once: true },
						);
					}),
			),
		);

		const pending = probeHqProjectSpaceCompatibility(
			CREDS,
			"clinic-space",
			searchPlan(),
		);
		await vi.advanceTimersByTimeAsync(
			HQ_PROJECT_SPACE_COMPATIBILITY_PROBE_TIMEOUT_MS,
		);

		await expect(pending).resolves.toMatchObject({
			capabilities: [{ state: "unverified" }],
		});
	});

	it("treats a foreign pagination pointer as unverified", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() =>
				Promise.resolve(
					response(200, {
						meta: {
							limit: 1,
							next: "https://attacker.example/steal",
							offset: 0,
							total_count: 2,
						},
						objects: [],
					}),
				),
			),
		);

		const result = await probeHqProjectSpaceCompatibility(
			CREDS,
			"clinic-space",
			searchPlan(),
		);
		expect(result.capabilities[0]?.state).toBe("unverified");
	});
});
