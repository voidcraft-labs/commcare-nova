/**
 * S02b authoritative app-writer matrix against the shared Postgres harness.
 *
 * Production has no lookup carrier yet, so this suite injects structural target
 * sets at the one production extractor seam. Everything after extraction is the
 * real protocol: app row lock, table `FOR KEY SHARE`, fresh definition snapshot,
 * exact edge replacement, writer-version declaration, app/entity/log write.
 */

import { Client } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setTransactionWriterVersion } from "@/lib/db/pg";
import {
	EMPTY_LOOKUP_REFERENCE_TARGETS,
	type LookupReferenceTargetSet,
	normalizeLookupReferenceTargetSet,
} from "@/lib/doc/lookupReferences";
import { blankAppMutations } from "@/lib/doc/scaffolds";
import {
	type LookupTableId,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { applyLookupSchemaGovernanceInTransaction } from "@/lib/lookup/schemaGovernance";
import { createLookupTable } from "@/lib/lookup/service";
import type { LookupTableSnapshot } from "@/lib/lookup/types";
import {
	lockLookupTablesForReferenceWrite,
	readStoredLookupReferenceTargets,
	replaceLookupReferenceEdges,
} from "../lookupReferenceEdges";
import { setupAppStateTestDb } from "./appStateTestDb";
import { createPerTestAppDb } from "./perTestAppDb";

const { extractLookupReferenceTargetsMock } = vi.hoisted(() => ({
	extractLookupReferenceTargetsMock: vi.fn(),
}));

vi.mock("@/lib/doc/lookupReferences", async () => {
	const actual = (await vi.importActual(
		"@/lib/doc/lookupReferences",
	)) as Record<string, unknown>;
	return {
		...actual,
		extractLookupReferenceTargets: extractLookupReferenceTargetsMock,
	};
});

vi.mock("@/lib/db/projectMembership", () => ({
	projectRoleFor: vi.fn(async () => "owner"),
	projectRoleForInTransaction: vi.fn(async () => "owner"),
}));

const {
	appendSyntheticBatch,
	commitAppProjectMove,
	commitGuardedBatch,
	createApp,
	loadApp,
} = await import("../apps");
const { BlueprintCommitRejectedError } = await import("../commitGuard");

const h = setupAppStateTestDb("authoritative_lookup_writers_");

const ACTOR = "lookup-writer-owner";
const PROJECT_A = "lookup-writer-project-a";
const PROJECT_B = "lookup-writer-project-b";
const MISSING_TABLE_ID = lookupTableIdSchema.parse(
	"018f0f43-7b7c-7abc-8def-0123456789ab",
);
const WRITER_RACE_ADVISORY_KEY = 20_260_722;
const DELETE_RACE_ADVISORY_KEY = 20_260_723;

async function backendPid(client: Client): Promise<number> {
	const result = await client.query<{ pid: number }>(
		"SELECT pg_backend_pid() AS pid",
	);
	const pid = result.rows[0]?.pid;
	if (pid === undefined) throw new Error("backend pid query returned no row");
	return pid;
}

async function waitUntilBackendBlockedBy(
	observer: Client,
	blockingPid: number,
): Promise<number> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		const result = await observer.query<{ pid: number }>(
			`SELECT pid
			 FROM pg_stat_activity
			 WHERE datname = current_database()
				AND pid <> pg_backend_pid()
				AND $1 = ANY(pg_blocking_pids(pid))
			 ORDER BY pid
			 LIMIT 1`,
			[blockingPid],
		);
		const pid = result.rows[0]?.pid;
		if (pid !== undefined) return pid;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(
		`No backend blocked behind ${blockingPid} within one second.`,
	);
}

async function waitUntilBlockedBy(
	observer: Client,
	waitingPid: number,
	blockingPid: number,
): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		const result = await observer.query<{ blockers: number[] }>(
			"SELECT pg_blocking_pids($1) AS blockers",
			[waitingPid],
		);
		if (result.rows[0]?.blockers.includes(blockingPid)) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(
		`Backend ${waitingPid} did not block behind ${blockingPid} within one second.`,
	);
}

