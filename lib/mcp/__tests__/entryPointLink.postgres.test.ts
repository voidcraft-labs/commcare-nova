/** Published evidence, exact released HTTP resources, and recorded observations. */
import type { Client } from "@modelcontextprotocol/client";
import AdmZip from "adm-zip";
import { sql } from "kysely";
import type { MockAgent } from "undici";
import { beforeEach, expect, it, vi } from "vitest";
import {
	readHttpRequestBody,
	withHttpPeer,
} from "@/__tests__/helpers/httpPeer";
import { applicationAnswer } from "@/__tests__/helpers/retainedHqReads";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import { compileCcz } from "@/lib/commcare/compiler";
import { decrypt } from "@/lib/commcare/encryption";
import { expandDoc } from "@/lib/commcare/expander";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { commitGuardedBatch, restoreApp, softDeleteApp } from "@/lib/db/apps";
import {
	appMappingToken,
	birthAdoptedApp,
} from "@/lib/deployment/__tests__/adoptedBirth";
import { admitEntryPointImport } from "@/lib/deployment/__tests__/entryPointWrite";
import { publishedEntryPoints } from "@/lib/deployment/entryPointManifest";
import { publishAppToHq } from "@/lib/deployment/service";
import * as deploymentStore from "@/lib/deployment/store";
import {
	admitAppCreate,
	admitAppWrite,
	finishDeploymentContentWrite,
	foldDeploymentAttempt,
	readDeployment,
	readEntryPointEvidence,
	readTargetIdentity,
	recordRemoteResource,
	settleRemoteWrites,
} from "@/lib/deployment/store";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import { prepareExportBoundary } from "@/lib/export/boundaryValidation";
import { PLAN_FEATURE_IDS } from "@/lib/publish/planFeatures";
import { CORPUS_COMMCARE_VERSION } from "@/proof/corpus/configurations";
import { TargetPeer } from "@/proof/corpus/targetPeer";
import { loadAppBlueprint } from "../loadApp";
import { registerGetEntryPointLink } from "../tools/getEntryPointLink";
import { withMcpClient } from "./client";
import { resultText } from "./resultText";

vi.mock("@/lib/commcare/encryption", () => ({ decrypt: vi.fn() }));
beforeEach(() => {
	vi.mocked(decrypt).mockReset();
	vi.mocked(decrypt).mockResolvedValue("fixture-key");
});
const h = setupAppStateTestDb("mcp_entry_link_", { authSchema: "migrated" });
const APP = "entry-app",
	PROJECT = "program",
	ACTOR = "editor";
const MODULE = testUuid("patients"),
	ENTRY = testUuid("visit-link");
