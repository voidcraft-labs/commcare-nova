// lib/db/__tests__/materializeCaseStoreSchemas.integration.test.ts
//
// Coverage for the chat-completion materialization step. The
// helper exists to close a gap that the SA's fire-and-forget
// chat-side `saveBlueprint` leaves open: until this call lands,
// `case_type_schemas` carries no row for any case type the SA
// just generated, and downstream awaited operations
// (sample-data populate, form submit, live preview) trip
// `SchemaNotSyncedError`. The integration test pins the closure
// of that gap end-to-end against a real Postgres testcontainer.
//
// The harness mirrors `applyBlueprintChange.integration.test.ts`:
//   - `setupPerTestDatabase` boots a fresh per-test Postgres
//     database + applies atlas migrations.
//   - A `vi.mock` of `@/lib/case-store` swaps `withOwnerContext`
//     for a constructor that returns a `PostgresCaseStore` bound
//     to the per-test handle.
//
// The unit-level tests (no testcontainer needed) cover the
// no-op paths: null `caseTypes`, empty `caseTypes`. The
// integration test covers the multi-case-type happy path —
// every case-type row materializes + per-property indexes land.

import type { Kysely } from "kysely";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresCaseStore } from "@/lib/case-store/postgres/store";
import { HeuristicCaseGenerator } from "@/lib/case-store/sample/heuristic";
import { applyMigrationsViaAtlas } from "@/lib/case-store/sql/__tests__/applyMigrationsViaAtlas";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import type { Database } from "@/lib/case-store/sql/database";
import type { CaseType, PersistableDoc } from "@/lib/domain";

// ── Hoisted spy shells ─────────────────────────────────────────────

const { withOwnerContextMock } = vi.hoisted(() => ({
	withOwnerContextMock: vi.fn(),
}));

vi.mock("@/lib/case-store", async () => {
	// Re-export the rest of the barrel so error classes / type
	// imports keep resolving — the per-test override only swaps
	// `withOwnerContext`. Casting through `unknown` avoids the
	// type-only import signature mismatch for `vi.importActual`.
	const actual = (await vi.importActual("@/lib/case-store")) as Record<
		string,
		unknown
	>;
	return {
		...actual,
		withOwnerContext: withOwnerContextMock,
	};
});

// Import AFTER the mock is registered so the helper's resolution
// of `@/lib/case-store` picks up the spy.
const { materializeCaseStoreSchemas } = await import(
	"../materializeCaseStoreSchemas"
);

// ── Postgres harness ──────────────────────────────────────────────

const dbHandle = setupPerTestDatabase({
	databaseNamePrefix: "matsync_test_",
});

beforeEach(() => {
	applyMigrationsViaAtlas(dbHandle.uri, { stdio: "pipe" });
});

beforeEach(() => {
	withOwnerContextMock.mockReset();
	// Default: route every `withOwnerContext` call to a
	// PostgresCaseStore bound to the per-test handle. Production
	// parity, just bypasses the singleton's Cloud SQL connector.
	withOwnerContextMock.mockImplementation(async (ownerId: string) => {
		return new PostgresCaseStore({
			ownerId,
			db: dbHandle.db as unknown as Kysely<Database>,
			sampleGenerator: new HeuristicCaseGenerator(),
		});
	});
});

// ── Fixture builders ──────────────────────────────────────────────

const APP_ID = "app-mat";
const OWNER_ID = "owner-mat";

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

describe("materializeCaseStoreSchemas — no-op paths", () => {
	it("does not allocate withOwnerContext when caseTypes is null", async () => {
		// Survey-only build — the SA generated no case types. The
		// helper's early return must skip the connection-pool
		// allocation entirely; otherwise a survey-only completion
		// pays the lookup cost for a loop that wouldn't issue any
		// work.
		await materializeCaseStoreSchemas({
			appId: APP_ID,
			userId: OWNER_ID,
			blueprint: makeBlueprint(null),
		});
		expect(withOwnerContextMock).not.toHaveBeenCalled();
	});

	it("does not allocate withOwnerContext when caseTypes is empty", async () => {
		// Same shape as `null` but the array is empty — the SA
		// declared a `caseTypes` array but never filled it. The
		// helper treats the two the same way.
		await materializeCaseStoreSchemas({
			appId: APP_ID,
			userId: OWNER_ID,
			blueprint: makeBlueprint([]),
		});
		expect(withOwnerContextMock).not.toHaveBeenCalled();
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
			properties: [{ name: "name", label: "Name", data_type: "text" }],
		};
		const visit: CaseType = {
			name: "visit",
			properties: [{ name: "notes", label: "Notes", data_type: "text" }],
		};
		const blueprint = makeBlueprint([patient, visit]);

		await materializeCaseStoreSchemas({
			appId: APP_ID,
			userId: OWNER_ID,
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
		expect(schemaRows.rows.map((r) => r.case_type)).toEqual([
			"patient",
			"visit",
		]);

		// Per-property expression indexes landed. The text-typed
		// `name` property materializes `cases_patient_name_fuzzy`
		// (trgm GIN per the per-data-type table in
		// `lib/case-store/CLAUDE.md`); the text-typed `notes`
		// property on `visit` materializes its own
		// `cases_visit_notes_fuzzy`. Index names follow the
		// `cases_<case_type>_<property>_<mode>` convention enforced
		// by the case-store; one assertion per case type proves
		// every iteration of the helper's loop ran the Phase B
		// path, not just the first.
		const indexes = await dbHandle.pool.query<{ indexname: string }>(
			`SELECT indexname FROM pg_indexes
			 WHERE tablename = 'cases'
			 AND indexname LIKE 'cases\\_%' ESCAPE '\\'
			 ORDER BY indexname`,
		);
		const indexNames = indexes.rows.map((r) => r.indexname);
		expect(indexNames).toContain("cases_patient_name_fuzzy");
		expect(indexNames).toContain("cases_visit_notes_fuzzy");
	});
});
