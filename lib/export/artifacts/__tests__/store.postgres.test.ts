import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { beforeEach, expect, it, vi } from "vitest";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { withAppTx } from "@/lib/db/pg";
import {
	connect,
	serveTableList,
	withManagedPeer,
} from "@/lib/deployment/__tests__/managedFixtures";
import {
	installLookupWitness,
	verifyAssignmentWitness,
} from "@/lib/export/privateAssignments";
import { createLookupTable } from "@/lib/lookup/service";
import {
	deleteAssetGeneration,
	exportPartGeneration,
	fetchExportPart,
	storeExportPart,
} from "@/lib/storage/media";
import type { ExportActor, ExportSpec } from "../access";
import { EXPORT_PART_BYTES } from "../range";
import {
	deliverExport,
	exportRange,
	readExportManifest,
	reclaimExportBatch,
} from "../store";

vi.mock("@/lib/commcare/encryption", () => ({
	decrypt: async () => "fixture-key",
}));
vi.mock("@/lib/storage/media", () => ({
	storeExportPart: vi.fn(),
	fetchExportPart: vi.fn(),
	exportPartGeneration: vi.fn(),
	deleteAssetGeneration: vi.fn(),
}));
const h = setupAppStateTestDb("retained_exports_", {
	authSchema: "migrated",
	poolMax: 3,
});
const projectId = "synthetic-download-project";
const actor = {
	userId: "synthetic-exporter",
	grant: { kind: "session", sessionId: "export-session" },
} as const;
const data = Buffer.alloc(EXPORT_PART_BYTES + 19, 0xab);
const objects = new Map<string, { bytes: Buffer; generation: string }>();
let spec: ExportSpec;
async function* source() {
	yield data.subarray(0, 731);
	yield data.subarray(731);
}
beforeEach(async () => {
	objects.clear();
	vi.clearAllMocks();
	await h.seedProjectMember(actor.userId, projectId, "editor");
	const appId = await h.seedApp({ owner: actor.userId, project_id: projectId });
	const row = await h
		.db()
		.selectFrom("apps")
		.select("mutation_seq")
		.where("id", "=", appId)
		.executeTakeFirstOrThrow();
	spec = {
		appId,
		projectId,
		documentRevision: Number(row.mutation_seq),
		dataRevision: "0",
		targetRevision: "0",
		format: "zip",
		filename: "clinic.zip",
		target: null,
	};
	await sql`INSERT INTO auth_session(id,token,"userId","expiresAt","createdAt","updatedAt") VALUES ('export-session','synthetic-export-token',${actor.userId},now()+interval '1 hour',now(),now())`.execute(
		h.db(),
	);
	vi.mocked(storeExportPart).mockImplementation(async (key, bytes) => {
		if (objects.has(key)) throw new Error("Duplicate storage PUT.");
		const generation = randomUUID();
		objects.set(key, { bytes: Buffer.from(bytes), generation });
		return generation;
	});
	vi.mocked(fetchExportPart).mockImplementation(
		async (key, generation, length) => {
			const part = objects.get(key);
			if (
				!part ||
				part.generation !== generation ||
				part.bytes.length !== length
			)
				throw new Error("Unexpected object read.");
			return part.bytes;
		},
	);
	vi.mocked(exportPartGeneration).mockImplementation(async (key) => {
		const part = objects.get(key);
		return part?.generation ?? null;
	});
	vi.mocked(deleteAssetGeneration).mockImplementation(
		async (key, generation) => {
			if (objects.get(key)?.generation !== generation)
				throw new Error("Wrong deletion generation.");
			objects.delete(key);
		},
	);
});