const TARGET = { server: "india" as const, domain: "clinic" };
const RUNTIME = { ...TARGET, appId: "working-app" };
const SCOPE = {
	appId: APP,
	projectId: PROJECT,
	role: "editor",
	actorUserId: ACTOR,
};
const HOST = "https://india.commcarehq.org";
const PATH = {
	domains: "/api/user_domains/v1/?limit=100",
	links: "/api/user_domains/v1/?limit=100&feature_flag=session_endpoints",
	multiSelect:
		"/api/user_domains/v1/?limit=100&feature_flag=case_search_advanced",
	versions: "/a/clinic/apps/view/working-app/current_version/",
	builds: "/a/clinic/api/application/v1/working-app/",
	profile: "/a/clinic/apps/download/released-build/profile.ccpr",
	suite: "/a/clinic/apps/download/released-build/suite.xml",
};
const VERSIONS = { currentVersion: 5, latestBuild: 5, latestReleasedBuild: 3 };
const PROFILE = `<profile><suite><resource id="suite"><location authority="remote">${HOST}${PATH.suite}</location></resource></suite></profile>`;
const INPUT = {
	app_id: APP,
	...TARGET,
	entry_point_uuid: ENTRY,
	selections: [{ module_uuid: MODULE, case_ids: ["hq-b /?", "hq-a"] }],
};
function asUser<T>(
	run: (client: Client) => Promise<T>,
	userId = ACTOR,
	scopes = ["nova.read", "nova.hq.write"],
) {
	return withMcpClient(
		(server) =>
			registerGetEntryPointLink(server, { userId, scopes, authKind: "oauth" }),
		run,
	);
}
async function call(client: Client, args: Record<string, unknown> = INPUT) {
	return client.callTool({ name: "get_entry_point_link", arguments: args });
}
function errorBody(result: Awaited<ReturnType<typeof call>>) {
	expect(result.isError).toBe(true);
	expect(result.content).toEqual([{ type: "text", text: expect.any(String) }]);
	const part = result.content[0];
	if (part.type !== "text") throw new Error("Expected text error");
	const body = JSON.parse(part.text);
	expect(body).not.toHaveProperty("url");
	return body;
}
function paths(peer: MockAgent) {
	return (
		peer
			.getCallHistory()
			?.calls()
			.map(({ method, fullUrl }) => ({ method, fullUrl })) ?? []
	);
}
function reply(peer: MockAgent, path: string, data: unknown, statusCode = 200) {
	return peer
		.get(HOST)
		.intercept({
			method: "GET",
			path,
			headers: { authorization: "ApiKey account@dimagi.com:fixture-key" },
		})
		.reply(statusCode, typeof data === "string" ? data : JSON.stringify(data));
}
function available(peer: MockAgent) {
	const domains = {
		meta: { total_count: 1 },
		objects: [{ domain_name: "clinic", project_name: "Clinic" }],
	};
	reply(peer, PATH.domains, domains);
	reply(peer, PATH.links, domains);
	reply(peer, PATH.multiSelect, domains);
}
function released(
	peer: MockAgent,
	suite: string,
	options: {
		profile?: string;
		workingVersion?: number;
		suiteStatus?: number;
	} = {},
) {
	available(peer);
	const versions =
		options.workingVersion === undefined
			? VERSIONS
			: {
					currentVersion: options.workingVersion,
					latestBuild: options.workingVersion,
					latestReleasedBuild: options.workingVersion,
				};
	reply(peer, PATH.versions, versions);
	reply(
		peer,
		PATH.builds,
		applicationAnswer(
			"working-app",
			options.workingVersion === undefined
				? [
						{ id: "newer-unreleased", version: 5, is_released: false },
						{ id: "released-build", version: 3, is_released: true },
						{ id: "older-released", version: 2, is_released: true },
					]
				: [
						{
							id: "released-build",
							version: options.workingVersion,
							is_released: true,
						},
					],
		).body,
	);
	reply(peer, PATH.profile, options.profile ?? PROFILE);
	reply(peer, PATH.suite, suite, options.suiteStatus ?? 200);
}
function confirm(
	peer: MockAgent,
	version: number | null = 3,
	before?: () => Promise<void>,
) {
	peer
		.get(HOST)
		.intercept({
			method: "GET",
			path: PATH.versions,
			headers: { authorization: "ApiKey account@dimagi.com:fixture-key" },
		})
		.reply(async () => {
			await before?.();
			return {
				statusCode: 200,
				data: JSON.stringify({ ...VERSIONS, latestReleasedBuild: version }),
			};
		});
}
async function seed(publish = true) {
	const config = caseListConfig([{ field: "case_name", header: "Name" }]);
	config.selection = { kind: "multiple", maximum: 3 };
	const doc = buildDoc({
		appName: "Patient visits",
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				uuid: MODULE,
				name: "Patients",
				caseType: "patient",
				caseListConfig: config,
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [{ id: "note", kind: "text" }],
					},
				],
			},
		],
	});
	doc.modules[MODULE].entryPoint = { uuid: ENTRY, id: "visit" };
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
			commcare_username: "account@dimagi.com",
			commcare_api_key: "ciphertext",
			commcare_server: "india",
			approved_domains: JSON.stringify([
				{ name: "clinic", displayName: "Clinic" },
			]),
			updated_at: new Date(),
		})
		.execute();
	const loaded = await loadAppBlueprint(APP, ACTOR, "edit");
	const app = expandDoc(loaded.doc, { runtimeTarget: RUNTIME });
	const suite = new AdmZip(
		compileCcz(app, doc.appName, loaded.doc, { runtimeTarget: RUNTIME }),
	).readAsText("suite.xml");
	if (!publish) return { suite, generation: "" };
	const exported = await prepareExportBoundary({
		mode: "hq-upload",
		access: loaded.access,
		doc: loaded.doc,
		compiledAtSeq: loaded.app.mutation_seq,
		attachmentTarget: null,
	});
	if (!exported.ok) throw new Error(JSON.stringify(exported.violations));
	const entries = publishedEntryPoints(
		exported.prepared,
		app,
		doc.appName,
		RUNTIME,
	);
	expect(entries).toHaveLength(1);
	expect(entries[0].requiredSelections).toEqual([
		{
			moduleUuid: MODULE,
			caseType: "patient",
			cardinality: "multiple",
			maximum: 3,
			argumentId: "selected_cases",
		},
	]);
	await foldDeploymentAttempt(
		SCOPE,
		TARGET,
		"preflight",
		{ status: "succeeded", at: "2026-09-01T00:00:00.000Z" },
		{ ensure: true, expectedEndings: 0 },
	);
	const generation = crypto.randomUUID();
	const created = await admitAppCreate(SCOPE, TARGET, {
		expectedEndings: 0,
		firstContentGeneration: generation,
	});
	await settleRemoteWrites([created], {
		kind: "settled",
		resourceId: "working-app",
	});
	await recordRemoteResource(SCOPE, TARGET, {
		expectedEndings: 0,
		kind: "app",
		novaResourceId: APP,
		remoteId: "working-app",
		ownership: "nova-created",
		pushedRevision: loaded.app.mutation_seq,
		remoteRevision: 3,
		uploadedAt: "2026-09-01T00:00:00.000Z",
		baseline: {
			origin: "unread",
			remoteAppId: "working-app",
			sourceGzip: null,
			sourceBytes: null,
			sourceDigest: null,
			ownership: null,
			observedAt: "2026-09-01T00:00:00.000Z",
			discard: null,
			novaRevision: null,
			mediaFiles: { kind: "set", files: null },
			firstPublish: { kind: "set", list: null },
		},
	});
	expect(
		await finishDeploymentContentWrite(
			SCOPE,
			TARGET,
			generation,
			{
				generation,
				remoteAppId: "working-app",
				sourceSequence: loaded.app.mutation_seq,
				entries,
				dependencies: [],
			},
			{ expectedEndings: 0 },
		),
	).toBe(true);
	return { suite, generation };
}

