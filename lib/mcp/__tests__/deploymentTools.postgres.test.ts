/** Actual deployment projections and refreshes through SDK, Postgres, and HTTP. */
import { gzipSync } from "node:zlib";
import type { Client } from "@modelcontextprotocol/client";
import { sql } from "kysely";
import type { MockAgent } from "undici";
import { beforeEach, expect, it, vi } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import {
	applicationAnswer,
	retainedBodyText,
	retainedPublishRead,
} from "@/__tests__/helpers/retainedHqReads";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { decrypt } from "@/lib/commcare/encryption";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { normalizeHqAppSource } from "@/lib/deployment/hqSourceBaseline";
import {
	applyDeploymentObservation,
	foldDeploymentAttempt,
	readDeployment,
	readTargetFacts,
	recordCreatedRemoteApp,
	recordRemoteResource,
} from "@/lib/deployment/store";
import { keptListFor } from "@/lib/deployment/targetFacts";
import type { AppOwnership } from "@/lib/deployment/types";
import { log } from "@/lib/logger";
import { KEPT_LABELS, keptListUnreadSentence } from "@/lib/publish/keptValues";
import {
	registerGetDeployment,
	registerRefreshDeployment,
} from "../tools/deploymentTools";
import { registerWithdrawDeploymentConfirmation } from "../tools/withdrawDeploymentConfirmation";
import { withMcpClient } from "./client";
import { resultText } from "./resultText";

vi.mock("@/lib/commcare/encryption", () => ({ decrypt: vi.fn() }));
vi.mock("@/lib/deployment/store", async (original) => {
	const store = await original<typeof import("@/lib/deployment/store")>();
	return { ...store, readTargetFacts: vi.fn(store.readTargetFacts) };
});
beforeEach(() => {
	vi.mocked(decrypt).mockReset();
	vi.mocked(decrypt).mockResolvedValue("fixture-key");
});
const h = setupAppStateTestDb("mcp_deployment_", { authSchema: "migrated" });
const APP = "published-app",
	PROJECT = "program",
	ACTOR = "editor";
const TARGET = { server: "india" as const, domain: "clinic" };
const SCOPE = {
	appId: APP,
	projectId: PROJECT,
	actorUserId: ACTOR,
	role: "editor",
};
const HOST = "https://india.commcarehq.org";
const VERSION_PATH = "/a/clinic/apps/view/working-app/current_version/";
const BUILD_PATH = "/a/clinic/api/application/v1/working-app/";
const PROFILE_PATH = "/a/clinic/apps/download/released-build/profile.ccpr";
const PROFILE = `<profile><suite><resource id="suite"><location authority="remote">${HOST}/a/clinic/apps/download/released-build/suite.xml</location></resource></suite></profile>`;
const GET = "get_deployment",
	REFRESH = "refresh_deployment",
	WITHDRAW = "withdraw_deployment_confirmation";
