import type { MockAgent } from "undici";
import { afterEach, expect, it, vi } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import { probeBuildProfile, readBuildXml } from "../client";

const CREDS = {
	username: "account",
	apiKey: "fixture-key",
	server: "eu",
} as const;
const HOST = "https://eu.commcarehq.org";
const PATH = "/a/clinic/apps/download/released-build/profile.ccpr";
const PROFILE = `<profile><suite><resource id="suite" version="3"><location authority="remote">${HOST}/a/clinic/apps/download/released-build/suite.xml</location></resource></suite></profile>`;
const intercept = (peer: MockAgent) =>
	peer.get(HOST).intercept({
		method: "GET",
		path: PATH,
		headers: { authorization: "ApiKey account:fixture-key" },
	});
const probe = () => probeBuildProfile(CREDS, "clinic", "released-build");
afterEach(() => {
	vi.useRealTimers();
});

it("confirms only a profile naming the selected server, project space and released build", async () => {
	await withHttpPeer(async (peer) => {
		intercept(peer).reply(200, PROFILE);
		expect(await probe()).toEqual({ ok: true });
		expect(
			peer
				.getCallHistory()
				?.calls()
				.map(({ method, fullUrl }) => ({ method, fullUrl })),
		).toEqual([{ method: "GET", fullUrl: HOST + PATH }]);
	});
});

it("does not promote empty, unrelated, malformed or wrong-build HTTP 200 bodies to runnable", async () => {
	await withHttpPeer(async (peer) => {
		const bodies = [
			"",
			"profile",
			"<html><body>Sign in</body></html>",
			"<profile>",
			PROFILE.replace("released-build/suite.xml", "working-app/suite.xml"),
			PROFILE.replace("/clinic/", "/another-project/"),
		];
		for (const body of bodies) {
			intercept(peer).reply(200, body);
			expect(await probe(), body).toEqual({ ok: false, reason: "unavailable" });
		}
		expect(peer.getCallHistory()?.calls()).toHaveLength(bodies.length);
	});
});

it("treats only a missing profile as a build verdict and does not follow redirects", async () => {
	await withHttpPeer(async (peer) => {
		const statuses = [404, 401, 403, 429, 400, 500, 503, 302];
		for (const status of statuses) {
			intercept(peer).reply(status, "", {
				headers: { location: "https://must-not-follow.invalid/login" },
			});
			expect(await probe(), String(status)).toEqual({
				ok: false,
				reason: status === 404 ? "not-installable" : "unavailable",
			});
		}
		intercept(peer).replyWithError(new Error("connection reset"));
		expect(await probe()).toEqual({ ok: false, reason: "unavailable" });
		expect(
			peer
				.getCallHistory()
				?.calls()
				.map((call) => call.fullUrl),
		).toEqual(Array(statuses.length + 1).fill(HOST + PATH));
	});
});

it("rejects path-shaped build identifiers at both public readers before a request", async () => {
	await withHttpPeer(async (peer) => {
		expect(
			await readBuildXml(
				CREDS,
				"clinic",
				"../working?latest=true",
				"profile.ccpr",
			),
		).toEqual({ success: false, status: 400 });
		expect(
			await probeBuildProfile(CREDS, "clinic", "../working?latest=true"),
		).toEqual({ ok: false, reason: "unavailable" });
		expect(peer.getCallHistory()?.calls()).toEqual([]);
	});
});

it("bounds an unanswered resource request and releases its timer after abort", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	await withHttpPeer(async (peer) => {
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		intercept(peer).reply(async () => {
			reached.resolve();
			await release.promise;
			return { statusCode: 200, data: PROFILE };
		});
		const pending = readBuildXml(
			CREDS,
			"clinic",
			"released-build",
			"profile.ccpr",
		);
		try {
			await reached.promise;
			await vi.advanceTimersByTimeAsync(30_000);
			expect(await pending).toEqual({ success: false, status: 503 });
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			release.resolve();
			await pending;
		}
		expect(peer.getCallHistory()?.calls()).toHaveLength(1);
	});
});
