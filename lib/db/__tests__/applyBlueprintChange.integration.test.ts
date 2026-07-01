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
//     migrations applied in a sibling `beforeEach`).
//   - A `vi.mock` of `@/lib/db/apps` returning a controllable
//     `loadApp` / `commitGuardedBatch` pair — the saga's Firestore
//     commit chokepoint. The Postgres phase is REAL; only the
//     Firestore write is mocked.
//   - A `vi.mock` of `@/lib/db/firestore` stubbing `docs.batchDedupRaw`
//     (the saga's non-transactional top-level dedup read) so the saga
//     reaches the Postgres phase without a live Firestore.
//   - A `vi.mock` of `@/lib/case-store` overriding
//     `withSchemaContext` to construct a `PostgresCaseStore`
//     against the per-test handle (production parity, just bypasses
//     the production singleton's Cloud SQL connector).
//
// Migration application mirrors the `PostgresCaseStore` test
// pattern (`beforeEach` runs `runCaseStoreMigrations` — Kysely's
// `Migrator` in process — against the per-test handle).

import type { Kysely } from "kysely";
import { v7 as uuidv7 } from "uuid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCaseTypeMap } from "@/lib/case-store";
import { runCaseStoreMigrations } from "@/lib/case-store/migrate";
import { PostgresCaseStore } from "@/lib/case-store/postgres/store";
import { HeuristicCaseGenerator } from "@/lib/case-store/sample/heuristic";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import type { Database } from "@/lib/case-store/sql/database";
import type { AppDoc } from "@/lib/db/types";
import type { BlueprintDoc, CaseType, PersistableDoc } from "@/lib/domain";

// ── Hoisted spy shells ─────────────────────────────────────────────
//
// `vi.hoisted` lifts these references above the `vi.mock` factories
// so the factories can capture them at module-load time. The same
// references survive across tests for assertion access; each test's
// `beforeEach` resets them.

const {
	loadAppMock,
	loadAppProjectIdMock,
	commitGuardedBatchMock,
	batchDedupRawGetMock,
} = vi.hoisted(() => {
	return {
		loadAppMock: vi.fn(),
		loadAppProjectIdMock: vi.fn(),
		commitGuardedBatchMock: vi.fn(),
		batchDedupRawGetMock: vi.fn(),
	};
});

// `withSchemaContextMock` is patched per-test once the per-test
// database handle is bound — the test body itself can't call
// `vi.hoisted` (Vitest's hoist-time evaluation runs before test
// state exists). We hoist the spy shell here and inject the
// PostgresCaseStore-backed implementation in `beforeEach`.

const { withSchemaContextMock } = vi.hoisted(() => ({
	withSchemaContextMock: vi.fn(),
}));

vi.mock("@/lib/db/apps", () => ({
	loadApp: loadAppMock,
	loadAppProjectId: loadAppProjectIdMock,
	commitGuardedBatch: commitGuardedBatchMock,
}));

