// scripts/__tests__/migrate-case-list-schema-reshape.test.ts
//
// Coverage for the v0+v1 → v2 migration. The test surface validates:
//
//   1. Pure transformation semantics — `migrateAppBlueprint` /
//      `migrateOneModule` pin shape correctness for every arm
//      (v0 → v2, v1 → v2, v2 idempotent skip, no-config silent
//      skip, corrupt → counter signal).
//   2. Per-`searchInput` corrupt-input handling — an `xpath`-less
//      v1 input lacking `property` increments `corruptInputCount`,
//      gets dropped, and the rest of the input list still migrates.
//   3. Header-collision INFO log on the v0 arm — when the same
//      `field` appears in both legacy arrays with different
//      `header` values, the caseList header wins and the migration
//      logs an INFO.
//   4. CLI surface — `parseArgs` extracts dryRun + appId + help out
//      of `process.argv`-shaped input, defaults to dry-run, opts
//      INTO live writes via `--write`, accepts the legacy
//      `--dry-run` no-op flag, and rejects empty `--app-id=` values.
//   5. Runtime safety — `run(...)` against a mocked Firestore
//      surface: status / `deleted_at` filter, dry-run no-write,
//      `--app-id` surgical retry bypass, corrupt-module isolation
//      logs WARN + bumps failedCount without taking the throw lane.
//
// Every transformation test routes its rewritten config through
// `caseListConfigSchema.safeParse(...)` via the local
// `expectValidConfig(...)` helper — guards against schema drift
// silently breaking the migration's output.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	advancedSearchInputDef,
	asUuid,
	calculatedColumn,
	caseListConfigSchema,
	idMappingEntry,
	plainColumn,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	eq,
	literal,
	matchAll,
	prop,
	term,
	today,
} from "@/lib/domain/predicate";

// ── Mock Firestore at module load ────────────────────────────────
//
// `vi.mock` factories run before imports. We hoist a controllable
// `state` object the test bodies populate, plus the spies the
// migration's `db.collection("apps").where(...).get()` chain
// touches. Mirrors the sibling `migrate-event-source.test.ts`
// pattern.

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
	 *  on the bulk query so tests can assert the filter shape. */
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
			ref: { update: d.updateSpy },
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
							ref: { update: found.updateSpy },
						};
					}
					return {
						exists: false,
						id,
						data: () => undefined,
						ref: { update: async () => undefined },
					};
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

// Capture the migration's log lines via a shared spy table — every
// test asserts on `mockLogger.info / warn / error` directly. Avoids
// the brittle "matches console output" pattern.
const { mockLogger } = vi.hoisted(() => ({
	mockLogger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		critical: vi.fn(),
	},
}));

vi.mock("@/lib/logger", () => ({
	log: mockLogger,
}));

// ── Imports under test ────────────────────────────────────────────

import {
	type MigrateOptions,
	migrateAppBlueprint,
	migrateOneModule,
	parseArgs,
	run,
} from "../migrate-case-list-schema-reshape";

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Schema-parse helper — every transformation test routes its output
 * through `caseListConfigSchema.safeParse` so future drift on the v2
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
 * Reset state between tests — Firestore mock + logger spies +
 * deterministic `crypto.randomUUID()` counter.
 */
function resetState(): void {
	state.docs = [];
	state.whereCalls = [];
	state.docsById = {};
	mockLogger.info.mockReset();
	mockLogger.warn.mockReset();
	mockLogger.error.mockReset();
	mockLogger.critical.mockReset();
}

/**
 * Build a fake Firestore doc fixture. `update` is a fresh spy on
 * each call so per-test assertions don't leak across cases.
 */
function makeDoc(id: string, data: Record<string, unknown>): FakeDoc {
	return { id, data, updateSpy: vi.fn().mockResolvedValue(undefined) };
}

const dryRunOpts: MigrateOptions = {
	dryRun: true,
	appId: undefined,
	help: false,
};
const liveOpts: MigrateOptions = {
	dryRun: false,
	appId: undefined,
	help: false,
};

// ── v0 → v2 transformation ────────────────────────────────────────

