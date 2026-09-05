/** Real schema/index projection, sequence monotonicity, and recovery after a transient gap. */

import type { Kysely } from "kysely";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresCaseStore } from "@/lib/case-store/postgres/store";
import { HeuristicCaseGenerator } from "@/lib/case-store/sample/heuristic";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import type { Database } from "@/lib/case-store/sql/database";
import {
	type CaseType,
	type PersistableDoc,
	USERCASE_CASE_TYPE,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";

// ── Hoisted spy shells ─────────────────────────────────────────────

const { withSchemaContextMock } = vi.hoisted(() => ({
	withSchemaContextMock: vi.fn(),
}));

vi.mock("@/lib/case-store", async () => {
	// Re-export the rest of the barrel so error classes / type
	// imports keep resolving — the per-test override only swaps
	// `withSchemaContext`. Casting through `unknown` avoids the
	// type-only import signature mismatch for `vi.importActual`.
	const actual = (await vi.importActual("@/lib/case-store")) as Record<
		string,
		unknown
	>;
	return {
		...actual,
		withSchemaContext: withSchemaContextMock,
	};
});

// Import AFTER the mock is registered so the helper's resolution
// of `@/lib/case-store` picks up the spy.
const { materializeCaseStoreSchemas } = await import(
	"../materializeCaseStoreSchemas"
);

// ── Postgres harness ──────────────────────────────────────────────

const dbHandle = setupPerTestDatabase({
	schema: "migrated",
	databaseNamePrefix: "matsync_test_",
});

beforeEach(() => {
	withSchemaContextMock.mockReset();
	// Default: route every `withSchemaContext` call to a
	// PostgresCaseStore bound to the per-test handle. Production
	// parity, just bypasses the singleton's Cloud SQL connector.
	withSchemaContextMock.mockImplementation(async () => {
		return new PostgresCaseStore({
			projectId: null,
			actorUserId: null,
			ownerId: null,
			db: dbHandle.db as unknown as Kysely<Database>,
			sampleGenerator: new HeuristicCaseGenerator(),
		});
	});
});

// ── Fixture builders ──────────────────────────────────────────────

const APP_ID = "app-mat";

function makeBlueprint(caseTypes: CaseType[] | null): PersistableDoc {
	return {
		appId: APP_ID,
		appName: "Materialize Test",
		connectType: null,
		caseTypes,
		modules: {},
		forms: {},
		fields: {},
		moduleOrder: [],
		formOrder: {},
		fieldOrder: {},
	};
}

// ── No-op paths — survey-only / empty case_types ─────────────────

describe("materializeCaseStoreSchemas — a survey-only app", () => {
	async function materializedTypes(): Promise<string[]> {
		const rows = await dbHandle.pool.query<{ case_type: string }>(
			"SELECT case_type FROM case_type_schemas WHERE app_id = $1 ORDER BY case_type",
			[APP_ID],
		);
		return rows.rows.map((row) => row.case_type);
	}

	it("still materializes the worker's own case when caseTypes is null", async () => {
		// Survey-only build — the SA declared no case types. The worker's own
		// case is NOT derived from what was declared: HQ gives every worker a
		// usercase whatever the app collects, `#user/<prop>` reads it through a
		// `casedb` join rather than a projection, and a persona exists on an app
		// with no case types at all. So this app has exactly one case type, and
		// it is the one nobody authored.
		await materializeCaseStoreSchemas({
			appId: APP_ID,
			blueprint: makeBlueprint(null),
		});
		expect(withSchemaContextMock).toHaveBeenCalledTimes(1);
		expect(await materializedTypes()).toEqual([USERCASE_CASE_TYPE]);
	});

	it("treats an empty caseTypes array the same as null", async () => {
		// The SA declared the array and never filled it. Both spellings mean
		// the same app, so both must reach the same materialized state.
		await materializeCaseStoreSchemas({
			appId: APP_ID,
			blueprint: makeBlueprint([]),
		});
		expect(withSchemaContextMock).toHaveBeenCalledTimes(1);
		expect(await materializedTypes()).toEqual([USERCASE_CASE_TYPE]);
	});
});

// ── Happy path — multi-case-type completion ───────────────────────

describe("materializeCaseStoreSchemas — multi-case-type completion", () => {
	it("materializes one schema row per case type and emits the matching expression indexes", async () => {
		// Multi-case-type fixture — single-case-type would pass
		// against a regression that fires `applySchemaChange` only
		// for the first case type. Two case types each carry one
		// `text` property whose trgm GIN expression index lands
		// only when the helper's per-case-type loop iterates past
		// the first entry.
		const patient: CaseType = {
			name: "patient",
			properties: [
				{ name: "name", label: proseText("Name"), data_type: "text" },
			],
		};
		const visit: CaseType = {
			name: "visit",
			properties: [
				{ name: "notes", label: proseText("Notes"), data_type: "text" },
			],
		};
		const blueprint = makeBlueprint([patient, visit]);

		await materializeCaseStoreSchemas({
			appId: APP_ID,
			blueprint,
		});

		// `case_type_schemas` carries one row per case type. The
		// existing case-store test suite uses `pool.query` for
		// schema-row probes (the Kysely typed builder is package-
		// private to the store); mirror that pattern.
		const schemaRows = await dbHandle.pool.query<{ case_type: string }>(
			"SELECT case_type FROM case_type_schemas WHERE app_id = $1 ORDER BY case_type",
			[APP_ID],
		);
		// `commcare-user` rides along with every app: HQ gives every worker a
		// usercase whatever the app collects, so it is materialized
		// unconditionally rather than derived from what was declared.
		expect(schemaRows.rows.map((r) => r.case_type)).toEqual([
			"commcare-user",
			"patient",
			"visit",
		]);

		const indexes = await dbHandle.pool.query<{ indexdef: string }>(
			"SELECT indexdef FROM pg_indexes WHERE tablename = 'cases'",
		);
		for (const [caseType, property] of [
			["patient", "name"],
			["visit", "notes"],
		]) {
			const definitions = indexes.rows
				.map(({ indexdef }) => indexdef)
				.filter((definition) => definition.includes(`'${caseType}'::text`));
			expect(definitions).toHaveLength(1);
			expect(definitions[0]).toContain("USING gin");
			expect(definitions[0]).toContain("gin_trgm_ops");
			expect(definitions[0]).toContain(`properties ->> '${property}'::text`);
			expect(definitions[0]).toContain("app_id = 'app-mat'::text");
		}
	});
});

// ── Monotone `synced_seq` gate — a stale lower-seq sync is a full no-op ──

describe("materializeCaseStoreSchemas — monotone synced_seq gate (integration)", () => {
	it("no-ops a stale lower-seq materialize against a fresher row", async () => {
		// First materialize the type at seq 5 (a peer's later state), then a
		// STALE materialize at seq 2 must not rewind the row: the guard reads
		// the recorded `synced_seq` and skips the whole call.
		const patientV1: CaseType = {
			name: "patient",
			properties: [
				{ name: "name", label: proseText("Name"), data_type: "text" },
			],
		};
		const patientV2: CaseType = {
			name: "patient",
			properties: [
				{ name: "name", label: proseText("Name"), data_type: "text" },
				{ name: "village", label: proseText("Village"), data_type: "text" },
			],
		};

		// Fresher sync lands first (seq 5), carrying the two-property schema.
		await materializeCaseStoreSchemas({
			appId: APP_ID,
			blueprint: makeBlueprint([patientV2]),
			syncedSeq: 5,
		});

		// Stale sync (seq 2) with the OLDER one-property schema — must no-op.
		await materializeCaseStoreSchemas({
			appId: APP_ID,
			blueprint: makeBlueprint([patientV1]),
			syncedSeq: 2,
		});

		const row = await dbHandle.pool.query<{
			schema: { properties?: Record<string, unknown> };
			synced_seq: string;
		}>(
			"SELECT schema, synced_seq FROM case_type_schemas WHERE app_id = $1 AND case_type = $2",
			[APP_ID, "patient"],
		);
		// The row still reflects the fresher seq-5 state, not the stale seq-2.
		expect(Number(row.rows[0]?.synced_seq)).toBe(5);
		expect(Object.keys(row.rows[0]?.schema.properties ?? {})).toContain(
			"village",
		);
	});

	it("a swallowed materialize failure self-heals on the next save", async () => {
		// First materialize's per-type sync FAILS (swallowed + warned) and
		// leaves NO `case_type_schemas` row — the exact gap the point-of-use
		// heal / next save must close. A subsequent materialize (the next save,
		// against real Postgres) lands the schema, proving the swallow doesn't
		// widen the gap it exists to close.
		const patient: CaseType = {
			name: "patient",
			properties: [
				{ name: "name", label: proseText("Name"), data_type: "text" },
			],
		};

		// The first save's store fails for `patient` with a TRANSIENT (coded)
		// blip that stays down — swallowed after the retry budget, so the helper
		// still resolves and no row is written.
		const throwingApply = vi.fn(async () => {
			throw Object.assign(new Error("transient outage during first save"), {
				code: "ECONNRESET",
			});
		});
		const throwingStore = {
			drainPendingIndexConvergence: vi.fn(),
			applySchemaChange: throwingApply,
		};
		withSchemaContextMock.mockImplementationOnce(async () => throwingStore);

		// Only this store stub uses fake time; restore the real clock before SQL.
		vi.useFakeTimers();
		try {
			const failedSync = expect(
				materializeCaseStoreSchemas({
					appId: APP_ID,
					blueprint: makeBlueprint([patient]),
					syncedSeq: 4,
				}),
			).resolves.toBeUndefined();
			await vi.runAllTimersAsync();
			await failedSync;
		} finally {
			vi.useRealTimers();
		}
		// Retried to the budget (3 attempts) then swallowed — for `patient` and
		// again for the worker's own case, which this store fails too.
		expect(throwingApply).toHaveBeenCalledTimes(6);
		const missing = await dbHandle.pool.query(
			"SELECT case_type FROM case_type_schemas WHERE app_id = $1 AND case_type = $2",
			[APP_ID, "patient"],
		);
		expect(missing.rows).toHaveLength(0);

		// Next save — the default per-test PostgresCaseStore lands the schema.
		await materializeCaseStoreSchemas({
			appId: APP_ID,
			blueprint: makeBlueprint([patient]),
			syncedSeq: 4,
		});
		const healed = await dbHandle.pool.query<{ synced_seq: string }>(
			"SELECT synced_seq FROM case_type_schemas WHERE app_id = $1 AND case_type = $2",
			[APP_ID, "patient"],
		);
		expect(healed.rows).toHaveLength(1);
		expect(Number(healed.rows[0]?.synced_seq)).toBe(4);
	});
});
