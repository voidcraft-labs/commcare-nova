import { describe, expect, it } from "vitest";
import {
	FROZEN_OCCURRENCE_RELATIONS,
	FROZEN_OCCURRENCE_TABLES,
	FROZEN_STORAGE_OCCURRENCES,
} from "../20260728000000_canonical_identity_foundation/frozenOccurrenceManifest";
import {
	classifyFrozenCasesRelation,
	classifyFrozenCatalogLifecycle,
	classifyFrozenFoldFamily,
	classifyFrozenObservedCatalogLifecycle,
	classifyFrozenRelationInventory,
	FROZEN_CANONICAL_CREATED_RELATION_KEYS,
	FROZEN_EXTERNAL_RELATION_KEYS,
	FROZEN_FOLD_FAMILY_OBJECT_KEYS,
	FROZEN_OCCURRENCE_LOGICAL_RELATION_KEYS,
	FROZEN_POST_PRIVILEGE_OCCURRENCE_RELATIONS,
	FROZEN_PRE_PRIVILEGE_OCCURRENCE_RELATIONS,
	FROZEN_PREEXISTING_RELATION_KEYS,
	FROZEN_RELATION_DDL_TRANSITIONS,
	FROZEN_RELATION_LIFECYCLE,
	FROZEN_REPAIR_RELATION_KEYS,
	type FrozenPhysicalRelation,
	resolveFrozenCasesRelation,
	resolveFrozenCatalogLifecycle,
	resolveFrozenRelationInventory,
} from "../20260728000000_canonical_identity_foundation/frozenRelationLifecycle";
import {
	FROZEN_PROJECT_ORPHAN_APP_ID_TABLES,
	FROZEN_PROJECT_ORPHAN_AUTH_TABLES,
} from "../20260728000000_canonical_identity_foundation/frozenRepairManifest";

const toPristine = (relations: readonly FrozenPhysicalRelation[]) =>
	relations
		.filter((relation) => relation.table !== "app_change_fold_baselines")
		.map((relation) =>
			relation.table === "app_changes"
				? { ...relation, table: "accepted_mutations" }
				: relation,
		);

const withRunSummaries = (relations: readonly FrozenPhysicalRelation[]) => [
	...relations,
	{ schema: "public", table: "run_summaries" },
];

const authRelations = FROZEN_EXTERNAL_RELATION_KEYS.map((table) => ({
	schema: "public",
	table,
}));

const publicPristine = withRunSummaries(
	toPristine(FROZEN_PRE_PRIVILEGE_OCCURRENCE_RELATIONS),
);
const publicFinal = withRunSummaries(FROZEN_PRE_PRIVILEGE_OCCURRENCE_RELATIONS);
const runtimePristine = withRunSummaries(
	toPristine(FROZEN_POST_PRIVILEGE_OCCURRENCE_RELATIONS),
);
const runtimeFinal = withRunSummaries(
	FROZEN_POST_PRIVILEGE_OCCURRENCE_RELATIONS,
);

const relationNames = (relations: readonly FrozenPhysicalRelation[]) =>
	relations.map((relation) => `${relation.schema}.${relation.table}`);