function asUser<T>(
	run: (client: Client) => Promise<T>,
	userId = ACTOR,
	scopes = ["nova.read", "nova.hq.read", "nova.hq.write"],
) {
	return withMcpClient((server) => {
		const ctx = { userId, scopes, authKind: "oauth" as const };
		registerGetDeployment(server, ctx);
		registerRefreshDeployment(server, ctx);
		registerWithdrawDeploymentConfirmation(server, ctx);
	}, run);
}
function call(
	client: Client,
	name = REFRESH,
	args: Record<string, unknown> = { app_id: APP, ...TARGET },
) {
	return client.callTool({ name, arguments: args });
}
function errorBody(result: Awaited<ReturnType<typeof call>>) {
	expect(result.isError).toBe(true);
	expect(result.content).toEqual([{ type: "text", text: expect.any(String) }]);
	const part = result.content[0];
	if (part.type !== "text") throw new Error("Expected text error");
	return JSON.parse(part.text);
}
async function refresh(client: Client, args?: Record<string, unknown>) {
	const result = await call(client, REFRESH, args);
	expect(result.isError, JSON.stringify(result)).not.toBe(true);
	return JSON.parse(resultText(result));
}
function reply(peer: MockAgent, path: string, data: unknown, status = 200) {
	return peer
		.get(HOST)
		.intercept({
			path,
			method: "GET",
			headers: { authorization: "ApiKey account:fixture-key" },
		})
		.reply(status, typeof data === "string" ? data : JSON.stringify(data));
}
function ready(peer: MockAgent, profile = PROFILE, profileStatus = 200) {
	reply(peer, VERSION_PATH, {
		currentVersion: 3,
		latestBuild: 3,
		latestReleasedBuild: 3,
	});
	reply(
		peer,
		BUILD_PATH,
		applicationAnswer("working-app", [
			{ id: "wrong-unreleased", version: 3, is_released: false },
			{ id: "released-build", version: 3, is_released: true },
		]).body,
	);
	reply(peer, PROFILE_PATH, profile, profileStatus);
}
function urls(peer: MockAgent) {
	return (
		peer
			.getCallHistory()
			?.calls()
			.map(({ method, fullUrl }) => ({ method, fullUrl })) ?? []
	);
}
async function snapshot() {
	return {
		deployments: await h
			.db()
			.selectFrom("app_deployments")
			.selectAll()
			.orderBy("id")
			.execute(),
		resources: await h
			.db()
			.selectFrom("app_deployment_resources")
			.selectAll()
			.orderBy("id")
			.execute(),
	};
}
async function record(remoteId = "working-app", target = TARGET) {
	await foldDeploymentAttempt(
		SCOPE,
		target,
		"preflight",
		{ status: "succeeded", at: "2026-09-01T00:00:00.000Z" },
		{ ensure: true },
	);
	return recordRemoteResource(SCOPE, target, {
		kind: "app",
		novaResourceId: APP,
		remoteId,
		ownership: "nova-created",
		pushedRevision: 0,
		remoteRevision: 1,
		uploadedAt: "2026-09-01T00:00:00.000Z",
		baseline: {
			origin: "unread",
			remoteAppId: remoteId,
			sourceGzip: null,
			sourceBytes: null,
			sourceDigest: null,
			ownership: null,
			observedAt: "2026-09-01T00:00:00.000Z",
			discard: null,
		},
	});
}
async function seed(published = true, runsOnlyOn?: "android") {
	const doc = buildDoc({
		appName: "Visits",
		modules: [
			{
				name: "Visits",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: [{ id: "note", kind: "text" }],
					},
				],
			},
		],
	});
	if (runsOnlyOn !== undefined)
		doc.appSettings = { ...doc.appSettings, runsOnlyOn };
	await h.seedAppWithBlueprint(doc, {
		id: APP,
		owner: "creator",
		projectId: PROJECT,
	});
	await h.seedProjectMember(ACTOR, PROJECT, "editor");
	await h.seedProjectMember("viewer", PROJECT, "viewer");
	await h
		.db()
		.insertInto("user_settings")
		.values({
			user_id: ACTOR,
			commcare_username: "account",
			commcare_api_key: "ciphertext",
			commcare_server: "india",
			approved_domains: JSON.stringify([
				{ name: "clinic", displayName: "Clinic" },
			]),
			updated_at: new Date(),
		})
		.execute();
	if (published) await record();
}

it("reports every stored target to a viewer with its current resource identity and target-specific setup links, without HQ access", async () => {
	await seed();
	await record("previous-app");
	await record("working-app");
	await record("previous-app");
	await record("working-app");
	await record("training-app", { server: "india", domain: "training" });
	const before = await snapshot();
	await withHttpPeer(async (peer) => {
		await asUser(
			async (client) => {
				const body = JSON.parse(
					resultText(await call(client, GET, { app_id: ` ${APP} ` })),
				);
				expect(body.app_id).toBe(APP);
				expect(body.deployments).toHaveLength(2);
				const clinic = body.deployments.find(
					(entry: { domain: string }) => entry.domain === "clinic",
				);
				expect(clinic).toEqual({
					server: "india",
					domain: "clinic",
					state: "uploaded",
					retry_from: null,
					retry_from_state: null,
					hq_app_id: "working-app",
					hq_app_gone: false,
					hq_app_empty: false,
					ownership: "nova-created",
					pushed_revision: 0,
					remote_revision: 1,
					last_checked_at: null,
					phases: {
						preflight: { status: "succeeded", detail: null },
						resources: null,
						upload: { status: "succeeded", detail: null },
						build: null,
						release: null,
						probe: null,
					},
					left_behind: [{ kind: "app", hq_id: "previous-app", hq_name: null }],
					confirmations: [],
					/* The publish's read-back failed and recorded an unread
					 * baseline, so Nova holds no read of the kept settings. */
					kept: null,
					setup_artifact: expect.any(Object),
				});
				for (const deployment of body.deployments) {
					expect(deployment.setup_artifact).toMatchObject({
						server: "india",
						domain: deployment.domain,
						hqAppId: deployment.hq_app_id,
					});
					expect(
						deployment.setup_artifact.sections.map(
							(section: { id: string; url: string }) => ({
								id: section.id,
								url: section.url,
							}),
						),
					).toEqual([
						{
							id: "build-and-release",
							url: `${HOST}/a/${deployment.domain}/apps/view/${deployment.hq_app_id}/releases/`,
						},
						{
							id: "web-apps",
							url: `${HOST}/a/${deployment.domain}/cloudcare/apps/v2/`,
						},
					]);
				}
			},
			"viewer",
			["nova.read", "nova.hq.read"],
		);
		expect(urls(peer)).toEqual([]);
		expect(decrypt).not.toHaveBeenCalled();
	});
	expect(await snapshot()).toEqual(before);
});

