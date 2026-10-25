/** Actual app/credential admission and HTTP decoding for the semantic compatibility tool. */
import type { Client } from "@modelcontextprotocol/client";
import type { MockAgent } from "undici";
import { beforeEach, expect, it, vi } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { connectWireFixtures } from "@/lib/commcare/__tests__/connectWireFixtures";
import { decrypt } from "@/lib/commcare/encryption";
import { locationOwnerFixture } from "@/lib/commcare/locations/__tests__/locationOwnerFixture";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { narrowingTo } from "@/lib/deployment/platformNarrowing";
import { foldDeploymentAttempt } from "@/lib/deployment/store";
import { plainColumn } from "@/lib/domain";
import {
	CONNECT_FORWARDER,
	FLAT_LOCATION_FIXTURE,
	PLAN_FEATURES,
	webAppsWhereMissing,
} from "@/lib/publish/planFeatures";
import { loadAppBlueprint } from "../loadApp";
import { registerCheckProjectSpaceCompatibility } from "../tools/checkProjectSpaceCompatibility";
import { withMcpClient } from "./client";
import { resultText } from "./resultText";

// KMS is the remaining external service boundary. The production settings
// reader must select this ciphertext; the actual HTTP request must use its
// returned plaintext. Neither settings nor the HQ client is replaced.
vi.mock("@/lib/commcare/encryption", () => ({ decrypt: vi.fn() }));
beforeEach(() => {
	vi.mocked(decrypt).mockReset();
	vi.mocked(decrypt).mockResolvedValue("fixture-key");
});
const h = setupAppStateTestDb("mcp_compatibility_", { authSchema: "migrated" });
const ACTOR = "viewer",
	PROJECT = "program",
	APP = "compatibility-app";
const HOST = "https://india.commcarehq.org";
const CURRENT = "check_project_space_compatibility";
const visible = {
	meta: { total_count: 1 },
	objects: [{ domain_name: "clinic", project_name: "Clinic" }],
};
const empty = { meta: { total_count: 0 }, objects: [] };
function asUser<T>(
	run: (client: Client) => Promise<T>,
	userId = ACTOR,
	scopes = ["nova.read", "nova.write", "nova.hq.read"],
) {
	return withMcpClient((server) => {
		const ctx = { userId, scopes, authKind: "oauth" as const };
		registerCheckProjectSpaceCompatibility(server, ctx);
	}, run);
}
function seededDoc(mode: "entry" | "search" | "plain" = "entry") {
	const doc = buildDoc({
		appName: "Clinic intake",
		...(mode === "search" && {
			caseTypes: [{ name: "patient", properties: [] }],
		}),
		modules: [
			{
				name: "Intake",
				...(mode === "search" && {
					caseType: "patient",
					caseSearchConfig: {},
					caseListConfig: {
						columns: [plainColumn(testUuid("column"), "case_name", "Name")],
						searchInputs: [],
					},
				}),
				forms: [
					{
						name: "Visit",
						type: mode === "search" ? "followup" : "survey",
						fields: [{ id: "note", kind: "text" }],
					},
				],
			},
		],
	});
	if (mode === "entry")
		Object.values(doc.forms)[0].entryPoint = {
			uuid: testUuid("entry"),
			id: "visit",
		};
	return doc;
}
async function seed(mode: "entry" | "search" | "plain" = "entry") {
	const doc = seededDoc(mode);
	await h.seedAppWithBlueprint(doc, {
		id: APP,
		owner: "creator",
		projectId: PROJECT,
	});
	await h.seedProjectMember(ACTOR, PROJECT, "viewer");
	await loadAppBlueprint(APP, ACTOR);
}
async function settings() {
	await h
		.db()
		.insertInto("user_settings")
		.values({
			user_id: ACTOR,
			commcare_username: "account@dimagi.com",
			commcare_api_key: "stored-ciphertext",
			commcare_server: "india",
			approved_domains: JSON.stringify([
				{ name: "clinic", displayName: "Clinic" },
				{ name: "training", displayName: "Training" },
			]),
			updated_at: new Date(),
		})
		.execute();
}
function reply(
	peer: MockAgent,
	path: string,
	body: unknown,
	status = 200,
	contentType = "application/json",
) {
	peer
		.get(HOST)
		.intercept({
			method: "GET",
			path,
			headers: { authorization: "ApiKey account@dimagi.com:fixture-key" },
		})
		.reply(status, typeof body === "string" ? body : JSON.stringify(body), {
			headers: { "content-type": contentType },
		});
}
function calls(peer: MockAgent) {
	return (
		peer
			.getCallHistory()
			?.calls()
			.map(({ method, fullUrl }) => ({ method, fullUrl })) ?? []
	);
}
async function payload(
	client: Client,
	name = CURRENT,
	args: Record<string, unknown> = { app_id: APP, domain: "clinic" },
) {
	const result = await client.callTool({ name, arguments: args });
	expect(result.isError, JSON.stringify(result)).not.toBe(true);
	return JSON.parse(resultText(result));
}
const deepLinkCapability = {
	id: "deep-links",
	label: "Deep links",
	description:
		"Lets an authenticated link open a named destination in the app.",
	reasons: ["The app has named entry points for authenticated links."],
};
/**
 * What the seeded app asks to confirm: it runs in Web Apps and on Android,
 * so the Web-Based Apps plan feature, with what a person can do where the
 * plan lacks it, and no project-space setting.
 */