describe("migrateOneModule — v0 → v2", () => {
	beforeEach(resetState);

	it("converts caseListColumns into v2 plain columns with visibility flags", () => {
		const mod = {
			uuid: "m1",
			id: "patients",
			name: "Patients",
			caseListColumns: [
				{ field: "case_name", header: "Name" },
				{ field: "age", header: "Age" },
			],
		};
		const result = migrateOneModule(mod, { appId: "a1", moduleUuid: "m1" });
		expect(result.version).toBe("v0");

		const config = expectValidConfig(result.nextConfig);
		expect(config.columns).toHaveLength(2);
		// caseList-only entries get `visibleInList: true` and
		// `visibleInDetail: false` (the legacy detail array carries
		// neither).
		expect(config.columns[0]).toMatchObject({
			kind: "plain",
			field: "case_name",
			header: "Name",
			visibleInList: true,
			visibleInDetail: false,
		});
		expect(config.columns[1]).toMatchObject({
			kind: "plain",
			field: "age",
			header: "Age",
			visibleInList: true,
			visibleInDetail: false,
		});
		expect(config.searchInputs).toEqual([]);
		expect(config.filter).toBeUndefined();
	});

	it("merges caseListColumns + caseDetailColumns into a unified column array with per-column visibility", () => {
		const mod = {
			uuid: "m1",
			id: "patients",
			name: "Patients",
			caseListColumns: [
				{ field: "case_name", header: "Name" },
				{ field: "age", header: "Age" },
			],
			caseDetailColumns: [
				{ field: "case_name", header: "Name" },
				{ field: "phone", header: "Phone" },
			],
		};
		const result = migrateOneModule(mod, { appId: "a1", moduleUuid: "m1" });
		const config = expectValidConfig(result.nextConfig);
		expect(config.columns).toHaveLength(3);
		// `case_name` in both → list+detail visible.
		expect(config.columns[0]).toMatchObject({
			field: "case_name",
			visibleInList: true,
			visibleInDetail: true,
		});
		// `age` only in caseList → list visible, detail hidden.
		expect(config.columns[1]).toMatchObject({
			field: "age",
			visibleInList: true,
			visibleInDetail: false,
		});
		// `phone` only in detail → list hidden, detail visible.
		expect(config.columns[2]).toMatchObject({
			field: "phone",
			visibleInList: false,
			visibleInDetail: true,
		});
	});

	it("logs INFO on header collision and the caseList header wins", () => {
		const mod = {
			uuid: "m1",
			id: "patients",
			name: "Patients",
			caseListColumns: [{ field: "case_name", header: "Name" }],
			caseDetailColumns: [{ field: "case_name", header: "Full Name" }],
		};
		const result = migrateOneModule(mod, { appId: "a1", moduleUuid: "m1" });
		const config = expectValidConfig(result.nextConfig);
		expect(config.columns[0]).toMatchObject({
			field: "case_name",
			header: "Name", // caseList header wins
			visibleInList: true,
			visibleInDetail: true,
		});
		// One INFO call mentioning the dropped detail header + the
		// kept caseList header.
		const infoMessages = mockLogger.info.mock.calls.map((c) => c[0] as string);
		const collisionLogs = infoMessages.filter((m) =>
			m.includes("header collision"),
		);
		expect(collisionLogs).toHaveLength(1);
		expect(collisionLogs[0]).toContain("case_name");
		expect(collisionLogs[0]).toContain('"Name"');
		expect(collisionLogs[0]).toContain('"Full Name"');
	});

	it("preserves order: caseList entries first, then detail-only entries", () => {
		const mod = {
			uuid: "m1",
			id: "patients",
			name: "Patients",
			caseListColumns: [
				{ field: "b_field", header: "B" },
				{ field: "a_field", header: "A" },
			],
			caseDetailColumns: [
				{ field: "z_field", header: "Z" },
				{ field: "a_field", header: "A" },
			],
		};
		const result = migrateOneModule(mod, { appId: "a1", moduleUuid: "m1" });
		const config = expectValidConfig(result.nextConfig);
		// Order: caseList entries in order (b, a) then detail-only (z).
		expect(
			config.columns.map((c) => ("field" in c ? c.field : "<calc>")),
		).toEqual(["b_field", "a_field", "z_field"]);
	});

	it("ignores legacy rows with non-string field or header (downstream OUTPUT validation rejects them)", () => {
		// Firestore's `ignoreUndefinedProperties: true` round-trip can
		// preserve `field: undefined` shapes that the v2 schema would
		// reject. The migration drops these defensively so the v2
		// output is structurally valid.
		const mod = {
			uuid: "m1",
			id: "patients",
			name: "Patients",
			caseListColumns: [
				{ field: "case_name", header: "Name" },
				{ field: undefined, header: "Bad" },
				{ field: "age" },
			],
		};
		const result = migrateOneModule(mod, { appId: "a1", moduleUuid: "m1" });
		const config = expectValidConfig(result.nextConfig);
		expect(config.columns).toHaveLength(1);
		expect(config.columns[0]).toMatchObject({ field: "case_name" });
	});
});

// ── v1 → v2 transformation ────────────────────────────────────────

