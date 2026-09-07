/** Membership and app-access discovery against the actual native HTTP path. */
import { afterEach, expect, it, vi } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import {
	discoverAccessibleDomains,
	listDomains,
	testDomainAccess,
} from "../client";

const CREDS = { username: "account", apiKey: "key", server: "eu" } as const;
const HOST = "https://eu.commcarehq.org";
const LIST = "/api/user_domains/v1/?limit=100";
const AUTH = { authorization: "ApiKey account:key" };
const memberships = (names: string[], meta: object = {}) => ({
	meta: { total_count: names.length, ...meta },
	objects: names.map((name) => ({
		domain_name: name,
		project_name: `${name} display`,
	})),
});
const accessPath = (domain: string) => `/a/${domain}/apps/api/list_apps/`;
afterEach(() => vi.useRealTimers());

it("retains only accessible memberships with exact display names on the selected server", async () => {
	await withHttpPeer(async (peer) => {
		peer
			.get(HOST)
			.intercept({ path: LIST, method: "GET", headers: AUTH })
			.reply(200, memberships(["alpha", "beta", "gamma", "delta"]));
		for (const [domain, status] of [
			["alpha", 200],
			["beta", 401],
			["gamma", 200],
			["delta", 403],
		] as const)
			peer
				.get(HOST)
				.intercept({ path: accessPath(domain), method: "GET", headers: AUTH })
				.reply(status, { status: "success", applications: [] });
		expect(await discoverAccessibleDomains(CREDS)).toEqual([
			{ name: "alpha", displayName: "alpha display" },
			{ name: "gamma", displayName: "gamma display" },
		]);
		expect(
			peer
				.getCallHistory()
				?.calls()
				.map((call) => call.fullUrl),
		).toEqual([
			HOST + LIST,
			...["alpha", "beta", "gamma", "delta"].map(
				(name) => HOST + accessPath(name),
			),
		]);
	});
});

it("reads current unpaginated membership and older same-endpoint pages without guessing a missing page", async () => {
	await withHttpPeer(async (peer) => {
		peer
			.get(HOST)
			.intercept({ path: LIST, method: "GET" })
			.reply(
				200,
				memberships(["alpha"], {
					total_count: 2,
					next: "?limit=100&offset=100",
				}),
			);
		peer
			.get(HOST)
			.intercept({
				path: "/api/user_domains/v1/?limit=100&offset=100",
				method: "GET",
			})
			.reply(200, {
				meta: { total_count: 2, next: null },
				objects: [{ domain_name: "beta", project_name: null }],
			});
		expect(await listDomains(CREDS)).toEqual([
			{ name: "alpha", displayName: "alpha display" },
			{ name: "beta", displayName: "beta" },
		]);
		peer
			.get(HOST)
			.intercept({ path: LIST, method: "GET" })
			.reply(200, memberships([]));
		expect(await discoverAccessibleDomains(CREDS)).toEqual([]);
		expect(peer.getCallHistory()?.calls()).toHaveLength(3);
	});
});

it("refuses malformed, duplicated, incomplete or unroutable memberships before app probes", async () => {
	const invalid: unknown[] = [
		null,
		[],
		{},
		memberships(["alpha"], { total_count: 2 }),
		memberships(["alpha"], { total_count: -1 }),
		memberships(["alpha"], { total_count: 1.5 }),
		memberships(["alpha", "alpha"]),
		memberships([".."]),
		memberships([""]),
		memberships(["alpha/beta"]),
		{ meta: { total_count: 1 }, objects: [{}] },
	];
	await withHttpPeer(async (peer) => {
		for (const data of invalid) {
			peer
				.get(HOST)
				.intercept({ path: LIST, method: "GET" })
				.reply(200, JSON.stringify(data));
			expect(
				await discoverAccessibleDomains(CREDS),
				JSON.stringify(data),
			).toEqual({ success: false, status: 502 });
		}
		expect(
			peer
				.getCallHistory()
				?.calls()
				.map((call) => call.fullUrl),
		).toEqual(Array(invalid.length).fill(HOST + LIST));
	});
});

it("refuses malformed or changed pagination targets and HTTP redirects without following them", async () => {
	await withHttpPeer(async (peer) => {
		const cursors = [
			"http://[",
			"https://outside.invalid/",
			"/a/other/api/application/v1/",
			"/api/user_domains/v1/?feature_flag=unrelated",
			"/api/user_domains/v1/#fragment",
			"https://user:pass@eu.commcarehq.org/api/user_domains/v1/",
			"",
		];
		for (const next of cursors) {
			peer
				.get(HOST)
				.intercept({ path: LIST, method: "GET" })
				.reply(200, memberships(["alpha"], { next }));
			expect(await listDomains(CREDS), next).toEqual({
				success: false,
				status: 502,
			});
		}
		peer
			.get(HOST)
			.intercept({ path: LIST, method: "GET" })
			.reply(302, "Redirect", {
				headers: { location: "/api/user_domains/v1/?feature_flag=unrelated" },
			});
		expect(await listDomains(CREDS)).toEqual({
			success: false,
			status: 302,
			edgeRefusal: false,
		});
		expect(
			peer
				.getCallHistory()
				?.calls()
				.map((call) => call.fullUrl),
		).toEqual(Array(cursors.length + 1).fill(HOST + LIST));
	});
});