it("returns the working-app URL only after exact released resources match and the observation commits", async () => {
	const { suite, generation } = await seed();
	const before = Date.now();
	await withHttpPeer(async (peer) => {
		released(peer, suite);
		confirm(peer);
		await asUser(async (client) => {
			const result = JSON.parse(resultText(await call(client)));
			expect(result).toEqual({
				app_id: APP,
				url: `${HOST}/a/clinic/app/v1/working-app/visit/?selected_cases=hq-b+%2F%3F%2Chq-a`,
				checked_at: expect.any(String),
				released_build_id: "released-build",
				released_version: 3,
			});
			expect(Date.parse(result.checked_at)).toBeGreaterThanOrEqual(before);
			expect(Date.parse(result.checked_at)).toBeLessThanOrEqual(Date.now());
			expect((await readEntryPointEvidence(SCOPE, TARGET)).observation).toEqual(
				{
					generation,
					remoteAppId: "working-app",
					entryPointUuid: ENTRY,
					sourceSequence: 0,
					checkedAt: result.checked_at,
					releasedBuildId: "released-build",
					releasedVersion: 3,
				},
			);
		});
		expect(paths(peer)).toEqual(
			[
				PATH.domains,
				PATH.links,
				PATH.multiSelect,
				PATH.versions,
				PATH.builds,
				PATH.profile,
				PATH.suite,
				PATH.versions,
			].map((path) => ({ method: "GET", fullUrl: HOST + path })),
		);
	});
	expect(vi.mocked(decrypt).mock.calls).toEqual([["ciphertext"]]);
});

