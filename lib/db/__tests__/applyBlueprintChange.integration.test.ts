// lib/db/__tests__/applyBlueprintChange.integration.test.ts
//
// End-to-end integration coverage for the cross-store saga.
// Drives a real Postgres testcontainer (via `setupPerTestDatabase`)
// and a hand-mocked Firestore boundary so the saga's two failure
// paths can be exercised:
//
//   1. Phase 1 (Postgres `applySchemaChange`) succeeds + Phase 2
//      (Firestore commit) succeeds → the prospective blueprint
//      lands and the schema row reflects the new shape.
//   2. Phase 2 fails after Phase 1 succeeded → compensation
//      regenerates the prior schema; the new blueprint is NOT
//      committed.
//
// The harness wires in:
//   - `setupPerTestDatabase` for Postgres (per-test database +
//     atlas migrations applied in a sibling `beforeEach`).
//   - A `vi.mock` of `@/lib/db/apps` returning a controllable
//     `loadApp` / `updateApp` / `updateAppForRun` triple. The
//     saga's `applyBlueprintChange` reads + writes via these.
//   - A `vi.mock` of `@/lib/case-store` overriding
//     `withOwnerContext` to construct a `PostgresCaseStore`
//     against the per-test handle (production parity, just bypasses
//     the production singleton's Cloud SQL connector).
//
// Atlas migration application mirrors the `PostgresCaseStore`
// test pattern (`beforeEach` shells out to atlas with stdio piped
// so per-test output doesn't drown the real test results).

import type { Kysely } from "kysely";
import { v7 as uuidv7 } from "uuid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresCaseStore } from "@/lib/case-store/postgres/store";
import { HeuristicCaseGenerator } from "@/lib/case-store/sample/heuristic";
import { applyMigrationsViaAtlas } from "@/lib/case-store/sql/__tests__/applyMigrationsViaAtlas";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import type { Database } from "@/lib/case-store/sql/database";
import type { AppDoc } from "@/lib/db/types";
import type { BlueprintDoc, CaseType } from "@/lib/domain";

// ── Hoisted spy shells ─────────────────────────────────────────────
//
// `vi.hoisted` lifts these references above the `vi.mock` factories
// so the factories can capture them at module-load time. The same
// references survive across tests for assertion access; each test's
// `beforeEach` resets them.

const { loadAppMock, updateAppMock, updateAppForRunMock } = vi.hoisted(() => {
	return {
		loadAppMock: vi.fn(),
		updateAppMock: vi.fn(),
		updateAppForRunMock: vi.fn(),
	};
});

// `withOwnerContextMock` is patched per-test once the per-test
// database handle is bound — the test body itself can't call
// `vi.hoisted` (Vitest's hoist-time evaluation runs before test
// state exists). We hoist the spy shell here and inject the
// PostgresCaseStore-backed implementation in `beforeEach`.

const { withOwnerContextMock } = vi.hoisted(() => ({
	withOwnerContextMock: vi.fn(),
}));

