import { afterEach, describe, expect, it, vi } from "vitest";
import {
	HQ_FEATURE_FLAG_PROBE_TIMEOUT_MS,
	probeHqFeatureFlags,
} from "../client";
import { HQ_FEATURE_FLAG_REQUIREMENTS } from "../featureFlags";

const CREDS = {
	username: "alice@example.com",
	apiKey: "key-xyz",
	server: "production",
} as const;

function response(status: number, body: unknown) {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
		text: async () => JSON.stringify(body),
	} as unknown as Response;
}

function domains(slugs: string[]) {
	return {
		meta: { limit: 100, next: null, offset: 0, total_count: slugs.length },
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

describe("probeHqFeatureFlags", () => {
	it("verifies live domain access before one filtered request per requirement", async () => {
		const urls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string) => {
				urls.push(url);
				const flag = new URL(url).searchParams.get("feature_flag");
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

		const result = await probeHqFeatureFlags(
			CREDS,
			"clinic-space",
			HQ_FEATURE_FLAG_REQUIREMENTS.slice(0, 2),
		);
		expect(result.map((probe) => probe.state)).toEqual(["enabled", "missing"]);
		expect(urls).toHaveLength(3);
		expect(
			urls.map((url) => new URL(url).searchParams.get("feature_flag")),
		).toEqual(
			expect.arrayContaining([null, "search_claim", "case_search_advanced"]),
		);
	});

	it("keeps every flag unavailable when a stored domain is no longer visible", async () => {
		const urls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string) => {
				urls.push(url);
				return Promise.resolve(response(200, domains(["other-space"])));
			}),
		);

		const result = await probeHqFeatureFlags(
			CREDS,
			"clinic-space",
			HQ_FEATURE_FLAG_REQUIREMENTS.slice(0, 2),
		);

		expect(result.map((probe) => probe.state)).toEqual([
			"unavailable",
			"unavailable",
		]);
		expect(urls).toHaveLength(1);
		expect(new URL(urls[0]).searchParams.has("feature_flag")).toBe(false);
	});

	it("keeps a retired slug or transport failure unavailable, never missing", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(response(200, domains(["clinic-space"])))
				.mockResolvedValueOnce(response(400, { error: "unknown toggle" }))
				.mockRejectedValueOnce(new Error("network down")),
		);

		const result = await probeHqFeatureFlags(
			CREDS,
			"clinic-space",
			HQ_FEATURE_FLAG_REQUIREMENTS.slice(0, 2),
		);
		expect(result.map((probe) => probe.state)).toEqual([
			"unavailable",
			"unavailable",
		]);
	});

	it("follows pagination before deciding a flag is missing", async () => {
		const firstPage = {
			meta: {
				limit: 1,
				next: "/api/user_domains/v1/?limit=1&offset=1&feature_flag=search_claim",
				offset: 0,
				total_count: 2,
			},
			objects: [{ domain_name: "other-space", project_name: "Other" }],
		};
		const secondPage = domains(["clinic-space"]);
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(response(200, domains(["clinic-space"])))
			.mockResolvedValueOnce(response(200, firstPage))
			.mockResolvedValueOnce(response(200, secondPage));
		vi.stubGlobal("fetch", fetchMock);

		const result = await probeHqFeatureFlags(
			CREDS,
			"clinic-space",
			HQ_FEATURE_FLAG_REQUIREMENTS.slice(0, 1),
		);

		expect(result[0]?.state).toBe("enabled");
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("degrades a hung diagnostic to unavailable within a fixed deadline", async () => {
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

		const pending = probeHqFeatureFlags(
			CREDS,
			"clinic-space",
			HQ_FEATURE_FLAG_REQUIREMENTS.slice(0, 1),
		);
		await vi.advanceTimersByTimeAsync(HQ_FEATURE_FLAG_PROBE_TIMEOUT_MS);

		await expect(pending).resolves.toMatchObject([{ state: "unavailable" }]);
	});

	it("treats a foreign pagination pointer as unavailable, not missing", async () => {
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

		const result = await probeHqFeatureFlags(
			CREDS,
			"clinic-space",
			HQ_FEATURE_FLAG_REQUIREMENTS.slice(0, 1),
		);

		expect(result[0]?.state).toBe("unavailable");
	});
});
