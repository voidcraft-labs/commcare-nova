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
//     database + applies migrations (`runCaseStoreMigrations`).
//   - A `vi.mock` of `@/lib/case-store` swaps `withSchemaContext`
//     for a constructor that returns a `PostgresCaseStore` bound
//     to the per-test handle.
//
// The unit-level tests (no testcontainer needed) cover the
// no-op paths: null `caseTypes`, empty `caseTypes`. The integration
// test covers the multi-case-type happy path — every case-type row
// materializes + per-property indexes land — plus the SWALLOW + WARN
// failure contract: a per-type `applySchemaChange` throw is caught,
// logged, and the loop moves on (each type attempted at most ONCE,
// no retry), and the helper never throws. A persistent fault leaves
// that type unsynced; the point-of-use `withSchemaHeal` closes the
// gap on the type's first case-store touch. The `syncedSeq` the
// helper threads into `applySchemaChange` is pinned here too — it
// feeds the monotone `synced_seq` gate so a stale lower-seq
// materialize no-ops against a fresher row.

import type { Kysely } from "kysely";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CaseStore } from "@/lib/case-store";
import { runCaseStoreMigrations } from "@/lib/case-store/migrate";
import {
	indexScopeTag,
	PostgresCaseStore,
} from "@/lib/case-store/postgres/store";
import { HeuristicCaseGenerator } from "@/lib/case-store/sample/heuristic";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import type { Database } from "@/lib/case-store/sql/database";
import type { CaseType, PersistableDoc } from "@/lib/domain";

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
	databaseNamePrefix: "matsync_test_",
});