it("records readiness from the exact released profile, survives an unavailable check, and moves backward when the release is withdrawn", async () => {
	await seed();
	await withHttpPeer(async (peer) => {
		await asUser(async (client) => {
			ready(peer);
			const readyResult = await refresh(client, {
				app_id: ` ${APP} `,
				server: "india",
				domain: " clinic ",
			});
			expect(readyResult).toMatchObject({
				app_id: APP,
				state: "runnable",
				hq_app_id: "working-app",
				pushed_revision: 0,
				remote_revision: 3,
				retry_from: null,
				last_checked_at: expect.any(String),
			});
			expect(readyResult.phases).toEqual({
				preflight: { status: "succeeded", detail: null },
				resources: null,
				upload: { status: "succeeded", detail: null },
				build: { status: "succeeded", detail: null },
				release: { status: "succeeded", detail: null },
				probe: { status: "succeeded", detail: null },
			});
			const before = await snapshot();
			expect(before.deployments[0].state).toBe("runnable");
			expect(before.resources[0].remote_revision).toBe("3");
			reply(peer, VERSION_PATH, "unavailable", 503);
			expect(errorBody(await call(client))).toMatchObject({
				error_type: "invalid_input",
				message: expect.stringContaining("couldn't reach CommCare HQ"),
			});
			expect(await snapshot()).toEqual(before);
			reply(peer, VERSION_PATH, {
				currentVersion: 3,
				latestBuild: 3,
				latestReleasedBuild: "3",
			});
			expect(errorBody(await call(client)).error_type).toBe("invalid_input");
			expect(await snapshot()).toEqual(before);
			reply(peer, VERSION_PATH, {
				currentVersion: 3,
				latestBuild: 3,
				latestReleasedBuild: null,
			});
			const withdrawn = await refresh(client);
			expect(withdrawn.state).toBe("built");
			expect(withdrawn.phases.release).toEqual({
				status: "pending",
				detail:
					"No build of this app is released yet. Star the build on CommCare HQ's Releases screen to release it.",
			});
			expect(withdrawn.phases.probe).toBeNull();
			expect((await snapshot()).deployments[0].state).toBe("built");
		});
		expect(urls(peer)).toEqual(
			[
				VERSION_PATH,
				BUILD_PATH,
				PROFILE_PATH,
				VERSION_PATH,
				VERSION_PATH,
				VERSION_PATH,
			].map((path) => ({ method: "GET", fullUrl: HOST + path })),
		);
	});
});

it.each(["", "<html>Sign in</html>"])(
	"keeps a released build unconfirmed when its successful HTTP response is not an install profile: %j",
	async (body) => {
		await seed();
		await withHttpPeer(async (peer) => {
			ready(peer, body);
			await asUser(async (client) => {
				const result = await refresh(client);
				expect(result.state).toBe("released");
				expect(result.phases.probe).toEqual({
					status: "pending",
					detail:
						"Nova can't confirm the released build installs on a device, because CommCare HQ didn't answer that request. Everything above is confirmed. Check again in a moment.",
				});
			});
			expect((await snapshot()).deployments[0].state).toBe("released");
			expect(urls(peer)).toHaveLength(3);
		});
	},
);

it("names a missing remote app as an upload refusal and heals it when HQ later reports the app restored", async () => {
	await seed();
	await withHttpPeer(async (peer) => {
		await asUser(async (client) => {
			reply(peer, VERSION_PATH, "", 404);
			const gone = await refresh(client);
			expect(gone).toMatchObject({
				state: "incomplete",
				retry_from: "upload",
				retry_from_state: "resources",
				hq_app_id: "working-app",
				hq_app_gone: true,
			});
			expect((await snapshot()).resources[0].remote_missing_at).not.toBeNull();
			expect(gone.phases.upload).toEqual({
				status: "failed",
				detail:
					"The app Nova published to “clinic” isn't there any more. It may have been deleted on CommCare HQ. Publish again to create a new one.",
			});
			reply(peer, VERSION_PATH, {
				currentVersion: 4,
				latestBuild: null,
				latestReleasedBuild: null,
			});
			const restored = await refresh(client);
			expect(restored).toMatchObject({
				state: "uploaded",
				retry_from: null,
				remote_revision: 4,
				hq_app_gone: false,
			});
			expect((await snapshot()).resources[0].remote_missing_at).toBeNull();
			expect(restored.phases.upload).toEqual({
				status: "succeeded",
				detail: null,
			});
			expect(restored.phases.build.status).toBe("pending");
		});
		expect((await snapshot()).deployments[0].state).toBe("uploaded");
		expect(urls(peer)).toHaveLength(2);
	});
});

