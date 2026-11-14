import { afterEach, expect, it, vi } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import { readAppVersions } from "../client";

const CREDS = { username: "account", apiKey: "key", server: "india" } as const;
const HOST = "https://india.commcarehq.org";
const VERSIONS = "/a/clinic/apps/view/working-app/current_version/";
const current = {
	currentVersion: 3,
	latestBuild: 2,
	latestReleasedBuild: null,
};
afterEach(() => vi.useRealTimers());

it("requires complete version and release evidence instead of turning malformed values into absent builds", async () => {
	await withHttpPeer(async (peer) => {
		peer
			.get(HOST)
			.intercept({ path: VERSIONS, method: "GET" })
			.reply(200, current);
		expect(await readAppVersions(CREDS, "clinic", "working-app")).toEqual({
			currentVersion: 3,
			latestBuildVersion: 2,
			latestReleasedVersion: null,
		});
		for (const data of [
			null,
			[],
			{},
			{ ...current, currentVersion: -1 },
			{ ...current, latestBuild: "2" },
			{ ...current, latestReleasedBuild: false },
			{ currentVersion: 3 },
		]) {
			peer
				.get(HOST)
				.intercept({ path: VERSIONS, method: "GET" })
				.reply(200, JSON.stringify(data));
			expect(
				await readAppVersions(CREDS, "clinic", "working-app"),
				JSON.stringify(data),
			).toEqual({ success: false, status: 502, cause: "malformed" });
		}
	});
});

it("binds the version read to one app and bounds unanswered requests", async () => {
	const path = VERSIONS;
	const read = readAppVersions;
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	await withHttpPeer(async (peer) => {
		for (const appId of ["..", "", "../other", "working-app?latest=true"])
			expect(await read(CREDS, "clinic", appId)).toEqual({
				success: false,
				status: 400,
			});
		peer
			.get(HOST)
			.intercept({ path, method: "GET" })
			.reply(302, "Moved", {
				headers: { location: path.replace("clinic", "other") },
			});
		expect(await read(CREDS, "clinic", "working-app")).toEqual({
			success: false,
			status: 302,
			edgeRefusal: false,
		});
		expect(vi.getTimerCount()).toBe(0);
		const reached = Promise.withResolvers<void>(),
			release = Promise.withResolvers<void>();
		peer
			.get(HOST)
			.intercept({ path, method: "GET" })
			.reply(async () => {
				reached.resolve();
				await release.promise;
				return { statusCode: 200, data: "{}" };
			});
		const pending = read(CREDS, "clinic", "working-app");
		try {
			await reached.promise;
			await vi.advanceTimersByTimeAsync(30_000);
			expect(await pending).toEqual({
				success: false,
				status: 503,
				cause: "timeout",
			});
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			release.resolve();
			await pending;
		}
		expect(
			peer
				.getCallHistory()
				?.calls()
				.map((call) => call.fullUrl),
		).toEqual(Array(2).fill(HOST + path));
	});
});