describe("migrateOneModule — v1 → v2", () => {
	beforeEach(resetState);

	it("converts plain columns with fresh uuids", () => {
		const mod = {
			uuid: "m1",
			id: "patients",
			name: "Patients",
			caseListConfig: {
				columns: [{ kind: "plain", field: "case_name", header: "Name" }],
				sort: [],
				calculatedColumns: [],
				searchInputs: [],
			},
		};
		const result = migrateOneModule(mod, { appId: "a1", moduleUuid: "m1" });
		expect(result.version).toBe("v1");
		const config = expectValidConfig(result.nextConfig);
		expect(config.columns).toHaveLength(1);
		expect(config.columns[0]).toMatchObject({
			kind: "plain",
			field: "case_name",
			header: "Name",
		});
		expect(config.columns[0].uuid).toMatch(/^[0-9a-f-]{36}$/i);
	});

	it("converts search-only column to plain + visibleInList: false", () => {
		const mod = {
			uuid: "m1",
			id: "patients",
			name: "Patients",
			caseListConfig: {
				columns: [{ kind: "search-only", field: "phone", header: "Phone" }],
				sort: [],
				calculatedColumns: [],
				searchInputs: [],
			},
		};
		const result = migrateOneModule(mod, { appId: "a1", moduleUuid: "m1" });
		const config = expectValidConfig(result.nextConfig);
		expect(config.columns[0]).toMatchObject({
			kind: "plain",
			field: "phone",
			header: "Phone",
			visibleInList: false,
		});
	});

	it("converts time-since-until → interval with display: 'always'", () => {
		const mod = {
			uuid: "m1",
			id: "patients",
			name: "Patients",
			caseListConfig: {
				columns: [
					{
						kind: "time-since-until",
						field: "last_visit",
						header: "Last visit",
						threshold: 30,
						unit: "days",
						displayLabel: "overdue",
					},
				],
				sort: [],
				calculatedColumns: [],
				searchInputs: [],
			},
		};
		const result = migrateOneModule(mod, { appId: "a1", moduleUuid: "m1" });
		const config = expectValidConfig(result.nextConfig);
		expect(config.columns[0]).toMatchObject({
			kind: "interval",
			field: "last_visit",
			header: "Last visit",
			threshold: 30,
			unit: "days",
			display: "always",
			text: "overdue",
		});
	});

	it("converts late-flag → interval with display: 'flag'", () => {
		const mod = {
			uuid: "m1",
			id: "patients",
			name: "Patients",
			caseListConfig: {
				columns: [
					{
						kind: "late-flag",
						field: "follow_up",
						header: "Status",
						threshold: 7,
						unit: "days",
						flagDisplayValue: "needs attention",
					},
				],
				sort: [],
				calculatedColumns: [],
				searchInputs: [],
			},
		};
		const result = migrateOneModule(mod, { appId: "a1", moduleUuid: "m1" });
		const config = expectValidConfig(result.nextConfig);
		expect(config.columns[0]).toMatchObject({
			kind: "interval",
			field: "follow_up",
			header: "Status",
			threshold: 7,
			unit: "days",
			display: "flag",
			text: "needs attention",
		});
	});

	it("appends calculated columns with prior id as new uuid", () => {
		const mod = {
			uuid: "m1",
			id: "patients",
			name: "Patients",
			caseListConfig: {
				columns: [{ kind: "plain", field: "case_name", header: "Name" }],
				sort: [],
				calculatedColumns: [
					{
						id: "calc_today",
						header: "Today",
						expression: today(),
					},
				],
				searchInputs: [],
			},
		};
		const result = migrateOneModule(mod, { appId: "a1", moduleUuid: "m1" });
		const config = expectValidConfig(result.nextConfig);
		expect(config.columns).toHaveLength(2);
		expect(config.columns[1]).toMatchObject({
			kind: "calculated",
			header: "Today",
		});
		expect(config.columns[1].uuid).toBe("calc_today");
	});

	it("mints a fresh uuid when calc column has empty id (v2 uuid rejects empty)", () => {
		const mod = {
			uuid: "m1",
			id: "patients",
			name: "Patients",
			caseListConfig: {
				columns: [],
				sort: [],
				calculatedColumns: [{ id: "", header: "Today", expression: today() }],
				searchInputs: [],
			},
		};
		const result = migrateOneModule(mod, { appId: "a1", moduleUuid: "m1" });
		const config = expectValidConfig(result.nextConfig);
		expect(config.columns).toHaveLength(1);
		expect(config.columns[0].uuid).toMatch(/^[0-9a-f-]{36}$/i);
	});

	it("distributes property sort onto matching columns by field with priority assigned by sort-array index", () => {
		const mod = {
			uuid: "m1",
			id: "patients",
			name: "Patients",
			caseListConfig: {
				columns: [
					{ kind: "plain", field: "case_name", header: "Name" },
					{ kind: "plain", field: "age", header: "Age" },
				],
				sort: [
					{
						source: { kind: "property", property: "age" },
						type: "integer",
						direction: "desc",
					},
					{
						source: { kind: "property", property: "case_name" },
						type: "plain",
						direction: "asc",
					},
				],
				calculatedColumns: [],
				searchInputs: [],
			},
		};
		const result = migrateOneModule(mod, { appId: "a1", moduleUuid: "m1" });
		const config = expectValidConfig(result.nextConfig);
		// `age` is the primary sort (priority 0) per sort-array index;
		// `case_name` is priority 1.
		const ageCol = config.columns.find(
			(c) => "field" in c && c.field === "age",
		);
		const nameCol = config.columns.find(
			(c) => "field" in c && c.field === "case_name",
		);
		expect(ageCol?.sort).toEqual({ direction: "desc", priority: 0 });
		expect(nameCol?.sort).toEqual({ direction: "asc", priority: 1 });
	});

	it("distributes calculated sort onto the matching calc column by columnId", () => {
		const mod = {
			uuid: "m1",
			id: "patients",
			name: "Patients",
			caseListConfig: {
				columns: [],
				sort: [
					{
						source: { kind: "calculated", columnId: "calc_today" },
						type: "date",
						direction: "asc",
					},
				],
				calculatedColumns: [
					{ id: "calc_today", header: "Today", expression: today() },
				],
				searchInputs: [],
			},
		};
		const result = migrateOneModule(mod, { appId: "a1", moduleUuid: "m1" });
		const config = expectValidConfig(result.nextConfig);
		const calcCol = config.columns.find((c) => c.kind === "calculated");
		expect(calcCol?.sort).toEqual({ direction: "asc", priority: 0 });
	});

	it("drops sort directives that don't resolve to any column", () => {
		const mod = {
			uuid: "m1",
			id: "patients",
			name: "Patients",
			caseListConfig: {
				columns: [{ kind: "plain", field: "case_name", header: "Name" }],
				sort: [
					{
						source: { kind: "property", property: "missing_field" },
						type: "plain",
						direction: "asc",
					},
				],
				calculatedColumns: [],
				searchInputs: [],
			},
		};
		const result = migrateOneModule(mod, { appId: "a1", moduleUuid: "m1" });
		const config = expectValidConfig(result.nextConfig);
		// The sort directive is dropped — the column has no `sort` slot.
		expect(config.columns[0].sort).toBeUndefined();
	});

	it("distributes detailColumns visibility — non-detail columns get visibleInDetail: false; detail-only columns join with visibleInList: false", () => {
		const mod = {
			uuid: "m1",
			id: "patients",
			name: "Patients",
			caseListConfig: {
				columns: [
					{ kind: "plain", field: "case_name", header: "Name" },
					{ kind: "plain", field: "age", header: "Age" },
				],
				sort: [],
				calculatedColumns: [],
				searchInputs: [],
				detailColumns: [
					{ kind: "plain", field: "case_name", header: "Name" },
					{ kind: "plain", field: "phone", header: "Phone" },
				],
			},
		};
		const result = migrateOneModule(mod, { appId: "a1", moduleUuid: "m1" });
		const config = expectValidConfig(result.nextConfig);
		expect(config.columns).toHaveLength(3);
		const nameCol = config.columns.find(
			(c) => "field" in c && c.field === "case_name",
		);
		const ageCol = config.columns.find(
			(c) => "field" in c && c.field === "age",
		);
		const phoneCol = config.columns.find(
			(c) => "field" in c && c.field === "phone",
		);
		// `case_name` is in detail → visibleInDetail: true.
		expect(nameCol?.visibleInDetail).toBe(true);
		// `age` is NOT in detail → visibleInDetail: false.
		expect(ageCol?.visibleInDetail).toBe(false);
		// `phone` is detail-only → visibleInList: false, visibleInDetail unset (defaults to true at wire).
		expect(phoneCol?.visibleInList).toBe(false);
	});

	it("converts xpath-bearing search input to advanced arm with predicate", () => {
		const xp = eq(prop("patient", "status"), literal("active"));
		const mod = {
			uuid: "m1",
			id: "patients",
			name: "Patients",
			caseListConfig: {
				columns: [],
				sort: [],
				calculatedColumns: [],
				searchInputs: [
					{
						name: "active_only",
						label: "Active only",
						type: "text",
						xpath: xp,
					},
				],
			},
		};
		const result = migrateOneModule(mod, { appId: "a1", moduleUuid: "m1" });
		const config = expectValidConfig(result.nextConfig);
		expect(config.searchInputs).toHaveLength(1);
		expect(config.searchInputs[0]).toMatchObject({
			kind: "advanced",
			name: "active_only",
			label: "Active only",
			type: "text",
			predicate: xp,
		});
		// `property`, `mode`, `via` are not on the advanced arm.
		expect("property" in config.searchInputs[0]).toBe(false);
	});

	it("converts xpath-less search input with property to simple arm", () => {
		const mod = {
			uuid: "m1",
			id: "patients",
			name: "Patients",
			caseListConfig: {
				columns: [],
				sort: [],
				calculatedColumns: [],
				searchInputs: [
					{
						name: "name_search",
						label: "Name",
						type: "text",
						property: "case_name",
						mode: { kind: "exact" },
					},
				],
			},
		};
		const result = migrateOneModule(mod, { appId: "a1", moduleUuid: "m1" });
		const config = expectValidConfig(result.nextConfig);
		expect(config.searchInputs[0]).toMatchObject({
			kind: "simple",
			name: "name_search",
			property: "case_name",
		});
	});

	it("drops search input lacking xpath AND property; bumps corruptInputCount; doc still migrates", () => {
		const mod = {
			uuid: "m1",
			id: "patients",
			name: "Patients",
			caseListConfig: {
				columns: [],
				sort: [],
				calculatedColumns: [],
				searchInputs: [
					// Corrupt: no xpath, no property.
					{ name: "broken", label: "Broken", type: "text" },
					// Valid simple input — survives.
					{
						name: "name_search",
						label: "Name",
						type: "text",
						property: "case_name",
					},
				],
			},
		};
		const result = migrateOneModule(mod, { appId: "a1", moduleUuid: "m1" });
		const config = expectValidConfig(result.nextConfig);
		expect(result.counters.corruptInputCount).toBe(1);
		// Bad input dropped; good input survives.
		expect(config.searchInputs).toHaveLength(1);
		expect(config.searchInputs[0]).toMatchObject({
			kind: "simple",
			name: "name_search",
			property: "case_name",
		});
		// WARN logged with the corrupt input's name + module uuid.
		const warnMessages = mockLogger.warn.mock.calls.map((c) => c[0] as string);
		expect(warnMessages.some((m) => m.includes("broken"))).toBe(true);
		expect(warnMessages.some((m) => m.includes("m1"))).toBe(true);
	});

	it("preserves the filter slot verbatim", () => {
		const filter = eq(prop("patient", "status"), literal("active"));
		const mod = {
			uuid: "m1",
			id: "patients",
			name: "Patients",
			caseListConfig: {
				columns: [],
				sort: [],
				calculatedColumns: [],
				searchInputs: [],
				filter,
			},
		};
		const result = migrateOneModule(mod, { appId: "a1", moduleUuid: "m1" });
		const config = expectValidConfig(result.nextConfig);
		expect(config.filter).toEqual(filter);
	});

	it("preserves a match-all filter sentinel verbatim", () => {
		const mod = {
			uuid: "m1",
			id: "patients",
			name: "Patients",
			caseListConfig: {
				columns: [],
				sort: [],
				calculatedColumns: [],
				searchInputs: [],
				filter: matchAll(),
			},
		};
		const result = migrateOneModule(mod, { appId: "a1", moduleUuid: "m1" });
		const config = expectValidConfig(result.nextConfig);
		expect(config.filter).toEqual(matchAll());
	});

	it("preserves search input default expression", () => {
		const mod = {
			uuid: "m1",
			id: "patients",
			name: "Patients",
			caseListConfig: {
				columns: [],
				sort: [],
				calculatedColumns: [],
				searchInputs: [
					{
						name: "since_when",
						label: "Since",
						type: "date",
						property: "last_visit",
						default: today(),
					},
				],
			},
		};
		const result = migrateOneModule(mod, { appId: "a1", moduleUuid: "m1" });
		const config = expectValidConfig(result.nextConfig);
		const input = config.searchInputs[0];
		expect(input.kind).toBe("simple");
		expect(input.default).toEqual(today());
	});
});