it("says what Nova knows of each target's HQ app: there, empty, gone or none", async () => {
	await seed(false);
	const at = "2026-09-01T00:00:00.000Z";
	const target = (domain: string) => ({ server: "india" as const, domain });
	await record("working-app");
	await foldDeploymentAttempt(
		SCOPE,
		target("shell"),
		"preflight",
		{ status: "succeeded", at },
		{ ensure: true },
	);
	await recordCreatedRemoteApp(SCOPE, target("shell"), {
		remoteId: "shell-app",
		baseline: {
			origin: "unread",
			remoteAppId: "shell-app",
			sourceGzip: null,
			sourceBytes: null,
			sourceDigest: null,
			ownership: null,
			observedAt: at,
			discard: null,
		},
	});
	const published = await record("gone-app", target("gone"));
	const mapped = published.active[0];
	await applyDeploymentObservation(SCOPE, target("gone"), {
		observedRemoteId: mapped.remoteId,
		observedPushToken: mapped.pushToken,
		outcomes: [
			[
				"upload",
				{
					status: "failed",
					at,
					failure: {
						code: "remote_app_missing",
						message: "The app Nova published isn't there any more.",
						details: [],
					},
				},
			],
		],
		remoteRevision: null,
	});
	await foldDeploymentAttempt(
		SCOPE,
		target("none"),
		"preflight",
		{ status: "succeeded", at },
		{ ensure: true },
	);
	await withHttpPeer(async (peer) => {
		await asUser(async (client) => {
			const body = JSON.parse(
				resultText(await call(client, GET, { app_id: APP })),
			);
			const flags = Object.fromEntries(
				body.deployments.map(
					(entry: {
						domain: string;
						hq_app_id: string | null;
						hq_app_gone: boolean;
						hq_app_empty: boolean;
					}) => [
						entry.domain,
						[entry.hq_app_id, entry.hq_app_gone, entry.hq_app_empty],
					],
				),
			);
			expect(flags).toEqual({
				clinic: ["working-app", false, false],
				shell: ["shell-app", false, true],
				gone: ["gone-app", true, false],
				none: [null, false, false],
			});
		});
		expect(urls(peer)).toEqual([]);
	});
});

it("tells a refresh of a first publish that stopped with its empty app mapped that there is nothing to check, and asks HQ nothing", async () => {
	await seed(false);
	const at = "2026-09-01T00:00:00.000Z";
	await foldDeploymentAttempt(
		SCOPE,
		TARGET,
		"preflight",
		{ status: "succeeded", at },
		{ ensure: true },
	);
	await recordCreatedRemoteApp(SCOPE, TARGET, {
		remoteId: "working-app",
		baseline: {
			origin: "unread",
			remoteAppId: "working-app",
			sourceGzip: null,
			sourceBytes: null,
			sourceDigest: null,
			ownership: null,
			observedAt: at,
			discard: null,
		},
	});
	await foldDeploymentAttempt(SCOPE, TARGET, "resources", {
		status: "failed",
		at,
		failure: {
			code: "hq_rejected_resource_push",
			message: "CommCare HQ would not take this app's lookup tables.",
			details: [],
		},
	});
	expect((await readDeployment(SCOPE, TARGET))?.active).toHaveLength(1);
	const before = await snapshot();
	await withHttpPeer(async (peer) => {
		await asUser(async (client) => {
			expect(errorBody(await call(client))).toMatchObject({
				error_type: "invalid_input",
				message:
					"This publish stopped before the app's content reached CommCare HQ, so checking there would say nothing about it. Fix what stopped it and publish again.",
			});
		});
		expect(urls(peer)).toEqual([]);
	});
	expect(await snapshot()).toEqual(before);
});

it("returns the fresh mapping when a publish lands during the HQ check", async () => {
	await seed();
	await withHttpPeer(async (peer) => {
		peer
			.get(HOST)
			.intercept({ path: VERSION_PATH, method: "GET" })
			.reply(async () => {
				await record("replacement-app");
				return { statusCode: 404, data: "" };
			});
		await asUser(async (client) => {
			const result = await refresh(client);
			expect(result).toMatchObject({
				state: "uploaded",
				hq_app_id: "replacement-app",
				remote_revision: 1,
				last_checked_at: null,
			});
			expect(result.phases.upload).toEqual({
				status: "succeeded",
				detail: null,
			});
		});
		expect((await snapshot()).deployments[0].state).toBe("uploaded");
		expect(urls(peer)).toHaveLength(1);
	});
});

it("rolls back observation and resource revision together on a late database failure", async () => {
	await seed();
	const before = await snapshot();
	await sql`CREATE FUNCTION reject_remote_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private revision write failure'; END $$`.execute(
		h.db(),
	);
	await sql`CREATE TRIGGER reject_remote_revision BEFORE UPDATE OF remote_revision ON app_deployment_resources FOR EACH ROW EXECUTE FUNCTION reject_remote_revision()`.execute(
		h.db(),
	);
	await withHttpPeer(async (peer) => {
		ready(peer);
		await asUser(async (client) =>
			expect(errorBody(await call(client))).toEqual({
				app_id: APP,
				error_type: "internal",
				message: "Something went wrong during generation.",
			}),
		);
		expect(await snapshot()).toEqual(before);
		expect(urls(peer)).toHaveLength(3);
	});
});