async function installWriterProbe(): Promise<void> {
	await h.pool().query(`
		CREATE TABLE writer_version_probe (
			app_id text NOT NULL,
			operation text NOT NULL,
			writer_version text
		);
		CREATE FUNCTION record_writer_version() RETURNS trigger
		LANGUAGE plpgsql AS $function$
		BEGIN
			INSERT INTO writer_version_probe (app_id, operation, writer_version)
			VALUES (
				NEW.id,
				TG_OP,
				NULLIF(current_setting('nova.writer_version', true), '')
			);
			RETURN NEW;
		END
		$function$;
		CREATE TRIGGER record_apps_writer_version
		AFTER INSERT OR UPDATE ON apps
		FOR EACH ROW EXECUTE FUNCTION record_writer_version();
	`);
}

async function clearWriterProbe(): Promise<void> {
	await h.pool().query("TRUNCATE writer_version_probe");
}

async function writerProbeRows(appId: string) {
	const result = await h.pool().query<{
		operation: string;
		writer_version: string | null;
	}>(
		"SELECT operation, writer_version FROM writer_version_probe WHERE app_id = $1 ORDER BY ctid",
		[appId],
	);
	return result.rows;
}

async function createTable(
	projectId: string,
	name: string,
): Promise<LookupTableSnapshot> {
	return createLookupTable(
		{ projectId, actorId: ACTOR, role: "owner" },
		{
			name,
			tag: name.toLowerCase().replaceAll(" ", "_"),
			columns: [{ wireName: "name", label: "Name", dataType: "text" }],
		},
	);
}

async function createEmptyApp(projectId = PROJECT_A): Promise<string> {
	return createApp(ACTOR, projectId, crypto.randomUUID(), {
		appName: "Writer test",
		status: "complete",
	});
}

async function materializeTargets(
	appId: string,
	projectId: string,
	targets: LookupReferenceTargetSet,
): Promise<void> {
	await h
		.db()
		.transaction()
		.execute(async (tx) => {
			await tx
				.selectFrom("apps")
				.select("id")
				.where("id", "=", appId)
				.forUpdate()
				.executeTakeFirstOrThrow();
			await lockLookupTablesForReferenceWrite(tx, projectId, targets.tableIds);
			await replaceLookupReferenceEdges(tx, { appId, projectId, targets });
		});
}

async function readTargets(appId: string): Promise<LookupReferenceTargetSet> {
	return readStoredLookupReferenceTargets(h.db(), appId);
}

async function readSeq(appId: string): Promise<number> {
	return Number((await h.readAppRow(appId))?.mutation_seq);
}

function tableTargets(tableId: LookupTableId): LookupReferenceTargetSet {
	return normalizeLookupReferenceTargetSet({ tableIds: [tableId] });
}

function setExtractionPair(
	previous: LookupReferenceTargetSet,
	candidate: LookupReferenceTargetSet,
): void {
	extractLookupReferenceTargetsMock
		.mockReset()
		.mockReturnValue(EMPTY_LOOKUP_REFERENCE_TARGETS)
		.mockReturnValueOnce(previous)
		.mockReturnValueOnce(candidate);
}

beforeEach(async () => {
	extractLookupReferenceTargetsMock
		.mockReset()
		.mockReturnValue(EMPTY_LOOKUP_REFERENCE_TARGETS);
	await installWriterProbe();
});