// ── Idempotency: v2 already-migrated docs ────────────────────────

describe("migrateOneModule — v2-skipped (idempotency)", () => {
	beforeEach(resetState);

	it("skips a module already on the v2 shape", () => {
		const mod = {
			uuid: "m1",
			id: "patients",
			name: "Patients",
			caseListConfig: {
				columns: [
					plainColumn(
						asUuid("11111111-1111-1111-1111-111111111111"),
						"case_name",
						"Name",
					),
				],
				searchInputs: [],
			},
		};
		const result = migrateOneModule(mod, { appId: "a1", moduleUuid: "m1" });
		expect(result.version).toBe("v2-skipped");
		expect(result.nextConfig).toBeUndefined();
	});

	it("skips a survey-only module with no caseListConfig", () => {
		const mod = { uuid: "m1", id: "survey", name: "Survey" };
		const result = migrateOneModule(mod, { appId: "a1", moduleUuid: "m1" });
		expect(result.version).toBe("no-config");
		expect(result.nextConfig).toBeUndefined();
	});

	it("survives a v2 doc that round-trips through Firestore + parse", () => {
		// Construct a real v2 config via the canonical builders, then
		// run it through the migration. Round-trips through
		// `migrateAppBlueprint` should leave the modules intact.
		const blueprint = {
			modules: {
				m1: {
					uuid: "m1",
					id: "patients",
					name: "Patients",
					caseListConfig: {
						columns: [
							plainColumn(
								asUuid("11111111-1111-1111-1111-111111111111"),
								"case_name",
								"Name",
								{
									sort: { direction: "asc", priority: 0 },
									visibleInList: true,
								},
							),
							calculatedColumn(
								asUuid("22222222-2222-2222-2222-222222222222"),
								"Today",
								today(),
							),
						],
						filter: matchAll(),
						searchInputs: [
							simpleSearchInputDef(
								asUuid("33333333-3333-3333-3333-333333333333"),
								"name_search",
								"Name",
								"text",
								"case_name",
							),
							advancedSearchInputDef(
								asUuid("44444444-4444-4444-4444-444444444444"),
								"adv",
								"Adv",
								"text",
								matchAll(),
							),
						],
					},
				},
			},
		};
		const result = migrateAppBlueprint(blueprint, "a1");
		expect(result.migratedModules).toBe(0);
		expect(result.diffs).toEqual([{ uuid: "m1", version: "v2-skipped" }]);
	});
});

