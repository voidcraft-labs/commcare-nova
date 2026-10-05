import { randomUUID } from "node:crypto";
import {
	type Kysely,
	type KyselyPlugin,
	PostgresQueryCompiler,
	sql,
} from "kysely";
import { describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { withAppTestNamespace } from "@/lib/case-store/appTestNamespace";
import type { AppDatabase } from "@/lib/db/pg";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import type { CaseType } from "@/lib/domain";
import {
	arith,
	eq,
	formField,
	gt,
	ifExpr,
	literal,
	matchAll,
	tableLookup,
	term,
} from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import { applyLookupAuthoringBatchInTransaction } from "@/lib/lookup/authoringBatch";
import { seedAppTest } from "@/lib/preview/app-tests/seed";
import { buildSimpleBlueprint } from "../../__tests__/fixtures/simpleBlueprint";
import { HeuristicCaseGenerator } from "../../sample/heuristic";
import { setupPerTestDatabase } from "../../sql/__tests__/perTestDatabase";
import type { Database } from "../../sql/database";
import { buildCaseTypeMap, type CaseRow } from "../../store";
import type { CaseOperationProgram } from "../../submission";
import { PostgresCaseStore } from "../store";

const APP_ID = "conditional-write-app";
const PROJECT_ID = "conditional-write-project";
const ACTOR = "worker-1";
const FORM_UUID = testUuid("conditional-write-form");
const OP_UUID = testUuid("conditional-write-create");
const FLAG_FIELD = testUuid("conditional-write-flag");
const VOLUME_FIELD = testUuid("conditional-write-volume");
const DURATION_FIELD = testUuid("conditional-write-duration");
const INSPECTION: CaseType = {
	name: "inspection",
	properties: [
		{ name: "flow", label: proseText("Flow"), data_type: "decimal" },
		{ name: "note", label: proseText("Note"), data_type: "text" },
	],
};
const SCHEMAS = buildCaseTypeMap(buildSimpleBlueprint([INSPECTION], APP_ID));

const fixture = setupPerTestDatabase({
	schema: "migrated",
	poolMax: 3,
	databaseNamePrefix: "conditional_write_",
	prepareTemplate: async (db) => {
		await sql`
			INSERT INTO apps (id, owner, project_id, app_name, app_name_lower)
			VALUES (${APP_ID}, ${ACTOR}, ${PROJECT_ID}, 'Inspection', 'inspection')
		`.execute(db);
		await makeStore(db as Kysely<Database>).applySchemaChange({
			appId: APP_ID,
			caseType: INSPECTION.name,
			caseTypeSchemas: SCHEMAS,
		});
	},
});

function makeStore(db: Kysely<Database> = fixture.db as Kysely<Database>) {
	return new PostgresCaseStore({
		projectId: PROJECT_ID,
		actorUserId: ACTOR,
		ownerId: ACTOR,
		db,
		sampleGenerator: new HeuristicCaseGenerator(),
	});
}

function program(
	flag: string,
	volume: string,
	duration: string,
): CaseOperationProgram {
	return {
		formUuid: FORM_UUID,
		caseTypeSchemas: SCHEMAS,
		formFieldTypes: new Map([
			[FLAG_FIELD, "single_select"],
			[VOLUME_FIELD, "decimal"],
			[DURATION_FIELD, "decimal"],
		]),
		scopes: [
			{
				iterations: [
					{
						formFields: new Map([
							[FLAG_FIELD, flag],
							[VOLUME_FIELD, volume],
							[DURATION_FIELD, duration],
						]),
					},
				],
			},
		],
		operations: [
			{
				guardConditions: [],
				expressionSnapshotTypes: { links: new Map() },
				operation: {
					uuid: OP_UUID,
					id: "create_inspection",
					action: "create",
					caseType: INSPECTION.name,
					target: { kind: "new" },
					name: term(literal("Inspection")),
					writes: [
						{ property: "note", value: term(literal("retained")) },
						{
							property: "flow",
							condition: eq(formField(FLAG_FIELD), literal("yes")),
							value: arith(
								"div",
								arith("*", term(literal(60)), term(formField(VOLUME_FIELD))),
								term(formField(DURATION_FIELD)),
							),
						},
					],
				},
			},
		],
	};
}

function submit(
	store: PostgresCaseStore,
	operations: CaseOperationProgram,
	entryKey = "conditional-write-entry",
) {
	return store.applySubmission({
		appId: APP_ID,
		ordinary: { kind: "none" },
		operations,
		submissionReceipt: {
			entryKey,
			formUuid: FORM_UUID,
			expectedAppMutationSeq: 0,
			blueprintDigest: "0".repeat(64),
			requestDigest: "conditional-write-request",
		},
	});
}

describe("conditional numeric writes", () => {
	it("submits from captured lookup rows while a live writer holds the table lock", async () => {
		const appDb = fixture.db as Kysely<AppDatabase>;
		const seeded = await appDb.transaction().execute((tx) =>
			applyLookupAuthoringBatchInTransaction(
				tx,
				{ projectId: PROJECT_ID, actorId: ACTOR, role: "owner" },
				{
					createTables: [
						{
							key: "divisor",
							name: "Divisor",
							tag: "divisor",
							columns: [
								{
									key: "amount",
									wireName: "amount",
									label: "Amount",
									dataType: "decimal",
								},
							],
							rows: [
								{ key: "initial", cells: [{ columnKey: "amount", value: 2 }] },
							],
						},
					],
				},
			),
		);
		const table = seeded.tables[0];
		const columnId = table?.columnIds[0]?.id;
		const rowId = table?.rowIds[0]?.id;
		if (!table || !columnId || !rowId)
			throw new Error("Lookup seed is incomplete.");
		const testId = randomUUID();
		await sql`SELECT public.nova_create_app_test_namespace(${testId}::uuid)`.execute(
			appDb,
		);
		const testScope = {
			testId,
			appId: APP_ID,
			projectId: PROJECT_ID,
			actorUserId: ACTOR,
			blueprintSeq: 0,
		};
		await appDb.transaction().execute((tx) =>
			seedAppTest(
				tx,
				testScope,
				{
					purpose: "Use captured lookup data",
					blueprint: toPersistableDoc(
						buildSimpleBlueprint([INSPECTION], APP_ID),
					),
					user: { id: ACTOR, name: ACTOR, email: "worker@example.test" },
					projectSpace: null,
					lookup: {
						projectRevision: seeded.projectRevision,
						definitions: [
							{
								id: table.tableId,
								name: "Divisor",
								tag: "divisor",
								definitionRevision: seeded.projectRevision,
								columns: [
									{
										id: columnId,
										wireName: "amount",
										label: "Amount",
										dataType: "decimal",
									},
								],
							},
						],
						rows: [[table.tableId, [{ id: rowId, values: { [columnId]: 2 } }]]],
					},
					organizationRevision: "0",
					locations: [],
					testPlaceIds: [],
					testAssignmentPersonaIds: [],
				},
				{ purpose: "Use captured lookup data" },
			),
		);
		const divisor = tableLookup(table.tableId, columnId, matchAll());
		const original = program("yes", "1", "1");
		const create = original.operations[0];
		if (!create) throw new Error("Inspection program has no create operation.");
		const lookupProgram: CaseOperationProgram = {
			...original,
			lookupTableSchemas: new Map([
				[table.tableId, new Map([[columnId, "decimal"]])],
			]),
			operations: [
				{
					...create,
					operation: {
						...create.operation,
						writes: [
							{
								property: "flow",
								condition: gt(divisor, literal(0)),
								value: arith("div", term(literal(60)), divisor),
							},
						],
					},
				},
			],
		};
		let writerLocked = false;
		const releaseWriter = Promise.withResolvers<void>();
		const writer = Promise.allSettled([
			appDb.transaction().execute(async (tx) => {
				await tx
					.selectFrom("lookup_tables")
					.select("id")
					.where("project_id", "=", PROJECT_ID)
					.where("id", "=", table.tableId)
					.forUpdate()
					.execute();
				writerLocked = true;
				await releaseWriter.promise;
				await tx
					.updateTable("lookup_rows")
					.set({ values: JSON.stringify({ [columnId]: 0 }) })
					.where("project_id", "=", PROJECT_ID)
					.where("table_id", "=", table.tableId)
					.where("id", "=", rowId)
					.execute();
			}),
		]);
		let submitted = false;
		let submission: Promise<PromiseSettledResult<unknown>[]> | undefined;
		try {
			await vi.waitFor(() => expect(writerLocked).toBe(true));
			submission = Promise.allSettled([
				fixture.db.transaction().execute((tx) =>
					withAppTestNamespace(
						tx,
						{ ...testScope, ownerId: ACTOR },
						async (store, isolated) => {
							await store.applySubmission({
								appId: APP_ID,
								ordinary: { kind: "none" },
								operations: lookupProgram,
								submissionReceipt: {
									entryKey: "isolated-lookup",
									formUuid: FORM_UUID,
									expectedAppMutationSeq: 0,
									blueprintDigest: "0".repeat(64),
									requestDigest: "isolated-lookup",
								},
							});
							const rows = await isolated
								.selectFrom("cases")
								.select("properties")
								.execute();
							expect(rows).toEqual([{ properties: { flow: 30 } }]);
						},
					),
				),
			]).then((results) => {
				submitted = true;
				return results;
			});
			await vi.waitFor(() => expect(submitted).toBe(true));
			expect(await submission).toMatchObject([{ status: "fulfilled" }]);
		} finally {
			releaseWriter.resolve();
			await submission;
			expect(await writer).toMatchObject([{ status: "fulfilled" }]);
		}
		expect(
			await (fixture.db as Kysely<Database>)
				.selectFrom("cases")
				.selectAll()
				.where("app_id", "=", APP_ID)
				.execute(),
		).toEqual([]);
		expect(
			(
				await appDb
					.selectFrom("lookup_rows")
					.select("values")
					.where("table_id", "=", table.tableId)
					.execute()
			)[0]?.values,
		).toEqual({ [columnId]: 0 });
	});

	it("keeps lookup guards and values consistent while a lookup writer is waiting", async () => {
		const appDb = fixture.db as Kysely<AppDatabase>;
		const scope = {
			projectId: PROJECT_ID,
			actorId: ACTOR,
			role: "owner" as const,
		};
		const seed = await appDb.transaction().execute((tx) =>
			applyLookupAuthoringBatchInTransaction(tx, scope, {
				createTables: [
					{
						key: "divisor",
						name: "Divisor",
						tag: "divisor",
						columns: [
							{
								key: "amount",
								wireName: "amount",
								label: "Amount",
								dataType: "decimal",
							},
						],
						rows: [
							{ key: "initial", cells: [{ columnKey: "amount", value: 2 }] },
						],
					},
				],
			}),
		);
		const table = seed.tables[0];
		const columnId = table?.columnIds[0]?.id;
		const rowId = table?.rowIds[0]?.id;
		if (!table || !columnId || !rowId)
			throw new Error("Lookup seed did not return its identities.");
		const divisor = tableLookup(table.tableId, columnId, matchAll());
		const operations = program("yes", "1", "1");
		const create = operations.operations[0];
		if (!create) throw new Error("Inspection program has no create operation.");
		const lookupProgram: CaseOperationProgram = {
			...operations,
			lookupTableSchemas: new Map([
				[table.tableId, new Map([[columnId, "decimal"]])],
			]),
			operations: [
				{
					...create,
					operation: {
						...create.operation,
						writes: [
							{
								property: "flow",
								condition: gt(divisor, literal(0)),
								value: arith("div", term(literal(60)), divisor),
							},
						],
					},
				},
			],
		};
		let guardObserved = false;
		const releaseGuard = Promise.withResolvers<void>();
		const guardedQueries = new WeakSet<object>();
		const compiler = new PostgresQueryCompiler();
		const pauseActualGuardResult: KyselyPlugin = {
			transformQuery(args) {
				const query = compiler.compileQuery(args.node, args.queryId);
				if (
					query.sql.includes('"lookup_rows"') &&
					query.sql.includes("case when")
				)
					guardedQueries.add(args.queryId);
				return args.node;
			},
			async transformResult(args) {
				if (guardedQueries.has(args.queryId)) {
					guardObserved = true;
					await releaseGuard.promise;
				}
				return args.result;
			},
		};
		const submission = Promise.allSettled([
			submit(
				makeStore(
					(fixture.db as Kysely<Database>).withPlugin(pauseActualGuardResult),
				),
				lookupProgram,
			),
		]);
		let writerPid = 0;
		let writer: Promise<PromiseSettledResult<unknown>[]> | undefined;
		let writerFinished = false;
		try {
			await vi.waitFor(() => expect(guardObserved).toBe(true));
			writer = Promise.allSettled([
				appDb.transaction().execute(async (tx) => {
					const backend = await sql<{
						pid: number;
					}>`SELECT pg_backend_pid() AS pid`.execute(tx);
					writerPid = backend.rows[0]?.pid ?? 0;
					return applyLookupAuthoringBatchInTransaction(tx, scope, {
						updateTables: [
							{
								tableId: table.tableId,
								expectedTableRevision: seed.projectRevision,
								rowOperations: [
									{ kind: "update", rowId, cells: [{ columnId, value: 0 }] },
								],
							},
						],
					});
				}),
			]).then((result) => {
				writerFinished = true;
				return result;
			});
			await vi.waitFor(() => expect(writerPid).toBeGreaterThan(0));
			const writerState = await vi.waitFor(async () => {
				const blocked = await sql<{
					blocked: boolean;
				}>`SELECT cardinality(pg_blocking_pids(${writerPid})) > 0 AS blocked`.execute(
					fixture.db,
				);
				if (blocked.rows[0]?.blocked) return "blocked";
				if (writerFinished) return "committed";
				throw new Error("Waiting for the actual lookup writer's lock state.");
			});
			releaseGuard.resolve();
			const [submitted] = await submission;
			if (submitted?.status === "rejected") throw submitted.reason;
			expect(submitted).toMatchObject({ status: "fulfilled" });
			expect(writerState).toBe("blocked");
			expect(await writer).toMatchObject([{ status: "fulfilled" }]);
			const rows = await makeStore().query({
				appId: APP_ID,
				caseType: INSPECTION.name,
			});
			expect(rows[0]?.properties).toEqual({ flow: 30 });
			const changed = await sql<{
				values: Record<string, number>;
			}>`SELECT "values" FROM lookup_rows WHERE project_id = ${PROJECT_ID} AND table_id = ${table.tableId} AND id = ${rowId}`.execute(
				fixture.db,
			);
			expect(changed.rows[0]?.values[columnId]).toBe(0);
		} finally {
			releaseGuard.resolve();
			await submission;
			await writer;
		}
	});

	it.each([
		["", ""],
		["7.5", "0"],
	])(
		"does not evaluate a false-guarded calculation (%s, %s)",
		async (volume, duration) => {
			const store = makeStore();
			await submit(store, program("no", volume, duration));
			const rows = await store.query({
				appId: APP_ID,
				caseType: INSPECTION.name,
			});
			expect(rows).toHaveLength(1);
			expect(rows[0]?.properties).toEqual({ note: "retained" });
		},
	);

	it.each([
		["7.5", "30", 15],
		["20.5", "10.25", 120],
		["0", "30", 0],
	])(
		"evaluates a true-guarded calculation (%s, %s)",
		async (volume, duration, expected) => {
			const store = makeStore();
			await submit(store, program("yes", volume, duration));
			const rows = await store.query({
				appId: APP_ID,
				caseType: INSPECTION.name,
			});
			expect(rows).toHaveLength(1);
			expect(rows[0]?.properties).toEqual({ note: "retained", flow: expected });
		},
	);

	it.each([
		["", "", "22P02"],
		["7.5", "0", "22012"],
	])(
		"retains real errors and rolls back when the guard is true (%s, %s)",
		async (volume, duration, code) => {
			const store = makeStore();
			await expect(
				submit(store, program("yes", volume, duration)),
			).rejects.toMatchObject({ code });
			expect(
				await store.query({ appId: APP_ID, caseType: INSPECTION.name }),
			).toEqual([]);
			const intents = await sql<{ count: number }>`
				SELECT count(*)::int AS count FROM form_submission_intents
				WHERE app_id = ${APP_ID}
			`.execute(fixture.db);
			expect(intents.rows[0]?.count).toBe(0);
		},
	);
});

describe("numeric answer branches", () => {
	it("omits a blank event value, clears its summary, and preserves zero and earlier events", async () => {
		const store = makeStore();
		const { caseId: summaryId } = await store.insert({
			appId: APP_ID,
			row: {
				case_type: INSPECTION.name,
				case_name: "Summary",
				properties: { flow: 42, note: "summary" },
			},
		});
		const events: CaseRow[] = [];
		const declarations = [
			["yes", "7.5", "30", 15],
			["no", "", "", undefined],
			["no", "0", "", 0],
		] as const;
		for (const [
			index,
			[flag, volume, duration, expected],
		] of declarations.entries()) {
			const base = program(flag, volume, duration);
			const create = base.operations[0];
			if (!create) throw new Error("Inspection create operation is missing.");
			const value = ifExpr(
				eq(formField(FLAG_FIELD), literal("yes")),
				arith(
					"div",
					arith("*", term(literal(60)), term(formField(VOLUME_FIELD))),
					term(formField(DURATION_FIELD)),
				),
				term(formField(VOLUME_FIELD)),
			);
			const writes = [{ property: "flow", value }];
			await submit(
				store,
				{
					...base,
					sessionCaseIds: [summaryId],
					operations: [
						{
							...create,
							operation: { ...create.operation, writes },
						},
						{
							guardConditions: [],
							expressionSnapshotTypes: { links: new Map() },
							operation: {
								uuid: testUuid("numeric-branch-summary"),
								id: "update_summary",
								action: "update",
								caseType: INSPECTION.name,
								target: { kind: "session" },
								writes,
							},
						},
					],
				},
				`numeric-branch-${index}`,
			);
			const rows = await store.query({
				appId: APP_ID,
				caseType: INSPECTION.name,
			});
			expect(rows).toHaveLength(index + 2);
			const currentSummary = rows.find((row) => row.case_id === summaryId);
			expect(currentSummary?.properties).toEqual({
				note: "summary",
				...(expected === undefined ? {} : { flow: expected }),
			});
			for (const event of events) {
				expect(rows.find((row) => row.case_id === event.case_id)).toEqual(
					event,
				);
			}
			const event = rows.find(
				(row) =>
					row.case_id !== summaryId &&
					!events.some((prior) => prior.case_id === row.case_id),
			);
			expect(event?.properties).toEqual(
				expected === undefined ? {} : { flow: expected },
			);
			if (!event) throw new Error("Submitted inspection event is missing.");
			events.push(event);
		}
	});
});
