/**
 * The authoritative app-writer matrix against a real Postgres.
 *
 * Every writer that can change which lookup resources an app depends on has to
 * leave the stored edge set exactly equal to the blueprint's structural target
 * set — that equality is what makes a referenced table undeletable and a
 * referencing app unmovable. The interesting failures are concurrent (a delete
 * racing a commit) and are enforced by row locks and composite foreign keys, so
 * this suite drives the production writers against a live database instead of
 * asserting the SQL they would emit.
 *
 * Historical lookup carriers are seeded through the same jsonb entity rows an
 * older deployment left behind, so the writers must hydrate those rows and run
 * the production extractor rather than trusting an in-memory doc.
 */

import { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import {
	EMPTY_LOOKUP_REFERENCE_TARGETS,
	extractLookupReferenceTargets,
	type LookupReferenceTargetSet,
	normalizeLookupReferenceTargetSet,
} from "@/lib/doc/lookupReferences";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import type { LookupOptionsSource, Uuid } from "@/lib/domain";
import {
	type LookupColumnId,
	type LookupTableId,
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { proseText } from "@/lib/domain/prose";
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

vi.mock("@/lib/db/projectMembership", () => ({
	projectRoleFor: vi.fn(async () => "owner"),
	projectRoleForInTransaction: vi.fn(async () => "owner"),
}));

const {
	appendSyntheticBatch,
	commitAppProjectMove,
	commitGuardedBatch: commitGuardedBatchOpaque,
	loadApp,
	repairLookupReferenceEdges,
} = await import("../apps");
const { createExplicitBlankApp } = await import("../appGenesis");
const commitGuardedBatch = (
	args: Omit<Parameters<typeof commitGuardedBatchOpaque>[0], "mutations"> & {
		mutations: unknown;
	},
) =>
	commitGuardedBatchOpaque({
		...args,
		mutations: admitMutationBatch(args.mutations),
	});
const { BlueprintCommitRejectedError } = await import("../commitGuard");

const h = setupAppStateTestDb("authoritative_lookup_writers_");

const ACTOR = "lookup-writer-owner";
const PROJECT_A = "lookup-writer-project-a";
const PROJECT_B = "lookup-writer-project-b";
const MISSING_TABLE_ID = lookupTableIdSchema.parse(
	"018f0f43-7b7c-7abc-8def-0123456789ab",
);
const MISSING_COLUMN_ID = lookupColumnIdSchema.parse(
	"018f0f43-7b7c-7abc-8def-0123456789ac",
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

/** Wait for SOME backend to be blocked behind `blockingPid`, and name it — the
 *  racing writer's connection is chosen by the pool, so the test cannot know
 *  its pid in advance. */
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

async function createTestApp(projectId = PROJECT_A): Promise<string> {
	return (
		await createExplicitBlankApp(ACTOR, projectId, crypto.randomUUID(), {
			name: "Writer test",
			status: "complete",
		})
	).appId;
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

function introduceLookupOptions(
	fieldUuid: Uuid,
	tableId: LookupTableId,
	columnId: LookupColumnId,
) {
	return [
		{
			kind: "convertField" as const,
			uuid: fieldUuid,
			toKind: "single_select" as const,
			optionsSource: {
				kind: "lookup" as const,
				tableId,
				valueColumnId: columnId,
				labelColumnId: columnId,
			},
		},
	];
}

interface HistoricalLookupCarrier {
	readonly appId: string;
	readonly fieldUuid: Uuid;
	readonly optionsSource: LookupOptionsSource;
	readonly targets: LookupReferenceTargetSet;
}

function lookupCarrierFixture(
	tableId: LookupTableId,
	columnId: LookupColumnId,
): Omit<HistoricalLookupCarrier, "appId"> & {
	readonly doc: ReturnType<typeof buildDoc>;
} {
	const fieldUuid = testUuid(crypto.randomUUID());
	const optionsSource: LookupOptionsSource = {
		kind: "lookup",
		tableId,
		valueColumnId: columnId,
		labelColumnId: columnId,
	};
	const doc = buildDoc({
		appName: "Historical lookup carrier",
		modules: [
			{
				name: "Survey",
				forms: [
					{
						name: "Survey",
						type: "survey",
						fields: [
							{
								uuid: fieldUuid,
								kind: "single_select",
								id: "choice",
								label: proseText("Choice"),
								optionsSource,
							},
						],
					},
				],
			},
		],
	});
	return {
		doc,
		fieldUuid,
		optionsSource,
		targets: normalizeLookupReferenceTargetSet({
			columnTargets: [{ tableId, columnId }],
		}),
	};
}

/** Seed the entity rows directly, bypassing the writers under test, so the app
 *  starts with a carrier in its blueprint and NO edges stored — the exact skew
 *  an app written before edges existed carries. */
async function seedHistoricalLookupCarrier(
	tableId: LookupTableId,
	columnId: LookupColumnId,
	projectId = PROJECT_A,
): Promise<HistoricalLookupCarrier> {
	const fixture = lookupCarrierFixture(tableId, columnId);
	const appId = await h.seedAppWithBlueprint(fixture.doc, {
		owner: ACTOR,
		projectId,
	});
	return { appId, ...fixture };
}

describe("atomic creation", () => {
	it("returns the exact committed canonical baseline and starter identities", async () => {
		const receipt = await createExplicitBlankApp(
			ACTOR,
			PROJECT_A,
			crypto.randomUUID(),
			{
				name: "  Born app  ",
				status: "complete",
			},
		);
		const loaded = await loadApp(receipt.appId);

		expect(receipt.baseSeq).toBe(1);
		expect(receipt.blueprint.appName).toBe("Born app");
		expect(loaded?.mutation_seq).toBe(1);
		expect(loaded?.blueprint).toEqual(receipt.blueprint);
		expect(receipt.blueprint.moduleOrder).toEqual([receipt.starter.moduleUuid]);
		expect(receipt.blueprint.formOrder[receipt.starter.moduleUuid]).toEqual([
			receipt.starter.formUuid,
		]);
		expect(receipt.blueprint.fieldOrder[receipt.starter.formUuid]).toEqual([
			receipt.starter.fieldUuid,
		]);
		expect(await readTargets(receipt.appId)).toEqual(
			EMPTY_LOOKUP_REFERENCE_TARGETS,
		);
		const marker = await h
			.db()
			.selectFrom("app_changes")
			.select(["seq", "kind", "mutations", "from_project_id", "to_project_id"])
			.where("app_id", "=", receipt.appId)
			.executeTakeFirstOrThrow();
		expect(marker).toEqual({
			seq: "1",
			kind: "fold-baseline",
			mutations: [],
			from_project_id: null,
			to_project_id: null,
		});
		const baseline = await h
			.db()
			.selectFrom("app_change_fold_baselines")
			.select(["seq", "project_id", "snapshot", "snapshot_digest"])
			.where("app_id", "=", receipt.appId)
			.executeTakeFirstOrThrow();
		expect(baseline).toEqual({
			seq: "1",
			project_id: PROJECT_A,
			snapshot: receipt.blueprint,
			snapshot_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
		});
		const digestProof = await h.pool().query<{ matches: boolean }>(
			`
				SELECT snapshot_digest =
					nova_app_change_fold_snapshot_digest(snapshot) AS matches
				FROM app_change_fold_baselines
				WHERE app_id = $1
			`,
			[receipt.appId],
		);
		expect(digestProof.rows[0]?.matches).toBe(true);
	});

	it("rolls back root, entities, marker, and baseline when the last genesis insert fails", async () => {
		const runId = crypto.randomUUID();
		await h.pool().query(`
			CREATE FUNCTION reject_genesis_baseline() RETURNS trigger
			LANGUAGE plpgsql AS $$
			BEGIN
				RAISE EXCEPTION 'forced late genesis failure';
			END
			$$;
			CREATE TRIGGER reject_genesis_baseline
			BEFORE INSERT ON app_change_fold_baselines
			FOR EACH ROW EXECUTE FUNCTION reject_genesis_baseline();
		`);
		await expect(
			createExplicitBlankApp(ACTOR, PROJECT_A, runId, {
				name: "Rollback proof",
				status: "complete",
			}),
		).rejects.toThrow("forced late genesis failure");

		const roots = await h
			.db()
			.selectFrom("apps")
			.select("id")
			.where("run_id", "=", runId)
			.execute();
		expect(roots).toEqual([]);
		const rolledBack = await h.pool().query<{
			roots: number;
			entities: number;
			markers: number;
			baselines: number;
		}>(`
			SELECT
				(SELECT count(*)::int FROM apps) AS roots,
				(SELECT count(*)::int FROM blueprint_entities) AS entities,
				(SELECT count(*)::int FROM app_changes) AS markers,
				(SELECT count(*)::int FROM app_change_fold_baselines) AS baselines
		`);
		expect(rolledBack.rows[0]).toEqual({
			roots: 0,
			entities: 0,
			markers: 0,
			baselines: 0,
		});
	});

	it("replaces stale edges exactly and persists deterministic synthetic mutations", async () => {
		const table = await createTable(PROJECT_A, "Stale edge");
		const appId = await createTestApp();
		await materializeTargets(appId, PROJECT_A, tableTargets(table.id));

		// The app's blueprint references nothing, so ANY commit must converge the
		// stored edges on that — a guarded write is never a no-op for edges.
		await commitGuardedBatch({
			appId,
			expectedProjectId: PROJECT_A,
			batchId: crypto.randomUUID(),
			mutations: [{ kind: "setAppName", name: "Guarded" }],
			actorUserId: ACTOR,
			kind: "autosave",
		});
		expect(await readTargets(appId)).toEqual(EMPTY_LOOKUP_REFERENCE_TARGETS);

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
		// A synthetic batch diffs to the minimal mutation set and lands in the
		// permanent server-folded log; live clients reload across it.
		const stream = await h
			.db()
			.selectFrom("app_changes")
			.select(["kind", "actor_id", "mutations"])
			.where("app_id", "=", appId)
			.orderBy("seq", "desc")
			.executeTakeFirstOrThrow();
		expect(stream).toMatchObject({
			kind: "blueprint-migration",
			actor_id: "system:writer-matrix",
			mutations: [{ kind: "setAppName", name: "Synthetic" }],
		});
	});

	it("rejects a stale synthetic basis without advancing the sequence", async () => {
		const appId = await createTestApp();
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
		expect(await readSeq(appId)).toBe(2);
	});

	it("deduplicates a synthetic replay before its stale basis can replace the first result", async () => {
		const appId = await createTestApp();
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
				expectedBaseSeq: initial.mutation_seq,
				batchId,
				targetDoc: {
					...initial.blueprint,
					appName: "First synthetic result",
				},
				authority,
			}),
		).resolves.toEqual({ kind: "committed", seq: 2 });

		await expect(
			appendSyntheticBatch({
				appId,
				// This basis is now stale and this target differs deliberately: the
				// durable batch latch, not a second diff, owns replay semantics.
				expectedBaseSeq: initial.mutation_seq,
				batchId,
				targetDoc: {
					...initial.blueprint,
					appName: "Replay must not replace the first result",
				},
				authority,
			}),
		).resolves.toEqual({ kind: "deduped", seq: 2 });

		expect(await readSeq(appId)).toBe(2);
		expect((await loadApp(appId))?.app_name).toBe("First synthetic result");
		const history = await h
			.db()
			.selectFrom("app_changes")
			.select(["batch_id", "mutations"])
			.where("app_id", "=", appId)
			.where("batch_id", "=", batchId)
			.execute();
		expect(history).toEqual([
			{
				batch_id: batchId,
				mutations: [{ kind: "setAppName", name: "First synthetic result" }],
			},
		]);
	});

	it("requires a named system actor and nonblank operator reason at runtime", async () => {
		const appId = await createTestApp();
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
					expectedBaseSeq: current.mutation_seq,
					targetDoc,
					authority,
				}),
			).rejects.toThrow(
				"Synthetic system authority requires a named system actor and reason.",
			);
		}
		// A rejected authority writes nothing beyond immutable genesis.
		expect(await readSeq(appId)).toBe(1);
		const streamRows = await h
			.db()
			.selectFrom("app_changes")
			.select("seq")
			.where("app_id", "=", appId)
			.execute();
		expect(streamRows).toEqual([{ seq: "1" }]);
	});
});