describe("frozen relation lifecycle catalog", () => {
	it("partitions every logical carrier under one exact lifecycle owner", () => {
		expect(
			new Set(FROZEN_RELATION_LIFECYCLE.map((entry) => entry.key)),
		).toHaveLength(FROZEN_RELATION_LIFECYCLE.length);
		expect(FROZEN_PREEXISTING_RELATION_KEYS).toHaveLength(21);
		expect(FROZEN_CANONICAL_CREATED_RELATION_KEYS).toEqual([
			"app_change_fold_baselines",
		]);
		expect(
			FROZEN_RELATION_LIFECYCLE.find((entry) => entry.key === "run_summaries"),
		).toEqual({
			key: "run_summaries",
			table: "run_summaries",
			owner: "preexisting-case-store",
			occurrence: false,
			repairClosure: true,
		});
		expect(FROZEN_EXTERNAL_RELATION_KEYS).toEqual(
			FROZEN_PROJECT_ORPHAN_AUTH_TABLES,
		);
		expect(new Set(FROZEN_OCCURRENCE_LOGICAL_RELATION_KEYS)).toEqual(
			new Set(FROZEN_OCCURRENCE_TABLES),
		);
		expect(FROZEN_OCCURRENCE_RELATIONS).toEqual(
			FROZEN_POST_PRIVILEGE_OCCURRENCE_RELATIONS,
		);

		const repairManifestKeys = new Set<string>([
			"apps",
			...FROZEN_PROJECT_ORPHAN_APP_ID_TABLES.map((qualified) =>
				qualified.endsWith(".cases")
					? "cases"
					: qualified.endsWith(".accepted_mutations")
						? "app_changes"
						: (qualified.split(".")[1] ?? ""),
			),
			...FROZEN_PROJECT_ORPHAN_AUTH_TABLES,
		]);
		expect(new Set(FROZEN_REPAIR_RELATION_KEYS)).toEqual(repairManifestKeys);
		for (const qualified of FROZEN_PROJECT_ORPHAN_APP_ID_TABLES) {
			const table = qualified.endsWith(".cases")
				? "cases"
				: qualified.endsWith(".accepted_mutations")
					? "app_changes"
					: (qualified.split(".")[1] ?? "");
			expect(FROZEN_PREEXISTING_RELATION_KEYS).toContain(table);
		}
	});

	it("owns the exact rename and absent-to-created DDL transitions", () => {
		expect(FROZEN_RELATION_DDL_TRANSITIONS).toEqual([
			{
				key: "app_changes",
				pristine: "accepted_mutations",
				final: "app_changes",
				owner: "preexisting-case-store",
			},
			{
				key: "app_change_fold_baselines",
				pristine: "absent",
				final: "created",
				owner: "canonical-created-fold-family",
			},
		]);

		const ddlTables = new Set(
			FROZEN_STORAGE_OCCURRENCES.filter(
				(entry) => entry.disposition === "DDL",
			).map((entry) => entry.table),
		);
		expect(ddlTables.has("app_change_fold_baselines")).toBe(true);
		for (const table of FROZEN_OCCURRENCE_TABLES) {
			if (table === "app_change_fold_baselines") continue;
			expect(FROZEN_PREEXISTING_RELATION_KEYS).toContain(table);
		}
	});

	it("resolves exactly one physical cases carrier and rejects neither or both", () => {
		expect(
			classifyFrozenCasesRelation([{ schema: "public", table: "cases" }]),
		).toMatchObject({
			state: "public-pristine",
			relation: { schema: "public", table: "cases" },
		});
		expect(
			classifyFrozenCasesRelation([
				{ schema: "nova_case_runtime", table: "cases" },
			]),
		).toMatchObject({
			state: "runtime-post-privilege",
			relation: { schema: "nova_case_runtime", table: "cases" },
		});
		expect(classifyFrozenCasesRelation([]).state).toBe("missing");
		expect(
			classifyFrozenCasesRelation([
				{ schema: "public", table: "cases" },
				{ schema: "nova_case_runtime", table: "cases" },
			]).state,
		).toBe("duplicate");
		expect(
			classifyFrozenCasesRelation([
				{ schema: "public", table: "cases" },
				{ schema: "public", table: "cases" },
			]).state,
		).toBe("duplicate");
		expect(() =>
			resolveFrozenCasesRelation([
				{ schema: "public", table: "cases" },
				{ schema: "nova_case_runtime", table: "cases" },
			]),
		).toThrow(/exactly one physical owner/);
	});

	it("derives exact pristine, final, post-privilege, and repair inventories", () => {
		const pristine = resolveFrozenRelationInventory(
			{
				canonicalPhase: "pristine",
				privilegePhase: "pre-privilege",
				purpose: "migration-or-scan",
				appCount: "0",
			},
			publicPristine,
		);
		expect(pristine.authState).toBe("absent-greenfield");
		expect(pristine.requiredRelations).toHaveLength(21);
		expect(relationNames(pristine.requiredRelations)).toContain(
			"public.run_summaries",
		);
		expect(relationNames(pristine.requiredRelations)).not.toContain(
			"public.app_change_fold_baselines",
		);
		expect(pristine.lockableRelations).toEqual(pristine.requiredRelations);

		const final = resolveFrozenRelationInventory(
			{
				canonicalPhase: "final",
				privilegePhase: "pre-privilege",
				purpose: "migration-or-scan",
				appCount: "0",
			},
			publicFinal,
		);
		expect(final.requiredRelations).toHaveLength(22);
		expect(relationNames(final.requiredRelations)).toContain(
			"public.app_change_fold_baselines",
		);

		const postPrivilege = resolveFrozenRelationInventory(
			{
				canonicalPhase: "final",
				privilegePhase: "post-privilege",
				purpose: "migration-or-scan",
				appCount: "1",
			},
			[...runtimeFinal, ...authRelations],
		);
		expect(postPrivilege.cases.state).toBe("runtime-post-privilege");
		expect(relationNames(postPrivilege.requiredRelations)).toContain(
			"nova_case_runtime.cases",
		);
		expect(relationNames(postPrivilege.requiredRelations)).not.toContain(
			"public.cases",
		);

		const repair = resolveFrozenRelationInventory(
			{
				canonicalPhase: "pristine",
				privilegePhase: "post-privilege",
				purpose: "repair-production",
				appCount: "428",
			},
			[...runtimePristine, ...authRelations],
		);
		expect(repair.repairState).toBe("applicable");
		expect(repair.requiredRelations).toHaveLength(28);
		expect(repair.repairRelations).toHaveLength(23);
		expect(relationNames(repair.repairRelations)).toContain(
			"public.run_summaries",
		);
	});

	it("accepts only all-absent zero-app auth or the exact complete seven", () => {
		expect(
			classifyFrozenRelationInventory(
				{
					canonicalPhase: "pristine",
					privilegePhase: "pre-privilege",
					purpose: "migration-or-scan",
					appCount: "0",
				},
				publicPristine,
			),
		).toMatchObject({ state: "valid", authState: "absent-greenfield" });

		const nonemptyAbsent = classifyFrozenRelationInventory(
			{
				canonicalPhase: "pristine",
				privilegePhase: "pre-privilege",
				purpose: "migration-or-scan",
				appCount: "1",
			},
			publicPristine,
		);
		expect(nonemptyAbsent.state).toBe("drift");
		expect(nonemptyAbsent.missingRelations).toEqual(
			authRelations.map((relation) => `${relation.schema}.${relation.table}`),
		);

		const partial = classifyFrozenRelationInventory(
			{
				canonicalPhase: "pristine",
				privilegePhase: "pre-privilege",
				purpose: "migration-or-scan",
				appCount: "0",
			},
			[...publicPristine, { schema: "public", table: "auth_account" }],
		);
		expect(partial.state).toBe("drift");
		expect(partial.authState).toBe("drift");
		expect(partial.missingRelations).toHaveLength(6);
		expect(partial.unexpectedRelations).toContain("public.auth_account");

		expect(
			resolveFrozenRelationInventory(
				{
					canonicalPhase: "pristine",
					privilegePhase: "pre-privilege",
					purpose: "migration-or-scan",
					appCount: "0",
				},
				[...publicPristine, ...authRelations],
			).authState,
		).toBe("complete");
	});

	it("reports complete missing and unexpected sets without join disappearance", () => {
		const observed = publicPristine.filter(
			(relation) =>
				relation.table !== "apps" && relation.table !== "blueprint_entities",
		);
		const resolution = classifyFrozenRelationInventory(
			{
				canonicalPhase: "pristine",
				privilegePhase: "pre-privilege",
				purpose: "migration-or-scan",
				appCount: "0",
			},
			[...observed, { schema: "nova_case_runtime", table: "cases" }],
		);
		expect(resolution.state).toBe("drift");
		expect(resolution.missingRelations).toEqual([
			"public.apps",
			"public.blueprint_entities",
		]);
		expect(resolution.unexpectedRelations).toContain("nova_case_runtime.cases");
		expect(resolution.lockableRelations).toHaveLength(19);
		expect(() =>
			resolveFrozenRelationInventory(
				{
					canonicalPhase: "pristine",
					privilegePhase: "pre-privilege",
					purpose: "migration-or-scan",
					appCount: "0",
				},
				observed,
			),
		).toThrow(/public\.apps.*public\.blueprint_entities/);
	});

	it("marks repair after the canonical transition terminally not applicable", () => {
		const resolution = classifyFrozenRelationInventory(
			{
				canonicalPhase: "final",
				privilegePhase: "post-privilege",
				purpose: "repair-production",
				appCount: "1",
			},
			[...runtimeFinal, ...authRelations],
		);
		expect(resolution).toMatchObject({
			state: "not-applicable",
			repairState: "terminal-not-applicable",
		});
	});
});