it("refuses scope, app access, absent publication, and invalid SDK input before any HQ request", async () => {
	await seed(false);
	await withHttpPeer(async (peer) => {
		await asUser(async (client) => {
			expect(
				JSON.parse(resultText(await call(client, GET, { app_id: APP }))),
			).toEqual({ app_id: APP, deployments: [] });
			expect(errorBody(await call(client))).toMatchObject({
				error_type: "invalid_input",
				message: expect.stringContaining("has no deployment"),
			});
			await foldDeploymentAttempt(
				SCOPE,
				TARGET,
				"preflight",
				{ status: "succeeded", at: "2026-09-01T00:00:00.000Z" },
				{ ensure: true },
			);
			expect(errorBody(await call(client)).message).toContain("hasn't reached");
			for (const args of [
				{ app_id: APP, ...TARGET, domain: " " },
				{ app_id: APP, ...TARGET, domain: "x".repeat(256) },
				{ app_id: APP, ...TARGET, server: "unknown" },
			]) {
				const result = await call(client, REFRESH, args);
				expect(result.isError).toBe(true);
				expect(JSON.stringify(result)).toContain("Input validation error");
			}
		});
		const before = await snapshot();
		for (const [name, scope] of [
			[GET, "nova.hq.read"],
			[REFRESH, "nova.hq.write"],
		]) {
			await asUser(
				async (client) =>
					expect(
						errorBody(
							await call(
								client,
								name,
								name === GET ? { app_id: APP } : { app_id: APP, ...TARGET },
							),
						),
					).toMatchObject({
						error_type: "scope_missing",
						required_scope: scope,
					}),
				ACTOR,
				["nova.read", "nova.write"],
			);
		}
		await asUser(
			async (client) =>
				expect(errorBody(await call(client))).toEqual({
					app_id: APP,
					error_type: "not_found",
					message: "App not found.",
				}),
			"viewer",
		);
		await asUser(
			async (client) =>
				expect(errorBody(await call(client, GET, { app_id: APP }))).toEqual({
					app_id: APP,
					error_type: "not_found",
					message: "App not found.",
				}),
			"outsider",
		);
		expect(await snapshot()).toEqual(before);
		expect(urls(peer)).toEqual([]);
		expect(decrypt).not.toHaveBeenCalled();
	});
});

it("keeps connection failures local to the caller and preserves the shared deployment", async () => {
	await seed();
	const before = await snapshot();
	await withHttpPeer(async (peer) => {
		await asUser(async (client) => {
			await h
				.db()
				.updateTable("user_settings")
				.set({ commcare_username: "" })
				.where("user_id", "=", ACTOR)
				.execute();
			expect(errorBody(await call(client)).error_type).toBe(
				"hq_not_configured",
			);
			await h
				.db()
				.updateTable("user_settings")
				.set({
					commcare_username: "account",
					approved_domains: JSON.stringify([
						{ name: "elsewhere", displayName: "Elsewhere" },
					]),
				})
				.where("user_id", "=", ACTOR)
				.execute();
			expect(errorBody(await call(client)).error_type).toBe(
				"domain_not_authorized",
			);
			await h
				.db()
				.updateTable("user_settings")
				.set({
					commcare_server: "eu",
					approved_domains: JSON.stringify([
						{ name: "clinic", displayName: "Clinic" },
					]),
				})
				.where("user_id", "=", ACTOR)
				.execute();
			expect(errorBody(await call(client))).toMatchObject({
				error_type: "invalid_input",
				message: expect.stringContaining("separate installations"),
			});
		});
		expect(await snapshot()).toEqual(before);
		expect(urls(peer)).toEqual([]);
	});
});

it("names the Web Apps section from the declaration, without asking CommCare HQ", async () => {
	await seed();
	const sections = await withHttpPeer(async (peer) => {
		const listed = await asUser(
			async (client) =>
				JSON.parse(resultText(await call(client, GET, { app_id: APP }))),
			"viewer",
			["nova.read", "nova.hq.read"],
		);
		expect(urls(peer)).toEqual([]);
		return listed.deployments[0].setup_artifact.sections as {
			id: string;
		}[];
	});
	expect(sections.find((section) => section.id === "web-apps")).toMatchObject({
		title: "Web Apps",
		summary:
			"Workers on “clinic” open this app in Web Apps once Web Apps serves a version of it, usually the latest one you released.",
	});
});

