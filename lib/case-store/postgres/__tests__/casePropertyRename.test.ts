import { type Kysely, sql } from "kysely";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CaseType } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { HeuristicCaseGenerator } from "../../sample/heuristic";
import { setupPerTestDatabase } from "../../sql/__tests__/perTestDatabase";
import type { Database, JsonObject } from "../../sql/database";
import { CasePropertyRenameStorageConflictError } from "../../store";
import { indexScopeTag, PostgresCaseStore, propertyIndexTag } from "../store";

const database = setupPerTestDatabase({
	schema: "migrated",
	databaseNamePrefix: "case_property_rename_",
});
const APP_ID = "rename-app";
const PROJECT_ID = "rename-project";

function db(): Kysely<Database> {
	return database.db as unknown as Kysely<Database>;
}

function store(): PostgresCaseStore {
	return new PostgresCaseStore({
		projectId: PROJECT_ID,
		actorUserId: "rename-actor",
		ownerId: "rename-actor",
		db: db(),
		sampleGenerator: new HeuristicCaseGenerator(),
	});
}

function schemas(
	properties: CaseType["properties"],
): ReadonlyMap<string, CaseType> {
	return new Map([
		[
			"patient",
			{
				name: "patient",
				properties,
			},
		],
	]);
}

beforeEach(async () => {
	await sql`
		INSERT INTO apps
			(id, owner, project_id, app_name, app_name_lower)
		VALUES
			(${APP_ID}, 'rename-actor', ${PROJECT_ID}, 'Rename', 'rename')
	`.execute(database.db);
});

