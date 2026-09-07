/** Real SDK/action dispatch, persisted personas and ledger, and native HQ HTTP. */
import type { Client } from "@modelcontextprotocol/client";
import { sql } from "kysely";
import type { MockAgent } from "undici";
import { beforeEach, expect, it, vi } from "vitest";
import {
	readHttpRequestBody,
	withHttpPeer,
} from "@/__tests__/helpers/httpPeer";
import { whileBlocked } from "@/__tests__/helpers/postgresBarrier";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { getSession } from "@/lib/auth-utils";
import { decrypt } from "@/lib/commcare/encryption";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { commitGuardedBatch } from "@/lib/db/apps";
import { provisionWorkersAction } from "@/lib/deployment/actions";
import {
	foldDeploymentAttempt,
	readDeployment,
	recordPushedResources,
	recordRemoteResource,
} from "@/lib/deployment/store";
import { provisionWorkers } from "@/lib/deployment/workers";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import type { BlueprintDoc } from "@/lib/domain";
import { log } from "@/lib/logger";
import { createLocation } from "@/lib/organization/service";
import { loadAppBlueprint } from "../loadApp";
import { registerProvisionWorkers } from "../tools/provisionWorkers";
import { withMcpClient } from "./client";
import { resultText } from "./promptClient";

vi.mock("@/lib/commcare/encryption", () => ({ decrypt: vi.fn() }));
vi.mock("@/lib/auth-utils", () => ({ getSession: vi.fn() }));
const h = setupAppStateTestDb("provision_workers_", { authSchema: "migrated" });
const APP = "worker-app",
	PROJECT = "program",
	ACTOR = "editor";
const AMINA = testUuid("worker-amina"),
	JOSEPH = testUuid("worker-joseph"),
	CADRE = testUuid("worker-cadre"),
	REGION = testUuid("worker-region");
const TARGET = { server: "india", domain: "clinic" } as const;
const SCOPE = {
	appId: APP,
	projectId: PROJECT,
	actorUserId: ACTOR,
	role: "editor",
};
const HOST = "https://india.commcarehq.org",
	PATH = "/a/clinic/api/user/v1/",
	SEARCH = "/a/clinic/api/bulk-user/v1/";
