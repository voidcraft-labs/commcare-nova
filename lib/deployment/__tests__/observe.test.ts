/** Actual HQ response decoding and stage decisions; durable folding is tested in Postgres. */
import type { MockAgent } from "undici";
import { expect, it } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import { observeDeployment } from "../observe";

const HOST = "https://eu.commcarehq.org";
const VERSION = "/a/clinic/apps/view/working/current_version/";
const BUILDS = "/a/clinic/api/application/v1/working/";
const PROFILE = "/a/clinic/apps/download/released/profile.ccpr";
const INPUT = {
	creds: { server: "eu" as const, username: "account", apiKey: "fixture-key" },
	domain: "clinic",
	hqAppId: "working",
	now: "2026-09-01T00:00:00.000Z",
};
function reply(peer: MockAgent, path: string, body: unknown, status = 200) {
	peer
		.get(HOST)
		.intercept({
			method: "GET",
			path,
			headers: { authorization: "ApiKey account:fixture-key" },
		})
		.reply(status, typeof body === "string" ? body : JSON.stringify(body), {
			headers: { location: "https://must-not-follow.invalid/login" },
		});
}
function calls(peer: MockAgent) {
	return (
		peer
			.getCallHistory()
			?.calls()
			.map((call) => call.fullUrl) ?? []
	);
}
const success = { status: "succeeded", at: INPUT.now };

it("stops at the first unfinished build or release stage using actual version responses", async () => {
	const examples = [
		{
			current: 1,
			built: null,
			released: null,
			phase: "build",
			reason:
				"CommCare HQ hasn't built this app yet. Open it there and choose Make new version.",
		},
		{
			current: 4,
			built: 2,
			released: 2,
			phase: "build",
			reason:
				"The app on CommCare HQ has changed since its newest build (version 2 of 4). Make a new version there to include those changes.",
		},
		{
			current: 3,
			built: 3,
			released: null,
			phase: "release",
			reason:
				"No build of this app is released yet. Star the build on CommCare HQ's Releases screen to release it.",
		},
		{
			current: 5,
			built: 5,
			released: 3,
			phase: "release",
			reason:
				"The newest build isn't released (released version 3, newest build 5). Star it on the Releases screen.",
		},
	];
	await withHttpPeer(async (peer) => {
		for (const example of examples) {
			reply(peer, VERSION, {
				currentVersion: example.current,
				latestBuild: example.built,
				latestReleasedBuild: example.released,
			});
			expect(await observeDeployment(INPUT)).toEqual({
				kind: "checked",
				outcomes: [
					["upload", success],
					...(example.phase === "release" ? [["build", success]] : []),
					[
						example.phase,
						{ status: "pending", at: INPUT.now, reason: example.reason },
					],
				],
				remoteRevision: example.current,
				releasedBuildId: null,
			});
		}
		expect(calls(peer)).toEqual(Array(examples.length).fill(HOST + VERSION));
	});
});

it.each([
	{
		label: "build-list permission",
		listStatus: 403,
		phaseStatus: "pending",
		detail: "Access APIs permission",
		releasedBuildId: null,
	},
	{
		label: "build-list unavailable",
		listStatus: 500,
		phaseStatus: "pending",
		detail: "didn't answer the request that lists",
		releasedBuildId: null,
	},
	{
		label: "build not listed",
		missingBuild: true,
		phaseStatus: "pending",
		detail: "hasn't listed the matching build",
		releasedBuildId: null,
	},
	{
		label: "missing profile",
		profileStatus: 404,
		phaseStatus: "failed",
		detail: "didn't serve the file",
		releasedBuildId: "released",
	},
	{
		label: "redirecting profile",
		profileStatus: 302,
		phaseStatus: "pending",
		detail: "didn't answer that request",
		releasedBuildId: "released",
	},
])(
	"retains confirmed stages and explains $label without inventing readiness",
	async (example) => {
		await withHttpPeer(async (peer) => {
			reply(peer, VERSION, {
				currentVersion: 2,
				latestBuild: 2,
				latestReleasedBuild: 2,
			});
			reply(
				peer,
				BUILDS,
				{
					versions: example.missingBuild
						? []
						: [{ id: "released", version: 2, is_released: true }],
				},
				example.listStatus ?? 200,
			);
			if (example.profileStatus !== undefined)
				reply(peer, PROFILE, "", example.profileStatus);
			const result = await observeDeployment(INPUT);
			expect(result).toMatchObject({
				kind: "checked",
				remoteRevision: 2,
				releasedBuildId: example.releasedBuildId,
			});
			if (result.kind !== "checked") throw new Error(result.message);
			expect(result.outcomes.slice(0, 3)).toEqual([
				["upload", success],
				["build", success],
				["release", success],
			]);
			expect(result.outcomes).toHaveLength(4);
			expect(result.outcomes[3][0]).toBe("probe");
			const last = result.outcomes[3][1];
			expect(last.status).toBe(example.phaseStatus);
			if (last.status === "failed")
				expect(last.failure).toEqual({
					code: "build_not_installable",
					message: expect.stringContaining(example.detail),
					details: [],
				});
			else if (last.status === "pending")
				expect(last.reason).toContain(example.detail);
			else throw new Error("Unexpected confirmed probe");
			expect(calls(peer)).toEqual(
				[
					VERSION,
					BUILDS,
					...(example.profileStatus !== undefined ? [PROFILE] : []),
				].map((path) => HOST + path),
			);
		});
	},
);

it("classifies malformed version and build-list JSON as unavailable instead of throwing", async () => {
	await withHttpPeer(async (peer) => {
		for (const body of [null, [], {}, "not JSON"]) {
			reply(peer, VERSION, body);
			expect(await observeDeployment(INPUT)).toEqual({
				kind: "unavailable",
				message:
					"Nova couldn't reach CommCare HQ to check on this app. What you see below is the last thing it saw. Try again in a moment.",
			});
		}
		reply(peer, VERSION, {
			currentVersion: 2,
			latestBuild: 2,
			latestReleasedBuild: 2,
		});
		reply(peer, BUILDS, null);
		const result = await observeDeployment(INPUT);
		expect(result).toMatchObject({ kind: "checked", releasedBuildId: null });
		if (result.kind !== "checked") throw new Error(result.message);
		expect(result.outcomes[3]).toEqual([
			"probe",
			{
				status: "pending",
				at: INPUT.now,
				reason:
					"Nova can't confirm the released build installs on a device, because CommCare HQ didn't answer the request that lists this app's builds. Everything above is confirmed. Check again in a moment.",
			},
		]);
		expect(calls(peer)).toEqual([
			...Array(5).fill(HOST + VERSION),
			HOST + BUILDS,
		]);
	});
});