async function retained() {
	const result = await deliverExport(source(), () => ({ actor, spec }));
	if (!("artifact" in result)) throw new Error("Expected a private download.");
	return result.artifact;
}
it("stops a live range before reading its next object after membership revocation", async () => {
	const file = await retained();
	const from = EXPORT_PART_BYTES - 3;
	const read = exportRange(actor, file.id, {
		start: from,
		end: data.length - 1,
	});
	try {
		expect((await read.next()).value).toEqual(
			data.subarray(from, EXPORT_PART_BYTES),
		);
		await sql`DELETE FROM auth_member WHERE "userId"=${actor.userId} AND "organizationId"=${projectId}`.execute(
			h.db(),
		);
		await expect(read.next()).rejects.toThrow();
		expect(fetchExportPart).toHaveBeenCalledTimes(1);
		await expect(readExportManifest(actor, file.id)).rejects.toThrow();
	} finally {
		await read.return(undefined);
	}
});
it("denies an old opted-out key and a viewer before protected bytes can be stored", async () => {
	await sql`INSERT INTO auth_apikey(id,key,"referenceId","configId","createdAt","updatedAt",enabled,permissions)
		VALUES ('ordinary-key','synthetic-key-hash',${actor.userId},'default',now(),now(),true,${JSON.stringify({ scope: ["nova.read", "nova.write", "nova.hq.read", "nova.hq.write", "nova.hq.import", "nova.projects.read", "nova.projects.write"] })})`.execute(
		h.db(),
	);
	const limited: ExportActor = {
		userId: actor.userId,
		grant: { kind: "api-key", keyId: "ordinary-key" },
	};
	const assignments = {
		target: { server: "india", domain: "clinic" },
		tables: [],
	};
	await expect(
		deliverExport(
			source(),
			() => ({ actor: limited, spec: { ...spec, assignments } }),
			{ protected: true },
		),
	).rejects.toThrow();
	await sql`UPDATE auth_member SET role='viewer' WHERE "userId"=${actor.userId} AND "organizationId"=${projectId}`.execute(
		h.db(),
	);
	await expect(
		deliverExport(source(), () => ({ actor, spec: { ...spec, assignments } }), {
			protected: true,
		}),
	).rejects.toThrow();
	expect(objects.size).toBe(0);
	expect(
		(await sql`SELECT id FROM export_artifacts`.execute(h.db())).rows,
	).toEqual([]);
});
it("retains an unacknowledged PUT and its charge until generation-specific recovery", async () => {
	vi.mocked(storeExportPart).mockImplementationOnce(async (key, bytes) => {
		objects.set(key, {
			bytes: Buffer.from(bytes),
			generation: "lost-response",
		});
		throw new Error("Indeterminate object upload.");
	});
	await expect(retained()).rejects.toThrow("Indeterminate object upload.");
	expect(objects.size).toBe(1);
	const result = await sql<{
		bytes: string;
		state: string;
	}>`SELECT bytes,state FROM lookup_bulk_reservations WHERE project_id=${projectId} AND kind='export'`.execute(
		h.db(),
	);
	expect(result.rows).toEqual([
		{ bytes: String(EXPORT_PART_BYTES), state: "working" },
	]);
	await sql`UPDATE export_artifacts SET expires_at=now()-interval '2 hours' WHERE project_id=${projectId}`.execute(
		h.db(),
	);
	expect(await withAppTx((tx) => reclaimExportBatch(tx, projectId))).toBe(
		false,
	);
	await sql`UPDATE export_artifact_parts SET write_intent_at=now()-interval '16 minutes' WHERE project_id=${projectId}`.execute(
		h.db(),
	);

	for (let i = 0; i < 2; i++)
		expect(await withAppTx((tx) => reclaimExportBatch(tx, projectId))).toBe(
			true,
		);
	expect(await withAppTx((tx) => reclaimExportBatch(tx, projectId))).toBe(
		false,
	);
	expect(objects.size).toBe(0);
	expect(deleteAssetGeneration).toHaveBeenCalledWith(
		expect.stringContaining("private-exports/" + projectId + "/"),
		"lost-response",
	);
	expect(
		(
			await sql`SELECT * FROM lookup_bulk_reservations WHERE project_id=${projectId}`.execute(
				h.db(),
			)
		).rows,
	).toEqual([]);
});

it("keeps a small assignment package private and cuts off its exact key when consent is narrowed", async () => {
	await connect(h, actor.userId, "india", ["clinic"]);
	const scoped: ExportActor = {
		userId: actor.userId,
		grant: { kind: "api-key", keyId: "assigned-key" },
	};
	const scopes = ["nova.read", "nova.write", "nova.projects.data.export"];
	await sql`INSERT INTO auth_apikey(id,key,"referenceId","configId","createdAt","updatedAt",enabled,permissions)
		VALUES ('assigned-key','synthetic-granted-hash',${actor.userId},'default',now(),now(),true,${JSON.stringify({ scope: scopes })})`.execute(
		h.db(),
	);
	async function* small() {
		yield Buffer.from("synthetic assignment");
	}
	const result = await deliverExport(
		small(),
		() => ({
			actor: scoped,
			spec: {
				...spec,
				assignments: {
					target: { server: "india", domain: "clinic" },
					tables: [],
				},
			},
		}),
		{ protected: true },
	);
	if (!("artifact" in result))
		throw new Error("Protected bytes escaped inline.");
	const id = result.artifact.id;
	await expect(readExportManifest(actor, id)).rejects.toThrow();
	const read = exportRange(scoped, id, { start: 0, end: 8 });
	try {
		expect((await read.next()).value).toEqual(Buffer.from("synthetic"));
	} finally {
		await read.return(undefined);
	}
	await sql`UPDATE auth_apikey SET permissions=${JSON.stringify({ scope: scopes.slice(0, -1) })} WHERE id='assigned-key'`.execute(
		h.db(),
	);
	await expect(readExportManifest(scoped, id)).rejects.toThrow();
	await sql`UPDATE auth_apikey SET permissions=${JSON.stringify({ scope: scopes })} WHERE id='assigned-key'`.execute(
		h.db(),
	);
	await expect(readExportManifest(scoped, id)).rejects.toThrow();
	expect(fetchExportPart).toHaveBeenCalledTimes(1);
});