// ── Corrupt module — surfaced via counter, not throw ─────────────

describe("migrateOneModule — corrupt", () => {
	beforeEach(resetState);

	it("classifies an unrecognized caseListConfig shape as corrupt", () => {
		const mod = {
			uuid: "m1",
			id: "patients",
			name: "Patients",
			caseListConfig: {
				// Neither v1 nor v2 — invalid `columns` entry.
				columns: [{ kind: "unknown-kind", oops: true }],
			},
		};
		const result = migrateOneModule(mod, { appId: "a1", moduleUuid: "m1" });
		expect(result.version).toBe("corrupt");
		expect(result.nextConfig).toBeUndefined();
	});
});

describe("migrateAppBlueprint — corrupt module isolates the whole-app write", () => {
	beforeEach(resetState);

	it("counts corrupt modules and leaves the original blueprint intact (no throw)", () => {
		const blueprint = {
			modules: {
				m1: {
					uuid: "m1",
					id: "patients",
					name: "Patients",
					caseListConfig: { columns: [{ kind: "unknown-kind" }] },
				},
			},
		};
		const result = migrateAppBlueprint(blueprint, "a1");
		expect(result.corruptModuleCount).toBe(1);
		expect(result.migratedModules).toBe(0);
		expect(result.diffs).toEqual([{ uuid: "m1", version: "corrupt" }]);
	});

	it("does not partially migrate a doc with one corrupt + one v0 module — no migration applied", () => {
		const blueprint = {
			modules: {
				m_corrupt: {
					uuid: "m_corrupt",
					id: "patients",
					name: "Patients",
					caseListConfig: { columns: [{ kind: "unknown-kind" }] },
				},
				m_v0: {
					uuid: "m_v0",
					id: "households",
					name: "Households",
					caseListColumns: [{ field: "case_name", header: "Name" }],
				},
			},
		};
		const result = migrateAppBlueprint(blueprint, "a1");
		expect(result.corruptModuleCount).toBe(1);
		// `migratedModules` counts the v0 module — but the per-app
		// caller skips the write whenever `corruptModuleCount > 0`, so
		// the partial migration never lands.
		expect(result.migratedModules).toBe(1);
	});
});