it("names no Web Apps section for an Android-only app", async () => {
	await seed(true, "android");
	const sections = await withHttpPeer(async (peer) => {
		const listed = await asUser(
			async (client) =>
				JSON.parse(resultText(await call(client, GET, { app_id: APP }))),
			"viewer",
			["nova.read", "nova.hq.read"],
		);
		expect(urls(peer)).toEqual([]);
		return listed.deployments[0].setup_artifact.sections as { id: string }[];
	});
	expect(sections.map((section) => section.id)).not.toContain("web-apps");
});

it("lists the confirmations in force by name, and withdraws one so the next upload asks again", async () => {
	await seed();
	await foldDeploymentAttempt(
		SCOPE,
		TARGET,
		"preflight",
		{ status: "succeeded", at: "2026-09-02T00:00:00.000Z" },
		{
			confirmations: [
				{ kind: "plan-feature", subject: "lookup-tables" },
				{ kind: "connect-forwarder" },
				{ kind: "form-entry-sync-off" },
				{ kind: "commtrack-off" },
			],
		},
	);
	await withHttpPeer(async (peer) => {
		await asUser(async (client) => {
			const listed = JSON.parse(
				resultText(await call(client, GET, { app_id: APP })),
			);
			expect(listed.deployments[0].confirmations).toEqual([
				{
					kind: "plan-feature",
					subject: "lookup-tables",
					label: "Lookup Tables",
					confirmed_by: ACTOR,
					confirmed_at: expect.any(String),
				},
				{
					kind: "connect-forwarder",
					subject: "connect-forwarder",
					label: "A Connect forwarder",
					confirmed_by: ACTOR,
					confirmed_at: expect.any(String),
				},
				{
					kind: "form-entry-sync-off",
					subject: "form-entry-sync-off",
					label: "Sync Cases On Form Entry turned off",
					confirmed_by: ACTOR,
					confirmed_at: expect.any(String),
				},
				{
					kind: "commtrack-off",
					subject: "commtrack-off",
					label: "CommCare Supply turned off",
					confirmed_by: ACTOR,
					confirmed_at: expect.any(String),
				},
			]);

			const withdrawn = JSON.parse(
				resultText(
					await call(client, WITHDRAW, {
						app_id: APP,
						domain: "clinic",
						kind: "plan-feature",
						subject: "lookup-tables",
					}),
				),
			);
			expect(
				withdrawn.confirmations.map((item: { kind: string }) => item.kind),
			).toEqual(["connect-forwarder", "form-entry-sync-off", "commtrack-off"]);
			const withdrawnSync = JSON.parse(
				resultText(
					await call(client, WITHDRAW, {
						app_id: APP,
						domain: "clinic",
						kind: "form-entry-sync-off",
					}),
				),
			);
			expect(
				withdrawnSync.confirmations.map((item: { kind: string }) => item.kind),
			).toEqual(["connect-forwarder", "commtrack-off"]);
			const withdrawnSupply = JSON.parse(
				resultText(
					await call(client, WITHDRAW, {
						app_id: APP,
						domain: "clinic",
						kind: "commtrack-off",
					}),
				),
			);
			expect(
				withdrawnSupply.confirmations.map(
					(item: { kind: string }) => item.kind,
				),
			).toEqual(["connect-forwarder"]);
			expect(
				errorBody(
					await call(client, WITHDRAW, {
						app_id: APP,
						kind: "plan-feature",
						subject: "user_case",
					}),
				).error_type,
			).toBe("invalid_input");
		});
		expect(urls(peer)).toEqual([]);
	});
	expect(
		(await readDeployment(SCOPE, TARGET))?.confirmations.map(
			(item) => item.subject,
		),
	).toEqual(["connect-forwarder"]);
});

it("refuses a withdrawal without the HQ write scope before any read", async () => {
	await seed();
	await asUser(
		async (client) => {
			expect(
				errorBody(
					await call(client, WITHDRAW, {
						app_id: APP,
						kind: "connect-forwarder",
					}),
				).error_type,
			).toBe("scope_missing");
		},
		ACTOR,
		["nova.read", "nova.hq.read"],
	);
});

/* The kept settings: what `get_deployment` reports of them and what
 * `refresh_deployment` with `kept_values` answers. The source reads are HQ's
 * own, retained by the proof lane (`proof/hq-reads/publish/source-live`), or
 * that read with fuzzy search turned on in CommCare HQ. */