describe("lookup materialization versus resource deletion", () => {
	it("backfills exact edges from a hydrated historical carrier and clears them when the carrier is removed", async () => {
		const table = await createTable(PROJECT_A, "Writer first");
		const column = table.columns[0];
		if (column === undefined) throw new Error("lookup table has no column");
		const { appId, fieldUuid, optionsSource, targets } =
			await seedHistoricalLookupCarrier(table.id, column.id);

		expect(await readTargets(appId)).toEqual(EMPTY_LOOKUP_REFERENCE_TARGETS);
		const hydrated = await loadApp(appId);
		if (!hydrated) throw new Error("historical app disappeared");
		const hydratedDoc = hydratePersistedBlueprint(hydrated.blueprint);
		expect(hydratedDoc.fields[fieldUuid]).toMatchObject({
			kind: "single_select",
			optionsSource,
		});
		expect(extractLookupReferenceTargets(hydratedDoc)).toEqual(targets);

		// An unrelated edit is enough: the writer always reconciles the full set.
		await commitGuardedBatch({
			appId,
			expectedProjectId: PROJECT_A,
			batchId: crypto.randomUUID(),
			mutations: [{ kind: "setAppName", name: "References table" }],
			actorUserId: ACTOR,
			kind: "autosave",
		});
		expect(await readTargets(appId)).toEqual(targets);

		// The backfilled edge is now load-bearing: the composite FK refuses the
		// table's deletion (23001 — restrict violation).
		await expect(
			h.withTransaction((tx) =>
				tx
					.deleteFrom("lookup_tables")
					.where("project_id", "=", PROJECT_A)
					.where("id", "=", table.id)
					.execute(),
			),
		).rejects.toMatchObject({ code: "23001" });

		await commitGuardedBatch({
			appId,
			expectedProjectId: PROJECT_A,
			batchId: crypto.randomUUID(),
			mutations: [
				{
					kind: "updateField",
					uuid: fieldUuid,
					targetKind: "single_select",
					patch: {
						optionsSource: {
							kind: "inline",
							options: [
								{
									uuid: testUuid("inline-option-a"),
									value: "a",
									label: proseText("A"),
								},
								{
									uuid: testUuid("inline-option-b"),
									value: "b",
									label: proseText("B"),
								},
							],
						},
					},
				},
			],
			actorUserId: ACTOR,
			kind: "autosave",
		});
		expect(await readTargets(appId)).toEqual(EMPTY_LOOKUP_REFERENCE_TARGETS);
		const repaired = await loadApp(appId);
		if (!repaired) throw new Error("repaired app disappeared");
		const repairedDoc = hydratePersistedBlueprint(repaired.blueprint);
		const repairedField = repairedDoc.fields[fieldUuid];
		if (
			repairedField?.kind !== "single_select" &&
			repairedField?.kind !== "multi_select"
		) {
			throw new Error("repaired field is no longer a select");
		}
		expect(repairedField.optionsSource).toEqual({
			kind: "inline",
			options: [
				{
					uuid: testUuid("inline-option-a"),
					value: "a",
					label: proseText("A"),
				},
				{
					uuid: testUuid("inline-option-b"),
					value: "b",
					label: proseText("B"),
				},
			],
		});
		expect(extractLookupReferenceTargets(repairedDoc)).toBe(
			EMPTY_LOOKUP_REFERENCE_TARGETS,
		);
	});

	it("holds table admission through commit so a concurrent delete blocks, then loses", async () => {
		const table = await createTable(PROJECT_A, "Serialized writer first");
		const column = table.columns[0];
		if (column === undefined) throw new Error("lookup table has no column");
		const { appId, targets } = await seedHistoricalLookupCarrier(
			table.id,
			column.id,
		);
		// Park the app writer mid-transaction, after it has taken table admission,
		// so the delete provably arrives while that admission is held.
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
			// The writer wins and its edge lands, so the delete that queued behind
			// it now violates the restrict constraint rather than orphaning a ref.
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

	it("lets an admitted resource delete commit first, then rejects the waiting reference introduction", async () => {
		const table = await createTable(PROJECT_A, "Serialized delete first");
		const column = table.columns[0];
		if (column === undefined) throw new Error("lookup table has no column");
		const receipt = await createExplicitBlankApp(
			ACTOR,
			PROJECT_A,
			crypto.randomUUID(),
			{
				name: "Delete-first candidate",
				status: "complete",
			},
		);
		const appId = receipt.appId;
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
				.execute(async (tx) =>
					applyLookupSchemaGovernanceInTransaction(
						tx,
						{ projectId: PROJECT_A, actorId: ACTOR, role: "owner" },
						{
							kind: "delete-table",
							tableId: table.id,
							expectedTableRevision: table.tableRevision,
						},
					),
				)
				.then(
					(value) => ({ ok: true as const, value, error: undefined }),
					(error: unknown) => ({ ok: false as const, value: undefined, error }),
				);
			pending.push(deletion);
			// The BEFORE DELETE trigger runs only after governance owns Project,
			// table, and exact-edge admission locks.
			const governancePid = await waitUntilBackendBlockedBy(
				observer,
				blockerPid,
			);

			const writer = commitGuardedBatch({
				appId,
				expectedProjectId: PROJECT_A,
				batchId: crypto.randomUUID(),
				mutations: introduceLookupOptions(
					receipt.starter.fieldUuid,
					table.id,
					column.id,
				),
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
			// The writer wakes to find its target gone and refuses wholesale — a
			// partial commit here would leave an edge to a table that no longer is.
			const writerOutcome = await writer;
			expect(writerOutcome.ok).toBe(false);
			expect(writerOutcome.error).toBeInstanceOf(BlueprintCommitRejectedError);
			expect(writerOutcome.error).toMatchObject({
				name: "BlueprintCommitRejectedError",
				message:
					"One or more lookup tables used by this app are no longer available in its Project. Remove or replace those references, then try again.",
			});
			expect(await readSeq(appId)).toBe(1);
			expect((await loadApp(appId))?.app_name).toBe("Delete-first candidate");
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
		const foreignColumn = foreign.columns[0];
		if (foreignColumn === undefined) {
			throw new Error("foreign lookup table has no column");
		}
		const errors: Error[] = [];
		for (const [tableId, columnId] of [
			[MISSING_TABLE_ID, MISSING_COLUMN_ID],
			[foreign.id, foreignColumn.id],
		] as const) {
			const receipt = await createExplicitBlankApp(
				ACTOR,
				PROJECT_A,
				crypto.randomUUID(),
				{
					name: "Unavailable candidate",
					status: "complete",
				},
			);
			const appId = receipt.appId;
			const error = await commitGuardedBatch({
				appId,
				expectedProjectId: PROJECT_A,
				batchId: crypto.randomUUID(),
				mutations: introduceLookupOptions(
					receipt.starter.fieldUuid,
					tableId,
					columnId,
				),
				actorUserId: ACTOR,
				kind: "autosave",
			}).catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(BlueprintCommitRejectedError);
			errors.push(error as Error);
			expect(await readSeq(appId)).toBe(1);
		}
		// Identical copy for both: a differing message would confirm that a table
		// exists in a Project the caller cannot see.
		expect(errors[0]?.message).toBe(errors[1]?.message);
	});
});

describe("cross-Project move", () => {
	it("requires an exact empty lookup closure before it will move an app", async () => {
		const table = await createTable(PROJECT_A, "Move blocker");
		const column = table.columns[0];
		if (column === undefined) throw new Error("lookup table has no column");
		const { appId, fieldUuid, targets } = await seedHistoricalLookupCarrier(
			table.id,
			column.id,
		);
		await h.seedProjectMember(ACTOR, PROJECT_A, "owner");
		await h.seedProjectMember(ACTOR, PROJECT_B, "owner");
		await materializeTargets(appId, PROJECT_A, targets);

		const move = () =>
			commitAppProjectMove(appId, {
				toProjectId: PROJECT_B,
				expectedFromProjectId: PROJECT_A,
				actorUserId: ACTOR,
				assetIdMap: new Map(),
			});

		// A referencing app cannot move: its edges are Project-scoped, and the
		// destination Project does not own that table.
		await expect(move()).rejects.toBeInstanceOf(BlueprintCommitRejectedError);
		expect((await h.readAppRow(appId))?.project_id).toBe(PROJECT_A);
		expect(await readTargets(appId)).toEqual(targets);

		// Clearing only the STORED edges is not enough — the blueprint still
		// carries the reference, and that skew is itself a refusal.
		await materializeTargets(appId, PROJECT_A, EMPTY_LOOKUP_REFERENCE_TARGETS);
		await expect(move()).rejects.toBeInstanceOf(BlueprintCommitRejectedError);
		expect((await h.readAppRow(appId))?.project_id).toBe(PROJECT_A);

		// Removing the carrier itself converges both sides on empty, and the move
		// becomes available.
		await commitGuardedBatch({
			appId,
			expectedProjectId: PROJECT_A,
			batchId: crypto.randomUUID(),
			mutations: [
				{
					kind: "updateField",
					uuid: fieldUuid,
					targetKind: "single_select",
					patch: {
						optionsSource: {
							kind: "inline",
							options: [
								{
									uuid: testUuid("inline-option-a"),
									value: "a",
									label: proseText("A"),
								},
								{
									uuid: testUuid("inline-option-b"),
									value: "b",
									label: proseText("B"),
								},
							],
						},
					},
				},
			],
			actorUserId: ACTOR,
			kind: "autosave",
		});
		expect(await readTargets(appId)).toEqual(EMPTY_LOOKUP_REFERENCE_TARGETS);
		await expect(move()).resolves.toEqual({ kind: "moved" });
		expect((await h.readAppRow(appId))?.project_id).toBe(PROJECT_B);
		expect(await readTargets(appId)).toEqual(EMPTY_LOOKUP_REFERENCE_TARGETS);
	});
});

describe("edge repair maintenance writer", () => {
	it("rederives structural edges from the committed blueprint without history or sequence", async () => {
		const table = await createTable(PROJECT_A, "Repair target");
		const stale = await createTable(PROJECT_A, "Repair stale");
		const column = table.columns[0];
		if (column === undefined) throw new Error("lookup table has no column");
		const { appId, targets } = await seedHistoricalLookupCarrier(
			table.id,
			column.id,
		);
		// A stored edge to a table the blueprint never references, plus the
		// missing real carrier edges, is exactly the scan's mismatch shape.
		await materializeTargets(appId, PROJECT_A, tableTargets(stale.id));

		const seqBefore = await readSeq(appId);
		expect(await repairLookupReferenceEdges(appId)).toEqual({
			kind: "repaired",
		});
		expect(await readTargets(appId)).toEqual(targets);
		expect(await repairLookupReferenceEdges(appId)).toEqual({
			kind: "unchanged",
		});
		// Edges are derived state, so a repair must not appear in the history
		// every live client replays.
		expect(await readSeq(appId)).toBe(seqBefore);
		const history = await h
			.db()
			.selectFrom("app_changes")
			.select("seq")
			.where("app_id", "=", appId)
			.execute();
		expect(history).toEqual([]);
	});

	it("fails closed on a missing app", async () => {
		await expect(repairLookupReferenceEdges("missing-app")).rejects.toThrow(
			"app row is unavailable",
		);
	});
});