// ── App-level idempotency ────────────────────────────────────────

describe("migrateAppBlueprint — counters", () => {
	beforeEach(resetState);

	it("returns the input blueprint unchanged when no module needs migration", () => {
		const blueprint = {
			modules: {
				m1: { uuid: "m1", id: "survey", name: "Survey" },
			},
		};
		const result = migrateAppBlueprint(blueprint, "a1");
		expect(result.migratedModules).toBe(0);
		expect(result.blueprint).toBe(blueprint);
	});

	it("aggregates corruptInputCount across modules", () => {
		const blueprint = {
			modules: {
				m1: {
					uuid: "m1",
					id: "patients",
					name: "Patients",
					caseListConfig: {
						columns: [],
						sort: [],
						calculatedColumns: [],
						searchInputs: [{ name: "broken_a", label: "A", type: "text" }],
					},
				},
				m2: {
					uuid: "m2",
					id: "households",
					name: "Households",
					caseListConfig: {
						columns: [],
						sort: [],
						calculatedColumns: [],
						searchInputs: [{ name: "broken_b", label: "B", type: "text" }],
					},
				},
			},
		};
		const result = migrateAppBlueprint(blueprint, "a1");
		expect(result.corruptInputCount).toBe(2);
		expect(result.migratedModules).toBe(2);
	});

	it("is idempotent — running twice equals running once", () => {
		const blueprint = {
			modules: {
				m1: {
					uuid: "m1",
					id: "patients",
					name: "Patients",
					caseListColumns: [{ field: "case_name", header: "Name" }],
				},
			},
		};
		const first = migrateAppBlueprint(blueprint, "a1");
		const second = migrateAppBlueprint(first.blueprint, "a1");
		expect(first.migratedModules).toBe(1);
		expect(second.migratedModules).toBe(0);
		expect(second.blueprint).toBe(first.blueprint);
	});
});

// ── parseArgs — CLI surface ────────────────────────────────────────

describe("parseArgs", () => {
	it("with no flags defaults to dry-run", () => {
		// Production data is on the v0 shape and a bare invocation
		// must NOT mutate every live app doc. Dry-run is the cautious
		// default; the operator opts INTO live writes via `--write`.
		expect(parseArgs([])).toEqual({
			dryRun: true,
			appId: undefined,
			help: false,
		});
	});

	it("--write opts into live writes", () => {
		// `--write` is the only path off the dry-run default. Reads
		// as a verb in help text rather than a double-negation
		// (`--no-dry-run`) and makes the destructive intent explicit
		// at the invocation site.
		expect(parseArgs(["--write"])).toEqual({
			dryRun: false,
			appId: undefined,
			help: false,
		});
	});

	it("--dry-run is an explicit no-op against the new default", () => {
		// Kept accepted for shell-history compatibility — operators
		// arriving from the deleted v0→v1 script's `--dry-run` muscle
		// memory hit the same dry pass they expected.
		expect(parseArgs(["--dry-run"])).toEqual({
			dryRun: true,
			appId: undefined,
			help: false,
		});
	});

	it("extracts appId from --app-id=<value>", () => {
		expect(parseArgs(["--app-id=abc123"])).toEqual({
			dryRun: true,
			appId: "abc123",
			help: false,
		});
	});

	it("combines --app-id with --write", () => {
		expect(parseArgs(["--app-id=abc123", "--write"])).toEqual({
			dryRun: false,
			appId: "abc123",
			help: false,
		});
	});

	it("combines --app-id with --dry-run", () => {
		expect(parseArgs(["--app-id=abc123", "--dry-run"])).toEqual({
			dryRun: true,
			appId: "abc123",
			help: false,
		});
	});

	it("--help (and -h short form) sets help: true", () => {
		expect(parseArgs(["-h"])).toEqual({
			dryRun: true,
			appId: undefined,
			help: true,
		});
		expect(parseArgs(["--help"])).toEqual({
			dryRun: true,
			appId: undefined,
			help: true,
		});
	});

	it("rejects an empty --app-id= value", () => {
		expect(() => parseArgs(["--app-id="])).toThrow(
			"--app-id flag requires a non-empty value",
		);
	});

	it("rejects unrecognized arguments", () => {
		expect(() => parseArgs(["--unknown"])).toThrow(
			"Unrecognized argument: --unknown",
		);
	});
});

// ── run — runtime safety against mocked Firestore ─────────────────