describe("atomic creation", () => {
	it("runs the seed callback once, declares writer v0, and commits the prepared app atomically", async () => {
		let seedCalls = 0;
		const appId = await createApp(ACTOR, PROJECT_A, crypto.randomUUID(), {
			appName: "Blank app",
			status: "complete",
			seedMutations(doc) {
				seedCalls += 1;
				return blankAppMutations(doc);
			},
		});

		expect(seedCalls).toBe(1);
		expect((await loadApp(appId))?.blueprint.moduleOrder).toHaveLength(1);
		expect(await readTargets(appId)).toEqual(EMPTY_LOOKUP_REFERENCE_TARGETS);
		expect(await writerProbeRows(appId)).toEqual([
			{ operation: "INSERT", writer_version: "0" },
		]);
	});

	it("rolls back the uncommitted app root when a prepared template is not export-ready", async () => {
		let appId = "";
		let seedCalls = 0;
		await expect(
			createApp(ACTOR, PROJECT_A, crypto.randomUUID(), {
				appName: "Invalid template",
				status: "complete",
				seedMutations(doc) {
					appId = doc.appId;
					seedCalls += 1;
					return [{ kind: "setAppName", name: "Still has no module" }];
				},
			}),
		).rejects.toThrow("must be born export-ready");

		expect(seedCalls).toBe(1);
		expect(await h.readAppRow(appId)).toBeUndefined();
		expect(await writerProbeRows(appId)).toEqual([]);
	});

	it("rejects a reducer-minted seed identity as a typed error before opening the transaction", async () => {
		let appId = "";
		let seedCalls = 0;
		await expect(
			createApp(ACTOR, PROJECT_A, crypto.randomUUID(), {
				appName: "Unsafe template",
				status: "complete",
				seedMutations(doc) {
					appId = doc.appId;
					seedCalls += 1;
					const mutations = blankAppMutations(doc);
					const addedField = mutations.find(
						(mutation) => mutation.kind === "addField",
					);
					if (addedField?.kind !== "addField") {
						throw new Error("blank template did not add a field");
					}
					return [
						...mutations,
						{ kind: "duplicateField", uuid: addedField.field.uuid },
					];
				},
			}),
		).rejects.toBeInstanceOf(BlueprintCommitRejectedError);

		expect(seedCalls).toBe(1);
		expect(await h.readAppRow(appId)).toBeUndefined();
		expect(await writerProbeRows(appId)).toEqual([]);
	});
});

