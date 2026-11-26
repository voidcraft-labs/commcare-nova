import { gzipSync } from "node:zlib";
import { sql } from "kysely";
import { expect, it, vi } from "vitest";
import { deploymentSession } from "@/__tests__/helpers/deploymentSession";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import { installationCredential } from "@/__tests__/helpers/installationCredential";
import { getSession } from "@/lib/auth-utils";
import { decrypt } from "@/lib/commcare/encryption";
import {
	patients,
	uuid,
} from "@/lib/commcare/reader/caseList/__tests__/fixtures";
import {
	closedCodes,
	readLists,
} from "@/lib/commcare/reader/caseList/__tests__/listReading";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { plainColumn, projectSearchOf } from "@/lib/domain/modules";
import { withMcpClient } from "@/lib/mcp/__tests__/client";
import { resultContentText, resultText } from "@/lib/mcp/__tests__/resultText";
import { registerProjectSearchDestinations } from "@/lib/mcp/tools/projectSearchDestinations";
import { projectSearchDestinationAction } from "../actions";
import { normalizeHqAppSource } from "../hqSourceBaseline";
import type { InstallationProfileCheckpoint } from "../installationProfileReview";
import {
	admitAppCreate,
	inspectProjectSearchDestination,
	readEntryPointEvidence,
	readInstallationReview,
	readTargetIdentity,
	recordRemoteResource,
	saveProjectSearchDestination,
	settleRemoteWrites,
	writeInstallationReview,
	writeTargetIdentityInTransaction,
} from "../store";
import { EMPTY_TARGET_IDENTITY } from "../targetIdentity";
import type { AppBaselineWrite } from "../types";

import { connect } from "./managedFixtures";

