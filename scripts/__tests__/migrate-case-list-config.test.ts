// scripts/__tests__/migrate-case-list-config.test.ts
//
// Coverage for the operator-run migration that backfills
// `caseListConfig` onto modules carrying the legacy
// `caseListColumns` / `caseDetailColumns` shape. Tests pin
// three property layers:
//
//   1. Pure migration semantics — `migrateModule` /
//      `migrateBlueprintShape` rewrite shape correctness:
//      legacy → structured, idempotence, mixed-shape merge,
//      filter preservation, schema-parse-of-output.
//
//   2. Runtime safety — `run(...)` against a mocked Firestore
//      surface: status / `deleted_at` filter, malformed-data
//      safe-parse failure path (skip + log + continue), single-doc
//      failure does not abort the batch, `--app-id` surgical
//      retry bypasses the bulk filter, dry-run does not write.
//
//   3. CLI surface — `parseArgs(...)` extracts `dryRun` + `appId`
//      out of `process.argv`-shaped input, rejecting empty
//      `--app-id=` values.
//
// Every migration test routes its rewritten config through
// `caseListConfigSchema.safeParse(...)` via the local
// `expectValidConfig(...)` helper — guards against schema drift
// silently breaking the migration's output.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { caseListConfigSchema, plainColumn } from "@/lib/domain";
import { eq, literal, matchAll, prop } from "@/lib/domain/predicate";

// ── Mock Firestore at module load ────────────────────────────────
//
// `vi.mock` factories run before imports. We hoist a controllable
// `state` object the test bodies populate, plus the spies the
// migration's `db.collection("apps").where(...).get()` chain
// touches. Mirrors the `lib/db/__tests__/runSummary.test.ts`
// pattern — one `vi.mock("../firestore", ...)` factory; the spies
// reset between tests via `beforeEach`.

interface FakeDoc {
	id: string;
	data: Record<string, unknown>;
	updateSpy: ReturnType<typeof vi.fn>;
}

interface FakeCollectionState {
	/** Docs returned by the bulk query. The mock filters them in JS
	 *  to mimic Firestore's server-side `.where(...)` behavior. */
	docs: FakeDoc[];
	/** Records the `(field, op, value)` triples the migration applied
	 *  on the bulk query so tests can assert filter shape. */
	whereCalls: Array<[string, string, unknown]>;
	/** Doc lookups by id — drives the surgical-retry `--app-id` path. */
	docsById: Record<string, FakeDoc | null>;
}

const { state, getDb } = vi.hoisted(() => {
	const fakeState: FakeCollectionState = {
		docs: [],
		whereCalls: [],
		docsById: {},
	};

	const buildSnapshot = (matchedDocs: FakeDoc[]) => ({
		docs: matchedDocs.map((d) => ({
			id: d.id,
			data: () => d.data,
			ref: { id: d.id, update: d.updateSpy },
		})),
	});

	const buildQuery = () => {
		const filters: Array<[string, string, unknown]> = [];
		const query: {
			where: (field: string, op: string, value: unknown) => typeof query;
			get: () => Promise<{
				docs: ReturnType<typeof buildSnapshot>["docs"];
			}>;
		} = {
			where: (field, op, value) => {
				filters.push([field, op, value]);
				fakeState.whereCalls.push([field, op, value]);
				return query;
			},
			get: async () => {
				const matched = fakeState.docs.filter((doc) =>
					filters.every(([field, op, value]) => {
						if (op !== "==") return true;
						return doc.data[field] === value;
					}),
				);
				return buildSnapshot(matched);
			},
		};
		return query;
	};

	const buildCollection = () => ({
		where: (...args: [string, string, unknown]) => {
			const q = buildQuery();
			return q.where(...args);
		},
		get: async () => buildSnapshot(fakeState.docs),
		doc: (id: string) => {
			const found = fakeState.docsById[id];
			return {
				get: async () => {
					if (found) {
						return {
							exists: true,
							id: found.id,
							data: () => found.data,
							ref: { id: found.id, update: found.updateSpy },
						};
					}
					return { exists: false, id, data: () => undefined, ref: null };
				},
			};
		},
	});

	const fakeGetDb = (): { collection: (name: string) => unknown } => ({
		collection: (name: string) => {
			if (name !== "apps") {
				throw new Error(`Unexpected collection: ${name}`);
			}
			return buildCollection();
		},
	});

	return { state: fakeState, getDb: fakeGetDb };
});