beforeEach(async () => {
	await runCaseStoreMigrations(dbHandle.db);
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

describe("materializeCaseStoreSchemas — no-op paths", () => {
	it("does not allocate withSchemaContext when caseTypes is null", async () => {
		// Survey-only build — the SA generated no case types. The
		// helper's early return must skip the connection-pool
		// allocation entirely; otherwise a survey-only completion
		// pays the lookup cost for a loop that wouldn't issue any
		// work.
		await materializeCaseStoreSchemas({
			appId: APP_ID,
			blueprint: makeBlueprint(null),
		});
		expect(withSchemaContextMock).not.toHaveBeenCalled();
	});

	it("does not allocate withSchemaContext when caseTypes is empty", async () => {
		// Same shape as `null` but the array is empty — the SA
		// declared a `caseTypes` array but never filled it. The
		// helper treats the two the same way.
		await materializeCaseStoreSchemas({
			appId: APP_ID,
			blueprint: makeBlueprint([]),
		});
		expect(withSchemaContextMock).not.toHaveBeenCalled();
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

		// Per-property expression indexes landed — one per case type
		// (text properties get a `gin_trgm_ops` partial GIN expression
		// index). Index names are fully app-scoped
		// (`cases_<scopeTag>_<propertyTag>_<mode>`, both segments hashed),
		// so each case type's index is enumerated by its OWN
		// `indexScopeTag` prefix; asserting one per case type proves every
		// iteration of the helper's loop ran the Phase B path, not just
		// the first.
		const indexes = await dbHandle.pool.query<{ indexname: string }>(
			`SELECT indexname FROM pg_indexes
			 WHERE tablename = 'cases'
			 AND indexname LIKE 'cases\\_%' ESCAPE '\\'
			 ORDER BY indexname`,
		);
		const indexNames = indexes.rows.map((r) => r.indexname);
		const patientIdx = indexNames.filter((n) =>
			n.startsWith(`cases_${indexScopeTag(APP_ID, "patient")}_`),
		);
		const visitIdx = indexNames.filter((n) =>
			n.startsWith(`cases_${indexScopeTag(APP_ID, "visit")}_`),
		);
		expect(patientIdx).toHaveLength(1);
		expect(visitIdx).toHaveLength(1);
		expect(patientIdx[0]?.endsWith("_fuzzy")).toBe(true);
		expect(visitIdx[0]?.endsWith("_fuzzy")).toBe(true);
	});
});

// ── syncedSeq threading — the monotone gate's input ─────────────────

describe("materializeCaseStoreSchemas — syncedSeq threading", () => {
	it("passes `syncedSeq` through to every applySchemaChange call", async () => {
		const seqs: Array<number | undefined> = [];
		const emptyReport = {
			migrated: 0,
			reshaped: 0,
			retyped: 0,
			parkedIds: [],
			skipped: 0,
			failureReasons: [],
		};
		const applySchemaChangeMock = vi.fn(
			async (args: { syncedSeq?: number }) => {
				seqs.push(args.syncedSeq);
				return emptyReport;
			},
		);
		const unused = vi.fn(() => {
			throw new Error("unused method");
		});
		const fakeStore = {
			query: unused,
			count: unused,
			insert: unused,
			insertWithChildren: unused,
			update: unused,
			close: unused,
			traverse: unused,
			applySchemaChange: applySchemaChangeMock,
			dropSchema: unused,
			unparkValues: unused,
			generateSampleData: unused,
			resetSampleData: unused,
		} satisfies CaseStore;
		withSchemaContextMock.mockImplementationOnce(async () => fakeStore);

		const a: CaseType = {
			name: "a",
			properties: [{ name: "x", label: "X", data_type: "text" }],
		};
		const b: CaseType = {
			name: "b",
			properties: [{ name: "y", label: "Y", data_type: "text" }],
		};

		await materializeCaseStoreSchemas({
			appId: APP_ID,
			blueprint: makeBlueprint([a, b]),
			syncedSeq: 12,
		});

		// Every per-type sync carries the same materialized-blueprint seq.
		expect(seqs).toEqual([12, 12]);
	});

	it("omits `syncedSeq` entirely when the caller supplies none", async () => {
		let observed: { syncedSeq?: number; hasKey?: boolean } = {};
		const emptyReport = {
			migrated: 0,
			reshaped: 0,
			retyped: 0,
			parkedIds: [],
			skipped: 0,
			failureReasons: [],
		};
		const applySchemaChangeMock = vi.fn(
			async (args: { syncedSeq?: number }) => {
				observed = { syncedSeq: args.syncedSeq, hasKey: "syncedSeq" in args };
				return emptyReport;
			},
		);
		const unused = vi.fn(() => {
			throw new Error("unused method");
		});
		const fakeStore = {
			query: unused,
			count: unused,
			insert: unused,
			insertWithChildren: unused,
			update: unused,
			close: unused,
			traverse: unused,
			applySchemaChange: applySchemaChangeMock,
			dropSchema: unused,
			unparkValues: unused,
			generateSampleData: unused,
			resetSampleData: unused,
		} satisfies CaseStore;
		withSchemaContextMock.mockImplementationOnce(async () => fakeStore);

		const a: CaseType = {
			name: "a",
			properties: [{ name: "x", label: "X", data_type: "text" }],
		};

		await materializeCaseStoreSchemas({
			appId: APP_ID,
			blueprint: makeBlueprint([a]),
		});

		// No key at all — the un-versioned plain UPSERT path, not `undefined`.
		expect(observed.hasKey).toBe(false);
	});
});

// ── Fault-class split — swallow transient, RETHROW deterministic ──

describe("materializeCaseStoreSchemas — retry transient, swallow transient, throw deterministic", () => {
	it("RETHROWS a DETERMINISTIC per-type fault (surfaced so a build fails, not celebrates)", async () => {
		// A deterministic fault (no transient `code`) is a real bug — an
		// identifier collision, a `CaseTypeNotInBlueprintError`. It would fail
		// identically on every heal, so it MUST surface (the build finalize
		// routes it through `failRun` → refund) rather than be swallowed and let
		// the build complete-and-charge over a permanently-unusable schema.
		const failureReason = "deterministic identifier collision";
		const emptyReport = {
			migrated: 0,
			reshaped: 0,
			retyped: 0,
			parkedIds: [],
			skipped: 0,
			failureReasons: [],
		};
		const applySchemaChangeMock = vi.fn(async (args: { caseType: string }) => {
			if (args.caseType === "b") {
				// Plain Error, no transient `code` → deterministic → rethrown.
				throw new Error(failureReason);
			}
			return emptyReport;
		});
		const unused = vi.fn(() => {
			throw new Error("unused method");
		});
		const fakeStore = {
			query: unused,
			count: unused,
			insert: unused,
			insertWithChildren: unused,
			update: unused,
			close: unused,
			traverse: unused,
			applySchemaChange: applySchemaChangeMock,
			dropSchema: unused,
			unparkValues: unused,
			generateSampleData: unused,
			resetSampleData: unused,
		} satisfies CaseStore;
		withSchemaContextMock.mockImplementationOnce(async () => fakeStore);

		const a: CaseType = {
			name: "a",
			properties: [{ name: "x", label: "X", data_type: "text" }],
		};
		const b: CaseType = {
			name: "b",
			properties: [{ name: "y", label: "Y", data_type: "text" }],
		};

		// Throws — the deterministic fault on `b` propagates (not swallowed).
		await expect(
			materializeCaseStoreSchemas({
				appId: APP_ID,
				blueprint: makeBlueprint([a, b]),
			}),
		).rejects.toThrow(failureReason);
	});

	it("swallows a TRANSIENT-exhausted per-type failure, moves to the next type, never throws", async () => {
		// A genuinely-transient fault that exhausts the retry budget (a sustained
		// Cloud SQL outage) is swallowed + warned so a build completes rather
		// than fails; the point-of-use `withSchemaHeal` closes the gap on
		// recovery. `b` retries to the budget then the loop moves to `c`.
		const calls: string[] = [];
		const emptyReport = {
			migrated: 0,
			reshaped: 0,
			retyped: 0,
			parkedIds: [],
			skipped: 0,
			failureReasons: [],
		};
		const applySchemaChangeMock = vi.fn(async (args: { caseType: string }) => {
			calls.push(args.caseType);
			if (args.caseType === "b") {
				// Coded ECONNRESET → transient → retried; stays down every attempt.
				throw Object.assign(new Error("sustained outage on b"), {
					code: "ECONNRESET",
				});
			}
			return emptyReport;
		});
		const unused = vi.fn(() => {
			throw new Error("unused method");
		});
		const fakeStore = {
			query: unused,
			count: unused,
			insert: unused,
			insertWithChildren: unused,
			update: unused,
			close: unused,
			traverse: unused,
			applySchemaChange: applySchemaChangeMock,
			dropSchema: unused,
			unparkValues: unused,
			generateSampleData: unused,
			resetSampleData: unused,
		} satisfies CaseStore;
		withSchemaContextMock.mockImplementationOnce(async () => fakeStore);

		const a: CaseType = {
			name: "a",
			properties: [{ name: "x", label: "X", data_type: "text" }],
		};
		const b: CaseType = {
			name: "b",
			properties: [{ name: "y", label: "Y", data_type: "text" }],
		};
		const c: CaseType = {
			name: "c",
			properties: [{ name: "z", label: "Z", data_type: "text" }],
		};

		// Resolves — the transient-exhausted throw on `b` is swallowed.
		await expect(
			materializeCaseStoreSchemas({
				appId: APP_ID,
				blueprint: makeBlueprint([a, b, c]),
			}),
		).resolves.toBeUndefined();

		// `a` once, `b` retried to the budget (3 attempts), then `c` still ran.
		expect(calls.filter((n) => n === "b")).toHaveLength(3);
		expect(calls[calls.length - 1]).toBe("c");
	});

	it("retries a TRANSIENT per-type blip and lands the sync (no gap left for the heal)", async () => {
		// The canonical drain-end failure is a transient Cloud SQL blip. The
		// retry absorbs it so the sync lands rather than leaving a
		// missing/stale row for the point-of-use heal to repair (whose own
		// first attempt could hit the same blip and re-throw on a "completed"
		// build). A coded ECONNRESET on the first attempt, success on the
		// second.
		let attempts = 0;
		const emptyReport = {
			migrated: 0,
			reshaped: 0,
			retyped: 0,
			parkedIds: [],
			skipped: 0,
			failureReasons: [],
		};
		const applySchemaChangeMock = vi.fn(async () => {
			attempts += 1;
			if (attempts === 1) {
				throw Object.assign(new Error("transient postgres blip"), {
					code: "ECONNRESET",
				});
			}
			return emptyReport;
		});
		const unused = vi.fn(() => {
			throw new Error("unused method");
		});
		const fakeStore = {
			query: unused,
			count: unused,
			insert: unused,
			insertWithChildren: unused,
			update: unused,
			close: unused,
			traverse: unused,
			applySchemaChange: applySchemaChangeMock,
			dropSchema: unused,
			unparkValues: unused,
			generateSampleData: unused,
			resetSampleData: unused,
		} satisfies CaseStore;
		withSchemaContextMock.mockImplementationOnce(async () => fakeStore);

		const a: CaseType = {
			name: "a",
			properties: [{ name: "x", label: "X", data_type: "text" }],
		};

		await expect(
			materializeCaseStoreSchemas({
				appId: APP_ID,
				blueprint: makeBlueprint([a]),
			}),
		).resolves.toBeUndefined();
		// One transient failure + one success = two attempts for the one type.
		expect(applySchemaChangeMock).toHaveBeenCalledTimes(2);
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
			properties: [{ name: "name", label: "Name", data_type: "text" }],
		};
		const patientV2: CaseType = {
			name: "patient",
			properties: [
				{ name: "name", label: "Name", data_type: "text" },
				{ name: "village", label: "Village", data_type: "text" },
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
			properties: [{ name: "name", label: "Name", data_type: "text" }],
		};

		// The first save's store fails for `patient` with a TRANSIENT (coded)
		// blip that stays down — swallowed after the retry budget, so the helper
		// still resolves and no row is written.
		const throwingApply = vi.fn(async () => {
			throw Object.assign(new Error("transient outage during first save"), {
				code: "ECONNRESET",
			});
		});
		const unused = vi.fn(() => {
			throw new Error("unused method");
		});
		const throwingStore = {
			query: unused,
			count: unused,
			insert: unused,
			insertWithChildren: unused,
			update: unused,
			close: unused,
			traverse: unused,
			applySchemaChange: throwingApply,
			dropSchema: unused,
			unparkValues: unused,
			generateSampleData: unused,
			resetSampleData: unused,
		} satisfies CaseStore;
		withSchemaContextMock.mockImplementationOnce(async () => throwingStore);

		// First save — resolves despite the throw; the row is still missing.
		await expect(
			materializeCaseStoreSchemas({
				appId: APP_ID,
				blueprint: makeBlueprint([patient]),
				syncedSeq: 4,
			}),
		).resolves.toBeUndefined();
		// Retried to the budget (3 attempts) then swallowed.
		expect(throwingApply).toHaveBeenCalledTimes(3);
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