it("keeps a member’s released link when an overlapping publisher sent nothing", async () => {
	const { suite } = await seed(false);
	const model = new TargetPeer({
		credentials: {
			server: TARGET.server,
			username: "account@dimagi.com",
			apiKey: "fixture-key",
		},
		domain: TARGET.domain,
		flags: new Set(["SESSION_ENDPOINTS", "CASE_SEARCH_ADVANCED"]),
		commcareVersion: CORPUS_COMMCARE_VERSION,
		appId: RUNTIME.appId,
		caseSearchEnabled: true,
		cloudcareGranted: true,
	});
	const publish = async () => {
		const loaded = await loadAppBlueprint(APP, ACTOR, "edit");
		return publishAppToHq({
			requireHqImport: null,
			scope: SCOPE,
			...TARGET,
			doc: loaded.doc,
			compiledAtSeq: loaded.app.mutation_seq,
			appName: loaded.app.app_name,
			confirm: PLAN_FEATURE_IDS.map((subject) => ({
				kind: "plan-feature",
				subject,
			})),
			reloadHead: async () => {
				const fresh = await loadAppBlueprint(APP, ACTOR, "edit");
				return { doc: fresh.doc, seq: fresh.app.mutation_seq };
			},
		});
	};
	const verify = () =>
		withHttpPeer(async (peer) => {
			const version = model.saveCounter();
			if (version === null) throw new Error("Expected a working app on HQ");
			released(peer, suite, { workingVersion: version });
			reply(peer, PATH.versions, {
				currentVersion: version,
				latestBuild: version,
				latestReleasedBuild: version,
			});
			return asUser(
				async (client) => JSON.parse(resultText(await call(client))).url,
			);
		});
	await withHttpPeer(async (peer) => {
		peer
			.get(HOST)
			.intercept({ path: () => true, method: () => true })
			.reply(async (opts) => {
				const headers = new Headers(opts.headers as Record<string, string>);
				expect(headers.get("authorization")).toBe(
					"ApiKey account@dimagi.com:fixture-key",
				);
				const request = {
					method: opts.method,
					path: opts.path,
					contentType: headers.get("content-type") ?? undefined,
					body: await readHttpRequestBody(opts),
				};
				model.requests.push(request);
				const answer = await model.answer(request);
				return {
					statusCode: answer.status,
					data: answer.body,
					responseOptions: { headers: { "content-type": answer.contentType } },
				};
			})
			.persist();
		const prime = await publish();
		expect(prime.refusal).toBeNull();
		const posts = () =>
			model.requests.filter((r) => r.method === "POST").length;
		const afterPrime = posts();
		const original = deploymentStore.admitAppWrite;
		let winner: Awaited<ReturnType<typeof readEntryPointEvidence>> | undefined;
		const hook = vi
			.spyOn(deploymentStore, "admitAppWrite")
			.mockImplementationOnce(async (...args) => {
				expect(posts()).toBe(afterPrime);
				// The first publisher has reached its send boundary but holds no
				// admission. The predecessor's released link is still available.
				expect(await verify()).toContain("/working-app/visit/");
				const newer = await publish();
				expect(newer.refusal).toBeNull();
				expect(await verify()).toContain("/working-app/visit/");
				winner = await readEntryPointEvidence(SCOPE, TARGET);
				expect(winner.manifest?.generation).toBe(
					winner.observation?.generation,
				);
				return original(...args);
			});
		try {
			const older = await publish();
			expect(older.landed).toBe(false);
			expect(posts()).toBe(afterPrime + 1);
			expect(await readEntryPointEvidence(SCOPE, TARGET)).toEqual(winner);
			expect(await verify()).toContain("/working-app/visit/");
			if (!winner?.generation)
				throw new Error("Missing the winner’s generation");
			const checked = await readEntryPointEvidence(SCOPE, TARGET);
			expect(
				await finishDeploymentContentWrite(
					SCOPE,
					TARGET,
					winner.generation,
					null,
					{ expectedEndings: 0 },
					{ writeIds: [], settle: [] },
				),
			).toBe(false);
			expect(await readEntryPointEvidence(SCOPE, TARGET)).toEqual(checked);
		} finally {
			hook.mockRestore();
		}
	});
}, 30_000);