function webAppsToConfirm() {
	return {
		plan_features: [
			{
				id: "web-apps",
				label: PLAN_FEATURES["web-apps"].label,
				plans: PLAN_FEATURES["web-apps"].plans,
				consequence: PLAN_FEATURES["web-apps"].consequence,
				reasons: ["This app runs in Web Apps."],
				where_missing: webAppsWhereMissing(narrowingTo(seededDoc(), "android")),
				state: "needs_confirmation",
			},
		],
		flat_location_fixture: null,
		connect_forwarder: null,
		form_entry_sync_off: null,
	};
}
function report(state: "available" | "missing" | "unverified" | "not_checked") {
	const requirement = { ...deepLinkCapability, state };
	const checked = state !== "not_checked";
	return {
		status:
			state === "not_checked"
				? "not_checked"
				: state === "available"
					? "ready"
					: "blocked",
		...(checked && { target_domain: "clinic" }),
		required_capabilities: [requirement],
		blockers:
			state === "missing" || state === "unverified" ? [requirement] : [],
		advisories: [],
		support_email: "support@dimagi.com",
		docs_url: "https://docs.commcare.app/project-space-compatibility",
		message:
			state === "available"
				? "This project space supports everything this app uses."
				: state === "not_checked"
					? "Choose a project space that supports everything this app uses."
					: state === "missing"
						? "This project space isn't ready for this app. It doesn't support Deep links. Ask a project-space administrator or Dimagi Support to enable that support, then check again."
						: "This project space isn't ready for this app. Nova couldn't confirm Deep links. Nothing has been sent. Check your CommCare HQ connection, then try again.",
	};
}

it("checks the selected deployment over HTTP and returns semantic compatibility", async () => {
	await seed();
	await settings();
	const before = await h.readAppRow(APP);
	await withHttpPeer(async (peer) => {
		for (let i = 0; i < 1; i++) {
			reply(peer, "/api/user_domains/v1/?limit=100", visible);
			reply(
				peer,
				"/api/user_domains/v1/?limit=100&feature_flag=session_endpoints",
				visible,
			);
		}
		await asUser(async (client) => {
			const current = await payload(client, CURRENT, {
				app_id: APP,
				domain: "  clinic  ",
			});
			expect(current).toEqual({
				app_id: APP,
				app_name: "Clinic intake",
				project_space_compatibility: report("available"),
				...webAppsToConfirm(),
			});
		});
		expect(calls(peer)).toEqual(
			Array.from({ length: 1 }, () =>
				[
					"/api/user_domains/v1/?limit=100",
					"/api/user_domains/v1/?limit=100&feature_flag=session_endpoints",
				].map((path) => ({ method: "GET", fullUrl: HOST + path })),
			).flat(),
		);
	});
	expect(vi.mocked(decrypt).mock.calls).toEqual([["stored-ciphertext"]]);
	expect(await h.readAppRow(APP)).toEqual(before);
	expect(await h.db().selectFrom("app_changes").selectAll().execute()).toEqual(
		[],
	);
});

it.each([
	{ label: "disabled", status: 200, body: empty, state: "missing" as const },
	{
		label: "unknown upstream setting",
		status: 400,
		body: "private upstream diagnostic",
		state: "unverified" as const,
	},
	{
		label: "malformed response",
		status: 200,
		body: { objects: [] },
		state: "unverified" as const,
	},
	{
		label: "pagination that drops the private capability filter",
		status: 200,
		body: {
			...visible,
			meta: {
				total_count: 2,
				next: "/api/user_domains/v1/?limit=100&offset=100",
			},
		},
		state: "unverified" as const,
	},
])(
	"distinguishes $label from confirmed availability without leaking upstream diagnostics",
	async ({ status, body, state }) => {
		await seed();
		await settings();
		await withHttpPeer(async (peer) => {
			reply(peer, "/api/user_domains/v1/?limit=100", visible);
			reply(
				peer,
				"/api/user_domains/v1/?limit=100&feature_flag=session_endpoints",
				body,
				status,
			);
			await asUser(async (client) =>
				expect(await payload(client)).toEqual({
					app_id: APP,
					app_name: "Clinic intake",
					project_space_compatibility: report(state),
					...webAppsToConfirm(),
				}),
			);
			expect(calls(peer)).toHaveLength(2);
		});
	},
);