vi.mock("@/lib/auth-utils", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/commcare/encryption", () => ({ decrypt: vi.fn() }));

const h = setupAppStateTestDb("project_search_destination_", {
	authSchema: "migrated",
});
const scope = {
	actorUserId: "author",
	role: "owner",
	appId: "project-search-test",
	projectId: "search-project",
};
const target = { server: "production" as const, domain: "first-space" };

async function readDirectory() {
	const source = patients([plainColumn(uuid(1), "case_name", "Name")], {
		search: {},
	});
	const read = await readLists(source, {
		edit(app) {
			const config = app.modules[0]?.search_config;
			if (!config) throw new Error("Source search missing.");
			config.case_search_endpoint_id = 17;
			config.default_properties = [
				{ property: "district", defaultValue: "'north'" },
			];
		},
	});
	expect(closedCodes(read)).toEqual([]);
	const doc = read.ctx.doc;
	const menu = read.ctx.draft.modules[0];
	if (!doc || !menu) throw new Error("Reading did not return its document.");
	const search = projectSearchOf(doc.modules[menu.uuid]);
	if (!search) throw new Error("The search was lost.");
	return { doc, menu, search };
}

it("requires the current actor, app, target and connection review before replacing an external service ID", async () => {
	const { doc, search } = await readDirectory();
	await h.seedAppWithBlueprint(doc, {
		id: scope.appId,
		owner: scope.actorUserId,
		projectId: scope.projectId,
	});
	await h.seedProjectMember("coauthor", scope.projectId, "editor");
	await h.seedProjectMember("reader", scope.projectId, "viewer");
	const initial = (await inspectProjectSearchDestination(scope, target)).review;
	expect(initial.searches).toMatchObject([
		{
			searchUuid: search.searchUuid,
			endpointId: null,
			menus: [
				{
					parameters: ["district"],
					results: [
						{ name: "case_id", type: "text" },
						{ name: "case_name", type: "text" },
					],
				},
			],
		},
	]);
	const bind = (version: string, endpointId: number | null) => ({
		version,
		bindings: [{ searchUuid: search.searchUuid, endpointId }],
	});
	const coauthor = { ...scope, actorUserId: "coauthor", role: "editor" };
	await expect(
		saveProjectSearchDestination(coauthor, target, bind(initial.version, 41)),
	).rejects.toThrow(/changed/);
	const other = { ...target, domain: "second-space" };
	await expect(
		saveProjectSearchDestination(scope, other, bind(initial.version, 41)),
	).rejects.toThrow(/changed/);
	const viewer = { ...scope, actorUserId: "reader", role: "viewer" };
	const viewed = (await inspectProjectSearchDestination(viewer, target)).review;
	await expect(
		saveProjectSearchDestination(viewer, target, bind(viewed.version, 41)),
	).rejects.toThrow();
	const updated = await saveProjectSearchDestination(
		scope,
		target,
		bind(initial.version, 17),
	);
	expect(updated.searches[0]?.endpointId).toBe(17);
	await expect(
		saveProjectSearchDestination(scope, target, bind(initial.version, 71)),
	).rejects.toThrow(/changed/);
	const elsewhere = (await inspectProjectSearchDestination(scope, other))
		.review;
	expect(elsewhere.searches[0]?.endpointId).toBeNull();
	await saveProjectSearchDestination(scope, other, bind(elsewhere.version, 91));
	await saveProjectSearchDestination(
		scope,
		target,
		bind(updated.version, null),
	);
	expect(
		(await inspectProjectSearchDestination(scope, other)).review.searches[0]
			?.endpointId,
	).toBe(91);
	expect(
		(await inspectProjectSearchDestination(viewer, target)).review.searches[0]
			?.endpointId,
	).toBeNull();
});

it("reviews a retired connection before moving its service ID to the current menu", async () => {
	const { doc, search } = await readDirectory();
	await h.seedAppWithBlueprint(doc, {
		id: scope.appId,
		owner: scope.actorUserId,
		projectId: scope.projectId,
	});
	const before = (await inspectProjectSearchDestination(scope, target)).review;
	await saveProjectSearchDestination(scope, target, {
		version: before.version,
		bindings: [{ searchUuid: search.searchUuid, endpointId: null }],
	});
	const deployment = await h
		.db()
		.selectFrom("app_deployments")
		.select("id")
		.where("app_id", "=", scope.appId)
		.where("domain", "=", target.domain)
		.executeTakeFirstOrThrow();
	const retired = uuid(802);
	await h
		.db()
		.insertInto("app_deployment_search_bindings")
		.values({
			deployment_id: deployment.id,
			search_uuid: retired,
			endpoint_id: 17,
		})
		.execute();
	const observed = (await inspectProjectSearchDestination(scope, target))
		.review;
	expect(observed.searches).toContainEqual({
		searchUuid: retired,
		endpointId: 17,
		name: "Removed search",
		menus: [],
	});
	const move = (retiredId: number | null) =>
		saveProjectSearchDestination(scope, target, {
			version: observed.version,
			bindings: [
				{ searchUuid: search.searchUuid, endpointId: 17 },
				{ searchUuid: retired, endpointId: retiredId },
			],
		});
	await expect(move(17)).rejects.toThrow(/same ID/);
	await expect(move(81)).rejects.toThrow(/in a menu/);
	const saved = await move(null);
	expect(saved.searches).toHaveLength(1);
	expect(saved.searches[0]).toMatchObject({
		searchUuid: search.searchUuid,
		endpointId: 17,
	});
	await expect(move(null)).rejects.toThrow(/changed/);
});

it.each([
	{
		example: "a search whose escaped name fits the inner JSON",
		label: '"'.repeat(22_500),
		repeatMenu: false,
	},
	{
		example: "a search and menu spanning several pages",
		label: '"🚲'.repeat(38_000),
		repeatMenu: true,
	},
])(
	"keeps the complete destination review inside the SDK limit for $example before returning the write version",
	async ({ label, repeatMenu }) => {
		const reading = await readDirectory();
		const { menu, search } = reading;
		const doc = structuredClone(reading.doc);
		if (!doc.appSettings.projectSearches)
			throw new Error("The app has no directory.");
		const menuName = repeatMenu ? "Clinic " + label : "Patients";
		doc.appSettings.projectSearches[search.searchUuid] = { name: label };
		doc.modules[menu.uuid].name = menuName;
		await h.seedAppWithBlueprint(doc, {
			id: scope.appId,
			owner: scope.actorUserId,
			projectId: scope.projectId,
		});
		const grant = await installationCredential(h.db(), scope.actorUserId, [
			...writeScopes,
			"nova.hq.read",
		]);
		await withMcpClient(
			(server) => registerProjectSearchDestinations(server, grant),
			async (client) => {
				type Page = { from: number; token: string };
				const read = async (domain: string, page?: Page) => {
					const result = await client.callTool({
						name: "get_project_search_destination",
						arguments: {
							app_id: scope.appId,
							server: target.server,
							domain,
							page,
						},
					});
					expect(JSON.stringify(result).length).toBeLessThanOrEqual(80_000);
					const text = resultText(result);
					expect(text.length).toBeLessThanOrEqual(80_000);
					return JSON.parse(text) as {
						restarted: boolean;
						version: string | null;
						next_page: Page | null;
						details: {
							kind: string;
							text: string;
							searchUuid: string;
							menuUuid?: string;
						}[];
					};
				};
				let current = await read(target.domain);
				expect(current.version).toBeNull();
				const first = current.next_page;
				if (!first) throw new Error("Expected another review page.");
				const incomplete = await client.callTool({
					name: "connect_project_searches",
					arguments: {
						app_id: scope.appId,
						...target,
						version: first.token,
						bindings: [{ searchUuid: search.searchUuid, endpointId: 17 }],
					},
				});
				expect(incomplete.isError).toBe(true);
				expect(resultContentText(incomplete)).toContain(
					"Review its searches again",
				);
				expect(
					(await inspectProjectSearchDestination(scope, target)).review
						.searches[0]?.endpointId,
				).toBeNull();
				const elsewhere = await read("different-space", first);
				expect(elsewhere.restarted).toBe(true);
				expect(elsewhere.version).toBeNull();
				expect(elsewhere.details).toEqual(current.details);
				const all = [...current.details];
				while (current.next_page !== null) {
					expect(current.version).toBeNull();
					current = await read(target.domain, current.next_page);
					expect(current.restarted).toBe(false);
					all.push(...current.details);
				}
				expect(current.version).toBe(
					(await inspectProjectSearchDestination(scope, target)).review.version,
				);
				expect(all.every((row) => row.searchUuid === search.searchUuid)).toBe(
					true,
				);
				expect(
					all
						.filter((row) => row.kind === "search")
						.map((row) => row.text)
						.join(""),
				).toBe(label);
				expect(
					all
						.filter((row) => row.kind === "menu" && row.menuUuid === menu.uuid)
						.map((row) => row.text)
						.join(""),
				).toBe(menuName);
				expect(
					all.filter((row) => row.kind === "parameter").map((row) => row.text),
				).toEqual(["district"]);
				expect(
					all.filter((row) => row.kind === "result").map((row) => row.text),
				).toEqual(["case_id", "case_name"]);
			},
		);
	},
	30_000,
);

const writeScopes = ["nova.read", "nova.write", "nova.hq.write"];

async function connectThroughMcp(
	ctx: Awaited<ReturnType<typeof installationCredential>>,
	version: string,
	searchUuid: string,
	endpointId: number | null,
) {
	return withMcpClient(
		(server) => registerProjectSearchDestinations(server, ctx),
		(client) =>
			client.callTool({
				name: "connect_project_searches",
				arguments: {
					app_id: scope.appId,
					...target,
					version,
					bindings: [{ searchUuid, endpointId }],
				},
			}),
	);
}

it("rechecks the credential after HQ answers before creating the destination and its first connection", async () => {
	const { doc, search } = await readDirectory();
	await h.seedAppWithBlueprint(doc, {
		id: scope.appId,
		owner: scope.actorUserId,
		projectId: scope.projectId,
	});
	await connect(h, scope.actorUserId, target.server, [target.domain]);
	vi.mocked(decrypt).mockResolvedValue("fixture-key");
	const ctx = await installationCredential(
		h.db(),
		scope.actorUserId,
		writeScopes,
	);
	if (ctx.grant?.kind !== "api-key") throw new Error("Expected an API key.");
	const keyId = ctx.grant.keyId;
	const { review } = await inspectProjectSearchDestination(scope, target);
	await withHttpPeer(async (peer) => {
		const hq = peer.get("https://www.commcarehq.org");
		const path = "/api/user_domains/v1/?limit=100";
		const visible = {
			meta: { total_count: 1 },
			objects: [{ domain_name: target.domain, project_name: "Visits" }],
		};
		const probe = () =>
			hq.intercept({
				method: "GET",
				path: path + "&feature_flag=case_search_endpoints",
			});
		hq.intercept({ method: "GET", path }).reply(200, visible).times(2);
		probe().reply(200, async () => {
			await sql`UPDATE auth_apikey SET permissions=${JSON.stringify({ scope: ["nova.read", "nova.write"] })} WHERE id=${keyId}`.execute(
				h.db(),
			);
			return JSON.stringify(visible);
		});
		probe().reply(200, visible);
		const refused = await connectThroughMcp(
			ctx,
			review.version,
			search.searchUuid,
			41,
		);
		expect(refused.isError).toBe(true);
		expect(JSON.parse(resultContentText(refused))).toMatchObject({
			error_type: "permission_denied",
		});
		expect(
			await h
				.db()
				.selectFrom("app_deployments")
				.select("id")
				.where("app_id", "=", scope.appId)
				.execute(),
		).toEqual([]);
		const restored = await installationCredential(
			h.db(),
			scope.actorUserId,
			writeScopes,
		);
		const saved = await connectThroughMcp(
			restored,
			review.version,
			search.searchUuid,
			41,
		);
		expect(saved.isError).not.toBe(true);
		expect(
			(await inspectProjectSearchDestination(scope, target)).review.searches[0]
				?.endpointId,
		).toBe(41);
	});
});

it("rechecks the credential when clearing a retired search without contacting HQ", async () => {
	await h.seedApp({
		id: scope.appId,
		owner: scope.actorUserId,
		project_id: scope.projectId,
	});
	const initial = (await inspectProjectSearchDestination(scope, target)).review;
	await saveProjectSearchDestination(scope, target, {
		version: initial.version,
		bindings: [],
	});
	const row = await h
		.db()
		.selectFrom("app_deployments")
		.select("id")
		.where("app_id", "=", scope.appId)
		.executeTakeFirstOrThrow();
	const retired = uuid(803);
	await h
		.db()
		.insertInto("app_deployment_search_bindings")
		.values({ deployment_id: row.id, search_uuid: retired, endpoint_id: 17 })
		.execute();
	const ctx = await installationCredential(
		h.db(),
		scope.actorUserId,
		writeScopes,
	);
	if (ctx.grant?.kind !== "api-key") throw new Error("Expected an API key.");
	const reviewed = (await inspectProjectSearchDestination(scope, target))
		.review;
	await sql`DELETE FROM auth_apikey WHERE id=${ctx.grant.keyId}`.execute(
		h.db(),
	);
	await withHttpPeer(async () => {
		const refused = await connectThroughMcp(
			ctx,
			reviewed.version,
			retired,
			null,
		);
		expect(refused.isError).toBe(true);
		expect(JSON.parse(resultContentText(refused))).toMatchObject({
			error_type: "permission_denied",
		});
		expect(
			(await inspectProjectSearchDestination(scope, target)).review,
		).toEqual(reviewed);
		const current = await installationCredential(
			h.db(),
			scope.actorUserId,
			writeScopes,
		);
		const saved = await connectThroughMcp(
			current,
			reviewed.version,
			retired,
			null,
		);
		expect(saved.isError).not.toBe(true);
		expect(
			(await inspectProjectSearchDestination(scope, target)).review.searches,
		).toEqual([]);
	});
});

it("retains a full destination inventory across a service ID rotation and a publish admission", async () => {
	await h.seedApp({
		id: scope.appId,
		owner: scope.actorUserId,
		project_id: scope.projectId,
	});
	const review = (await inspectProjectSearchDestination(scope, target)).review;
	await saveProjectSearchDestination(scope, target, {
		version: review.version,
		bindings: [],
	});
	const deployment = await h
		.db()
		.selectFrom("app_deployments")
		.select("id")
		.where("app_id", "=", scope.appId)
		.executeTakeFirstOrThrow();
	// The inventory exceeds the number of parameters PostgreSQL accepts in one statement.
	const bindings = Array.from({ length: 65_536 }, (_, index) => ({
		searchUuid: uuid(index + 1),
		endpointId: index + 1,
	}));
	const rotated = bindings.map((row, index) => ({
		searchUuid: row.searchUuid,
		endpointId: bindings[(index + 1) % bindings.length].endpointId,
	}));
	const replace = (before: typeof bindings, after: typeof bindings) =>
		h.withTransaction(async (tx) => {
			await tx
				.selectFrom("app_deployments")
				.select("id")
				.where("id", "=", deployment.id)
				.forUpdate()
				.executeTakeFirstOrThrow();
			await writeTargetIdentityInTransaction(
				tx,
				deployment.id,
				{ appId: scope.appId, server: target.server },
				{
					read: { ...EMPTY_TARGET_IDENTITY, projectSearches: before },
					next: { ...EMPTY_TARGET_IDENTITY, projectSearches: after },
				},
			);
		});
	await replace([], bindings);
	await replace(bindings, rotated);
	const admit = (searchConnections: typeof bindings) =>
		admitAppCreate(scope, target, {
			expectedEndings: 0,
			searchConnections,
		});
	await expect(admit(bindings)).rejects.toMatchObject({ code: "stale" });
	const writeId = await admit(rotated);
	await settleRemoteWrites([writeId], { kind: "settled" });
	await replace(rotated, []);
	const count = await h
		.db()
		.selectFrom("app_deployment_search_bindings")
		.select((eb) => eb.fn.countAll<string>().as("count"))
		.where("deployment_id", "=", deployment.id)
		.executeTakeFirstOrThrow();
	expect(Number(count.count)).toBe(0);
}, 90_000);

it("refuses to promote prepared practice after its target search connection changes", async () => {
	const { doc, search } = await readDirectory();
	await h.seedAppWithBlueprint(doc, {
		id: scope.appId,
		owner: scope.actorUserId,
		projectId: scope.projectId,
	});
	const bind = async (endpointId: number) => {
		const { review } = await inspectProjectSearchDestination(scope, target);
		await saveProjectSearchDestination(scope, target, {
			version: review.version,
			bindings: [{ searchUuid: search.searchUuid, endpointId }],
		});
	};
	await bind(17);
	const identity = await readTargetIdentity(scope, target);
	const sequence = Number((await h.readAppRow(scope.appId))?.mutation_seq);
	const source = normalizeHqAppSource({
		doc_type: "Application",
		name: "Practice directory",
		modules: [],
		_attachments: {},
	});
	if ("malformed" in source)
		throw new Error("Expected a normalized working app.");
	const before = "2026-01-01T00:00:00.000Z";
	const after = "2026-01-02T00:00:00.000Z";
	const baseline: AppBaselineWrite = {
		origin: "push",
		remoteAppId: "working-app",
		sourceGzip: gzipSync(source.text),
		sourceBytes: source.bytes,
		sourceDigest: source.digest,
		ownership: {
			addOns: [],
			profileProperties: [],
			profileCustomProperties: [],
		},
		observedAt: before,
		discard: null,
		novaRevision: sequence,
		mediaFiles: { kind: "set", files: null },
		firstPublish: { kind: "set", list: null },
	};
	const remote = {
		kind: "app",
		novaResourceId: scope.appId,
		remoteId: baseline.remoteAppId,
		remoteRevision: 3,
		expectedEndings: 0,
		pushedRevision: null,
		uploadedAt: before,
		baseline,
	} as const;
	const recorded = await recordRemoteResource(scope, target, remote);
	if (!recorded.pushToken) throw new Error("Expected a prepared app mapping.");
	const checkpoint: InstallationProfileCheckpoint = {
		claim: { mapping: recorded.pushToken, endings: 0 },
		appId: baseline.remoteAppId,
		phase: "prepare-practice",
		workingVersion: remote.remoteRevision,
		sequence,
		sourceDigest: source.digest,
		unrelatedDigest: source.digest,
		review: { requested: [], previousKeys: [] },
		preparedContent: {
			version: remote.remoteRevision,
			inputs: source.digest,
			baselineDigest: source.digest,
			resourcesReady: true,
		},
	};
	expect(
		await writeInstallationReview(scope, target, {
			claim: checkpoint.claim,
			previous: undefined,
			next: checkpoint,
			identity,
			remoteAppId: baseline.remoteAppId,
			sequence,
			requireHqImport: null,
		}),
	).toBe(true);
	const promote = () =>
		recordRemoteResource(scope, target, {
			...remote,
			expectedInstallationMapping: checkpoint.claim.mapping,
			searchConnections: identity.projectSearches,
			pushedRevision: sequence,
			uploadedAt: after,
			baseline: { ...baseline, observedAt: after },
			practicePublication: {
				expected: checkpoint,
				promotedEntry: { generation: crypto.randomUUID(), entries: [] },
				requireHqImport: null,
			},
		});

	await bind(18);
	await expect(promote()).rejects.toMatchObject({ code: "stale" });
	expect(await readInstallationReview(scope, target)).toEqual(checkpoint);
	expect((await readEntryPointEvidence(scope, target)).manifest).toBeNull();

	await bind(17);
	expect((await promote()).pushToken).not.toBeNull();
	expect((await readEntryPointEvidence(scope, target)).manifest).toMatchObject({
		remoteAppId: baseline.remoteAppId,
		sourceSequence: sequence,
	});
});

it.each(["active", "retired"] as const)(
	"holds the signed-in editor's session when connecting a %s search through the Builder",
	async (kind) => {
		const { doc, search } = await readDirectory();
		await h.seedAppWithBlueprint(doc, {
			id: scope.appId,
			owner: scope.actorUserId,
			projectId: scope.projectId,
		});
		const session = await deploymentSession(h.db(), scope.actorUserId);
		vi.mocked(getSession).mockResolvedValue(session as never);
		const destination = { appId: scope.appId, ...target };
		let searchUuid = search.searchUuid;
		if (kind === "retired") {
			searchUuid = uuid(975);
			await h.seedApp({
				id: "ordinary-search-app",
				owner: scope.actorUserId,
				project_id: scope.projectId,
			});
			const ordinary = { ...scope, appId: "ordinary-search-app" };
			destination.appId = ordinary.appId;
			const initial = await inspectProjectSearchDestination(ordinary, target);
			await saveProjectSearchDestination(ordinary, target, {
				version: initial.review.version,
				bindings: [],
			});
			const deployment = await h
				.db()
				.selectFrom("app_deployments")
				.select("id")
				.where("app_id", "=", ordinary.appId)
				.executeTakeFirstOrThrow();
			await h
				.db()
				.insertInto("app_deployment_search_bindings")
				.values({
					deployment_id: deployment.id,
					search_uuid: searchUuid,
					endpoint_id: 17,
				})
				.execute();
		}
		const review = await projectSearchDestinationAction(destination);
		if (!review.success) throw new Error(review.message);
		const edit = {
			version: review.data.version,
			bindings: [{ searchUuid, endpointId: kind === "active" ? 41 : null }],
		};
		const revoke = () =>
			sql`DELETE FROM auth_session WHERE id = ${session.session.id}`.execute(
				h.db(),
			);
		await withHttpPeer(async (peer) => {
			if (kind === "retired") {
				await revoke();
			} else {
				await connect(h, scope.actorUserId, target.server, [target.domain]);
				vi.mocked(decrypt).mockResolvedValue("fixture-key");
				const visible = {
					meta: { total_count: 1 },
					objects: [{ domain_name: target.domain, project_name: "Visits" }],
				};
				const hq = peer.get("https://www.commcarehq.org");
				const path = "/api/user_domains/v1/?limit=100";
				hq.intercept({ method: "GET", path }).reply(200, visible).times(2);
				hq.intercept({
					method: "GET",
					path: path + "&feature_flag=case_search_endpoints",
				}).reply(200, async () => {
					await revoke();
					return JSON.stringify(visible);
				});
				hq.intercept({
					method: "GET",
					path: path + "&feature_flag=case_search_endpoints",
				}).reply(200, visible);
			}
			expect(
				await projectSearchDestinationAction(destination, edit),
			).toMatchObject({
				success: false,
				code: "not_permitted",
				message: expect.stringMatching(/sign in again/i),
			});
			const held = await inspectProjectSearchDestination(
				{ ...scope, appId: destination.appId },
				target,
			);
			expect(held.review.version).toBe(review.data.version);
			vi.mocked(getSession).mockResolvedValue(
				(await deploymentSession(h.db(), scope.actorUserId)) as never,
			);
			const saved = await projectSearchDestinationAction(destination, edit);
			if (!saved.success) throw new Error(saved.message);
			if (kind === "active")
				expect(saved.data.searches[0]?.endpointId).toBe(41);
			else expect(saved.data.searches).toEqual([]);
		});
	},
);