const SOURCE_PATH = "/a/clinic/apps/source/working-app/";
const READ_AT = "2026-11-01T09:00:00.000Z";
/** What Nova's upload owned in the read: its two app settings. */
const OWNERSHIP: AppOwnership = {
	addOns: [],
	profileProperties: ["cc-show-saved", "cc-show-incomplete"],
	profileCustomProperties: [],
	autoGpsCapture: false,
};
function liveSource(): Record<string, unknown> {
	return JSON.parse(retainedBodyText(retainedPublishRead("source-live")));
}
function fuzzyOnSource(): Record<string, unknown> {
	const source = liveSource();
	const profile = source.profile as { properties: Record<string, string> };
	profile.properties["cc-fuzzy-search-enabled"] = "yes";
	return source;
}
/** Record a landed publish whose read-back of `source`, dated `observedAt`, is the baseline. */
async function publishedWithRead(
	source: Record<string, unknown>,
	observedAt = READ_AT,
) {
	const read = normalizeHqAppSource(source);
	if ("malformed" in read) throw new Error(read.malformed);
	await foldDeploymentAttempt(
		SCOPE,
		TARGET,
		"preflight",
		{ status: "succeeded", at: READ_AT },
		{ ensure: true },
	);
	await recordRemoteResource(SCOPE, TARGET, {
		kind: "app",
		novaResourceId: APP,
		remoteId: "working-app",
		ownership: "nova-created",
		pushedRevision: 0,
		remoteRevision: 1,
		uploadedAt: READ_AT,
		baseline: {
			origin: "push",
			remoteAppId: "working-app",
			sourceGzip: gzipSync(Buffer.from(read.text, "utf8")),
			sourceBytes: read.bytes,
			sourceDigest: read.digest,
			ownership: OWNERSHIP,
			observedAt,
			discard: null,
		},
	});
}
function sourceRequest(peer: MockAgent) {
	return peer.get(HOST).intercept({
		path: SOURCE_PATH,
		method: "GET",
		headers: { authorization: "ApiKey account:fixture-key" },
	});
}
function serveSource(peer: MockAgent, source: Record<string, unknown>) {
	sourceRequest(peer).reply(200, JSON.stringify(source), {
		headers: { "content-type": "application/json" },
	});
}
/** The one deployment's app baseline row, whole. */
async function baselines() {
	return h.db().selectFrom("app_deployment_baselines").selectAll().execute();
}
const KEPT_ARGS = { app_id: APP, ...TARGET, kept_values: true };

it("reports the kept settings to a viewer worded as the card words them, in the card's order, with the instant Nova read them", async () => {
	await seed(false);
	await publishedWithRead(fuzzyOnSource());
	const facts = await readTargetFacts(SCOPE, TARGET);
	if (facts === null) throw new Error("Expected the stored read's facts");
	const words = keptListFor(facts).map((label) => KEPT_LABELS[label]);
	expect(words).toContain("Fuzzy search in case lists");
	await withHttpPeer(async (peer) => {
		const body = await asUser(
			async (client) =>
				JSON.parse(resultText(await call(client, GET, { app_id: APP }))),
			"viewer",
			["nova.read", "nova.hq.read"],
		);
		expect(body.deployments[0].kept).toEqual({
			labels: words,
			observed_at: READ_AT,
		});
		expect(urls(peer)).toEqual([]);
	});
});

it("reads the kept settings again with kept_values, answers with the card's sentence and the deployment, and asks about no build", async () => {
	await seed(false);
	await publishedWithRead(liveSource());
	await withHttpPeer(async (peer) => {
		await asUser(async (client) => {
			serveSource(peer, fuzzyOnSource());
			const changed = await refresh(client, KEPT_ARGS);
			const stored = await readTargetFacts(SCOPE, TARGET);
			expect(stored?.observedAt).not.toBe(READ_AT);
			expect(changed).toMatchObject({
				app_id: APP,
				kept_refresh: "refreshed",
				message: "Updated. This is what CommCare HQ holds now.",
				domain: "clinic",
				state: "uploaded",
				hq_app_id: "working-app",
				kept: {
					labels: expect.arrayContaining(["Fuzzy search in case lists"]),
					observed_at: stored?.observedAt,
				},
				setup_artifact: { domain: "clinic", hqAppId: "working-app" },
			});

			serveSource(peer, fuzzyOnSource());
			const same = await refresh(client, KEPT_ARGS);
			expect(same).toMatchObject({
				kept_refresh: "refreshed",
				message: "Nothing has changed. This is still what CommCare HQ holds.",
				kept: { labels: changed.kept.labels },
			});
		});
		expect(urls(peer)).toEqual(
			[SOURCE_PATH, SOURCE_PATH].map((path) => ({
				method: "GET",
				fullUrl: HOST + path,
			})),
		);
	});
});

it("says the kept settings were updated when a value moved under a label listed before and after", async () => {
	/* A sign-in held at 12 hours, then set to one hour in CommCare HQ: the
	 * label "How long a sign-in lasts" is listed on both sides, and the
	 * value under it is what changed. */
	const signInFor = (seconds: string) => {
		const source = liveSource();
		const profile = source.profile as { properties: Record<string, string> };
		profile.properties["cc-login-duration-seconds"] = seconds;
		return source;
	};
	await seed(false);
	await publishedWithRead(signInFor("43200"));
	await withHttpPeer(async (peer) => {
		await asUser(async (client) => {
			serveSource(peer, signInFor("3600"));
			const moved = await refresh(client, KEPT_ARGS);
			expect(moved).toMatchObject({
				kept_refresh: "refreshed",
				message: "Updated. This is what CommCare HQ holds now.",
			});
			expect(moved.kept.labels).toContain("How long a sign-in lasts");
		});
	});
	const facts = await readTargetFacts(SCOPE, TARGET);
	expect(facts?.profileProperties["cc-login-duration-seconds"]).toBe("3600");
});