const requested = [
	{ persona_uuid: AMINA, username: "amina" },
	{ persona_uuid: JOSEPH, username: "joseph" },
];
beforeEach(() => {
	vi.mocked(decrypt).mockResolvedValue("fixture-key");
});
function document(organization = false): BlueprintDoc {
	return {
		...buildDoc({
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
		}),
		userProperties: { [CADRE]: { uuid: CADRE, slug: "cadre", label: "Cadre" } },
		userPropertyOrder: [CADRE],
		personas: {
			[AMINA]: { uuid: AMINA, name: "Amina", values: { [CADRE]: "community" } },
			[JOSEPH]: { uuid: JOSEPH, name: "Joseph" },
		},
		personaOrder: [AMINA, JOSEPH],
		...(organization
			? {
					organizationLevels: {
						[REGION]: {
							uuid: REGION,
							code: "region",
							name: "Region",
							caseFlow: {
								workers: "assigned" as const,
								ownsCases: true,
								descendantCases: { kind: "none" as const },
							},
							addressBook: { reach: "own-branch" as const },
						},
					},
					organizationLevelOrder: [REGION],
				}
			: {}),
	};
}
async function seed(
	options: { organization?: boolean; published?: boolean } = {},
) {
	await h.seedAppWithBlueprint(document(options.organization), {
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
	if (options.published === false) return;
	const at = new Date().toISOString();
	await foldDeploymentAttempt(
		SCOPE,
		TARGET,
		"preflight",
		{ status: "succeeded", at },
		{ ensure: true },
	);
	await recordRemoteResource(SCOPE, TARGET, {
		kind: "app",
		novaResourceId: APP,
		remoteId: "published-app",
		ownership: "nova-created",
		pushedRevision: 0,
		remoteRevision: 1,
		uploadedAt: at,
	});
}
function asUser<T>(
	run: (client: Client) => Promise<T>,
	userId = ACTOR,
	scopes = ["nova.read", "nova.hq.write"],
) {
	return withMcpClient(
		(server) =>
			registerProvisionWorkers(server, { userId, scopes, authKind: "oauth" }),
		run,
	);
}
function call(client: Client, extra: Record<string, unknown> = {}) {
	return client.callTool({
		name: "provision_workers",
		arguments: { app_id: APP, ...TARGET, workers: requested, ...extra },
	});
}
function body(result: Awaited<ReturnType<typeof call>>, error = false) {
	expect(result.isError === true, JSON.stringify(result)).toBe(error);
	return JSON.parse(resultText({ ...result, isError: undefined }));
}
function search(peer: MockAgent, data: unknown = { objects: [] }) {
	return peer
		.get(HOST)
		.intercept({
			path: (path) => path.startsWith(SEARCH),
			method: "GET",
			headers: { authorization: "ApiKey account:fixture-key" },
		})
		.reply(200, JSON.stringify(data));
}
function wire(peer: MockAgent, id?: string) {
	return peer.get(HOST).intercept({
		path: id ? `${PATH}${id}/` : PATH,
		method: id ? "PUT" : "POST",
		headers: { authorization: "ApiKey account:fixture-key" },
	});
}
async function snapshot() {
	return {
		deployments: await h
			.db()
			.selectFrom("app_deployments")
			.selectAll()
			.execute(),
		resources: await h
			.db()
			.selectFrom("app_deployment_resources")
			.selectAll()
			.orderBy("id")
			.execute(),
	};
}
function changes(mutations: Parameters<typeof admitMutationBatch>[0]) {
	return commitGuardedBatch({
		appId: APP,
		batchId: crypto.randomUUID(),
		actorUserId: ACTOR,
		expectedProjectId: PROJECT,
		kind: "autosave",
		mutations: admitMutationBatch(mutations),
	});
}

it("creates accounts with the exact generated credentials in the SDK answer, then updates known identities even while search lags", async () => {
	await seed();
	const before = await snapshot();
	const sent: Record<string, unknown>[] = [];
	await withHttpPeer(async (peer) => {
		search(peer);
		for (const name of ["amina", "joseph"])
			wire(peer).reply(async (request) => {
				sent.push(JSON.parse((await readHttpRequestBody(request)).toString()));
				return { statusCode: 201, data: JSON.stringify({ id: `hq-${name}` }) };
			});
		await asUser(async (client) => {
			const made = body(await call(client));
			expect(made.workers).toEqual(
				requested.map((person, index) => ({
					persona_uuid: person.persona_uuid,
					persona_name: index === 0 ? "Amina" : "Joseph",
					username: `${person.username}@clinic.commcarehq.org`,
					hq_user_id: `hq-${person.username}`,
					action: "created",
					adopted: false,
					password: sent[index]?.password,
				})),
			);
			expect(
				sent.map(({ password, ...rest }) => {
					expect(password).toEqual(expect.any(String));
					expect(String(password)).toHaveLength(20);
					return rest;
				}),
			).toEqual([
				{ username: "amina", user_data: { cadre: "community" } },
				{ username: "joseph", user_data: { cadre: "" } },
			]);
			const landed = await snapshot();
			expect(landed.deployments).toEqual(before.deployments);
			expect(
				landed.resources
					.filter((row) => row.kind === "worker")
					.map((row) => row.remote_id)
					.sort(),
			).toEqual(["hq-amina", "hq-joseph"]);
			for (const request of sent)
				expect(
					JSON.stringify([
						landed,
						vi.mocked(log.info).mock.calls,
						vi.mocked(log.warn).mock.calls,
						vi.mocked(log.error).mock.calls,
					]),
				).not.toContain(request.password);
			search(peer);
			wire(peer, "hq-amina").reply(async (request) => {
				expect(
					JSON.parse((await readHttpRequestBody(request)).toString()),
				).toEqual({ user_data: { cadre: "community" } });
				return { statusCode: 200, data: JSON.stringify({ id: "hq-amina" }) };
			});
			const updated = body(await call(client, { workers: [requested[0]] }));
			expect(updated.workers).toEqual([
				{ ...made.workers[0], action: "updated", password: null },
			]);
			expect(
				(await readDeployment(SCOPE, TARGET))?.active.filter(
					(row) => row.kind === "worker",
				),
			).toHaveLength(2);
		});
		expect(
			peer
				.getCallHistory()
				?.calls()
				.map((call) => call.method),
		).toEqual(["GET", "POST", "POST", "GET", "PUT"]);
	});
});

it.each(["refused", "lost", "malformed"])(
	"keeps the first account and its credential when the next create is %s",
	async (failure) => {
		await seed();
		const sent: Record<string, unknown>[] = [];
		await withHttpPeer(async (peer) => {
			search(peer);
			wire(peer).reply(async (request) => {
				sent.push(JSON.parse((await readHttpRequestBody(request)).toString()));
				return { statusCode: 201, data: '{"id":"hq-amina"}' };
			});
			wire(peer).reply(async (request) => {
				sent.push(JSON.parse((await readHttpRequestBody(request)).toString()));
				if (failure === "lost")
					throw new Error("Response lost after account creation");
				return {
					statusCode: failure === "refused" ? 400 : 201,
					data:
						failure === "refused"
							? '{"error":"Username is already taken or reserved."}'
							: "null",
				};
			});
			await asUser(async (client) => {
				const result = body(await call(client), true);
				expect(result.error_type).toBe(
					failure === "refused" ? "hq_rejected_worker" : "hq_worker_may_exist",
				);
				expect(result.workers).toHaveLength(1);
				expect(result.workers[0].password).toBe(sent[0]?.password);
				if (failure === "refused") {
					expect(result.unconfirmed_workers).toBeUndefined();
					expect(result.message).toContain("Username is already taken");
				} else
					expect(result.unconfirmed_workers).toEqual([
						{
							persona_uuid: JOSEPH,
							persona_name: "Joseph",
							username: "joseph@clinic.commcarehq.org",
							password: sent[1]?.password,
						},
					]);
				expect(
					(await readDeployment(SCOPE, TARGET))?.active
						.filter((row) => row.kind === "worker")
						.map((row) => row.remoteId),
				).toEqual(["hq-amina"]);
			});
			expect(
				peer
					.getCallHistory()
					?.calls()
					.map((call) => call.method),
			).toEqual(["GET", "POST", "POST"]);
		});
	},
);

it("requires exact adoption, records the actor, and never resets the existing account password or places", async () => {
	await seed();
	const before = await snapshot();
	await withHttpPeer(async (peer) => {
		const found = {
			objects: [
				{ id: "foreign-account", username: "amina@clinic.commcarehq.org" },
			],
		};
		search(peer, found);
		search(peer, found);
		wire(peer, "foreign-account").reply(async (request) => {
			expect(
				JSON.parse((await readHttpRequestBody(request)).toString()),
			).toEqual({ user_data: { cadre: "community" } });
			return { statusCode: 200, data: '{"id":"foreign-account"}' };
		});
		await asUser(async (client) => {
			const conflict = body(
				await call(client, { workers: [requested[0]] }),
				true,
			);
			expect(conflict.worker_conflicts).toEqual([
				{
					persona_uuid: AMINA,
					persona_name: "Amina",
					username: "amina@clinic.commcarehq.org",
					hq_user_id: "foreign-account",
				},
			]);
			expect(await snapshot()).toEqual(before);
			const adopted = body(
				await call(client, {
					workers: [requested[0]],
					adopt_personas: [AMINA],
				}),
			);
			expect(adopted.workers[0]).toMatchObject({
				action: "updated",
				adopted: true,
				password: null,
			});
			expect(
				(await readDeployment(SCOPE, TARGET))?.active.find(
					(row) => row.kind === "worker",
				),
			).toMatchObject({
				novaResourceId: AMINA,
				remoteId: "foreign-account",
				ownership: "adopted",
				adoptedBy: ACTOR,
			});
		});
	});
});

it.each([
	"malformed-search",
	"missing-persona",
	"invalid-name",
	"unpublished",
	"wrong-server",
	"missing-key",
])("refuses %s before any account write", async (failure) => {
	await seed({ published: failure !== "unpublished" });
	if (failure === "wrong-server")
		await h
			.db()
			.updateTable("user_settings")
			.set({ commcare_server: "europe" })
			.execute();
	if (failure === "missing-key")
		await h.db().deleteFrom("user_settings").execute();
	const before = await snapshot();
	await withHttpPeer(async (peer) => {
		if (failure === "malformed-search") search(peer, {});
		await asUser(async (client) => {
			const result = body(
				await call(client, {
					workers:
						failure === "missing-persona"
							? [{ persona_uuid: testUuid("gone"), username: "gone" }]
							: failure === "invalid-name"
								? [{ persona_uuid: AMINA, username: "Amina Osei!" }]
								: requested,
				}),
				true,
			);
			expect(result.error_type).toBe(
				failure === "malformed-search"
					? "hq_worker_state_unknown"
					: failure === "unpublished"
						? "app_not_published"
						: failure === "wrong-server" || failure === "missing-key"
							? "hq_not_configured"
							: "workers_not_provisionable",
			);
			expect(result.workers).toEqual([]);
		});
		expect(
			peer
				.getCallHistory()
				?.calls()
				.map((call) => call.method),
		).toEqual(failure === "malformed-search" ? ["GET"] : []);
		expect(await snapshot()).toEqual(before);
	});
});

it("waits for actual worker mapping persistence before releasing its credential answer", async () => {
	await seed();
	await withHttpPeer(async (peer) => {
		search(peer);
		wire(peer).reply(201, { id: "hq-amina" });
		await asUser(async (client) => {
			const result = await whileBlocked(
				h,
				(pg) => pg.query("LOCK TABLE app_deployment_resources IN SHARE MODE"),
				() => call(client, { workers: [requested[0]] }),
				async (settled) => {
					expect(settled).toBe(false);
					expect(
						peer
							.getCallHistory()
							?.calls()
							.map((call) => call.method),
					).toEqual(["GET", "POST"]);
				},
			);
			expect(body(result).workers[0]).toMatchObject({
				hq_user_id: "hq-amina",
				password: expect.any(String),
			});
			expect(
				(await readDeployment(SCOPE, TARGET))?.active.some(
					(row) => row.remoteId === "hq-amina",
				),
			).toBe(true);
		});
	});
});

it("returns the exact credential even when PostgreSQL refuses the worker mapping", async () => {
	await seed();
	await sql`create function refuse_worker_mapping() returns trigger language plpgsql as $$ begin if NEW.kind = 'worker' then raise exception 'Worker mapping unavailable'; end if; return NEW; end $$`.execute(
		h.db(),
	);
	await sql`create trigger refuse_worker_mapping before insert on app_deployment_resources for each row execute function refuse_worker_mapping()`.execute(
		h.db(),
	);
	await withHttpPeer(async (peer) => {
		search(peer);
		let password: unknown;
		wire(peer).reply(async (request) => {
			password = JSON.parse(
				(await readHttpRequestBody(request)).toString(),
			).password;
			return { statusCode: 201, data: '{"id":"hq-amina"}' };
		});
		const { doc } = await loadAppBlueprint(APP, ACTOR, "edit");
		const result = await provisionWorkers({
			scope: SCOPE,
			doc,
			locations: [],
			...TARGET,
			workers: [{ personaUuid: AMINA }],
		});
		expect(result.workers).toHaveLength(1);
		expect(result.workers[0]?.password).toBe(password);
		expect(result.deployment).toBeNull();
		expect(result.refusal).toBeNull();
		expect(
			(await readDeployment(SCOPE, TARGET))?.active.filter(
				(row) => row.kind === "worker",
			),
		).toEqual([]);
	});
});

async function place(assigned = true) {
	const location = (
		await createLocation(SCOPE, {
			levelUuid: REGION,
			parentId: null,
			name: "Denver",
			externalId: null,
			latitude: null,
			longitude: null,
			values: {},
		})
	).location;
	if (assigned)
		await changes([
			{
				kind: "updatePersona",
				uuid: AMINA,
				patch: { locations: { primaryUuid: location.id } },
			},
		]);
	return location;
}
async function mapPlace(location: Awaited<ReturnType<typeof place>>) {
	await recordPushedResources(
		SCOPE,
		TARGET,
		[
			{
				kind: "location",
				novaResourceId: location.id,
				remoteId: "hq-denver",
				ownership: "nova-created",
				pushedIdentity: location.siteCode,
				pushedRevision: null,
				remoteRevision: null,
			},
		],
		{ status: "partial" },
	);
}
it("refuses an unpublished place by name, then preserves the created account when its separate assignment is refused", async () => {
	await seed({ organization: true });
	const location = await place();
	await withHttpPeer(async (peer) => {
		await asUser(async (client) => {
			const refused = body(
				await call(client, { workers: [requested[0]] }),
				true,
			);
			expect(refused.error_type).toBe("workers_not_provisionable");
			expect(refused.message).toContain("Denver");
			expect(peer.getCallHistory()?.calls()).toHaveLength(0);
			await mapPlace(location);
			search(peer);
			let password: unknown;
			wire(peer).reply(async (request) => {
				const data = JSON.parse(
					(await readHttpRequestBody(request)).toString(),
				);
				password = data.password;
				expect(Object.keys(data).sort()).toEqual([
					"password",
					"user_data",
					"username",
				]);
				return { statusCode: 201, data: '{"id":"hq-amina"}' };
			});
			wire(peer, "hq-amina").reply(async (request) => {
				expect(
					JSON.parse((await readHttpRequestBody(request)).toString()),
				).toEqual({ locations: ["hq-denver"], primary_location: "hq-denver" });
				return {
					statusCode: 400,
					data: '{"error":"Could not find location ids: hq-denver."}',
				};
			});
			const result = body(
				await call(client, { workers: [requested[0]] }),
				true,
			);
			expect(result.message).toContain("The account works");
			expect(result.message).toContain(
				"Could not find location ids: hq-denver.",
			);
			expect(result.workers[0].password).toBe(password);
			expect(
				(await readDeployment(SCOPE, TARGET))?.active.find(
					(row) => row.kind === "worker",
				),
			).toMatchObject({ remoteId: "hq-amina", novaResourceId: AMINA });
			search(peer);
			wire(peer, "hq-amina").reply(async (request) => {
				expect(
					JSON.parse((await readHttpRequestBody(request)).toString()),
				).toEqual({
					user_data: { cadre: "community" },
					locations: ["hq-denver"],
					primary_location: "hq-denver",
				});
				return { statusCode: 200, data: '{"id":"hq-amina"}' };
			});
			expect(
				body(await call(client, { workers: [requested[0]] })).workers[0],
			).toMatchObject({ action: "updated", password: null });
		});
		expect(
			peer
				.getCallHistory()
				?.calls()
				.map((call) => call.method),
		).toEqual(["GET", "POST", "PUT", "GET", "PUT"]);
	});
});

it("clears an existing worker's places only for an app with an organization, and reconciles deleted personas without retiring accounts", async () => {
	await seed({ organization: true });
	await withHttpPeer(async (peer) => {
		search(peer);
		wire(peer).reply(201, { id: "hq-amina" });
		wire(peer).reply(201, { id: "hq-joseph" });
		await asUser(async (client) => {
			body(await call(client));
			await changes([{ kind: "removePersona", uuid: JOSEPH }]);
			search(peer);
			wire(peer, "hq-amina").reply(async (request) => {
				expect(
					JSON.parse((await readHttpRequestBody(request)).toString()),
				).toEqual({ user_data: { cadre: "community" }, locations: [] });
				return { statusCode: 200, data: '{"id":"hq-amina"}' };
			});
			body(await call(client, { workers: [requested[0]] }));
			const record = await readDeployment(SCOPE, TARGET);
			expect(
				record?.active
					.filter((row) => row.kind === "worker")
					.map((row) => row.remoteId),
			).toEqual(["hq-amina"]);
			expect(
				record?.superseded
					.filter((row) => row.kind === "worker")
					.map((row) => row.remoteId),
			).toEqual(["hq-joseph"]);
		});
		expect(
			peer
				.getCallHistory()
				?.calls()
				.map((call) => call.method),
		).toEqual(["GET", "POST", "POST", "GET", "PUT"]);
	});
});

it.each(["viewer", "outsider", "scope"])(
	"enforces %s access through actual SDK and membership before contacting HQ",
	async (access) => {
		await seed();
		const before = await snapshot();
		await withHttpPeer(async (peer) => {
			await asUser(
				async (client) => {
					const result = body(await call(client), true);
					expect(result.error_type).toBe(
						access === "scope" ? "scope_missing" : "not_found",
					);
				},
				access === "scope" ? ACTOR : access,
				access === "scope" ? ["nova.read"] : ["nova.read", "nova.hq.write"],
			);
			expect(peer.getCallHistory()?.calls()).toHaveLength(0);
			expect(await snapshot()).toEqual(before);
		});
	},
);

function session() {
	const now = new Date();
	vi.mocked(getSession).mockResolvedValue({
		user: {
			id: ACTOR,
			name: "Editor",
			email: "editor@dimagi.com",
			emailVerified: true,
			banned: false,
			createdAt: now,
			updatedAt: now,
		},
		session: {
			id: "session",
			token: "session-token",
			userId: ACTOR,
			expiresAt: new Date(now.getTime() + 60_000),
			createdAt: now,
			updatedAt: now,
		},
	});
}
it.each(["complete", "partial", "reporting-read"])(
	"keeps credentials in the actual browser action's %s result",
	async (outcome) => {
		await seed({ organization: outcome === "reporting-read" });
		session();
		if (outcome === "reporting-read") {
			// The mapping commits, then the view's fresh organization read meets a
			// real schema failure. This lives only in the disposable test database.
			await sql`create function break_organization_read() returns trigger language plpgsql as $$ begin if NEW.kind = 'worker' then alter table app_locations rename to unavailable_locations; end if; return NEW; end $$`.execute(
				h.db(),
			);
			await sql`create trigger break_organization_read after insert on app_deployment_resources for each row execute function break_organization_read()`.execute(
				h.db(),
			);
		}
		await withHttpPeer(async (peer) => {
			search(peer);
			let password: unknown;
			wire(peer).reply(async (request) => {
				password = JSON.parse(
					(await readHttpRequestBody(request)).toString(),
				).password;
				return { statusCode: 201, data: '{"id":"hq-amina"}' };
			});
			if (outcome === "partial")
				wire(peer).reply(400, { error: "Username is taken" });
			const result = await provisionWorkersAction({
				appId: APP,
				...TARGET,
				workers: (outcome === "partial" ? requested : [requested[0]]).map(
					(worker) => ({
						personaUuid: worker?.persona_uuid,
						username: worker?.username,
					}),
				),
			});
			expect(result.success).toBe(true);
			if (!result.success) throw new Error(result.message);
			expect(result.data.workers).toHaveLength(1);
			expect(result.data.workers[0]?.password).toBe(password);
			expect(result.data.refusal?.code ?? null).toBe(
				outcome === "partial" ? "hq_rejected_worker" : null,
			);
			expect(result.data.view).not.toBeNull();
			if (outcome === "reporting-read")
				expect(vi.mocked(log.warn).mock.calls).toEqual(
					expect.arrayContaining([
						[
							"[deployment] organization unavailable for left-behind",
							expect.anything(),
						],
					]),
				);
		});
	},
);

it("refuses all requested workers before HTTP when one lacks required information", async () => {
	await seed();
	await changes([
		{ kind: "updateUserProperty", uuid: CADRE, patch: { required: true } },
	]);
	const before = await snapshot();
	await withHttpPeer(async (peer) => {
		await asUser(async (client) => {
			const result = body(await call(client), true);
			expect(result.error_type).toBe("workers_not_provisionable");
			expect(result.message).toContain("Joseph");
			expect(result.message).toContain("Cadre");
			expect(result.workers).toEqual([]);
		});
		expect(peer.getCallHistory()?.calls()).toHaveLength(0);
		expect(await snapshot()).toEqual(before);
	});
});
