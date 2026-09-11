import { expect, it } from "vitest";
import {
	did,
	fixtureValue,
	makeNestedMenuContract,
} from "@/lib/agent/design/__tests__/fixtures";
import {
	normalizeStoredDesignArtifactWorkspaceOperation,
	replayDesignWorkspace,
} from "@/lib/agent/design/artifactWorkspaceOperations";
import { planWorkspacePlacementMigration } from "../designContinuationMigration";

it("appends ordinary placement operations to preserve saved sibling order under the single replay contract", () => {
	const source = makeNestedMenuContract();
	const parent = fixtureValue(source.moduleCompositions[0], "parent");
	const originalChild = {
		...fixtureValue(source.moduleCompositions[1], "child"),
		parentModuleCompositionId: undefined,
	};
	const sibling = { ...originalChild, id: did(999) };
	const operations = [
		normalizeStoredDesignArtifactWorkspaceOperation({
			storageVersion: 2,
			operation: {
				kind: "revision",
				collections: [
					{
						collection: "moduleCompositions",
						upserts: [
							{ ...originalChild, parentModuleCompositionId: parent.id },
						],
						removeIds: [],
					},
				],
			},
		}),
		normalizeStoredDesignArtifactWorkspaceOperation({
			storageVersion: 2,
			operation: {
				kind: "revision",
				collections: [
					{
						collection: "moduleCompositions",
						upserts: [originalChild],
						removeIds: [],
					},
				],
			},
		}),
	];
	const args = {
		kind: "revision" as const,
		baseContract: { moduleCompositions: [parent, originalChild, sibling] },
		operations,
	};
	expect(
		(replayDesignWorkspace(args).moduleCompositions as { id: string }[]).map(
			(menu) => menu.id,
		),
	).toEqual([parent.id, sibling.id, originalChild.id]);
	const migration = planWorkspacePlacementMigration(args);
	expect(migration.length).toBeGreaterThan(0);
	const migrated = { ...args, operations: [...operations, ...migration] };
	expect(
		(
			replayDesignWorkspace(migrated).moduleCompositions as { id: string }[]
		).map((menu) => menu.id),
	).toEqual([parent.id, originalChild.id, sibling.id]);
	expect(planWorkspacePlacementMigration(migrated)).toEqual([]);
});