it("keeps the released link observed after a settled publisher's claim was retired", async () => {
	const { suite } = await seed();
	const fence = { expectedEndings: 0 };
	const original = (await readEntryPointEvidence(SCOPE, TARGET)).manifest;
	if (!original) throw new Error("Expected the published entry point.");
	const publish = async (counter: number) => {
		const generation = crypto.randomUUID();
		const write = await admitAppWrite(SCOPE, TARGET, {
			...fence,
			firstContentGeneration: generation,
			remoteAppId: original.remoteAppId,
			observedPushToken: appMappingToken(await readDeployment(SCOPE, TARGET)),
			compiledIdentity: await readTargetIdentity(SCOPE, TARGET),
			writeKind: "import",
			compiledAtSeq: original.sourceSequence,
		});
		if (write.kind !== "admitted")
			throw new Error("Expected the import to be admitted.");
		const writeIds = [write.writeId];
		const result = await recordRemoteResource(
			SCOPE,
			TARGET,
			{
				...fence,
				kind: "app",
				novaResourceId: APP,
				remoteId: original.remoteAppId,
				ownership: "nova-created",
				pushedRevision: original.sourceSequence,
				remoteRevision: counter,
				uploadedAt: new Date().toISOString(),
				baseline: {
					origin: "unread",
					remoteAppId: original.remoteAppId,
					sourceGzip: null,
					sourceBytes: null,
					sourceDigest: null,
					ownership: null,
					observedAt: new Date().toISOString(),
					discard: null,
					novaRevision: null,
					mediaFiles: { kind: "keep" },
					firstPublish: { kind: "set", list: null },
				},
			},
			{ writeIds, settle: [{ writeIds, how: { kind: "settled" } }] },
		);
		expect(result.pushToken).toEqual(expect.any(String));
		return () =>
			finishDeploymentContentWrite(
				SCOPE,
				TARGET,
				generation,
				{ ...original, generation },
				fence,
				{ writeIds, settle: [] },
			);
	};
	const finishRetired = await publish(4);
	await h.seedProjectMember(ACTOR, PROJECT, "owner");
	await softDeleteApp(APP, ACTOR);
	const taker = testUuid("temporary-claim");
	await birthAdoptedApp(h, {
		appId: taker,
		projectId: PROJECT,
		actorUserId: ACTOR,
		target: TARGET,
		remoteAppId: original.remoteAppId,
	});
	await softDeleteApp(taker, ACTOR);
	await restoreApp(APP, ACTOR);
	// A new claim is its own ordering domain, even on the same remote ID.
	const finishCurrent = await publish(3);
	expect(await finishCurrent()).toBe(true);
	await withHttpPeer(async (peer) => {
		released(peer, suite);
		confirm(peer);
		await asUser(async (client) => {
			const link = JSON.parse(resultText(await call(client)));
			expect(link.released_build_id).toBe("released-build");
			const before = await readEntryPointEvidence(SCOPE, TARGET);
			expect(before.observation?.remoteAppId).toBe(original.remoteAppId);
			expect(await finishRetired()).toBe(false);
			expect(await readEntryPointEvidence(SCOPE, TARGET)).toEqual(before);
			released(peer, suite);
			confirm(peer);
			expect(JSON.parse(resultText(await call(client))).url).toBe(link.url);
		});
	});
	// A real media job on the current claim remained open into the
	// next generation. A settled response alone cannot order that job
	// before the later publisher, so this completion invalidates the link.
	const earlier = crypto.randomUUID();
	const media = await admitAppWrite(SCOPE, TARGET, {
		...fence,
		firstContentGeneration: earlier,
		observedPushToken: appMappingToken(await readDeployment(SCOPE, TARGET)),
		remoteAppId: original.remoteAppId,
		compiledIdentity: await readTargetIdentity(SCOPE, TARGET),
		writeKind: "media",
	});
	if (media.kind !== "admitted")
		throw new Error("Expected the media job to be admitted.");
	const finishLater = await publish(6);
	expect(await finishLater()).toBe(true);
	await settleRemoteWrites([media.writeId], { kind: "settled" });
	expect(
		await finishDeploymentContentWrite(SCOPE, TARGET, earlier, null, fence, {
			writeIds: [media.writeId],
			settle: [],
		}),
	).toBe(false);
	expect((await readEntryPointEvidence(SCOPE, TARGET)).manifest).toBeNull();
}, 30_000);

