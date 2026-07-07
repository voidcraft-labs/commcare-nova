/**
 * Direct tests for `discoverAccessibleDomains` — the list-then-probe
 * orchestration that turns a key's membership list into the spaces it can
 * actually upload to.
 *
 * Mocks the HTTP boundary (`fetch`), not the sibling functions, so the real
 * `listDomains` + `testDomainAccess` wiring runs: a tautological mock of those
 * two couldn't catch a regression in how their results are combined, filtered,
 * or bounded.
 *
 * The bounded-concurrency window is the load-bearing safety property here — an
 * unscoped key on a heavily-shared account can list hundreds of spaces, and an
 * unbounded fan-out would self-inflict a 429 and fail the whole save. One test
 * asserts peak in-flight probes never exceed the window.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { type CommCareApiError, discoverAccessibleDomains } from "../client";

const CREDS = {
	username: "alice@example.com",
	apiKey: "key-xyz",
	server: "production",
} as const;

/** A fetch Response stand-in carrying just what the client reads. */
function res(status: number, body: unknown) {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
		text: async () => JSON.stringify(body),
	} as unknown as Response;
}

/** Build a `/api/user_domains/` page body from a list of domain slugs. */
function userDomainsBody(slugs: string[]) {
	return {
		meta: { limit: 100, next: null, offset: 0, total_count: slugs.length },
		objects: slugs.map((s) => ({ domain_name: s, project_name: `${s} (HR)` })),
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("discoverAccessibleDomains", () => {
	it("returns only the spaces whose app-level probe passes (200), dropping 401s", async () => {
		const slugs = ["alpha", "beta", "gamma"];
		/* beta 401s at the app level (membership without app access) — it must
		 * be filtered out even though user_domains listed it. */
		const probeStatus: Record<string, number> = {
			alpha: 200,
			beta: 401,
			gamma: 200,
		};
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string) => {
				if (url.includes("/api/user_domains/")) {
					return Promise.resolve(res(200, userDomainsBody(slugs)));
				}
				const slug = url.match(/\/a\/([^/]+)\/apps\/api\/list_apps\//)?.[1];
				return Promise.resolve(res(probeStatus[slug ?? ""] ?? 401, {}));
			}),
		);

		const result = await discoverAccessibleDomains(CREDS);
		expect(Array.isArray(result)).toBe(true);
		expect((result as { name: string }[]).map((d) => d.name)).toEqual([
			"alpha",
			"gamma",
		]);
	});

	it("propagates a 5xx from a probe as a CommCareApiError instead of dropping the space", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string) => {
				if (url.includes("/api/user_domains/")) {
					return Promise.resolve(res(200, userDomainsBody(["alpha", "beta"])));
				}
				const slug = url.match(/\/a\/([^/]+)\/apps\/api\/list_apps\//)?.[1];
				return Promise.resolve(res(slug === "beta" ? 503 : 200, {}));
			}),
		);

		const result = await discoverAccessibleDomains(CREDS);
		expect(Array.isArray(result)).toBe(false);
		expect((result as CommCareApiError).status).toBe(503);
	});

	it("propagates a listDomains failure (bad key) without probing", async () => {
		const probe = vi.fn();
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string) => {
				if (url.includes("/api/user_domains/")) {
					return Promise.resolve(res(401, {}));
				}
				probe();
				return Promise.resolve(res(200, {}));
			}),
		);

		const result = await discoverAccessibleDomains(CREDS);
		expect((result as CommCareApiError).status).toBe(401);
		/* No app-level probe should fire when the key itself is invalid. */
		expect(probe).not.toHaveBeenCalled();
	});

	it("sends every request to the credentials' server, not a fixed host", async () => {
		const hosts: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string) => {
				hosts.push(new URL(url).host);
				if (url.includes("/api/user_domains/")) {
					return Promise.resolve(res(200, userDomainsBody(["alpha"])));
				}
				return Promise.resolve(res(200, {}));
			}),
		);

		const result = await discoverAccessibleDomains({ ...CREDS, server: "eu" });
		expect((result as { name: string }[]).map((d) => d.name)).toEqual([
			"alpha",
		]);
		/* An EU key must never be presented to another deployment — a wrong
		 * host both fails auth (separate account DBs) and leaks the key. */
		expect(hosts.length).toBeGreaterThan(0);
		for (const host of hosts) expect(host).toBe("eu.commcarehq.org");
	});

	it("bounds peak in-flight probes to the concurrency window for a many-space key", async () => {
		/* 30 spaces, all reachable — far past the window of 8. */
		const slugs = Array.from({ length: 30 }, (_, i) => `space-${i}`);
		let inFlight = 0;
		let maxInFlight = 0;

		vi.stubGlobal(
			"fetch",
			vi.fn((url: string) => {
				if (url.includes("/api/user_domains/")) {
					return Promise.resolve(res(200, userDomainsBody(slugs)));
				}
				/* Each probe overlaps with its window-mates: bump the counter,
				 * yield a macrotask so the whole window is in flight at once,
				 * then resolve. `maxInFlight` records the peak. */
				inFlight += 1;
				maxInFlight = Math.max(maxInFlight, inFlight);
				return new Promise<Response>((resolve) => {
					setTimeout(() => {
						inFlight -= 1;
						resolve(res(200, {}));
					}, 0);
				});
			}),
		);

		const result = await discoverAccessibleDomains(CREDS);
		expect((result as { name: string }[]).length).toBe(30);
		/* The load-bearing assertion: never more than the window in flight. */
		expect(maxInFlight).toBeLessThanOrEqual(8);
		/* And the window was actually exercised (not accidentally serialized). */
		expect(maxInFlight).toBeGreaterThan(1);
	});
});