describe("run", () => {
	beforeEach(resetState);

	function legacyV0Blueprint(modUuid: string) {
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
				blueprint: legacyV0Blueprint("m1"),
			}),
		];
		await run(dryRunOpts);
		expect(state.whereCalls).toEqual([
			["deleted_at", "==", null],
			["status", "==", "complete"],
		]);
	});

	it("skips soft-deleted apps in the bulk path", async () => {
		const liveDoc = makeDoc("a-live", {
			owner: "u1",
			status: "complete",
			deleted_at: null,
			blueprint: legacyV0Blueprint("m1"),
		});
		const deletedDoc = makeDoc("a-deleted", {
			owner: "u1",
			status: "complete",
			deleted_at: "2026-04-01T00:00:00.000Z",
			blueprint: legacyV0Blueprint("m2"),
		});
		state.docs = [liveDoc, deletedDoc];
		const summary = await run(liveOpts);
		expect(summary.appsTouched).toBe(1);
		expect(liveDoc.updateSpy).toHaveBeenCalledTimes(1);
		expect(deletedDoc.updateSpy).not.toHaveBeenCalled();
	});

	it("skips generating apps in the bulk path", async () => {
		const liveDoc = makeDoc("a-live", {
			owner: "u1",
			status: "complete",
			deleted_at: null,
			blueprint: legacyV0Blueprint("m1"),
		});
		const generatingDoc = makeDoc("a-generating", {
			owner: "u1",
			status: "generating",
			deleted_at: null,
			blueprint: legacyV0Blueprint("m2"),
		});
		state.docs = [liveDoc, generatingDoc];
		const summary = await run(liveOpts);
		expect(summary.appsTouched).toBe(1);
		expect(liveDoc.updateSpy).toHaveBeenCalledTimes(1);
		expect(generatingDoc.updateSpy).not.toHaveBeenCalled();
	});

	it("does not write under --dry-run", async () => {
		const doc = makeDoc("a1", {
			owner: "u1",
			status: "complete",
			deleted_at: null,
			blueprint: legacyV0Blueprint("m1"),
		});
		state.docs = [doc];
		const summary = await run(dryRunOpts);
		expect(summary.appsTouched).toBe(1);
		expect(summary.modulesMigrated).toBe(1);
		expect(doc.updateSpy).not.toHaveBeenCalled();
	});

	it("writes under live run + persists the v2-shaped blueprint", async () => {
		const doc = makeDoc("a1", {
			owner: "u1",
			status: "complete",
			deleted_at: null,
			blueprint: legacyV0Blueprint("m1"),
		});
		state.docs = [doc];
		const summary = await run(liveOpts);
		expect(summary.appsTouched).toBe(1);
		expect(doc.updateSpy).toHaveBeenCalledTimes(1);
		const written = doc.updateSpy.mock.calls[0]?.[0] as {
			blueprint: {
				modules: Record<
					string,
					{ caseListConfig?: unknown; caseListColumns?: unknown }
				>;
			};
		};
		const m1 = written.blueprint.modules.m1;
		expectValidConfig(m1.caseListConfig);
		// Legacy top-level fields are stripped.
		expect(m1.caseListColumns).toBeUndefined();
	});

	it("isolates a single corrupt-module app from the rest of the batch (WARN, not ERROR)", async () => {
		const corruptDoc = makeDoc("a-corrupt", {
			owner: "u1",
			status: "complete",
			deleted_at: null,
			blueprint: {
				modules: {
					m1: {
						uuid: "m1",
						id: "patients",
						name: "Patients",
						caseListConfig: { columns: [{ kind: "unknown-kind" }] },
					},
				},
			},
		});
		const goodDoc = makeDoc("a-good", {
			owner: "u1",
			status: "complete",
			deleted_at: null,
			blueprint: legacyV0Blueprint("m2"),
		});
		state.docs = [corruptDoc, goodDoc];
		const summary = await run(liveOpts);
		// The corrupt doc skips its write + bumps failedCount. The
		// good doc still processes.
		expect(corruptDoc.updateSpy).not.toHaveBeenCalled();
		expect(goodDoc.updateSpy).toHaveBeenCalledTimes(1);
		expect(summary.failedCount).toBe(1);
		expect(summary.appsTouched).toBe(1);
		// Per-plan-letter — corrupt classification logs at WARN level,
		// NOT at ERROR. ERROR is reserved for unforeseen exceptions
		// (output safeParse failure / Firestore write rejection).
		const warnMessages = mockLogger.warn.mock.calls.map((c) => c[0] as string);
		expect(
			warnMessages.some(
				(m) => m.includes("a-corrupt") && m.includes("corrupt"),
			),
		).toBe(true);
		expect(mockLogger.error).not.toHaveBeenCalled();
	});

	it("a single firestore-write failure does not abort the batch", async () => {
		const failingDoc = makeDoc("a-fail", {
			owner: "u1",
			status: "complete",
			deleted_at: null,
			blueprint: legacyV0Blueprint("m1"),
		});
		failingDoc.updateSpy.mockRejectedValueOnce(
			new Error("simulated firestore write failure"),
		);
		const goodDoc = makeDoc("a-good", {
			owner: "u1",
			status: "complete",
			deleted_at: null,
			blueprint: legacyV0Blueprint("m2"),
		});
		state.docs = [failingDoc, goodDoc];
		const summary = await run(liveOpts);
		expect(summary.failedCount).toBe(1);
		expect(summary.appsTouched).toBe(1);
		expect(failingDoc.updateSpy).toHaveBeenCalledTimes(1);
		expect(goodDoc.updateSpy).toHaveBeenCalledTimes(1);
	});

	it("--app-id targets a single doc and bypasses the bulk filter", async () => {
		const targetedDoc = makeDoc("a-target", {
			owner: "u1",
			status: "error",
			deleted_at: "2026-04-01T00:00:00.000Z",
			blueprint: legacyV0Blueprint("m1"),
		});
		state.docsById = { "a-target": targetedDoc };
		// `state.docs` stays empty — confirms the bulk path is not
		// consulted.
		const summary = await run({
			dryRun: false,
			appId: "a-target",
			help: false,
		});
		expect(state.whereCalls).toEqual([]);
		expect(summary.appsTouched).toBe(1);
		expect(targetedDoc.updateSpy).toHaveBeenCalledTimes(1);
	});

	it("--app-id with a missing doc reports zero scanned + no failures", async () => {
		state.docsById = {}; // doc lookup returns `exists: false`.
		const summary = await run({
			dryRun: true,
			appId: "missing-id",
			help: false,
		});
		expect(summary.scanned).toBe(0);
		expect(summary.appsTouched).toBe(0);
		expect(summary.failedCount).toBe(0);
	});

	it("aggregates corruptInputCount across the run", async () => {
		const doc = makeDoc("a1", {
			owner: "u1",
			status: "complete",
			deleted_at: null,
			blueprint: {
				modules: {
					m1: {
						uuid: "m1",
						id: "patients",
						name: "Patients",
						caseListConfig: {
							columns: [],
							sort: [],
							calculatedColumns: [],
							searchInputs: [{ name: "broken", label: "Broken", type: "text" }],
						},
					},
				},
			},
		});
		state.docs = [doc];
		const summary = await run(liveOpts);
		expect(summary.corruptInputCount).toBe(1);
	});
});