it.each([
	{
		label: "drifted command",
		suite:
			'<suite><endpoint id="visit"><command value="\'other\'"/></endpoint><entry><command id="other"/><session/></entry></suite>',
		message: "doesn't match",
	},
	{
		label: "login document",
		profile: "<html><body>Sign in</body></html>",
		message: "install profile",
	},
	{
		label: "temporary resource failure",
		suiteStatus: 503,
		message: "couldn't read",
	},
])(
	"withholds a link for $label and preserves the previous observation",
	async ({ suite: replacement, profile, suiteStatus, message }) => {
		const { suite } = await seed();
		await withHttpPeer(async (peer) => {
			released(peer, suite);
			confirm(peer);
			await asUser(async (client) => resultText(await call(client)));
			const old = await readEntryPointEvidence(SCOPE, TARGET);
			released(peer, replacement ?? suite, { profile, suiteStatus });
			await asUser(async (client) => {
				const result = await call(client);
				expect(errorBody(result)).toEqual({
					app_id: APP,
					error_type: "invalid_input",
					message: expect.stringContaining(message),
				});
			});
			expect(await readEntryPointEvidence(SCOPE, TARGET)).toEqual(old);
			expect(paths(peer)).toHaveLength(15);
		});
	},
);

it("withholds a link when the release is withdrawn between the two version reads", async () => {
	const { suite } = await seed();
	await withHttpPeer(async (peer) => {
		released(peer, suite);
		confirm(peer, null);
		await asUser(async (client) => {
			const result = await call(client);
			expect(errorBody(result).message).toContain("released build changed");
		});
		expect(
			(await readEntryPointEvidence(SCOPE, TARGET)).observation,
		).toBeNull();
		expect(paths(peer)).toHaveLength(8);
	});
});

it("rejects a completed remote check after another publish invalidates its generation", async () => {
	const { suite, generation } = await seed();
	await withHttpPeer(async (peer) => {
		released(peer, suite);
		confirm(peer, 3, async () => {
			const { writeId } = await admitEntryPointImport(SCOPE, TARGET, {
				expectedEndings: 0,
			});
			await settleRemoteWrites([writeId], { kind: "settled" });
		});
		await asUser(async (client) => {
			const result = await call(client);
			expect(errorBody(result).message).toContain("app or deployment changed");
		});
		const evidence = await readEntryPointEvidence(SCOPE, TARGET);
		expect(evidence.generation).not.toBe(generation);
		expect(evidence.manifest).toBeNull();
		expect(evidence.observation).toBeNull();
		expect(paths(peer)).toHaveLength(8);
	});
});

it("does not return a verified URL when storing its observation fails, and a retry records it", async () => {
	const { suite } = await seed();
	await sql`CREATE FUNCTION refuse_link_observation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private database failure'; END $$`.execute(
		h.db(),
	);
	await sql`CREATE TRIGGER refuse_link_observation BEFORE UPDATE OF entry_point_observation ON app_deployments FOR EACH ROW EXECUTE FUNCTION refuse_link_observation()`.execute(
		h.db(),
	);
	await withHttpPeer(async (peer) => {
		released(peer, suite);
		confirm(peer);
		await asUser(async (client) => {
			const result = await call(client);
			expect(errorBody(result)).toEqual({
				app_id: APP,
				error_type: "internal",
				message: "Something went wrong during generation.",
			});
		});
		expect(
			(await readEntryPointEvidence(SCOPE, TARGET)).observation,
		).toBeNull();
		await sql`DROP TRIGGER refuse_link_observation ON app_deployments`.execute(
			h.db(),
		);
		released(peer, suite);
		confirm(peer);
		await asUser(async (client) => resultText(await call(client)));
		expect(
			(await readEntryPointEvidence(SCOPE, TARGET)).observation
				?.releasedBuildId,
		).toBe("released-build");
		expect(paths(peer)).toHaveLength(16);
	});
});