it("reads revoked live HQ membership as not-a-member and performs no private setting probes", async () => {
	await seed();
	await settings();
	await withHttpPeer(async (peer) => {
		reply(peer, "/api/user_domains/v1/?limit=100", empty);
		await asUser(async (client) => {
			const requirement = {
				...deepLinkCapability,
				state: "unverified",
				issue: "not-a-member",
			};
			expect((await payload(client)).project_space_compatibility).toEqual({
				...report("unverified"),
				issue: "not-a-member",
				required_capabilities: [requirement],
				blockers: [requirement],
				message:
					"Nova couldn't check “clinic” because the connected CommCare HQ account is no longer a member of it. Once that account joins the project space again, or you connect a different account in Settings, publishing can continue.",
			});
		});
		expect(calls(peer)).toEqual([
			{ method: "GET", fullUrl: `${HOST}/api/user_domains/v1/?limit=100` },
		]);
	});
});

it("refuses missing scope, foreign apps and unreachable targets before KMS or HTTP", async () => {
	await seed();
	await h.seedApp({
		id: "foreign",
		owner: "other",
		project_id: "foreign-project",
	});
	await withHttpPeer(async (peer) => {
		for (const name of [CURRENT]) {
			await asUser(
				async (client) => {
					const result = await client.callTool({
						name,
						arguments: { app_id: APP, domain: "clinic" },
					});
					expect(result.isError).toBe(true);
					expect(JSON.stringify(result)).toContain("scope_missing");
				},
				ACTOR,
				["nova.read", "nova.write"],
			);
			await asUser(async (client) => {
				for (const app_id of ["foreign", "missing"])
					expect(
						await client.callTool({
							name,
							arguments: { app_id, domain: "clinic" },
						}),
					).toEqual({
						isError: true,
						content: [
							{
								type: "text",
								text: JSON.stringify({
									error_type: "not_found",
									message: "App not found.",
									app_id,
								}),
							},
						],
					});
				expect(
					await client.callTool({
						name,
						arguments: { app_id: APP, domain: "clinic" },
					}),
				).toEqual({
					isError: true,
					content: [
						{
							type: "text",
							text: JSON.stringify({
								error_type: "hq_not_configured",
								message:
									"CommCare HQ is not configured. Add your HQ credentials in Settings before checking a project space.",
								app_id: APP,
							}),
						},
					],
				});
			});
		}
		await settings();
		await asUser(async (client) => {
			for (const name of [CURRENT]) {
				const result = await client.callTool({
					name,
					arguments: { app_id: APP, domain: "outside" },
				});
				expect(result.isError).toBe(true);
				expect(JSON.stringify(result)).toContain("domain_not_authorized");
				for (const domain of ["", "   ", 42]) {
					const invalid = await client.callTool({
						name,
						arguments: { app_id: APP, domain },
					});
					expect(invalid.isError).toBe(true);
					expect(JSON.stringify(invalid)).toContain("Input validation error");
				}
			}
		});
		expect(calls(peer)).toEqual([]);
		expect(decrypt).not.toHaveBeenCalled();
	});
});

it("needs no decryption or HTTP when the app has no target-specific capability requirements", async () => {
	await seed("plain");
	await settings();
	await withHttpPeer(async (peer) => {
		await asUser(async (client) => {
			expect((await payload(client)).project_space_compatibility).toEqual({
				status: "not_needed",
				target_domain: "clinic",
				required_capabilities: [],
				blockers: [],
				advisories: [],
				support_email: "support@dimagi.com",
				docs_url: "https://docs.commcare.app/project-space-compatibility",
				message:
					"This app can run without any additional project-space support.",
			});
		});
		expect(calls(peer)).toEqual([]);
		expect(decrypt).not.toHaveBeenCalled();
	});
});

