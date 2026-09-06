import { afterEach, expect, it, vi } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import { readHqAppSourceProfile } from "../hq/appSource";

const CREDS = { username: "account", apiKey: "key", server: "india" } as const;
const HOST = "https://india.commcarehq.org";
const PATH = "/a/clinic/apps/source/working-app/";
const read = () => readHqAppSourceProfile(CREDS, "clinic", "working-app");
afterEach(() => vi.useRealTimers());

it("reads the whole target profile, including foreign JSON values and an explicitly empty bag", async () => {
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
	await withHttpPeer(async (peer) => {
		peer
			.get(HOST)
			.intercept({
				path: PATH,
				method: "GET",
				headers: { authorization: "ApiKey account:key" },
			})
			.reply(200, { profile });
		peer
			.get(HOST)
			.intercept({ path: PATH, method: "GET" })
			.reply(200, { profile: {} });
		expect(await read()).toEqual({ profile });
		expect(await read()).toEqual({ profile: {} });
	});
});

it("refuses missing or malformed profiles instead of authorizing an empty replacement", async () => {
	await withHttpPeer(async (peer) => {
		const invalid = [
			null,
			[],
			{},
			{ profile: [] },
			{ profile: { custom_properties: [] } },
			{ profile: null },
		];
		for (const body of invalid)
			peer
				.get(HOST)
				.intercept({ path: PATH, method: "GET" })
				.reply(200, JSON.stringify(body));
		peer
			.get(HOST)
			.intercept({ path: PATH, method: "GET" })
			.reply(200, "<html>Sign in</html>");
		for (let i = 0; i < invalid.length + 1; i++)
			expect(await read()).toEqual({ success: false, status: 502 });
	});
});

it("keeps refusals and disconnects explicit and follows no redirect even to another project on the same host", async () => {
	await withHttpPeer(async (peer) => {
		for (const status of [401, 403, 404, 503, 302]) {
			peer
				.get(HOST)
				.intercept({ path: PATH, method: "GET" })
				.reply(status, "Refused", {
					headers: { location: "/a/other/apps/source/working-app/" },
				});
			expect(await read()).toEqual({
				success: false,
				status,
				edgeRefusal: false,
			});
		}
		peer
			.get(HOST)
			.intercept({ path: PATH, method: "GET" })
			.replyWithError(new Error("connection lost"));
		expect(await read()).toEqual({ success: false, status: 503 });
		expect(
			peer
				.getCallHistory()
				?.calls()
				.map((call) => call.fullUrl),
		).toEqual(Array(6).fill(HOST + PATH));
	});
});

it("rejects an invalid project or app path before requesting source", async () => {
	await withHttpPeer(async (peer) => {
		for (const [domain, app] of [
			[".", "working-app"],
			["..", "working-app"],
			["clinic/space", "working-app"],
			["clinic", ".."],
			["clinic", "../other"],
			["clinic", ""],
		])
			expect(await readHqAppSourceProfile(CREDS, domain, app)).toEqual({
				success: false,
				status: 400,
			});
		expect(peer.getCallHistory()?.calls()).toEqual([]);
	});
});

it("aborts an unanswered source request and releases its sole deadline", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	await withHttpPeer(async (peer) => {
		const reached = Promise.withResolvers<void>(),
			release = Promise.withResolvers<void>();
		peer
			.get(HOST)
			.intercept({ path: PATH, method: "GET" })
			.reply(async () => {
				reached.resolve();
				await release.promise;
				return { statusCode: 200, data: JSON.stringify({ profile: {} }) };
			});
		const pending = read();
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
});