it("rejects an authoring edit during verification and refuses the resulting stale publish before another HQ read", async () => {
	const { suite } = await seed();
	await withHttpPeer(async (peer) => {
		released(peer, suite);
		confirm(peer, 3, async () => {
			const commit = await commitGuardedBatch({
				appId: APP,
				actorUserId: ACTOR,
				expectedProjectId: PROJECT,
				batchId: "rename-after-release-read",
				kind: "autosave",
				mutations: admitMutationBatch([
					{ kind: "setAppName", name: "Current visits" },
				]),
			});
			expect(commit.seq).toBe(1);
		});
		await asUser(async (client) => {
			const changed = await call(client);
			expect(errorBody(changed).message).toContain("app or deployment changed");
			const stale = await call(client);
			expect(errorBody(stale).message).toContain(
				"changed since it was published",
			);
		});
		expect(
			(await readEntryPointEvidence(SCOPE, TARGET)).observation,
		).toBeNull();
		expect(paths(peer)).toHaveLength(8);
		expect(vi.mocked(decrypt).mock.calls).toEqual([["ciphertext"]]);
	});
});

it("rechecks edit membership before recording a remotely successful verification", async () => {
	const { suite } = await seed();
	await withHttpPeer(async (peer) => {
		released(peer, suite);
		confirm(peer, 3, async () => {
			await sql`UPDATE auth_member SET role = 'viewer' WHERE "userId" = ${ACTOR} AND "organizationId" = ${PROJECT}`.execute(
				h.db(),
			);
		});
		await asUser(async (client) => {
			const result = await call(client);
			expect(errorBody(result).error_type).toBe("not_found");
		});
		expect(
			(
				await h
					.db()
					.selectFrom("app_deployments")
					.select("entry_point_observation")
					.executeTakeFirstOrThrow()
			).entry_point_observation,
		).toBeNull();
		expect(paths(peer)).toHaveLength(8);
	});
});

it("refuses unauthorized callers, SDK-invalid identities, and invalid case selections before KMS or HTTP", async () => {
	await seed();
	await withHttpPeer(async (peer) => {
		await asUser(
			async (client) => {
				const result = await call(client);
				expect(errorBody(result)).toMatchObject({
					error_type: "scope_missing",
					required_scope: "nova.hq.write",
				});
			},
			ACTOR,
			["nova.read", "nova.hq.read"],
		);
		for (const user of ["viewer", "outsider"])
			await asUser(async (client) => {
				const result = await call(client);
				expect(errorBody(result)).toEqual({
					app_id: APP,
					error_type: "not_found",
					message: "App not found.",
				});
			}, user);
		await asUser(async (client) => {
			for (const args of [
				{ ...INPUT, entry_point_uuid: "ep1" },
				{ ...INPUT, selections: [{ module_uuid: "m1", case_ids: ["hq-a"] }] },
				{ ...INPUT, surprise: true },
			]) {
				const result = await call(client, args);
				expect(result.isError).toBe(true);
				expect(JSON.stringify(result)).toContain("Input validation error");
			}
			for (const selections of [
				[],
				[{ module_uuid: MODULE, case_ids: [" "] }],
				[{ module_uuid: MODULE, case_ids: ["a,b"] }],
				[{ module_uuid: MODULE, case_ids: ["a", "a"] }],
				[{ module_uuid: MODULE, case_ids: ["a", "b", "c", "d"] }],
				[INPUT.selections[0], INPUT.selections[0]],
			]) {
				const result = await call(client, { ...INPUT, selections });
				expect(errorBody(result).error_type).toBe("invalid_input");
			}
		});
		expect(
			(await readEntryPointEvidence(SCOPE, TARGET)).observation,
		).toBeNull();
		expect(paths(peer)).toEqual([]);
		expect(decrypt).not.toHaveBeenCalled();
	});
});

it("refuses absent and incomplete publishes before contacting HQ", async () => {
	await seed(false);
	await withHttpPeer(async (peer) => {
		await asUser(async (client) => {
			const absent = await call(client);
			expect(errorBody(absent).message).toContain(
				"Publish this app to the selected project space",
			);
			await foldDeploymentAttempt(
				SCOPE,
				TARGET,
				"preflight",
				{ status: "succeeded", at: "2026-09-01T00:00:00.000Z" },
				{ ensure: true, expectedEndings: 0 },
			);
			const incomplete = await call(client);
			expect(errorBody(incomplete).message).toContain("complete publish");
		});
		expect(paths(peer)).toEqual([]);
		expect(decrypt).not.toHaveBeenCalled();
	});
});