vi.mock("@/lib/db/firestore", () => ({
	getDb,
}));

// Silence the migration's own log lines during tests — assertions
// look at counters + spies, not at console output.
vi.mock("@/lib/logger", () => ({
	log: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

// ── Imports under test ────────────────────────────────────────────

import {
	migrateBlueprintShape,
	migrateModule,
	parseArgs,
	run,
} from "../migrate-case-list-config";

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Schema-parse helper — every migration test routes its output
 * through `caseListConfigSchema.safeParse` so future drift on the
 * schema surfaces as a test failure rather than silently breaking
 * the migration's output. Returns the parsed value (the schema's
 * canonical shape) so callers can chain assertions on it.
 */
function expectValidConfig(
	config: unknown,
): import("@/lib/domain").CaseListConfig {
	const parsed = caseListConfigSchema.safeParse(config);
	if (!parsed.success) {
		throw new Error(
			`caseListConfigSchema.safeParse failed: ${parsed.error.message}`,
		);
	}
	return parsed.data;
}

/**
 * Reset the mocked Firestore state between tests. Each test
 * populates `state.docs` / `state.docsById` directly with whatever
 * fixture shape it needs.
 */
function resetState(): void {
	state.docs = [];
	state.whereCalls = [];
	state.docsById = {};
}

// ── Pure migration tests ──────────────────────────────────────────

describe("migrateModule", () => {
	it("rewrites legacy caseListColumns into caseListConfig.columns", () => {
		const mod = {
			uuid: "m1",
			id: "patients",
			name: "Patients",
			caseType: "patient",
			caseListColumns: [{ field: "case_name", header: "Name" }],
		};
		const next = migrateModule(mod);
		expect(next).not.toBeNull();
		expect(next?.caseListColumns).toBeUndefined();
		const config = expectValidConfig(next?.caseListConfig);
		expect(config).toEqual({
			columns: [plainColumn("case_name", "Name")],
			sort: [],
			calculatedColumns: [],
			searchInputs: [],
		});
	});

	it("rewrites legacy caseDetailColumns into caseListConfig.detailColumns", () => {
		const mod = {
			uuid: "m1",
			id: "patients",
			name: "Patients",
			caseType: "patient",
			caseListColumns: [{ field: "case_name", header: "Name" }],
			caseDetailColumns: [
				{ field: "case_name", header: "Full Name" },
				{ field: "age", header: "Age" },
			],
		};
		const next = migrateModule(mod);
		expect(next).not.toBeNull();
		expect(next?.caseDetailColumns).toBeUndefined();
		const config = expectValidConfig(next?.caseListConfig);
		expect(config.detailColumns).toEqual([
			plainColumn("case_name", "Full Name"),
			plainColumn("age", "Age"),
		]);
	});

	it("returns null for a module already on the new shape", () => {
		const mod = {
			uuid: "m1",
			id: "patients",
			name: "Patients",
			caseListConfig: {
				columns: [plainColumn("case_name", "Name")],
				sort: [],
				calculatedColumns: [],
				searchInputs: [],
			},
		};
		expect(migrateModule(mod)).toBeNull();
	});

	it("returns null for a module that never carried legacy column fields", () => {
		// Survey-only module with no case list at all.
		const mod = {
			uuid: "m1",
			id: "survey",
			name: "Survey",
		};
		expect(migrateModule(mod)).toBeNull();
	});

	it("merges legacy fields onto a partially-migrated structured shape", () => {
		// Mixed shape — legacy column array AND a partial
		// `caseListConfig`. The legacy array wins for `columns` (the
		// authoritative pre-migration source); already-authored
		// `sort` / `calculatedColumns` / `searchInputs` survive the
		// rewrite.
		const mod = {
			uuid: "m1",
			id: "patients",
			name: "Patients",
			caseType: "patient",
			caseListColumns: [{ field: "case_name", header: "Name" }],
			caseListConfig: {
				columns: [plainColumn("stale", "Stale")],
				sort: [
					{
						source: { kind: "property" as const, property: "case_name" },
						type: "plain" as const,
						direction: "asc" as const,
					},
				],
				calculatedColumns: [
					{
						id: "today",
						header: "Today",
						expression: { kind: "today" as const },
					},
				],
				searchInputs: [{ name: "q", label: "Q", type: "text" as const }],
			},
		};
		const next = migrateModule(mod);
		expect(next?.caseListColumns).toBeUndefined();
		const config = expectValidConfig(next?.caseListConfig);
		expect(config.columns).toEqual([plainColumn("case_name", "Name")]);
		// Pre-existing structured authoring survives the rewrite.
		expect(config.sort).toHaveLength(1);
		expect(config.calculatedColumns).toHaveLength(1);
		expect(config.searchInputs).toHaveLength(1);
	});

	it("preserves the filter slot when merging stale legacy columns onto a structured config", () => {
		// Regression guard for the silent-filter-wipe bug. A doc
		// with stale legacy columns AND a partially-migrated
		// `caseListConfig` carrying a `filter` (e.g. an active
		// case-list filter) must round-trip the filter intact;
		// dropping it would silently change runtime behavior.
		const filterPredicate = eq(prop("patient", "status"), literal("active"));
		const mod = {
			uuid: "m1",
			id: "patients",
			name: "Patients",
			caseType: "patient",
			caseListColumns: [{ field: "case_name", header: "Name" }],
			caseListConfig: {
				columns: [],
				sort: [],
				calculatedColumns: [],
				searchInputs: [],
				filter: filterPredicate,
			},
		};
		const next = migrateModule(mod);
		const config = expectValidConfig(next?.caseListConfig);
		expect(config.filter).toEqual(filterPredicate);
	});

	it("preserves a match-all filter sentinel when merging stale legacy columns", () => {
		// Symmetric to the predicate-filter case — `match-all` is
		// the canonical "no filter authored, render every row"
		// sentinel and the same preservation contract holds.
		const mod = {
			uuid: "m1",
			id: "patients",
			name: "Patients",
			caseListColumns: [{ field: "case_name", header: "Name" }],
			caseListConfig: {
				columns: [],
				sort: [],
				calculatedColumns: [],
				searchInputs: [],
				filter: matchAll(),
			},
		};
		const next = migrateModule(mod);
		const config = expectValidConfig(next?.caseListConfig);
		expect(config.filter).toEqual(matchAll());
	});
});

describe("migrateBlueprintShape", () => {
	it("returns a count of migrated modules + a rewritten blueprint", () => {
		const blueprint = {
			appName: "Test",
			modules: {
				m1: {
					uuid: "m1",
					id: "patients",
					name: "Patients",
					caseListColumns: [{ field: "case_name", header: "Name" }],
				},
				m2: {
					uuid: "m2",
					id: "survey",
					name: "Survey",
					// Already on the new shape — should not be rewritten.
					caseListConfig: {
						columns: [],
						sort: [],
						calculatedColumns: [],
						searchInputs: [],
					},
				},
			},
		};
		const result = migrateBlueprintShape(blueprint);
		expect(result.migratedModules).toBe(1);
		expect(result.diffs).toHaveLength(1);
		expect(result.diffs[0]).toEqual({
			uuid: "m1",
			fromLegacyList: 1,
			fromLegacyDetail: 0,
		});
		const m1 = result.blueprint.modules?.m1;
		const m2 = result.blueprint.modules?.m2;
		expect(m1?.caseListColumns).toBeUndefined();
		const m1Config = expectValidConfig(m1?.caseListConfig);
		expect(m1Config.columns).toEqual([plainColumn("case_name", "Name")]);
		// m2 was already migrated — same reference, no rewrite.
		expect(m2).toBe(blueprint.modules.m2);
	});

	it("returns the input blueprint unchanged when no modules need migration", () => {
		const blueprint = {
			appName: "Test",
			modules: {
				m1: {
					uuid: "m1",
					id: "survey",
					name: "Survey",
				},
			},
		};
		const result = migrateBlueprintShape(blueprint);
		expect(result.migratedModules).toBe(0);
		expect(result.blueprint).toBe(blueprint);
	});

	it("is idempotent — running twice equals running once", () => {
		const blueprint = {
			appName: "Test",
			modules: {
				m1: {
					uuid: "m1",
					id: "patients",
					name: "Patients",
					caseListColumns: [{ field: "case_name", header: "Name" }],
					caseDetailColumns: [{ field: "age", header: "Age" }],
				},
			},
		};
		const first = migrateBlueprintShape(blueprint);
		const second = migrateBlueprintShape(first.blueprint);
		expect(first.migratedModules).toBe(1);
		expect(second.migratedModules).toBe(0);
		expect(second.blueprint).toBe(first.blueprint);
		// The rewritten output passes the live schema.
		const m1 = first.blueprint.modules?.m1;
		expectValidConfig(m1?.caseListConfig);
	});
});

// ── Runtime safety tests — `run(...)` against mocked Firestore ────

describe("parseArgs", () => {
	it("extracts dryRun + appId out of argv", () => {
		expect(parseArgs(["--dry-run"])).toEqual({
			dryRun: true,
			appId: undefined,
		});
		expect(parseArgs(["--app-id=abc123"])).toEqual({
			dryRun: false,
			appId: "abc123",
		});
		expect(parseArgs(["--app-id=abc123", "--dry-run"])).toEqual({
			dryRun: true,
			appId: "abc123",
		});
		expect(parseArgs([])).toEqual({ dryRun: false, appId: undefined });
	});

	it("rejects an empty --app-id= value", () => {
		expect(() => parseArgs(["--app-id="])).toThrow(
			"--app-id flag requires a non-empty value",
		);
	});
});

describe("run", () => {
	beforeEach(() => {
		resetState();
	});

	/**
	 * Build a fake Firestore doc fixture. `update` is a fresh spy on
	 * each call so per-test assertions don't leak across cases.
	 */
	function makeDoc(id: string, data: Record<string, unknown>): FakeDoc {
		return { id, data, updateSpy: vi.fn().mockResolvedValue(undefined) };
	}

	function legacyBlueprint(modUuid: string) {
		return {
			modules: {
				[modUuid]: {
					uuid: modUuid,
					id: "patients",
					name: "Patients",
					caseListColumns: [{ field: "case_name", header: "Name" }],
				},
			},
		};
	}

	it("filters the apps query on deleted_at == null AND status == complete", async () => {
		state.docs = [
			makeDoc("a1", {
				owner: "u1",
				status: "complete",
				deleted_at: null,
				blueprint: legacyBlueprint("m1"),
			}),
		];
		await run({ dryRun: true });
		expect(state.whereCalls).toEqual([
			["deleted_at", "==", null],
			["status", "==", "complete"],
		]);
	});

	it("skips soft-deleted apps", async () => {
		const liveDoc = makeDoc("a-live", {
			owner: "u1",
			status: "complete",
			deleted_at: null,
			blueprint: legacyBlueprint("m1"),
		});
		const deletedDoc = makeDoc("a-deleted", {
			owner: "u1",
			status: "complete",
			deleted_at: "2026-04-01T00:00:00.000Z",
			blueprint: legacyBlueprint("m2"),
		});
		state.docs = [liveDoc, deletedDoc];
		const summary = await run({ dryRun: false });
		expect(summary.appsTouched).toBe(1);
		expect(liveDoc.updateSpy).toHaveBeenCalledTimes(1);
		expect(deletedDoc.updateSpy).not.toHaveBeenCalled();
	});

	it("skips generating apps", async () => {
		const liveDoc = makeDoc("a-live", {
			owner: "u1",
			status: "complete",
			deleted_at: null,
			blueprint: legacyBlueprint("m1"),
		});
		const generatingDoc = makeDoc("a-generating", {
			owner: "u1",
			status: "generating",
			deleted_at: null,
			blueprint: legacyBlueprint("m2"),
		});
		state.docs = [liveDoc, generatingDoc];
		const summary = await run({ dryRun: false });
		expect(summary.appsTouched).toBe(1);
		expect(liveDoc.updateSpy).toHaveBeenCalledTimes(1);
		expect(generatingDoc.updateSpy).not.toHaveBeenCalled();
	});

	it("does not write under --dry-run", async () => {
		const doc = makeDoc("a1", {
			owner: "u1",
			status: "complete",
			deleted_at: null,
			blueprint: legacyBlueprint("m1"),
		});
		state.docs = [doc];
		const summary = await run({ dryRun: true });
		expect(summary.appsTouched).toBe(1);
		expect(summary.modulesMigrated).toBe(1);
		expect(doc.updateSpy).not.toHaveBeenCalled();
	});

	it("writes under live run + persists the rewritten blueprint", async () => {
		const doc = makeDoc("a1", {
			owner: "u1",
			status: "complete",
			deleted_at: null,
			blueprint: legacyBlueprint("m1"),
		});
		state.docs = [doc];
		const summary = await run({ dryRun: false });
		expect(summary.appsTouched).toBe(1);
		expect(doc.updateSpy).toHaveBeenCalledTimes(1);
		const written = doc.updateSpy.mock.calls[0]?.[0] as {
			blueprint: { modules: Record<string, { caseListConfig?: unknown }> };
		};
		// Pin the persisted output passes the live schema.
		expectValidConfig(written.blueprint.modules.m1.caseListConfig);
	});

	it("safe-parse failure on malformed legacy data skips the doc + logs + continues", async () => {
		// Malformed legacy data: `field: undefined` would round-trip
		// through Firestore's `ignoreUndefinedProperties: true` as a
		// missing required field. The migration must reject before
		// writing.
		const badDoc = makeDoc("a-bad", {
			owner: "u1",
			status: "complete",
			deleted_at: null,
			blueprint: {
				modules: {
					m1: {
						uuid: "m1",
						id: "patients",
						name: "Patients",
						caseListColumns: [{ field: undefined, header: "Stale" }],
					},
				},
			},
		});
		const goodDoc = makeDoc("a-good", {
			owner: "u1",
			status: "complete",
			deleted_at: null,
			blueprint: legacyBlueprint("m2"),
		});
		state.docs = [badDoc, goodDoc];

		const summary = await run({ dryRun: false });
		// The bad doc is skipped (no write) but the good doc still
		// processes — single-doc failure does not abort the batch.
		expect(badDoc.updateSpy).not.toHaveBeenCalled();
		expect(goodDoc.updateSpy).toHaveBeenCalledTimes(1);
		expect(summary.failedCount).toBe(1);
		expect(summary.appsTouched).toBe(1);
	});

	it("a single-app failure does not abort the batch", async () => {
		// Force a write failure on the first doc; assert the second
		// doc still processes and the run reports one failure +
		// one success.
		const failingDoc = makeDoc("a-fail", {
			owner: "u1",
			status: "complete",
			deleted_at: null,
			blueprint: legacyBlueprint("m1"),
		});
		failingDoc.updateSpy.mockRejectedValueOnce(
			new Error("simulated firestore write failure"),
		);
		const goodDoc = makeDoc("a-good", {
			owner: "u1",
			status: "complete",
			deleted_at: null,
			blueprint: legacyBlueprint("m2"),
		});
		state.docs = [failingDoc, goodDoc];

		const summary = await run({ dryRun: false });
		expect(summary.failedCount).toBe(1);
		expect(summary.appsTouched).toBe(1);
		expect(failingDoc.updateSpy).toHaveBeenCalledTimes(1);
		expect(goodDoc.updateSpy).toHaveBeenCalledTimes(1);
	});

	it("--app-id filter targets a single doc + bypasses the bulk filter", async () => {
		// Surgical-retry path: the operator targets one app even when
		// the apps-query filter would have excluded it. We seed a
		// soft-deleted doc into the per-id lookup table — the bulk
		// query would skip it; the surgical-retry path reads it.
		const targetedDoc = makeDoc("a-target", {
			owner: "u1",
			status: "error",
			deleted_at: "2026-04-01T00:00:00.000Z",
			blueprint: legacyBlueprint("m1"),
		});
		state.docsById = { "a-target": targetedDoc };
		// `state.docs` stays empty — confirms the bulk path is not
		// consulted. The operator's intent is read straight off the
		// id, without the apps-query filter.

		const summary = await run({ dryRun: false, appId: "a-target" });
		expect(state.whereCalls).toEqual([]);
		expect(summary.appsTouched).toBe(1);
		expect(targetedDoc.updateSpy).toHaveBeenCalledTimes(1);
	});

	it("--app-id with a missing doc reports zero scanned + no failures", async () => {
		state.docsById = {}; // doc lookup returns `exists: false`
		const summary = await run({ dryRun: true, appId: "missing-id" });
		expect(summary.scanned).toBe(0);
		expect(summary.appsTouched).toBe(0);
		expect(summary.failedCount).toBe(0);
	});
});