describe("guarded and synthetic writers", () => {
	it("declares writer v0, replaces stale edges exactly, and persists deterministic synthetic mutations", async () => {
		const table = await createTable(PROJECT_A, "Stale edge");
		const appId = await createEmptyApp();
		await materializeTargets(appId, PROJECT_A, tableTargets(table.id));
		await clearWriterProbe();

		await commitGuardedBatch({
			appId,
			expectedProjectId: PROJECT_A,
			batchId: crypto.randomUUID(),
			mutations: [{ kind: "setAppName", name: "Guarded" }],
			actorUserId: ACTOR,
			kind: "autosave",
		});
		expect(await readTargets(appId)).toEqual(EMPTY_LOOKUP_REFERENCE_TARGETS);
		expect(await writerProbeRows(appId)).toEqual([
			{ operation: "UPDATE", writer_version: "0" },
		]);

		const current = await loadApp(appId);
		if (!current) throw new Error("created app disappeared");
		await appendSyntheticBatch({
			appId,
			expectedBaseSeq: current.mutation_seq,
			targetDoc: {
				...current.blueprint,
				appName: "Synthetic",
			},
			authority: {
				kind: "system",
				actorId: "system:writer-matrix",
				reason: "Exercise deterministic synthetic history",
			},
		});
		expect(await writerProbeRows(appId)).toEqual([
			{ operation: "UPDATE", writer_version: "0" },
			{ operation: "UPDATE", writer_version: "0" },
		]);
		const stream = await h
			.db()
			.selectFrom("accepted_mutations")
			.select(["kind", "actor_id", "mutations"])
			.where("app_id", "=", appId)
			.orderBy("seq", "desc")
			.executeTakeFirstOrThrow();
		expect(stream).toMatchObject({
			kind: "migration",
			actor_id: "system:writer-matrix",
			mutations: [{ kind: "setAppName", name: "Synthetic" }],
		});
	});

	it("rejects a stale synthetic basis without advancing the sequence", async () => {
		const appId = await createEmptyApp();
		await commitGuardedBatch({
			appId,
			expectedProjectId: PROJECT_A,
			batchId: crypto.randomUUID(),
			mutations: [{ kind: "setAppName", name: "Advanced" }],
			actorUserId: ACTOR,
			kind: "autosave",
		});
		const current = await loadApp(appId);
		if (!current) throw new Error("created app disappeared");

		await expect(
			appendSyntheticBatch({
				appId,
				expectedBaseSeq: 0,
				targetDoc: {
					...current.blueprint,
					appName: "Stale repair",
				},
				authority: {
					kind: "system",
					actorId: "system:stale-repair",
					reason: "Exercise stale base rejection",
				},
			}),
		).rejects.toBeInstanceOf(BlueprintCommitRejectedError);
		expect(await readSeq(appId)).toBe(1);
	});

	it("deduplicates a synthetic replay before its stale basis can replace the first result", async () => {
		const appId = await createEmptyApp();
		const initial = await loadApp(appId);
		if (!initial) throw new Error("created app disappeared");
		const batchId = crypto.randomUUID();
		const authority = {
			kind: "system" as const,
			actorId: "system:replay-test" as const,
			reason: "Exercise synthetic batch idempotency",
		};

		await expect(
			appendSyntheticBatch({
				appId,
				expectedBaseSeq: 0,
				batchId,
				targetDoc: {
					...initial.blueprint,
					appName: "First synthetic result",
				},
				authority,
			}),
		).resolves.toEqual({ kind: "committed", seq: 1 });

		await expect(
			appendSyntheticBatch({
				appId,
				// This basis is now stale and this target differs deliberately: the
				// durable batch latch, not a second diff, owns replay semantics.
				expectedBaseSeq: 0,
				batchId,
				targetDoc: {
					...initial.blueprint,
					appName: "Replay must not replace the first result",
				},
				authority,
			}),
		).resolves.toEqual({ kind: "deduped", seq: 1 });

		expect(await readSeq(appId)).toBe(1);
		expect((await loadApp(appId))?.app_name).toBe("First synthetic result");
		const history = await h
			.db()
			.selectFrom("accepted_mutations")
			.select(["batch_id", "mutations"])
			.where("app_id", "=", appId)
			.execute();
		expect(history).toEqual([
			{
				batch_id: batchId,
				mutations: [{ kind: "setAppName", name: "First synthetic result" }],
			},
		]);
	});

	it("requires a named system actor and nonblank operator reason at runtime", async () => {
		const appId = await createEmptyApp();
		const current = await loadApp(appId);
		if (!current) throw new Error("created app disappeared");
		const targetDoc = {
			...current.blueprint,
			appName: "Guarded repair",
		};

		for (const authority of [
			{
				kind: "system" as const,
				actorId: "maintenance" as `system:${string}`,
				reason: "Named maintenance task",
			},
			{
				kind: "system" as const,
				actorId: "system:maintenance" as const,
				reason: "   ",
			},
		]) {
			await expect(
				appendSyntheticBatch({
					appId,
					expectedBaseSeq: 0,
					targetDoc,
					authority,
				}),
			).rejects.toThrow(
				"Synthetic system authority requires a named system actor and reason.",
			);
		}
		expect(await readSeq(appId)).toBe(0);
		const streamRows = await h
			.db()
			.selectFrom("accepted_mutations")
			.select("seq")
			.where("app_id", "=", appId)
			.execute();
		expect(streamRows).toEqual([]);
	});
});

