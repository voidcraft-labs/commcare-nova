/** Actual app/credential admission and HTTP decoding for both compatibility names. */
import type { Client } from "@modelcontextprotocol/client";
import type { MockAgent } from "undici";
import { beforeEach, expect, it, vi } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { decrypt } from "@/lib/commcare/encryption";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { plainColumn } from "@/lib/domain";
import { loadAppBlueprint } from "../loadApp";
import { registerCheckProjectSpaceCompatibility } from "../tools/checkProjectSpaceCompatibility";
import { registerGetAppHqFeatureFlagsCompatibility } from "../tools/getAppHqFeatureFlagsCompatibility";
import { withMcpClient } from "./client";
import { resultText } from "./promptClient";

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
const CURRENT = "check_project_space_compatibility",
	LEGACY = "get_app_hq_feature_flags";
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
		registerGetAppHqFeatureFlagsCompatibility(server, ctx);
	}, run);
}
async function seed(mode: "entry" | "search" | "plain" = "entry") {
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
function reply(peer: MockAgent, path: string, body: unknown, status = 200) {
	peer
		.get(HOST)
		.intercept({
			method: "GET",
			path,
			headers: { authorization: "ApiKey account@dimagi.com:fixture-key" },
		})
		.reply(status, typeof body === "string" ? body : JSON.stringify(body), {
			headers: { "content-type": "application/json" },
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
function legacyRequirement() {
	return {
		...deepLinkCapability,
		slug: "deep-links",
		required_for: deepLinkCapability.reasons[0],
		docs_url:
			"https://docs.commcare.app/project-space-compatibility#deep-links",
		namespaces: [],
	};
}

it("checks the selected deployment over HTTP and projects the same semantic result for current and legacy clients", async () => {
	await seed();
	await settings();
	const before = await h.readAppRow(APP);
	await withHttpPeer(async (peer) => {
		for (let i = 0; i < 2; i++) {
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
			});
			expect(await payload(client, LEGACY)).toEqual({
				...current,
				domain_checked: true,
				feature_flag_requirements: {
					verification: "verified",
					target_domain: "clinic",
					required_flags: [legacyRequirement()],
					missing_flags: [],
					unverified_flags: [],
					support_email: "support@dimagi.com",
					docs_url: "https://docs.commcare.app/project-space-compatibility",
					message: report("available").message,
				},
			});
		});
		expect(calls(peer)).toEqual(
			Array.from({ length: 2 }, () =>
				[
					"/api/user_domains/v1/?limit=100",
					"/api/user_domains/v1/?limit=100&feature_flag=session_endpoints",
				].map((path) => ({ method: "GET", fullUrl: HOST + path })),
			).flat(),
		);
	});
	expect(vi.mocked(decrypt).mock.calls).toEqual([
		["stored-ciphertext"],
		["stored-ciphertext"],
	]);
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
				}),
			);
			expect(calls(peer)).toHaveLength(2);
		});
	},
);

it("treats revoked live HQ membership as unverified and performs no private setting probes", async () => {
	await seed();
	await settings();
	await withHttpPeer(async (peer) => {
		reply(peer, "/api/user_domains/v1/?limit=100", empty);
		await asUser(async (client) =>
			expect((await payload(client)).project_space_compatibility).toEqual(
				report("unverified"),
			),
		);
		expect(calls(peer)).toEqual([
			{ method: "GET", fullUrl: `${HOST}/api/user_domains/v1/?limit=100` },
		]);
	});
});

it("supports legacy requirement discovery without a target, HQ scope, credentials or an HTTP request", async () => {
	await seed();
	await withHttpPeer(async (peer) => {
		await asUser(
			async (client) => {
				expect(await payload(client, LEGACY, { app_id: APP })).toEqual({
					app_id: APP,
					app_name: "Clinic intake",
					domain_checked: false,
					project_space_compatibility: report("not_checked"),
					feature_flag_requirements: {
						verification: "not_checked",
						required_flags: [legacyRequirement()],
						missing_flags: [],
						unverified_flags: [],
						support_email: "support@dimagi.com",
						docs_url: "https://docs.commcare.app/project-space-compatibility",
						message: report("not_checked").message,
					},
				});
			},
			ACTOR,
			["nova.read", "nova.write"],
		);
		expect(calls(peer)).toEqual([]);
		expect(decrypt).not.toHaveBeenCalled();
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
		for (const name of [CURRENT, LEGACY]) {
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
			for (const name of [CURRENT, LEGACY]) {
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
			reply(peer, paths[3], "", status);
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