it.each([200, 403])(
	"keeps a missing search optimization advisory separate from runtime access (%s)",
	async (status) => {
		await seed("search");
		await settings();
		await withHttpPeer(async (peer) => {
			const paths = [
				"/api/user_domains/v1/?limit=100",
				"/api/user_domains/v1/?limit=100&feature_flag=search_claim",
				"/api/user_domains/v1/?limit=100&feature_flag=custom_properties",
				"/a/clinic/phone/search/?case_type=__nova_compatibility_probe__",
			];
			reply(peer, paths[0], visible);
			reply(peer, paths[1], visible);
			reply(peer, paths[2], empty);
			reply(
				peer,
				paths[3],
				status === 200 ? "<fixture/>" : "Forbidden",
				status,
				status === 200 ? "text/xml; charset=utf-8" : "text/plain",
			);
			await asUser(async (client) => {
				const result = (await payload(client)).project_space_compatibility;
				const requirement = {
					id: "case-search",
					label: "Case search",
					description:
						"Lets workers search across cases that are not already available in the app.",
					reasons: [
						"The app searches for cases that may not already be available.",
					],
					state: status === 200 ? "available" : "unverified",
					...(status === 403 && { issue: "connected-account-permission" }),
				};
				expect(result).toEqual({
					status: status === 200 ? "ready" : "blocked",
					target_domain: "clinic",
					required_capabilities: [requirement],
					blockers: status === 200 ? [] : [requirement],
					advisories: [
						{
							id: "large-search-performance",
							title: "Large searches may open more slowly",
							description:
								"Large Search results may take longer to open when the faster path is unavailable.",
							reasons: requirement.reasons,
							state: "missing",
							message:
								"This project space doesn't support the faster path for large Search results. Large results may take longer to open.",
						},
					],
					support_email: "support@dimagi.com",
					docs_url: "https://docs.commcare.app/project-space-compatibility",
					message:
						status === 200
							? "This project space supports everything this app uses."
							: "This project space isn't ready for this app. Nova couldn't confirm Case search because the connected CommCare HQ account does not have Mobile App Access. Nothing has been sent. Ask a project-space administrator to add that permission to the connected account, then check again.",
				});
			});
			expect(
				calls(peer).sort((a, b) => a.fullUrl.localeCompare(b.fullUrl)),
			).toEqual(
				paths
					.map((path) => ({ method: "GET", fullUrl: HOST + path }))
					.sort((a, b) => a.fullUrl.localeCompare(b.fullUrl)),
			);
		});
	},
);

it("returns what an upload there asks to confirm, each with its state from the deployment's ledger", async () => {
	const connect = connectWireFixtures().find(
		(fixture) => fixture.name === "deliver-default",
	)?.doc;
	if (connect === undefined) throw new Error("No Connect fixture");
	await h.seedAppWithBlueprint(connect, {
		id: APP,
		owner: "creator",
		projectId: PROJECT,
	});
	await h.seedProjectMember(ACTOR, PROJECT, "viewer");
	await h.seedProjectMember("confirmer", PROJECT, "editor");
	await settings();
	await foldDeploymentAttempt(
		{
			appId: APP,
			projectId: PROJECT,
			role: "editor",
			actorUserId: "confirmer",
		},
		{ server: "india", domain: "clinic" },
		"preflight",
		{ status: "succeeded", at: "2026-10-16T00:00:00.000Z" },
		{
			ensure: true,
			confirmations: [{ kind: "plan-feature", subject: "data-forwarding" }],
		},
	);
	await withHttpPeer(async () => {
		await asUser(async (client) => {
			const checked = await payload(client);
			expect(checked.plan_features).toEqual([
				{
					id: "worker-records",
					label: PLAN_FEATURES["worker-records"].label,
					plans: PLAN_FEATURES["worker-records"].plans,
					consequence: PLAN_FEATURES["worker-records"].consequence,
					reasons: ["Activity reads worker information."],
					where_missing: null,
					state: "needs_confirmation",
				},
				{
					id: "data-forwarding",
					label: PLAN_FEATURES["data-forwarding"].label,
					plans: PLAN_FEATURES["data-forwarding"].plans,
					consequence: PLAN_FEATURES["data-forwarding"].consequence,
					reasons: [
						"Activity sends a deliver unit to CommCare Connect.",
						"Record & review sends a task to CommCare Connect.",
					],
					where_missing: null,
					state: "confirmed",
					confirmed_by: "confirmer",
					confirmed_at: expect.any(String),
				},
			]);
			expect(checked.connect_forwarder).toEqual({
				label: CONNECT_FORWARDER.label,
				consequence: CONNECT_FORWARDER.consequence,
				reasons: [
					"Activity sends a deliver unit to CommCare Connect.",
					"Record & review sends a task to CommCare Connect.",
				],
				where_missing: CONNECT_FORWARDER.whereMissing,
				state: "needs_confirmation",
			});
			expect(checked.flat_location_fixture).toBeNull();
		});
	});
});

it("asks about the flat location list for an app whose form sets an owner from a place", async () => {
	await h.seedAppWithBlueprint(locationOwnerFixture("direct"), {
		id: APP,
		owner: "creator",
		projectId: PROJECT,
	});
	await h.seedProjectMember(ACTOR, PROJECT, "viewer");
	await settings();
	await withHttpPeer(async () => {
		await asUser(async (client) => {
			expect((await payload(client)).flat_location_fixture).toEqual({
				label: FLAT_LOCATION_FIXTURE.label,
				consequence: FLAT_LOCATION_FIXTURE.consequence,
				reasons: [
					"Transfer sets a case's owner from a place in your organization.",
				],
				where_missing: FLAT_LOCATION_FIXTURE.whereMissing,
				state: "needs_confirmation",
			});
		});
	});
});