// ── Source-version log surfacing ─────────────────────────────────

describe("processApp log lines surface source-version tags", () => {
	beforeEach(resetState);

	it("logs the per-module version tag (v0 / v1 / v2-skipped) for the operator's breakdown scan", async () => {
		const doc = makeDoc("a1", {
			owner: "u1",
			status: "complete",
			deleted_at: null,
			blueprint: {
				modules: {
					m_v0: {
						uuid: "m_v0",
						id: "patients",
						name: "Patients",
						caseListColumns: [{ field: "case_name", header: "Name" }],
					},
					m_v2: {
						uuid: "m_v2",
						id: "households",
						name: "Households",
						caseListConfig: {
							columns: [
								plainColumn(
									asUuid("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
									"case_name",
									"Name",
								),
							],
							searchInputs: [],
						},
					},
				},
			},
		});
		state.docs = [doc];
		await run(dryRunOpts);
		const allInfo = mockLogger.info.mock.calls.map((c) => c[0] as string);
		const summaryLog = allInfo.find((m) => m.includes("modules=["));
		expect(summaryLog).toBeDefined();
		expect(summaryLog).toContain("version=v0");
		expect(summaryLog).toContain("version=v2-skipped");
	});
});

// ── Defensive shape coverage ──────────────────────────────────────

describe("misc shape pinning", () => {
	beforeEach(resetState);

	it("preserves id-mapping column entries through v1 → v2", () => {
		const mod = {
			uuid: "m1",
			id: "patients",
			name: "Patients",
			caseListConfig: {
				columns: [
					{
						kind: "id-mapping",
						field: "region_code",
						header: "Region",
						mapping: [
							idMappingEntry("01", "North"),
							idMappingEntry("02", "South"),
						],
					},
				],
				sort: [],
				calculatedColumns: [],
				searchInputs: [],
			},
		};
		const result = migrateOneModule(mod, { appId: "a1", moduleUuid: "m1" });
		const config = expectValidConfig(result.nextConfig);
		expect(config.columns[0]).toMatchObject({
			kind: "id-mapping",
			field: "region_code",
			mapping: [
				{ value: "01", label: "North" },
				{ value: "02", label: "South" },
			],
		});
	});

	it("preserves search-input via on simple arm", () => {
		const via = {
			kind: "ancestor" as const,
			via: [{ identifier: "parent" }] as [{ identifier: string }],
		};
		const mod = {
			uuid: "m1",
			id: "patients",
			name: "Patients",
			caseListConfig: {
				columns: [],
				sort: [],
				calculatedColumns: [],
				searchInputs: [
					{
						name: "parent_name",
						label: "Parent name",
						type: "text",
						property: "case_name",
						via,
					},
				],
			},
		};
		const result = migrateOneModule(mod, { appId: "a1", moduleUuid: "m1" });
		const config = expectValidConfig(result.nextConfig);
		const input = config.searchInputs[0];
		expect(input.kind).toBe("simple");
		if (input.kind === "simple") {
			expect(input.via).toEqual(via);
		}
	});

	// `term(literal(...))` is a redundant test of the predicate
	// builder; keeps imports honest in case a future test wants to
	// reach for the lifted-Term shape.
	it("term(literal()) round-trips through the v2 schema (sanity check)", () => {
		const expr = term(literal("hello"));
		const mod = {
			uuid: "m1",
			id: "patients",
			name: "Patients",
			caseListConfig: {
				columns: [],
				sort: [],
				calculatedColumns: [
					{
						id: "calc_hello",
						header: "Greeting",
						expression: expr,
					},
				],
				searchInputs: [],
			},
		};
		const result = migrateOneModule(mod, { appId: "a1", moduleUuid: "m1" });
		const config = expectValidConfig(result.nextConfig);
		const calcCol = config.columns.find((c) => c.kind === "calculated");
		// biome-ignore lint/style/noNonNullAssertion: calc column was constructed above
		expect(calcCol!.kind === "calculated" && calcCol!.expression).toEqual(expr);
	});
});