it("invalidates a completed download when its document or Project data changes", async () => {
	const first = await retained();
	await sql`INSERT INTO lookup_project_state(project_id,revision) VALUES(${projectId},1)
		ON CONFLICT(project_id) DO UPDATE SET revision=lookup_project_state.revision+1`.execute(
		h.db(),
	);
	await expect(readExportManifest(actor, first.id)).rejects.toThrow();
	expect(fetchExportPart).not.toHaveBeenCalled();
});

it("resumes an interrupted preparation under its original intent and reuses its released manifest", async () => {
	let writes = 0;
	vi.mocked(storeExportPart).mockImplementation(async (key, bytes) => {
		if (key.endsWith("/" + EXPORT_PART_BYTES) && writes++ === 0)
			throw new Error("Paused client.");
		const previous = objects.get(key);
		if (previous) throw new Error("A completed part was written again.");
		objects.set(key, { bytes: Buffer.from(bytes), generation: "stable" });
		return "stable";
	});
	await expect(retained()).rejects.toThrow("Paused client.");
	const resumed = await retained();
	expect(await retained()).toEqual(resumed);
	expect(objects.size).toBe(2);
	expect(
		(await sql`SELECT id FROM export_artifacts`.execute(h.db())).rows,
	).toEqual([{ id: resumed.id }]);
});

it("requires the current private restore table on this app's exact installation target without reading any worker rows", async () => {
	const target = { server: "india", domain: "clinic" };
	await connect(h, actor.userId, "india", [target.domain]);
	const table = await createLookupTable(
		{ projectId, actorId: actor.userId, role: "editor" },
		{
			name: "Private visits",
			tag: "visits",
			columns: [{ wireName: "code", label: "Code", dataType: "text" }],
		},
	);
	await sql`UPDATE lookup_tables SET worker_access='assigned' WHERE project_id=${projectId} AND id=${table.id}`.execute(
		h.db(),
	);
	const deployment = randomUUID(),
		targetApp = "working-app",
		remote = "12".repeat(16);
	await sql`INSERT INTO app_deployments(id,app_id,project_id,server,domain,state,created_by) VALUES(${deployment},${spec.appId},${projectId},${target.server},${target.domain},'uploaded',${actor.userId})`.execute(
		h.db(),
	);
	await sql`INSERT INTO app_deployment_resources(id,deployment_id,kind,nova_resource_id,remote_id,ownership) VALUES
		(${randomUUID()},${deployment},'app',${spec.appId},${targetApp},'nova-created'),
		(${randomUUID()},${deployment},'lookup-table',${table.id},${remote},'nova-created')`.execute(
		h.db(),
	);
	const access = {
		target,
		scope: { projectId, actorUserId: actor.userId, appId: spec.appId },
		grant: actor.grant,
	};
	await withManagedPeer(async (peer) => {
		const native = {
			id: remote,
			tag: "visits",
			fields: ["code"],
			rows: [],
			isGlobal: false,
		};
		await expect(
			installLookupWitness(access, "some-other-app", [table.id]),
		).rejects.toThrow();
		serveTableList(peer, target.domain, [native]);
		const restore = await installLookupWitness(access, targetApp, [table.id]);
		expect(restore.tableIds).toEqual([table.id]);
		serveTableList(peer, target.domain, [{ ...native, isGlobal: true }]);
		await expect(
			verifyAssignmentWitness(access, { target, tables: [], restore }),
		).rejects.toThrow();
	});
	expect(storeExportPart).not.toHaveBeenCalled();
});