describe("lookup introduction versus resource deletion", () => {
	it("app-writer-first materializes the exact edge and makes the later table delete lose", async () => {
		const table = await createTable(PROJECT_A, "Writer first");
		const appId = await createEmptyApp();
		const targets = tableTargets(table.id);
		setExtractionPair(EMPTY_LOOKUP_REFERENCE_TARGETS, targets);

		await commitGuardedBatch({
			appId,
			expectedProjectId: PROJECT_A,
			batchId: crypto.randomUUID(),
			mutations: [{ kind: "setAppName", name: "References table" }],
			actorUserId: ACTOR,
			kind: "autosave",
		});
		expect(await readTargets(appId)).toEqual(targets);

		await expect(
			h
				.db()
				.deleteFrom("lookup_tables")
				.where("project_id", "=", PROJECT_A)
				.where("id", "=", table.id)
				.execute(),
		).rejects.toMatchObject({ code: "23001" });

		setExtractionPair(targets, EMPTY_LOOKUP_REFERENCE_TARGETS);
		await commitGuardedBatch({
			appId,
			expectedProjectId: PROJECT_A,
			batchId: crypto.randomUUID(),
			mutations: [{ kind: "setAppName", name: "Reference removed" }],
			actorUserId: ACTOR,
			kind: "autosave",
		});
		expect(await readTargets(appId)).toEqual(EMPTY_LOOKUP_REFERENCE_TARGETS);
	});

	it("holds table admission through commit so a concurrent delete blocks, then loses", async () => {
		const table = await createTable(PROJECT_A, "Serialized writer first");
		const appId = await createEmptyApp();
		const targets = tableTargets(table.id);
		setExtractionPair(EMPTY_LOOKUP_REFERENCE_TARGETS, targets);
		await h.pool().query(`
			CREATE FUNCTION wait_authoritative_writer_race() RETURNS trigger
			LANGUAGE plpgsql AS $function$
			BEGIN
				PERFORM pg_advisory_xact_lock(
					hashtext(current_database()),
					${WRITER_RACE_ADVISORY_KEY}
				);
				RETURN NEW;
			END
			$function$;
			CREATE TRIGGER wait_authoritative_writer_race
			BEFORE UPDATE ON apps
			FOR EACH ROW EXECUTE FUNCTION wait_authoritative_writer_race();
		`);

		const blocker = new Client({ connectionString: h.uri() });
		const deleter = new Client({ connectionString: h.uri() });
		const observer = new Client({ connectionString: h.uri() });
		await Promise.all([
			blocker.connect(),
			deleter.connect(),
			observer.connect(),
		]);
		const pending: Promise<unknown>[] = [];
		try {
			await blocker.query("BEGIN");
			await blocker.query(
				"SELECT pg_advisory_xact_lock(hashtext(current_database()), $1)",
				[WRITER_RACE_ADVISORY_KEY],
			);
			const blockerPid = await backendPid(blocker);
			const writer = commitGuardedBatch({
				appId,
				expectedProjectId: PROJECT_A,
				batchId: crypto.randomUUID(),
				mutations: [{ kind: "setAppName", name: "Admitted writer" }],
				actorUserId: ACTOR,
				kind: "autosave",
			}).then(
				(value) => ({ ok: true as const, value, error: undefined }),
				(error: unknown) => ({ ok: false as const, value: undefined, error }),
			);
			pending.push(writer);
			const writerPid = await waitUntilBackendBlockedBy(observer, blockerPid);

			const deleterPid = await backendPid(deleter);
			const deletion = deleter
				.query("DELETE FROM lookup_tables WHERE project_id = $1 AND id = $2", [
					PROJECT_A,
					table.id,
				])
				.then(
					() => ({ ok: true as const, error: undefined }),
					(error: unknown) => ({ ok: false as const, error }),
				);
			pending.push(deletion);
			await waitUntilBlockedBy(observer, deleterPid, writerPid);

			await blocker.query("COMMIT");
			const writerOutcome = await writer;
			expect(writerOutcome.ok).toBe(true);
			expect(writerOutcome.value).toMatchObject({ seq: 1, deduped: false });
			const deleteOutcome = await deletion;
			expect(deleteOutcome.ok).toBe(false);
			expect((deleteOutcome.error as { code?: string } | undefined)?.code).toBe(
				"23001",
			);
			expect(await readTargets(appId)).toEqual(targets);
		} finally {
			await Promise.allSettled([
				blocker.query("ROLLBACK"),
				deleter.query("ROLLBACK"),
				observer.query("ROLLBACK"),
			]);
			await Promise.allSettled(pending);
			await Promise.all([blocker.end(), deleter.end(), observer.end()]);
		}
	});

	it("lets an admitted resource delete commit first, then rejects the waiting app introduction", async () => {
		const table = await createTable(PROJECT_A, "Serialized delete first");
		const appId = await createEmptyApp();
		await h
			.db()
			.updateTable("lookup_reference_compatibility")
			.set({
				minimum_writer_version: 1,
				destructive_schema_actions_enabled: true,
				updated_at: new Date(),
			})
			.where("id", "=", 1)
			.execute();
		await h.pool().query(`
			CREATE FUNCTION wait_authoritative_delete_race() RETURNS trigger
			LANGUAGE plpgsql AS $function$
			BEGIN
				PERFORM pg_advisory_xact_lock(
					hashtext(current_database()),
					${DELETE_RACE_ADVISORY_KEY}
				);
				RETURN OLD;
			END
			$function$;
			CREATE TRIGGER wait_authoritative_delete_race
			BEFORE DELETE ON lookup_tables
			FOR EACH ROW EXECUTE FUNCTION wait_authoritative_delete_race();
		`);

		// The harness's injected pool has max=1, so governance needs its own
		// bounded handle; otherwise the app writer would queue for a connection
		// instead of proving it waits on governance's table lock.
		const governance = createPerTestAppDb(h.uri());
		const blocker = new Client({ connectionString: h.uri() });
		const observer = new Client({ connectionString: h.uri() });
		await Promise.all([blocker.connect(), observer.connect()]);
		const pending: Promise<unknown>[] = [];
		try {
			await blocker.query("BEGIN");
			await blocker.query(
				"SELECT pg_advisory_xact_lock(hashtext(current_database()), $1)",
				[DELETE_RACE_ADVISORY_KEY],
			);
			const blockerPid = await backendPid(blocker);

			const deletion = governance.appDb
				.transaction()
				.execute(async (tx) => {
					await setTransactionWriterVersion(tx, 1);
					return applyLookupSchemaGovernanceInTransaction(
						tx,
						{ projectId: PROJECT_A, actorId: ACTOR, role: "owner" },
						{
							kind: "delete-table",
							tableId: table.id,
							expectedTableRevision: table.tableRevision,
						},
						1,
					);
				})
				.then(
					(value) => ({ ok: true as const, value, error: undefined }),
					(error: unknown) => ({ ok: false as const, value: undefined, error }),
				);
			pending.push(deletion);
			// The BEFORE DELETE trigger runs only after governance owns Project,
			// table, compatibility, and exact-edge admission locks.
			const governancePid = await waitUntilBackendBlockedBy(
				observer,
				blockerPid,
			);

			setExtractionPair(EMPTY_LOOKUP_REFERENCE_TARGETS, tableTargets(table.id));
			const writer = commitGuardedBatch({
				appId,
				expectedProjectId: PROJECT_A,
				batchId: crypto.randomUUID(),
				mutations: [{ kind: "setAppName", name: "Must not land" }],
				actorUserId: ACTOR,
				kind: "autosave",
			}).then(
				(value) => ({ ok: true as const, value, error: undefined }),
				(error: unknown) => ({ ok: false as const, value: undefined, error }),
			);
			pending.push(writer);
			const writerPid = await waitUntilBackendBlockedBy(
				observer,
				governancePid,
			);
			await waitUntilBlockedBy(observer, writerPid, governancePid);

			await blocker.query("COMMIT");
			const deletionOutcome = await deletion;
			expect(deletionOutcome.ok).toBe(true);
			expect(deletionOutcome.value).toMatchObject({
				kind: "delete-table",
				tableId: table.id,
			});
			const writerOutcome = await writer;
			expect(writerOutcome.ok).toBe(false);
			expect(writerOutcome.error).toBeInstanceOf(BlueprintCommitRejectedError);
			expect(writerOutcome.error).toMatchObject({
				name: "BlueprintCommitRejectedError",
				message:
					"One or more lookup tables used by this app are no longer available in its Project. Remove or replace those references, then try again.",
			});
			expect(await readSeq(appId)).toBe(0);
			expect((await loadApp(appId))?.app_name).toBe("Writer test");
			expect(await readTargets(appId)).toEqual(EMPTY_LOOKUP_REFERENCE_TARGETS);
			const deletedTable = await h
				.db()
				.selectFrom("lookup_tables")
				.select("id")
				.where("project_id", "=", PROJECT_A)
				.where("id", "=", table.id)
				.executeTakeFirst();
			expect(deletedTable).toBeUndefined();
		} finally {
			await Promise.allSettled([
				blocker.query("ROLLBACK"),
				observer.query("ROLLBACK"),
			]);
			await Promise.allSettled(pending);
			await Promise.all([blocker.end(), observer.end()]);
			await governance.destroy();
		}
	});

	it("makes missing and foreign targets the same typed, no-write rejection", async () => {
		const foreign = await createTable(PROJECT_B, "Foreign");
		const errors: Error[] = [];
		for (const tableId of [MISSING_TABLE_ID, foreign.id]) {
			const appId = await createEmptyApp();
			setExtractionPair(EMPTY_LOOKUP_REFERENCE_TARGETS, tableTargets(tableId));
			const error = await commitGuardedBatch({
				appId,
				expectedProjectId: PROJECT_A,
				batchId: crypto.randomUUID(),
				mutations: [{ kind: "setAppName", name: "Unavailable" }],
				actorUserId: ACTOR,
				kind: "autosave",
			}).catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(BlueprintCommitRejectedError);
			errors.push(error as Error);
			expect(await readSeq(appId)).toBe(0);
		}
		expect(errors[0]?.message).toBe(errors[1]?.message);
	});
});