it("returns transport, JSON, permission and throttle failures rather than incomplete membership", async () => {
	await withHttpPeer(async (peer) => {
		for (const status of [401, 403, 429, 503]) {
			peer
				.get(HOST)
				.intercept({ path: LIST, method: "GET" })
				.reply(status, "Refused");
			expect(await discoverAccessibleDomains(CREDS)).toEqual({
				success: false,
				status,
				edgeRefusal: false,
			});
		}
		peer
			.get(HOST)
			.intercept({ path: LIST, method: "GET" })
			.reply(200, "<html>Sign in</html>");
		expect(await discoverAccessibleDomains(CREDS)).toEqual({
			success: false,
			status: 502,
		});
		peer
			.get(HOST)
			.intercept({ path: LIST, method: "GET" })
			.replyWithError(new Error("reset"));
		expect(await discoverAccessibleDomains(CREDS)).toEqual({
			success: false,
			status: 503,
		});
		expect(
			peer
				.getCallHistory()
				?.calls()
				.map((call) => call.fullUrl),
		).toEqual(Array(6).fill(HOST + LIST));
	});
});

it("does not call a redirected or HTML login page successful app access", async () => {
	await withHttpPeer(async (peer) => {
		peer
			.get(HOST)
			.intercept({ path: accessPath("alpha"), method: "GET" })
			.reply(302, "Redirect", { headers: { location: "/accounts/login/" } });
		expect(await testDomainAccess(CREDS, "alpha")).toEqual({
			success: false,
			status: 302,
			edgeRefusal: false,
		});
		peer
			.get(HOST)
			.intercept({ path: accessPath("alpha"), method: "GET" })
			.reply(200, "<html>Sign in</html>");
		expect(await testDomainAccess(CREDS, "alpha")).toEqual({
			success: false,
			status: 502,
		});
		expect(
			peer
				.getCallHistory()
				?.calls()
				.map((call) => call.fullUrl),
		).toEqual(Array(2).fill(HOST + accessPath("alpha")));
	});
});

it("owns and drains each eight-request window before starting another", async () => {
	const names = Array.from({ length: 30 }, (_, i) => `space-${i}`);
	const gates = Array.from({ length: 4 }, () => ({
		reached: Promise.withResolvers<void>(),
		release: Promise.withResolvers<void>(),
		count: 0,
	}));
	let active = 0,
		maximum = 0;
	await withHttpPeer(async (peer) => {
		peer
			.get(HOST)
			.intercept({ path: LIST, method: "GET" })
			.reply(200, memberships(names));
		names.forEach((name, index) => {
			const gate = gates[Math.floor(index / 8)];
			peer
				.get(HOST)
				.intercept({ path: accessPath(name), method: "GET", headers: AUTH })
				.reply(async () => {
					active++;
					maximum = Math.max(maximum, active);
					gate.count++;
					if (gate.count === (index < 24 ? 8 : 6)) gate.reached.resolve();
					try {
						await gate.release.promise;
						return {
							statusCode: 200,
							data: JSON.stringify({ status: "success", applications: [] }),
						};
					} finally {
						active--;
					}
				});
		});
		const pending = discoverAccessibleDomains(CREDS);
		try {
			for (let i = 0; i < gates.length; i++) {
				await gates[i].reached.promise;
				expect(active).toBe(i === 3 ? 6 : 8);
				expect(peer.getCallHistory()?.calls()).toHaveLength(
					1 + Math.min((i + 1) * 8, names.length),
				);
				gates[i].release.resolve();
			}
			expect(await pending).toEqual(
				names.map((name) => ({ name, displayName: `${name} display` })),
			);
			expect(maximum).toBe(8);
			expect(active).toBe(0);
		} finally {
			for (const gate of gates) gate.release.resolve();
			await pending;
		}
	});
});

it("finishes in-flight probes but starts no next window after a transport failure", async () => {
	const names = Array.from({ length: 9 }, (_, i) => `space-${i}`);
	const reached = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	let active = 0,
		settled = false;
	await withHttpPeer(async (peer) => {
		peer
			.get(HOST)
			.intercept({ path: LIST, method: "GET" })
			.reply(200, memberships(names));
		peer
			.get(HOST)
			.intercept({ path: accessPath(names[0]), method: "GET" })
			.replyWithError(new Error("reset"));
		for (const name of names.slice(1, 8))
			peer
				.get(HOST)
				.intercept({ path: accessPath(name), method: "GET" })
				.reply(async () => {
					active++;
					if (active === 7) reached.resolve();
					try {
						await release.promise;
						return {
							statusCode: 200,
							data: JSON.stringify({ status: "success", applications: [] }),
						};
					} finally {
						active--;
					}
				});
		const pending = discoverAccessibleDomains(CREDS).then(
			(value) => {
				settled = true;
				return { value };
			},
			(error) => {
				settled = true;
				return { error };
			},
		);
		try {
			await reached.promise;
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(settled).toBe(false);
			release.resolve();
			expect(await pending).toEqual({ value: { success: false, status: 503 } });
			expect(active).toBe(0);
		} finally {
			release.resolve();
			await pending;
		}
		expect(peer.getCallHistory()?.calls()).toHaveLength(9);
	});
});

it.each(["membership", "app access"] as const)(
	"bounds an unanswered %s read and clears its timer",
	async (kind) => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		await withHttpPeer(async (peer) => {
			const reached = Promise.withResolvers<void>(),
				release = Promise.withResolvers<void>();
			peer
				.get(HOST)
				.intercept({
					path: kind === "membership" ? LIST : accessPath("alpha"),
					method: "GET",
				})
				.reply(async () => {
					reached.resolve();
					await release.promise;
					return {
						statusCode: 200,
						data: JSON.stringify(
							kind === "membership"
								? memberships([])
								: { status: "success", applications: [] },
						),
					};
				});
			const pending =
				kind === "membership"
					? listDomains(CREDS)
					: testDomainAccess(CREDS, "alpha");
			try {
				await reached.promise;
				await vi.advanceTimersByTimeAsync(30_000);
				expect(await pending).toEqual({ success: false, status: 503 });
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				release.resolve();
				await pending;
			}
		});
	},
);