// The saga's top-level dedup read is `docs.batchDedupRaw(appId, batchId).get()`
// — a non-transactional Firestore read. Stub just that ref factory so the saga
// proceeds to the Postgres phase without a live Firestore client.
vi.mock("@/lib/db/firestore", () => ({
	docs: {
		batchDedupRaw: () => ({ get: batchDedupRawGetMock }),
	},
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

// Import AFTER the mocks are registered so the saga's resolution
// of `@/lib/db/apps` and `@/lib/case-store` picks up the spies.
const { applyBlueprintChange } = await import("../applyBlueprintChange");

// ── Postgres harness ──────────────────────────────────────────────

const dbHandle = setupPerTestDatabase({
	databaseNamePrefix: "saga_test_",
});

beforeEach(async () => {
	await runCaseStoreMigrations(dbHandle.db);
});

beforeEach(() => {
	loadAppMock.mockReset();
	loadAppProjectIdMock.mockReset();
	commitGuardedBatchMock.mockReset();
	batchDedupRawGetMock.mockReset();
	// A null-project (owner-scoped) app: `reauthorizeActorForCommit(null, …)`
	// is a no-op, so the REAL helper runs without a live auth DB. The saga's
	// reauth-before-DDL gate is unit-pinned in `applyBlueprintChangeGuard.test`.
	loadAppProjectIdMock.mockResolvedValue(null);
	// No prior dedup latch — the saga proceeds to the Postgres phase + commit.
	batchDedupRawGetMock.mockResolvedValue({ exists: false });
	// The Firestore commit succeeds by default. Additive tests that rely on
	// the post-commit sweep override `committedDoc` (the sweep skips a
	// `committedDoc`-undefined result); commit-failure tests reject it.
	commitGuardedBatchMock.mockResolvedValue({
		seq: 1,
		basisToken: "token-1",
		committedDoc: undefined,
		deduped: false,
	});
	withSchemaContextMock.mockReset();
	// Default: route every `withSchemaContext` call to a
	// PostgresCaseStore bound to the per-test handle. Tests that
	// need to inject a faulty store override this in their body.
	withSchemaContextMock.mockImplementation(async () => {
		return new PostgresCaseStore({
			projectId: null,
			actorUserId: null,
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

/** The persisted (stripped) shape — what real callers hand the saga.
 *  `PersistedBlueprint`'s compile-time wall on `prospective` rejects an
 *  in-memory `BlueprintDoc` here, the same way it does in production. */
function makeBlueprint(caseTypes: CaseType[] | null): PersistableDoc {
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
	};
}

/**
 * The `committedDoc` a successful `commitGuardedBatch` returns — the hydrated
 * committed blueprint the post-commit sweep re-derives schemas from. The sweep
 * reads `.caseTypes` only (via `buildCaseTypeMap`), so a `PersistableDoc`
 * widened to `BlueprintDoc` is sufficient for the fixture. An additive test
 * MUST supply this (the sweep skips a `committedDoc`-undefined result).
 */
function committedDocFor(blueprint: PersistableDoc): BlueprintDoc {
	return blueprint as unknown as BlueprintDoc;
}

function makeAppDoc(blueprint: PersistableDoc, mutationSeq = 1): AppDoc {
	// `loadApp` returns the full `AppDoc` shape; the saga reads `blueprint`
	// (prior state) and `compensate` reads `blueprint` + `mutation_seq` (the
	// current committed state, seq-guarded). The `AppDoc` schema doesn't expose
	// every denormalized list field as a typed slot, so the cast through
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
		mutation_seq: mutationSeq,
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
		// via `commitGuardedBatch`.
		const prior = makeBlueprint(null);
		const prospective = makeBlueprint([PATIENT]);
		loadAppMock.mockResolvedValueOnce(makeAppDoc(prior));
		// The additive `patient` addition rides the post-commit sweep, which
		// re-derives its schema from the committed doc.
		commitGuardedBatchMock.mockResolvedValueOnce({
			seq: 4,
			basisToken: "token-1",
			committedDoc: committedDocFor(prospective),
			deduped: false,
		});

		await applyBlueprintChange({
			appId: APP_ID,
			userId: OWNER_ID,
			prospective,
			batchId: "batch-add-1",
			kind: "mcp",
			guard: { mutations: [{ kind: "setAppName", name: "Saga Test" }] },
		});

		// Firestore committed through the unified guarded writer, carrying the
		// caller's batchId + kind + actor. No runId supplied here → omitted.
		expect(commitGuardedBatchMock).toHaveBeenCalledTimes(1);
		const commitArgs = commitGuardedBatchMock.mock.calls[0]?.[0];
		expect(commitArgs).toMatchObject({
			appId: APP_ID,
			batchId: "batch-add-1",
			actorUserId: OWNER_ID,
			kind: "mcp",
		});
		expect("runId" in commitArgs).toBe(false);

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

	it("threads runId through to the guarded writer when supplied", async () => {
		const prior = makeBlueprint(null);
		const prospective = makeBlueprint([PATIENT]);
		loadAppMock.mockResolvedValueOnce(makeAppDoc(prior));
		commitGuardedBatchMock.mockResolvedValueOnce({
			seq: 4,
			basisToken: "token-1",
			committedDoc: committedDocFor(prospective),
			deduped: false,
		});

		await applyBlueprintChange({
			appId: APP_ID,
			userId: OWNER_ID,
			prospective,
			runId: "run-mcp-1",
			batchId: "batch-run-1",
			kind: "mcp",
			guard: { mutations: [{ kind: "setAppName", name: "Saga Test" }] },
		});

		expect(commitGuardedBatchMock).toHaveBeenCalledTimes(1);
		expect(commitGuardedBatchMock.mock.calls[0]?.[0]).toMatchObject({
			appId: APP_ID,
			runId: "run-mcp-1",
			kind: "mcp",
		});
	});

	it("skips loadApp when the caller supplies priorBlueprint", async () => {
		// The auto-save PUT route already loaded the doc for its
		// ownership check; threading the result through as
		// `priorBlueprint` halves the Firestore-read cost on every
		// save. The saga must use the supplied snapshot directly
		// rather than re-reading.
		const prior = makeBlueprint(null);
		const prospective = makeBlueprint([PATIENT]);
		commitGuardedBatchMock.mockResolvedValueOnce({
			seq: 4,
			basisToken: "token-1",
			committedDoc: committedDocFor(prospective),
			deduped: false,
		});

		await applyBlueprintChange({
			appId: APP_ID,
			userId: OWNER_ID,
			prospective,
			priorBlueprint: prior,
			batchId: "batch-prior-1",
			kind: "autosave",
			guard: { mutations: [{ kind: "setAppName", name: "Saga Test" }] },
		});

		// Firestore committed; `loadApp` was NOT called because the
		// caller supplied the prior snapshot. This is the perf
		// invariant the call-site change in
		// `app/api/apps/[id]/route.ts` depends on.
		expect(commitGuardedBatchMock).toHaveBeenCalledTimes(1);
		expect(loadAppMock).not.toHaveBeenCalled();

		// Schema row materialized — proves the caller-supplied prior
		// flowed through the diff correctly (the classifier saw
		// "case-type addition" and emitted a schema-sync entry).
		const schemaRow = await dbHandle.pool.query<{ schema: unknown }>(
			"SELECT schema FROM case_type_schemas WHERE app_id = $1 AND case_type = $2",
			[APP_ID, "patient"],
		);
		expect(schemaRow.rows).toHaveLength(1);
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

		await applyBlueprintChange({
			appId: APP_ID,
			userId: OWNER_ID,
			prospective,
			batchId: "batch-fastpath-1",
			kind: "autosave",
			guard: { mutations: [{ kind: "setAppName", name: "Saga Test" }] },
		});

		// Firestore committed; case-store factory was never invoked.
		expect(commitGuardedBatchMock).toHaveBeenCalledTimes(1);
		expect(withSchemaContextMock).not.toHaveBeenCalled();
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
			projectId: OWNER_ID,
			actorUserId: OWNER_ID,
			db: dbHandle.db as unknown as Kysely<Database>,
			sampleGenerator: new HeuristicCaseGenerator(),
		});
		await initialStore.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(initialBlueprint),
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

		await applyBlueprintChange({
			appId: APP_ID,
			userId: OWNER_ID,
			prospective: retypedBlueprint,
			batchId: "batch-retype-1",
			kind: "mcp",
			guard: { mutations: [{ kind: "setAppName", name: "Saga Test" }] },
			hint: {
				kind: "retype",
				caseType: "patient",
				property: "age",
				fromType: "text",
				toType: "int",
			},
		});

		// Firestore committed.
		expect(commitGuardedBatchMock).toHaveBeenCalledTimes(1);

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

	// Saga-level proof that a retype mutation's schema sync +
	// migration runs atomically: a mid-migration failure leaves no
	// schema row behind. The sibling store-level proof
	// (`PostgresCaseStore — applySchemaChange index DDL > Phase A
	// rolls back atomically on per-row migration failure`) covers
	// the store on its own; this one covers the saga's wrapper so a
	// regression in either layer's failure routing surfaces here.
	it("rolls back the schema row + suppresses the Firestore commit when the retype migration fails mid-Phase-A", async () => {
		// Bootstrap: seed `case_type_schemas[appId, "patient"]` with
		// a `text`-typed `age`. This is the prior state the rollback
		// must preserve.
		const initial: CaseType = {
			name: "patient",
			properties: [{ name: "age", label: "Age", data_type: "text" }],
		};
		const initialBlueprint = makeBlueprint([initial]);
		const seedStore = new PostgresCaseStore({
			projectId: OWNER_ID,
			actorUserId: OWNER_ID,
			db: dbHandle.db as unknown as Kysely<Database>,
			sampleGenerator: new HeuristicCaseGenerator(),
		});
		await seedStore.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(initialBlueprint),
		});

		// Insert one row whose `age` value will fail the cast
		// (`"abc"` → int) so the retype's migration path routes the
		// row through the `cases_quarantine` INSERT — the step we'll
		// sabotage to force a mid-Phase-A failure.
		await seedStore.insert({
			appId: APP_ID,
			row: {
				case_id: uuidv7(),
				case_type: "patient",
				case_name: "uncastable",
				status: "open",
				properties: { age: "abc" },
			},
		});

		// Capture the prior schema so the post-failure assertion can
		// pin the exact bytes the rollback must preserve. Comparing
		// JSONB values via `toEqual` keeps the test honest if the
		// schema generator's output ever changes shape — the prior
		// snapshot is the source of truth, not a hand-rolled literal.
		const priorRows = await dbHandle.pool.query<{ schema: unknown }>(
			"SELECT schema FROM case_type_schemas WHERE app_id = $1 AND case_type = $2",
			[APP_ID, "patient"],
		);
		expect(priorRows.rows).toHaveLength(1);
		const priorSchema = priorRows.rows[0]?.schema;

		// Sabotage: drop `case_indices` so the retype's quarantine
		// path throws mid-flight. `bulkQuarantine` runs INSERT into
		// `cases_quarantine` FIRST, then DELETE from `case_indices` —
		// the dropped table makes the second statement throw, and
		// Phase A's transaction ROLLBACK reverts the in-flight
		// `cases_quarantine` INSERT alongside the schema regen UPSERT.
		// `cases_quarantine` survives so the post-failure assertion
		// can probe it for zero rows; the store-level sibling test
		// (`postgres/__tests__/store.test.ts > Phase A rolls back
		// atomically`) drops `cases_quarantine` instead because it
		// only asserts the schema row's shape.
		await dbHandle.pool.query("DROP TABLE case_indices");

		// Drive the retype through the saga. The mocked Firestore
		// `commitGuardedBatch` would resolve if reached, but the saga
		// short-circuits on the Postgres failure before the commit
		// step runs — the post-failure assertion below verifies that.
		const retyped: CaseType = {
			name: "patient",
			properties: [{ name: "age", label: "Age", data_type: "int" }],
		};
		const retypedBlueprint = makeBlueprint([retyped]);
		loadAppMock.mockResolvedValueOnce(makeAppDoc(initialBlueprint));

		await expect(
			applyBlueprintChange({
				appId: APP_ID,
				userId: OWNER_ID,
				prospective: retypedBlueprint,
				batchId: "batch-rollback-1",
				kind: "mcp",
				guard: { mutations: [{ kind: "setAppName", name: "Saga Test" }] },
				hint: {
					kind: "retype",
					caseType: "patient",
					property: "age",
					fromType: "text",
					toType: "int",
				},
			}),
		).rejects.toThrow();

		// Phase A rollback: `case_type_schemas` carries the prior
		// `text`-typed schema verbatim. The schema regen UPSERT and
		// the failed migration share one transaction; the
		// transaction's rollback returns the row to its pre-call
		// shape.
		const postRows = await dbHandle.pool.query<{ schema: unknown }>(
			"SELECT schema FROM case_type_schemas WHERE app_id = $1 AND case_type = $2",
			[APP_ID, "patient"],
		);
		expect(postRows.rows).toHaveLength(1);
		expect(postRows.rows[0]?.schema).toEqual(priorSchema);

		// `cases_quarantine` carries zero rows for this app. The
		// retype path's `bulkQuarantine` ran the INSERT into
		// `cases_quarantine` BEFORE the DELETE that threw — the
		// rollback reverts the in-flight INSERT alongside the schema
		// regen, so the table reflects its pre-call (empty) state.
		// This is the durability test for the in-transaction
		// guarantee: a non-transactional implementation would have
		// committed the INSERT before the DELETE failed and the
		// quarantine table would carry the orphan row.
		const quarantined = await dbHandle.pool.query(
			"SELECT case_id FROM cases_quarantine WHERE app_id = $1",
			[APP_ID],
		);
		expect(quarantined.rows).toHaveLength(0);

		// Saga-level invariant: the Firestore commit MUST NOT have
		// fired. The saga's contract is "Postgres first, Firestore
		// second"; an `applySchemaChange` failure short-circuits
		// before `commitGuardedBatch` runs. Without this check, a
		// future regression that swallowed the Postgres throw would
		// silently land a Firestore commit pointing at a schema row
		// that doesn't reflect the new blueprint.
		expect(commitGuardedBatchMock).not.toHaveBeenCalled();
	});
});

// ── Cases — Firestore commit failure + compensation ───────────────
//
// Only a MIGRATION-BEARING entry (a `change` hint) runs Postgres-first, so
// only it compensates on a Firestore-commit failure. Additive entries never
// touch Postgres before the commit — they ride the post-commit sweep, which is
// simply skipped when the commit throws — so there is nothing to compensate
// for them (the case-type-addition `dropSchema` arm is gone).

describe("applyBlueprintChange — compensation on Firestore commit failure", () => {
	it("compensates a MIGRATION-BEARING retype back to the prior schema when the guarded commit throws", async () => {
		// Bootstrap: seed an initial schema with a `text`-typed `age`.
		const initial: CaseType = {
			name: "patient",
			properties: [{ name: "age", label: "Age", data_type: "text" }],
		};
		const initialBlueprint = makeBlueprint([initial]);
		const seedStore = new PostgresCaseStore({
			projectId: OWNER_ID,
			actorUserId: OWNER_ID,
			db: dbHandle.db as unknown as Kysely<Database>,
			sampleGenerator: new HeuristicCaseGenerator(),
		});
		await seedStore.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(initialBlueprint),
		});

		// Capture the prior schema so we can compare after compensation runs.
		const priorRows = await dbHandle.pool.query<{ schema: unknown }>(
			"SELECT schema FROM case_type_schemas WHERE app_id = $1 AND case_type = $2",
			[APP_ID, "patient"],
		);
		expect(priorRows.rows).toHaveLength(1);
		const priorSchema = priorRows.rows[0]?.schema;

		// Prospective: retype `age` text → int. The hint makes it
		// migration-bearing, so Phase 1 forward-applies it against Postgres
		// BEFORE the commit.
		const retyped: CaseType = {
			name: "patient",
			properties: [{ name: "age", label: "Age", data_type: "int" }],
		};
		const retypedBlueprint = makeBlueprint([retyped]);
		// The saga's prior read AND compensate's fresh current-state read both
		// resolve to the initial doc (no concurrent peer in this test), so
		// compensate re-derives the prior `text` schema, seq-guarded.
		loadAppMock.mockResolvedValue(makeAppDoc(initialBlueprint));
		// Firestore commit fails — the saga must compensate the retype.
		const commitErr = new Error("simulated firestore failure");
		commitGuardedBatchMock.mockRejectedValueOnce(commitErr);

		await expect(
			applyBlueprintChange({
				appId: APP_ID,
				userId: OWNER_ID,
				prospective: retypedBlueprint,
				batchId: "batch-compensate-1",
				kind: "autosave",
				guard: { mutations: [{ kind: "setAppName", name: "Saga Test" }] },
				hint: {
					kind: "retype",
					caseType: "patient",
					property: "age",
					fromType: "text",
					toType: "int",
				},
			}),
		).rejects.toThrow("simulated firestore failure");

		// Postgres compensated back to the prior `text`-typed schema.
		const postRows = await dbHandle.pool.query<{ schema: unknown }>(
			"SELECT schema FROM case_type_schemas WHERE app_id = $1 AND case_type = $2",
			[APP_ID, "patient"],
		);
		expect(postRows.rows).toHaveLength(1);
		expect(postRows.rows[0]?.schema).toEqual(priorSchema);
	});

	it("touches no Postgres before the commit for an ADDITIVE case-type addition, so a commit failure leaves no orphan row", async () => {
		// Prior: empty case_types — no `patient` exists yet.
		const priorBlueprint = makeBlueprint(null);
		const beforeRows = await dbHandle.pool.query<{ schema: unknown }>(
			"SELECT schema FROM case_type_schemas WHERE app_id = $1 AND case_type = $2",
			[APP_ID, "patient"],
		);
		expect(beforeRows.rows).toHaveLength(0);

		// Prospective: add `patient`. Additive (no hint) → it rides the
		// post-commit sweep, which never runs because the commit throws. No
		// Phase-1 Postgres write happened, so there is nothing to compensate
		// and no orphan row is left behind.
		const added: CaseType = {
			name: "patient",
			properties: [{ name: "name", label: "Name", data_type: "text" }],
		};
		const addedBlueprint = makeBlueprint([added]);
		loadAppMock.mockResolvedValueOnce(makeAppDoc(priorBlueprint));
		const commitErr = new Error("simulated firestore failure");
		commitGuardedBatchMock.mockRejectedValueOnce(commitErr);

		await expect(
			applyBlueprintChange({
				appId: APP_ID,
				userId: OWNER_ID,
				prospective: addedBlueprint,
				batchId: "batch-compensate-2",
				kind: "autosave",
				guard: { mutations: [{ kind: "setAppName", name: "Saga Test" }] },
			}),
		).rejects.toThrow("simulated firestore failure");

		// No schema row was ever written — the additive addition never ran
		// Phase-1 Postgres-first, and the sweep was skipped on the failed
		// commit. The table is exactly as it was.
		const postSchemaRows = await dbHandle.pool.query<{ schema: unknown }>(
			"SELECT schema FROM case_type_schemas WHERE app_id = $1 AND case_type = $2",
			[APP_ID, "patient"],
		);
		expect(postSchemaRows.rows).toHaveLength(0);
		expect(commitGuardedBatchMock).toHaveBeenCalledTimes(1);
	});

	it("preserves a concurrent peer's committed property when a migration compensates on commit failure", async () => {
		// The concurrency bug [C3] guards against: migration M's un-versioned
		// Phase-1 UPSERT overwrites the schema with M's prospective; a peer
		// committed a NEW property to the same type mid-window. If compensate
		// reverted to M's stale PRIOR, the peer's property would be lost. It
		// must instead re-derive from the CURRENT committed doc (which carries
		// the peer's property and NOT M's failed change), seq-guarded.

		// Prior (M's view): `patient` has just `age: text`.
		const priorPatient: CaseType = {
			name: "patient",
			properties: [{ name: "age", label: "Age", data_type: "text" }],
		};
		const priorBlueprint = makeBlueprint([priorPatient]);

		// A peer concurrently committed `phone` → the CURRENT committed state has
		// BOTH `age` and `phone`. Seed Postgres to that state (peer's sweep ran).
		const currentPatient: CaseType = {
			name: "patient",
			properties: [
				{ name: "age", label: "Age", data_type: "text" },
				{ name: "phone", label: "Phone", data_type: "text" },
			],
		};
		const currentBlueprint = makeBlueprint([currentPatient]);
		const seedStore = new PostgresCaseStore({
			projectId: OWNER_ID,
			actorUserId: OWNER_ID,
			db: dbHandle.db as unknown as Kysely<Database>,
			sampleGenerator: new HeuristicCaseGenerator(),
		});
		await seedStore.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(currentBlueprint),
			syncedSeq: 10, // the peer's committed seq
		});

		// M retypes `age` text → int against ITS prior (which lacks `phone`).
		const retypedPatient: CaseType = {
			name: "patient",
			properties: [{ name: "age", label: "Age", data_type: "int" }],
		};
		const retypedBlueprint = makeBlueprint([retypedPatient]);
		// The saga takes M's prior from `priorBlueprint` (below), so it never
		// reads `loadApp` for the prior — the ONLY `loadApp` call is
		// compensate's fresh current-state read, which must return the CURRENT
		// committed doc (with phone) at seq 10.
		loadAppMock.mockResolvedValue(makeAppDoc(currentBlueprint, 10));
		const commitErr = new Error("simulated firestore failure");
		commitGuardedBatchMock.mockRejectedValueOnce(commitErr);

		await expect(
			applyBlueprintChange({
				appId: APP_ID,
				userId: OWNER_ID,
				prospective: retypedBlueprint,
				priorBlueprint,
				batchId: "batch-compensate-peer",
				kind: "autosave",
				guard: { mutations: [{ kind: "setAppName", name: "Saga Test" }] },
				hint: {
					kind: "retype",
					caseType: "patient",
					property: "age",
					fromType: "text",
					toType: "int",
				},
			}),
		).rejects.toThrow("simulated firestore failure");

		// The compensated schema carries the peer's `phone` AND the prior
		// `age` (text — M's int retype was uncommitted), NOT M's stale
		// prior-without-phone. The peer's committed property survived.
		const postRows = await dbHandle.pool.query<{
			schema: { properties?: Record<string, { type?: string }> };
			synced_seq: string;
		}>(
			"SELECT schema, synced_seq FROM case_type_schemas WHERE app_id = $1 AND case_type = $2",
			[APP_ID, "patient"],
		);
		expect(postRows.rows).toHaveLength(1);
		const props = postRows.rows[0]?.schema.properties ?? {};
		expect(Object.keys(props).sort()).toEqual(["age", "phone"]);
		// `age` reverted to text (M's int retype never committed).
		expect(props.age?.type).toBe("string");
		// The compensation recorded the current seq (10), not M's stale seq.
		expect(Number(postRows.rows[0]?.synced_seq)).toBe(10);
	});
});