describe("frozen fold-family lifecycle", () => {
	it("accepts only wholly absent pristine or the complete exact final family", () => {
		expect(
			FROZEN_FOLD_FAMILY_OBJECT_KEYS.filter((key) =>
				key.startsWith("relation:"),
			),
		).toHaveLength(5);
		expect(
			FROZEN_FOLD_FAMILY_OBJECT_KEYS.filter((key) =>
				key.startsWith("constraint:"),
			),
		).toHaveLength(8);
		expect(
			FROZEN_FOLD_FAMILY_OBJECT_KEYS.filter((key) =>
				key.startsWith("trigger:"),
			),
		).toHaveLength(6);
		expect(
			FROZEN_FOLD_FAMILY_OBJECT_KEYS.filter((key) =>
				key.startsWith("routine:"),
			),
		).toHaveLength(9);
		expect(classifyFrozenFoldFamily([])).toMatchObject({
			state: "pristine",
			unexpectedObjects: [],
			duplicateObjects: [],
		});
		expect(classifyFrozenFoldFamily(FROZEN_FOLD_FAMILY_OBJECT_KEYS)).toEqual({
			state: "final",
			missingObjects: [],
			unexpectedObjects: [],
			duplicateObjects: [],
		});
		expect(
			classifyFrozenFoldFamily(FROZEN_FOLD_FAMILY_OBJECT_KEYS.slice(0, 1)),
		).toMatchObject({ state: "drift" });
	});

	it("rejects wrong-schema and duplicate named objects", () => {
		const wrongSchema = classifyFrozenFoldFamily([
			...FROZEN_FOLD_FAMILY_OBJECT_KEYS,
			"relation:other:app_change_fold_baselines",
		]);
		expect(wrongSchema).toMatchObject({
			state: "drift",
			unexpectedObjects: ["relation:other:app_change_fold_baselines"],
		});

		const duplicate = classifyFrozenFoldFamily([
			...FROZEN_FOLD_FAMILY_OBJECT_KEYS,
			FROZEN_FOLD_FAMILY_OBJECT_KEYS[0],
		]);
		expect(duplicate).toMatchObject({
			state: "drift",
			duplicateObjects: [FROZEN_FOLD_FAMILY_OBJECT_KEYS[0]],
		});
	});

	it("is the shared terminal state oracle for migration, scanner, and audit", () => {
		expect(
			classifyFrozenObservedCatalogLifecycle({
				purpose: "migration-or-scan",
				appCount: "0",
				observedRelations: publicPristine,
				observedFoldObjectKeys: [],
			}),
		).toMatchObject({
			state: "pristine",
			canonicalPhase: "pristine",
			privilegePhase: "pre-privilege",
		});
		expect(
			classifyFrozenObservedCatalogLifecycle({
				purpose: "migration-or-scan",
				appCount: "0",
				observedRelations: publicFinal,
				observedFoldObjectKeys: FROZEN_FOLD_FAMILY_OBJECT_KEYS,
			}),
		).toMatchObject({
			state: "final",
			canonicalPhase: "final",
			privilegePhase: "pre-privilege",
		});
		expect(
			resolveFrozenCatalogLifecycle({
				context: {
					canonicalPhase: "pristine",
					privilegePhase: "pre-privilege",
					purpose: "migration-or-scan",
					appCount: "0",
				},
				observedRelations: publicPristine,
				observedFoldObjectKeys: [],
			}).state,
		).toBe("valid");
		expect(
			resolveFrozenCatalogLifecycle({
				context: {
					canonicalPhase: "final",
					privilegePhase: "pre-privilege",
					purpose: "migration-or-scan",
					appCount: "0",
				},
				observedRelations: publicFinal,
				observedFoldObjectKeys: FROZEN_FOLD_FAMILY_OBJECT_KEYS,
			}).state,
		).toBe("valid");

		const partialFinal = classifyFrozenCatalogLifecycle({
			context: {
				canonicalPhase: "final",
				privilegePhase: "pre-privilege",
				purpose: "migration-or-scan",
				appCount: "0",
			},
			observedRelations: publicFinal,
			observedFoldObjectKeys: [],
		});
		expect(partialFinal).toMatchObject({
			state: "drift",
			relations: { state: "valid" },
			foldFamily: { state: "pristine" },
		});
		expect(
			classifyFrozenObservedCatalogLifecycle({
				purpose: "migration-or-scan",
				appCount: "0",
				observedRelations: publicFinal,
				observedFoldObjectKeys: [],
			}).state,
		).toBe("drift");
		expect(
			classifyFrozenObservedCatalogLifecycle({
				purpose: "migration-or-scan",
				appCount: "0",
				observedRelations: publicFinal,
				observedFoldObjectKeys: FROZEN_FOLD_FAMILY_OBJECT_KEYS.slice(0, 1),
			}),
		).toMatchObject({
			state: "drift",
			canonicalPhase: null,
			foldFamily: { state: "drift" },
		});
	});
});