describe("dormant Project move", () => {
	it("requires both structural and stored target sets empty, then clears + flips under writer v0", async () => {
		const table = await createTable(PROJECT_A, "Move blocker");
		const targets = tableTargets(table.id);
		const appId = await createEmptyApp();
		await materializeTargets(appId, PROJECT_A, targets);
		await clearWriterProbe();

		await expect(
			commitAppProjectMove(appId, {
				toProjectId: PROJECT_B,
				expectedFromProjectId: PROJECT_A,
				actorUserId: ACTOR,
				assetIdMap: new Map(),
				attemptedRealIds: new Set(),
			}),
		).rejects.toBeInstanceOf(BlueprintCommitRejectedError);
		expect((await h.readAppRow(appId))?.project_id).toBe(PROJECT_A);
		expect(await readTargets(appId)).toEqual(targets);

		await materializeTargets(appId, PROJECT_A, EMPTY_LOOKUP_REFERENCE_TARGETS);
		setExtractionPair(targets, targets);
		await expect(
			commitAppProjectMove(appId, {
				toProjectId: PROJECT_B,
				expectedFromProjectId: PROJECT_A,
				actorUserId: ACTOR,
				assetIdMap: new Map(),
				attemptedRealIds: new Set(),
			}),
		).rejects.toBeInstanceOf(BlueprintCommitRejectedError);
		expect((await h.readAppRow(appId))?.project_id).toBe(PROJECT_A);

		extractLookupReferenceTargetsMock
			.mockReset()
			.mockReturnValue(EMPTY_LOOKUP_REFERENCE_TARGETS);
		await expect(
			commitAppProjectMove(appId, {
				toProjectId: PROJECT_B,
				expectedFromProjectId: PROJECT_A,
				actorUserId: ACTOR,
				assetIdMap: new Map(),
				attemptedRealIds: new Set(),
			}),
		).resolves.toEqual({ kind: "moved" });
		expect((await h.readAppRow(appId))?.project_id).toBe(PROJECT_B);
		expect(await readTargets(appId)).toEqual(EMPTY_LOOKUP_REFERENCE_TARGETS);
		expect(await writerProbeRows(appId)).toEqual([
			{ operation: "UPDATE", writer_version: "0" },
		]);
	});
});