it("answers a read that could not be used with its sentence dated by the ISO date of the read the list stands on, and writes nothing", async () => {
	await seed(false);
	await publishedWithRead(liveSource());
	const before = await baselines();
	await withHttpPeer(async (peer) => {
		await asUser(async (client) => {
			sourceRequest(peer).reply(401, "");
			expect(await refresh(client, KEPT_ARGS)).toEqual({
				app_id: APP,
				kept_refresh: "key-not-accepted",
				message:
					"CommCare HQ didn't accept your saved API key, so these stay as of 2026-11-01. You can save a new key in Settings, then refresh again.",
			});
			sourceRequest(peer).reply(403, "");
			expect(await refresh(client, KEPT_ARGS)).toEqual({
				app_id: APP,
				kept_refresh: "no-permission",
				message:
					"CommCare HQ didn't let your account read this app, so these stay as of 2026-11-01. Reading it needs permission to edit apps in clinic. You can check the connected account, then refresh again.",
			});
		});
		expect(urls(peer)).toHaveLength(2);
	});
	expect(await baselines()).toEqual(before);
});

it("answers superseded with the deployment as the publish that landed during the read left it", async () => {
	await seed(false);
	await publishedWithRead(liveSource());
	const publishedAgainAt = new Date(Date.now() + 60_000).toISOString();
	await withHttpPeer(async (peer) => {
		sourceRequest(peer).reply(async () => {
			await publishedWithRead(fuzzyOnSource(), publishedAgainAt);
			return { statusCode: 200, data: JSON.stringify(liveSource()) };
		});
		await asUser(async (client) => {
			expect(await refresh(client, KEPT_ARGS)).toMatchObject({
				kept_refresh: "superseded",
				message:
					"A publish or another read of CommCare HQ landed here while Nova was reading, so this is the latest Nova has.",
				hq_app_id: "working-app",
				kept: {
					labels: expect.arrayContaining(["Fuzzy search in case lists"]),
					observed_at: publishedAgainAt,
				},
			});
		});
	});
});

it("gives the tool's error with its sentence when the caller's connection cannot read the kept settings, and asks nothing", async () => {
	await seed(false);
	await publishedWithRead(liveSource());
	const before = await baselines();
	await h
		.db()
		.updateTable("user_settings")
		.set({ commcare_username: "" })
		.where("user_id", "=", ACTOR)
		.execute();
	await withHttpPeer(async (peer) => {
		await asUser(async (client) => {
			expect(errorBody(await call(client, REFRESH, KEPT_ARGS))).toMatchObject({
				error_type: "hq_not_configured",
				message:
					"CommCare HQ isn't connected on your account, so Nova can't read these again. You can add your API key in Settings, then refresh.",
			});
		});
		expect(urls(peer)).toEqual([]);
	});
	expect(await baselines()).toEqual(before);
});

it("answers a kept refresh whose write landed as landed when its list cannot be read after it, leaving `kept` out and saying so", async () => {
	await seed(false);
	await publishedWithRead(liveSource());
	const store = await vi.importActual<typeof import("@/lib/deployment/store")>(
		"@/lib/deployment/store",
	);
	const words = "Mother's Visit Checklist";
	await withHttpPeer(async (peer) => {
		await asUser(async (client) => {
			serveSource(peer, fuzzyOnSource());
			/* The list before the refresh reads; the one after it faults. */
			vi.mocked(readTargetFacts)
				.mockImplementationOnce(store.readTargetFacts)
				.mockRejectedValueOnce(
					Object.assign(new Error(`could not read “${words}”`), {
						code: "57P01",
					}),
				);
			const answer = await refresh(client, KEPT_ARGS);
			expect(answer).toMatchObject({
				app_id: APP,
				kept_refresh: "refreshed",
				message: keptListUnreadSentence("2026-11-01"),
				domain: "clinic",
				state: "uploaded",
			});
			expect(answer).not.toHaveProperty("kept");
		});
	});
	const stored = await readTargetFacts(SCOPE, TARGET);
	expect(stored?.profileProperties["cc-fuzzy-search-enabled"]).toBe("yes");
	expect(log.error).toHaveBeenCalledWith(
		"[deployment] kept list unavailable after a write landed",
		undefined,
		{
			appId: APP,
			domain: "clinic",
			after: "kept-refresh",
			errorName: "Error",
			errorCode: "57P01",
		},
	);
	expect(JSON.stringify(vi.mocked(log.error).mock.calls)).not.toContain(words);
});
