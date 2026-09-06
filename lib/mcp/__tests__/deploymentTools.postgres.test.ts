/** Actual deployment projections and refreshes through SDK, Postgres, and HTTP. */
import type { Client } from "@modelcontextprotocol/client";
import { sql } from "kysely";
import type { MockAgent } from "undici";
import { beforeEach, expect, it, vi } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { decrypt } from "@/lib/commcare/encryption";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import {
	foldDeploymentAttempt,
	recordRemoteResource,
} from "@/lib/deployment/store";
import {
	registerGetDeployment,
	registerRefreshDeployment,
} from "../tools/deploymentTools";
import { withMcpClient } from "./client";
import { resultText } from "./promptClient";

vi.mock("@/lib/commcare/encryption", () => ({ decrypt: vi.fn() }));
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
	REFRESH = "refresh_deployment";
function asUser<T>(
	run: (client: Client) => Promise<T>,
	userId = ACTOR,
	scopes = ["nova.read", "nova.hq.read", "nova.hq.write"],
) {
	return withMcpClient((server) => {
		const ctx = { userId, scopes, authKind: "oauth" as const };
		registerGetDeployment(server, ctx);
		registerRefreshDeployment(server, ctx);
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
	reply(peer, BUILD_PATH, {
		versions: [
			{ id: "wrong-unreleased", version: 3, is_released: false },
			{ id: "released-build", version: 3, is_released: true },
		],
	});
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
	});
}
async function seed(published = true) {
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
			[VERSION_PATH, BUILD_PATH, PROFILE_PATH, VERSION_PATH, VERSION_PATH].map(
				(path) => ({ method: "GET", fullUrl: HOST + path }),
			),
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
			});
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
			});
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
