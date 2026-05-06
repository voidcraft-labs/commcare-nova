// scripts/__tests__/migrate-case-list-config.test.ts
//
// Coverage for the operator-run migration that backfills
// `caseListConfig` onto modules persisted before the structured
// shape landed. Tests pin three properties:
//
//   1. Pure migration — a module on the legacy shape rewrites to
//      the structured shape with `kind: "plain"` columns and
//      empty arrays for `sort` / `calculatedColumns` /
//      `searchInputs`. Legacy field names are dropped.
//   2. Idempotence — running the migration on an already-migrated
//      module yields the same module reference (the migration
//      short-circuits with `null`).
//   3. Mixed shape — a module carrying both legacy `caseListColumns`
//      AND a partial `caseListConfig` (unusual but possible during
//      a partially-applied migration) merges the legacy columns
//      onto the structured shape and drops the legacy fields.

import { describe, expect, it } from "vitest";
import {
	migrateBlueprintShape,
	migrateModule,
} from "../migrate-case-list-config";

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
		expect(next?.caseListConfig).toEqual({
			columns: [{ kind: "plain" as const, field: "case_name", header: "Name" }],
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
		expect(next?.caseListConfig?.detailColumns).toEqual([
			{ kind: "plain", field: "case_name", header: "Full Name" },
			{ kind: "plain", field: "age", header: "Age" },
		]);
	});

	it("returns null for a module already on the new shape", () => {
		const mod = {
			uuid: "m1",
			id: "patients",
			name: "Patients",
			caseListConfig: {
				columns: [
					{ kind: "plain" as const, field: "case_name", header: "Name" },
				],
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
				columns: [{ kind: "plain" as const, field: "stale", header: "Stale" }],
				sort: [
					{
						source: { kind: "property", property: "case_name" },
						type: "plain",
						direction: "asc",
					},
				],
				calculatedColumns: [
					{ id: "today", header: "Today", expression: { kind: "today" } },
				],
				searchInputs: [{ name: "q", label: "Q", type: "text" }],
			},
		};
		const next = migrateModule(mod);
		expect(next?.caseListColumns).toBeUndefined();
		expect(next?.caseListConfig?.columns).toEqual([
			{ kind: "plain", field: "case_name", header: "Name" },
		]);
		// Pre-existing structured authoring survives the rewrite.
		expect(next?.caseListConfig?.sort).toHaveLength(1);
		expect(next?.caseListConfig?.calculatedColumns).toHaveLength(1);
		expect(next?.caseListConfig?.searchInputs).toHaveLength(1);
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
		const m1 = result.blueprint.modules?.m1;
		const m2 = result.blueprint.modules?.m2;
		expect(m1?.caseListColumns).toBeUndefined();
		expect(m1?.caseListConfig?.columns).toEqual([
			{ kind: "plain", field: "case_name", header: "Name" },
		]);
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
	});
});