describe("explicit case-property rename storage", () => {
	it("moves a heterogeneous chain across live and dismissed parked rows without touching metadata", async () => {
		const caseStore = store();
		const initial = schemas([
			{ name: "a", label: proseText("A"), data_type: "text" },
			{ name: "b", label: proseText("B"), data_type: "int" },
			{ name: "untouched", label: proseText("Untouched"), data_type: "text" },
		]);
		await caseStore.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: initial,
			syncedSeq: 0,
		});
		await caseStore.insert({
			appId: APP_ID,
			row: {
				case_id: "case-1",
				case_type: "patient",
				case_name: "Patient",
				modified_on: new Date("2024-01-02T03:04:05.000Z"),
				properties: { a: "alpha", b: 7, untouched: "stay" },
			},
		});
		await sql`
			INSERT INTO parked_case_values
				(id, app_id, case_id, case_type, property, original_value,
				 reason, from_type, to_type, dismissed_at, created_at)
			VALUES
				('10000000-0000-0000-0000-000000000001', ${APP_ID}, 'case-1',
				 'patient', 'a', '11'::jsonb, 'keep-a', 'int', 'decimal',
				 NULL, '2024-02-01T00:00:00Z'),
				('10000000-0000-0000-0000-000000000002', ${APP_ID}, 'case-1',
				 'patient', 'b', '"old"'::jsonb, 'keep-b', 'text', 'date',
				 '2024-03-01T00:00:00Z', '2024-02-02T00:00:00Z')
		`.execute(database.db);
		const liveBefore = await db()
			.selectFrom("cases")
			.selectAll()
			.where("case_id", "=", "case-1")
			.executeTakeFirstOrThrow();
		const parkedBefore = await db()
			.selectFrom("parked_case_values")
			.selectAll()
			.orderBy("id")
			.execute();

		const latest = schemas([
			{ name: "b", label: proseText("A"), data_type: "text" },
			{ name: "c", label: proseText("B"), data_type: "int" },
			{ name: "untouched", label: proseText("Untouched"), data_type: "text" },
		]);
		const phase = await db()
			.transaction()
			.execute((tx) =>
				caseStore.applyCasePropertyRenamePhaseA(tx, {
					appId: APP_ID,
					desiredSeq: 1,
					caseTypeSchemas: latest,
					entries: [
						{ caseType: "patient", from: "a", to: "b" },
						{ caseType: "patient", from: "b", to: "c" },
					],
				}),
			);
		await phase.completeAfterCommit();

		const live = await db()
			.selectFrom("cases")
			.select(["properties", "modified_on"])
			.where("case_id", "=", "case-1")
			.executeTakeFirstOrThrow();
		expect(live.properties).toEqual({
			b: "alpha",
			c: 7,
			untouched: "stay",
		});
		expect(live.modified_on?.toISOString()).toBe("2024-01-02T03:04:05.000Z");
		const liveAfter = await db()
			.selectFrom("cases")
			.selectAll()
			.where("case_id", "=", "case-1")
			.executeTakeFirstOrThrow();
		expect(liveAfter).toEqual({
			...liveBefore,
			properties: { b: "alpha", c: 7, untouched: "stay" },
		});

		const parked = await db()
			.selectFrom("parked_case_values")
			.select([
				"id",
				"property",
				"original_value",
				"reason",
				"from_type",
				"to_type",
				"dismissed_at",
				"created_at",
			])
			.orderBy("id")
			.execute();
		expect(parked).toEqual([
			expect.objectContaining({
				property: "b",
				original_value: 11,
				reason: "keep-a",
				from_type: "int",
				to_type: "decimal",
				dismissed_at: null,
			}),
			expect.objectContaining({
				property: "c",
				original_value: "old",
				reason: "keep-b",
				from_type: "text",
				to_type: "date",
				dismissed_at: new Date("2024-03-01T00:00:00.000Z"),
			}),
		]);
		const parkedAfter = await db()
			.selectFrom("parked_case_values")
			.selectAll()
			.orderBy("id")
			.execute();
		expect(parkedAfter).toEqual([
			{ ...parkedBefore[0], property: "b" },
			{ ...parkedBefore[1], property: "c" },
		]);
		const schema = await db()
			.selectFrom("case_type_schemas")
			.select(["schema", "index_pending_seq", "index_synced_seq"])
			.where("app_id", "=", APP_ID)
			.where("case_type", "=", "patient")
			.executeTakeFirstOrThrow();
		expect((schema.schema.properties as JsonObject).b).toMatchObject({
			type: "string",
		});
		expect((schema.schema.properties as JsonObject).c).toMatchObject({
			type: "integer",
		});
		expect(schema.index_pending_seq).toBeNull();
		expect(Number(schema.index_synced_seq)).toBe(1);
	});

	it("a delayed older Phase B converges the latest committed schema", async () => {
		const caseStore = store();
		const a = schemas([{ name: "a", label: proseText("A"), data_type: "int" }]);
		await caseStore.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: a,
			syncedSeq: 0,
		});

		const b = schemas([{ name: "b", label: proseText("A"), data_type: "int" }]);
		const phaseN = await db()
			.transaction()
			.execute((tx) =>
				caseStore.applyCasePropertyRenamePhaseA(tx, {
					appId: APP_ID,
					desiredSeq: 1,
					caseTypeSchemas: b,
					entries: [{ caseType: "patient", from: "a", to: "b" }],
				}),
			);
		const c = schemas([
			{ name: "c", label: proseText("A"), data_type: "decimal" },
		]);
		await db()
			.transaction()
			.execute((tx) =>
				caseStore.applyCasePropertyRenamePhaseA(tx, {
					appId: APP_ID,
					desiredSeq: 2,
					caseTypeSchemas: c,
					entries: [{ caseType: "patient", from: "b", to: "c" }],
				}),
			);

		await phaseN.completeAfterCommit();
		const state = await db()
			.selectFrom("case_type_schemas")
			.select(["index_pending_seq", "index_synced_seq"])
			.where("app_id", "=", APP_ID)
			.where("case_type", "=", "patient")
			.executeTakeFirstOrThrow();
		expect(state.index_pending_seq).toBeNull();
		expect(Number(state.index_synced_seq)).toBe(2);

		const indexes = await database.pool.query<{ indexdef: string }>(
			`SELECT indexdef FROM pg_indexes WHERE tablename = 'cases' AND indexname LIKE $1 ESCAPE '\\'`,
			[`cases\\_%\\_num`],
		);
		expect(
			indexes.rows.some((row) => row.indexdef.includes("properties")),
		).toBe(true);
	});

	it("moves a three-way cycle simultaneously across live and parked values", async () => {
		const caseStore = store();
		const initial = schemas([
			{ name: "a", label: proseText("A"), data_type: "text" },
			{ name: "b", label: proseText("B"), data_type: "text" },
			{ name: "c", label: proseText("C"), data_type: "text" },
		]);
		await caseStore.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: initial,
			syncedSeq: 0,
		});
		await caseStore.insert({
			appId: APP_ID,
			row: {
				case_id: "cycle-case",
				case_type: "patient",
				case_name: "Cycle",
				properties: { a: "A", b: "B", c: "C" },
			},
		});
		await sql`
			INSERT INTO parked_case_values
				(id, app_id, case_id, case_type, property, original_value,
				 reason, from_type, to_type)
			VALUES
				('20000000-0000-0000-0000-000000000001', ${APP_ID}, 'cycle-case',
				 'patient', 'a', '"park-a"'::jsonb, 'a', 'text', 'text'),
				('20000000-0000-0000-0000-000000000002', ${APP_ID}, 'cycle-case',
				 'patient', 'b', '"park-b"'::jsonb, 'b', 'text', 'text'),
				('20000000-0000-0000-0000-000000000003', ${APP_ID}, 'cycle-case',
				 'patient', 'c', '"park-c"'::jsonb, 'c', 'text', 'text')
		`.execute(database.db);

		const phase = await db()
			.transaction()
			.execute((tx) =>
				caseStore.applyCasePropertyRenamePhaseA(tx, {
					appId: APP_ID,
					desiredSeq: 1,
					caseTypeSchemas: initial,
					entries: [
						{ caseType: "patient", from: "a", to: "b" },
						{ caseType: "patient", from: "b", to: "c" },
						{ caseType: "patient", from: "c", to: "a" },
					],
				}),
			);
		await phase.completeAfterCommit();

		expect(
			(
				await db()
					.selectFrom("cases")
					.select("properties")
					.where("case_id", "=", "cycle-case")
					.executeTakeFirstOrThrow()
			).properties,
		).toEqual({ a: "C", b: "A", c: "B" });
		expect(
			(
				await db()
					.selectFrom("parked_case_values")
					.select("property")
					.orderBy("id")
					.execute()
			).map((row) => row.property),
		).toEqual(["b", "c", "a"]);
	});

	it("leaves rename index work pending after Phase-B failure and a later drain retries it", async () => {
		const caseStore = store();
		const initial = schemas([
			{ name: "a", label: proseText("A"), data_type: "text" },
		]);
		await caseStore.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: initial,
			syncedSeq: 0,
		});
		const renamed = schemas([
			{ name: "b", label: proseText("B"), data_type: "text" },
		]);
		const phase = await db()
			.transaction()
			.execute((tx) =>
				caseStore.applyCasePropertyRenamePhaseA(tx, {
					appId: APP_ID,
					desiredSeq: 1,
					caseTypeSchemas: renamed,
					entries: [{ caseType: "patient", from: "a", to: "b" }],
				}),
			);

		type PrivateSync = (args: unknown) => Promise<void>;
		const privateStore = caseStore as unknown as {
			syncExpressionIndexes: PrivateSync;
		};
		const syncSpy = vi
			.spyOn(privateStore, "syncExpressionIndexes")
			.mockRejectedValueOnce(new Error("injected rename Phase-B failure"));
		await expect(phase.completeAfterCommit()).rejects.toThrow(
			"injected rename Phase-B failure",
		);
		expect(
			Number(
				(
					await db()
						.selectFrom("case_type_schemas")
						.select("index_pending_seq")
						.where("app_id", "=", APP_ID)
						.where("case_type", "=", "patient")
						.executeTakeFirstOrThrow()
				).index_pending_seq,
			),
		).toBe(1);

		syncSpy.mockRestore();
		await caseStore.drainPendingIndexConvergence({ appId: APP_ID });
		const state = await db()
			.selectFrom("case_type_schemas")
			.select(["index_pending_seq", "index_synced_seq"])
			.where("app_id", "=", APP_ID)
			.where("case_type", "=", "patient")
			.executeTakeFirstOrThrow();
		expect(state.index_pending_seq).toBeNull();
		expect(Number(state.index_synced_seq)).toBe(1);
	});

	it("treats null live and dismissed parked destinations as occupied and rolls back", async () => {
		const caseStore = store();
		const initial = schemas([
			{ name: "a", label: proseText("A"), data_type: "text" },
		]);
		await caseStore.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: initial,
			syncedSeq: 0,
		});
		await sql`
			INSERT INTO cases
				(case_id, app_id, project_id, case_type, case_name, properties)
			VALUES
				('case-conflict', ${APP_ID}, ${PROJECT_ID}, 'patient', 'Patient',
				 '{"a":"source","b":null}'::jsonb)
		`.execute(database.db);
		const renamed = schemas([
			{ name: "b", label: proseText("A"), data_type: "text" },
		]);
		const apply = () =>
			db()
				.transaction()
				.execute((tx) =>
					caseStore.applyCasePropertyRenamePhaseA(tx, {
						appId: APP_ID,
						desiredSeq: 1,
						caseTypeSchemas: renamed,
						entries: [{ caseType: "patient", from: "a", to: "b" }],
					}),
				);
		await expect(apply()).rejects.toBeInstanceOf(
			CasePropertyRenameStorageConflictError,
		);
		expect(
			(
				await db()
					.selectFrom("cases")
					.select("properties")
					.where("case_id", "=", "case-conflict")
					.executeTakeFirstOrThrow()
			).properties,
		).toEqual({ a: "source", b: null });

		await sql`
			UPDATE cases
			SET properties = '{"a":"source"}'::jsonb
			WHERE case_id = 'case-conflict'
		`.execute(database.db);
		await sql`
			INSERT INTO parked_case_values
				(id, app_id, case_id, case_type, property, original_value,
				 reason, from_type, to_type, dismissed_at)
			VALUES
				('10000000-0000-0000-0000-000000000003', ${APP_ID}, 'case-conflict',
				 'patient', 'b', '"parked"'::jsonb, 'dismissed destination',
				 'text', 'text', now())
		`.execute(database.db);
		await expect(apply()).rejects.toBeInstanceOf(
			CasePropertyRenameStorageConflictError,
		);
		const schema = await db()
			.selectFrom("case_type_schemas")
			.select(["schema", "index_pending_seq"])
			.where("app_id", "=", APP_ID)
			.where("case_type", "=", "patient")
			.executeTakeFirstOrThrow();
		expect(Object.keys(schema.schema.properties as JsonObject)).toContain("a");
		expect(schema.index_pending_seq).toBeNull();
	});

	it.each([
		{
			name: "text into old int",
			sourceType: "text" as const,
			sourceValue: "not-an-int",
			oldDestinationType: "int" as const,
			destinationValue: 4,
			oldSuffix: "int",
			dropped: true,
		},
		{
			name: "fractional decimal into old int",
			sourceType: "decimal" as const,
			sourceValue: 1.5,
			oldDestinationType: "int" as const,
			destinationValue: 4,
			oldSuffix: "int",
			dropped: true,
		},
		{
			name: "int into old decimal",
			sourceType: "int" as const,
			sourceValue: 7,
			oldDestinationType: "decimal" as const,
			destinationValue: 4.5,
			oldSuffix: "num",
			dropped: false,
		},
		{
			name: "int into old int",
			sourceType: "int" as const,
			sourceValue: 7,
			oldDestinationType: "int" as const,
			destinationValue: 4,
			oldSuffix: "int",
			dropped: false,
		},
		{
			name: "decimal into old decimal",
			sourceType: "decimal" as const,
			sourceValue: 7.5,
			oldDestinationType: "decimal" as const,
			destinationValue: 4.5,
			oldSuffix: "num",
			dropped: false,
		},
	])(
		"drops only unsafe cast-bearing destination indexes: $name",
		async (fixture) => {
			const caseStore = store();
			const initial = schemas([
				{
					name: "a",
					label: proseText("A"),
					data_type: fixture.sourceType,
				},
				{
					name: "b",
					label: proseText("B"),
					data_type: fixture.oldDestinationType,
				},
			]);
			await caseStore.applySchemaChange({
				appId: APP_ID,
				caseType: "patient",
				caseTypeSchemas: initial,
				syncedSeq: 0,
			});
			await caseStore.insert({
				appId: APP_ID,
				row: {
					case_id: "case-index-safety",
					case_type: "patient",
					case_name: "Patient",
					properties: {
						a: fixture.sourceValue,
						b: fixture.destinationValue,
					},
				},
			});
			const latest = schemas([
				{
					name: "b",
					label: proseText("A"),
					data_type: fixture.sourceType,
				},
				{
					name: "c",
					label: proseText("B"),
					data_type: fixture.oldDestinationType,
				},
			]);
			const staleIndex = `cases_${indexScopeTag(APP_ID, "patient")}_${propertyIndexTag("b")}_${fixture.oldSuffix}`;
			const { phase, stalePresent } = await db()
				.transaction()
				.execute(async (tx) => {
					const phase = await caseStore.applyCasePropertyRenamePhaseA(tx, {
						appId: APP_ID,
						desiredSeq: 1,
						caseTypeSchemas: latest,
						entries: [
							{ caseType: "patient", from: "a", to: "b" },
							{ caseType: "patient", from: "b", to: "c" },
						],
					});
					const probe = await sql<{ present: boolean }>`
						SELECT to_regclass(${staleIndex}) IS NOT NULL AS present
					`.execute(tx);
					return {
						phase,
						stalePresent: probe.rows[0]?.present ?? false,
					};
				});
			expect(stalePresent).toBe(!fixture.dropped);
			await phase.completeAfterCommit();
		},
	);

	it("a delayed old drop completion preserves a newer recreated schema index", async () => {
		const caseStore = store();
		const initial = schemas([
			{ name: "a", label: proseText("A"), data_type: "text" },
		]);
		await caseStore.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: initial,
			syncedSeq: 1,
		});

		type PrivateDrain = (appId: string, caseType: string) => Promise<void>;
		const privateStore = caseStore as unknown as {
			drainPendingIndexConvergenceForType: PrivateDrain;
		};
		const original =
			privateStore.drainPendingIndexConvergenceForType.bind(caseStore);
		let releaseDrop: (() => void) | undefined;
		const dropPaused = new Promise<void>((resolve) => {
			releaseDrop = resolve;
		});
		let phaseBStarted: (() => void) | undefined;
		const phaseBReached = new Promise<void>((resolve) => {
			phaseBStarted = resolve;
		});
		vi.spyOn(
			privateStore,
			"drainPendingIndexConvergenceForType",
		).mockImplementation(async (appId, caseType) => {
			if (phaseBStarted !== undefined) {
				phaseBStarted?.();
				phaseBStarted = undefined;
				await dropPaused;
			}
			await original(appId, caseType);
		});

		const oldDrop = caseStore.purgeSchemaForMaintenance({
			appId: APP_ID,
			caseType: "patient",
		});
		await phaseBReached;
		const recreated = schemas([
			{ name: "new_value", label: proseText("New"), data_type: "decimal" },
		]);
		await caseStore.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: recreated,
			syncedSeq: 2,
		});
		releaseDrop?.();
		await oldDrop;

		const expected = `cases_${indexScopeTag(APP_ID, "patient")}_${propertyIndexTag("new_value")}_num`;
		const probe = await sql<{ present: boolean }>`
			SELECT to_regclass(${expected}) IS NOT NULL AS present
		`.execute(database.db);
		expect(probe.rows[0]?.present).toBe(true);
	});
});