vi.mock("@/lib/db/apps", () => ({
	loadApp: loadAppMock,
	updateApp: updateAppMock,
	updateAppForRun: updateAppForRunMock,
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

// Import AFTER the mocks are registered so the saga's resolution
// of `@/lib/db/apps` and `@/lib/case-store` picks up the spies.
const { applyBlueprintChange } = await import("../applyBlueprintChange");

// ── Postgres harness ──────────────────────────────────────────────

const dbHandle = setupPerTestDatabase({
	databaseNamePrefix: "saga_test_",
});

beforeEach(() => {
	applyMigrationsViaAtlas(dbHandle.uri, { stdio: "pipe" });
});

beforeEach(() => {
	loadAppMock.mockReset();
	updateAppMock.mockReset();
	updateAppForRunMock.mockReset();
	withOwnerContextMock.mockReset();
	// Default: route every `withOwnerContext` call to a
	// PostgresCaseStore bound to the per-test handle. Tests that
	// need to inject a faulty store override this in their body.
	withOwnerContextMock.mockImplementation(async (ownerId: string) => {
		return new PostgresCaseStore({
			ownerId,
			db: dbHandle.db as unknown as Kysely<Database>,
			sampleGenerator: new HeuristicCaseGenerator(),
		});
	});
});

afterEach(() => {
	vi.clearAllMocks();
});

// ── Fixture builders ──────────────────────────────────────────────

const APP_ID = "app-saga";
const OWNER_ID = "owner-saga";

function makeBlueprint(caseTypes: CaseType[] | null): BlueprintDoc {
	return {
		appId: APP_ID,
		appName: "Saga Test",
		connectType: null,
		caseTypes,
		modules: {},
		forms: {},
		fields: {},
		moduleOrder: [],
		formOrder: {},
		fieldOrder: {},
		fieldParent: {},
	};
}

function makeAppDoc(blueprint: BlueprintDoc): AppDoc {
	// `loadApp` returns the full `AppDoc` shape; the saga reads
	// only `blueprint`. The `AppDoc` schema doesn't expose every
	// denormalized list field as a typed slot, so the cast through
	// `unknown` papers over the test fixture's minimal shape.
	const now = new Date();
	const tsLike = {
		toDate: () => now,
		toMillis: () => now.getTime(),
	};
	const doc = {
		owner: OWNER_ID,
		app_name: blueprint.appName,
		connect_type: null,
		module_count: 0,
		form_count: 0,
		blueprint,
		status: "complete" as const,
		error_type: null,
		deleted_at: null,
		recoverable_until: null,
		run_id: "run-saga",
		created_at: tsLike,
		updated_at: tsLike,
	};
	return doc as unknown as AppDoc;
}

const PATIENT: CaseType = {
	name: "patient",
	properties: [
		{ name: "name", label: "Name", data_type: "text" },
		{ name: "age", label: "Age", data_type: "int" },
	],
};

// ── Cases — additive blueprint mutation ───────────────────────────

describe("applyBlueprintChange — additive mutations", () => {
	it("schema-syncs Postgres + commits Firestore for a property add", async () => {
		// Prior: empty case_types. Prospective: one case type with
		// two properties. The saga should issue one schema-sync-only
		// `applySchemaChange` (Postgres `case_type_schemas` row
		// materializes), then commit the new blueprint to Firestore
		// via `updateApp`.
		const prior = makeBlueprint(null);
		const prospective = makeBlueprint([PATIENT]);
		loadAppMock.mockResolvedValueOnce(makeAppDoc(prior));
		updateAppMock.mockResolvedValueOnce(undefined);

		await applyBlueprintChange({
			appId: APP_ID,
			userId: OWNER_ID,
			prospective,
		});

		// Firestore committed the new blueprint.
		expect(updateAppMock).toHaveBeenCalledTimes(1);
		expect(updateAppMock).toHaveBeenCalledWith(APP_ID, prospective);
		expect(updateAppForRunMock).not.toHaveBeenCalled();

		// Postgres `case_type_schemas` carries the new schema. The
		// existing `PostgresCaseStore` test suite uses `pool.query`
		// for schema-row probes (see
		// `lib/case-store/postgres/__tests__/store.test.ts`); the
		// Kysely typed builder is package-private to the store.
		const schemaRow = await dbHandle.pool.query<{ schema: unknown }>(
			"SELECT schema FROM case_type_schemas WHERE app_id = $1 AND case_type = $2",
			[APP_ID, "patient"],
		);
		expect(schemaRow.rows).toHaveLength(1);
	});

	it("routes through updateAppForRun when runId is supplied", async () => {
		const prior = makeBlueprint(null);
		const prospective = makeBlueprint([PATIENT]);
		loadAppMock.mockResolvedValueOnce(makeAppDoc(prior));
		updateAppForRunMock.mockResolvedValueOnce(undefined);

		await applyBlueprintChange({
			appId: APP_ID,
			userId: OWNER_ID,
			prospective,
			runId: "run-mcp-1",
		});

		expect(updateAppForRunMock).toHaveBeenCalledTimes(1);
		expect(updateAppForRunMock).toHaveBeenCalledWith(
			APP_ID,
			prospective,
			"run-mcp-1",
		);
		expect(updateAppMock).not.toHaveBeenCalled();
	});

	it("skips Postgres entirely for a non-case-type mutation", async () => {
		// The saga's fast path: classifier returns no entries, the
		// saga commits Firestore directly without touching the
		// case store.
		const prior = makeBlueprint([PATIENT]);
		const prospective = makeBlueprint([PATIENT]);
		// Add a non-case-type module mutation; case_types unchanged.
		// The `as` cast skirts the `Uuid` brand on `Module.uuid` —
		// the saga + classifier read `caseTypes` only, so a string
		// uuid is sufficient for this fixture.
		const modUuid = uuidv7() as unknown as import("@/lib/domain").Uuid;
		prospective.modules = {
			[modUuid]: { uuid: modUuid, id: "patients", name: "Patients" },
		};
		loadAppMock.mockResolvedValueOnce(makeAppDoc(prior));
		updateAppMock.mockResolvedValueOnce(undefined);

		await applyBlueprintChange({
			appId: APP_ID,
			userId: OWNER_ID,
			prospective,
		});

		// Firestore committed; case-store factory was never invoked.
		expect(updateAppMock).toHaveBeenCalledTimes(1);
		expect(withOwnerContextMock).not.toHaveBeenCalled();
	});
});

// ── Cases — retype mutation with hint ─────────────────────────────

describe("applyBlueprintChange — retype mutations", () => {
	it("runs schema sync + per-row migration in one transaction with the retype hint", async () => {
		// Bootstrap: seed an initial schema with `age: text`,
		// insert two rows (one castable, one not).
		const initial: CaseType = {
			name: "patient",
			properties: [{ name: "age", label: "Age", data_type: "text" }],
		};
		const initialBlueprint = makeBlueprint([initial]);
		const initialStore = new PostgresCaseStore({
			ownerId: OWNER_ID,
			db: dbHandle.db as unknown as Kysely<Database>,
			sampleGenerator: new HeuristicCaseGenerator(),
		});
		await initialStore.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			blueprint: initialBlueprint,
		});

		const aliceId = uuidv7();
		const bobId = uuidv7();
		await initialStore.insert({
			appId: APP_ID,
			row: {
				case_id: aliceId,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				properties: { age: "30" },
			},
		});
		await initialStore.insert({
			appId: APP_ID,
			row: {
				case_id: bobId,
				case_type: "patient",
				case_name: "Bob",
				status: "open",
				properties: { age: "not-a-number" },
			},
		});

		// Retype `age` from text to int. The saga's hint carries
		// the explicit per-row migration; Postgres runs schema sync
		// + migration in one transaction.
		const retyped: CaseType = {
			name: "patient",
			properties: [{ name: "age", label: "Age", data_type: "int" }],
		};
		const retypedBlueprint = makeBlueprint([retyped]);
		loadAppMock.mockResolvedValueOnce(makeAppDoc(initialBlueprint));
		updateAppMock.mockResolvedValueOnce(undefined);

		await applyBlueprintChange({
			appId: APP_ID,
			userId: OWNER_ID,
			prospective: retypedBlueprint,
			hint: {
				kind: "retype",
				caseType: "patient",
				property: "age",
				fromType: "text",
				toType: "int",
			},
		});

		// Firestore committed.
		expect(updateAppMock).toHaveBeenCalledTimes(1);

		// Alice's row migrated; Bob's row landed in quarantine.
		const aliceRows = await initialStore.query({
			appId: APP_ID,
			caseType: "patient",
		});
		expect(aliceRows).toHaveLength(1);
		expect(aliceRows[0]?.properties).toEqual({ age: 30 });

		// `cases_quarantine` carries Bob's row with the original
		// JSONB value preserved.
		const quarantined = await dbHandle.pool.query(
			"SELECT case_id FROM cases_quarantine WHERE app_id = $1",
			[APP_ID],
		);
		expect(quarantined.rows).toHaveLength(1);
	});
});

// ── Cases — Firestore commit failure + compensation ───────────────

describe("applyBlueprintChange — compensation on Firestore commit failure", () => {
	it("compensates Postgres back to the prior schema when updateApp throws", async () => {
		// Bootstrap: seed an initial schema with one property.
		const initial: CaseType = {
			name: "patient",
			properties: [{ name: "name", label: "Name", data_type: "text" }],
		};
		const initialBlueprint = makeBlueprint([initial]);
		const seedStore = new PostgresCaseStore({
			ownerId: OWNER_ID,
			db: dbHandle.db as unknown as Kysely<Database>,
			sampleGenerator: new HeuristicCaseGenerator(),
		});
		await seedStore.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			blueprint: initialBlueprint,
		});

		// Capture the prior schema so we can compare after
		// compensation runs.
		const priorRows = await dbHandle.pool.query<{ schema: unknown }>(
			"SELECT schema FROM case_type_schemas WHERE app_id = $1 AND case_type = $2",
			[APP_ID, "patient"],
		);
		expect(priorRows.rows).toHaveLength(1);
		const priorSchema = priorRows.rows[0]?.schema;

		// Prospective: extend the case type with a second property.
		const extended: CaseType = {
			name: "patient",
			properties: [
				{ name: "name", label: "Name", data_type: "text" },
				{ name: "age", label: "Age", data_type: "int" },
			],
		};
		const extendedBlueprint = makeBlueprint([extended]);
		loadAppMock.mockResolvedValueOnce(makeAppDoc(initialBlueprint));
		// Firestore commit fails — the saga must compensate.
		const commitErr = new Error("simulated firestore failure");
		updateAppMock.mockRejectedValueOnce(commitErr);

		await expect(
			applyBlueprintChange({
				appId: APP_ID,
				userId: OWNER_ID,
				prospective: extendedBlueprint,
			}),
		).rejects.toThrow("simulated firestore failure");

		// Postgres compensated back to the prior schema.
		const postRows = await dbHandle.pool.query<{ schema: unknown }>(
			"SELECT schema FROM case_type_schemas WHERE app_id = $1 AND case_type = $2",
			[APP_ID, "patient"],
		);
		expect(postRows.rows).toHaveLength(1);
		expect(postRows.rows[0]?.schema).toEqual(priorSchema);
	});
});
