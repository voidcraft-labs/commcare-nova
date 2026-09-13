import { describe, expect, it } from "vitest";
import {
	normalizeStoredDesignArtifactWorkspaceOperation,
	replayDesignWorkspace,
} from "../artifactWorkspaceOperations";
import { appDesignContractSchema } from "../contract";
import { placeDesignMenus } from "../modulePlacement";
import { did, fixtureValue, makeNestedMenuContract } from "./fixtures";

const menus = [
	{ id: "search", name: "Search" },
	{ id: "review", name: "Review" },
	{ id: "approval", name: "Approval" },
	{ id: "correction", name: "Correction" },
];

describe("design menu placement", () => {
	it("moves a late-created correction immediately below its existing parent", () => {
		const next = placeDesignMenus(menus, [
			{ moduleId: "correction", parentModuleId: "search", afterModuleId: null },
		]);
		expect(next.map((menu) => menu.id)).toEqual([
			"search",
			"correction",
			"review",
			"approval",
		]);
		expect(menus.map((menu) => menu.id)).toEqual([
			"search",
			"review",
			"approval",
			"correction",
		]);
	});
	it("moves the whole parent block and addresses equal-name menus by identity", () => {
		const source = [
			{ id: "a", name: "Same" },
			{ id: "child", parentModuleCompositionId: "a", name: "Child" },
			{ id: "b", name: "Same" },
		];
		expect(
			placeDesignMenus(source, [
				{ moduleId: "a", parentModuleId: null, afterModuleId: "b" },
			]).map((menu) => menu.id),
		).toEqual(["b", "a", "child"]);
	});
	it("rejects a batch atomically when a later anchor is not a sibling", () => {
		const snapshot = JSON.stringify(menus);
		expect(() =>
			placeDesignMenus(menus, [
				{
					moduleId: "correction",
					parentModuleId: "search",
					afterModuleId: null,
				},
				{
					moduleId: "review",
					parentModuleId: null,
					afterModuleId: "correction",
				},
			]),
		).toThrow("not a sibling");
		expect(JSON.stringify(menus)).toBe(snapshot);
	});
	it.each([
		{ moduleId: "missing", parentModuleId: null, afterModuleId: null },
		{ moduleId: "search", parentModuleId: "search", afterModuleId: null },
		{ moduleId: "review", parentModuleId: "missing", afterModuleId: null },
		{ moduleId: "review", parentModuleId: null, afterModuleId: "review" },
	])("refuses unknown and self-referential placement %j", (placement) => {
		expect(() => placeDesignMenus(menus, [placement])).toThrow();
	});
	it("refuses a second submenu tier and parenting a root with children", () => {
		const nested = placeDesignMenus(menus, [
			{ moduleId: "correction", parentModuleId: "search", afterModuleId: null },
		]);
		expect(() =>
			placeDesignMenus(nested, [
				{
					moduleId: "review",
					parentModuleId: "correction",
					afterModuleId: null,
				},
			]),
		).toThrow("child menu");
		expect(() =>
			placeDesignMenus(nested, [
				{ moduleId: "search", parentModuleId: "review", afterModuleId: null },
			]),
		).toThrow("with children");
	});
	it("replays placement against a private revision without changing the immutable base", () => {
		const storedMenus = menus.map((menu, index) => ({
			...menu,
			id: did(index + 1),
		}));
		const base = { moduleCompositions: storedMenus };
		const result = replayDesignWorkspace({
			kind: "revision",
			baseContract: base,
			operations: [
				{
					kind: "revision",
					collections: [],
					placements: [{ moduleId: did(4), parentModuleId: did(1) }],
				},
			],
		});
		expect(
			(result.moduleCompositions as typeof menus).map((menu) => menu.id),
		).toEqual([did(1), did(4), did(2), did(3)]);
		expect(base.moduleCompositions).toBe(storedMenus);
	});
});

it("retains legacy selection inference when a current placement moves a stored module", () => {
	const contract = makeNestedMenuContract();
	const legacy = [
		normalizeStoredDesignArtifactWorkspaceOperation({
			kind: "contract",
			root: { id: contract.id, charter: contract.charter, schemaVersion: 1 },
			collections: [],
		}),
		...Object.entries(contract).flatMap(([collection, items]) =>
			Array.isArray(items) && items.length > 0
				? [
						normalizeStoredDesignArtifactWorkspaceOperation({
							kind: "contract",
							collections: [
								{
									collection,
									upserts:
										collection === "moduleCompositions"
											? items.map((item) =>
													Object.fromEntries(
														Object.entries(item).filter(
															([key]) => key !== "selection",
														),
													),
												)
											: items,
									removeIds: [],
								},
							],
						}),
					]
				: [],
		),
	];
	const child = fixtureValue(contract.moduleCompositions[1], "child");
	const parent = fixtureValue(contract.moduleCompositions[0], "parent");
	const before = appDesignContractSchema.parse(
		replayDesignWorkspace({ kind: "contract", operations: legacy }),
	);
	const after = appDesignContractSchema.parse(
		replayDesignWorkspace({
			kind: "contract",
			operations: [
				...legacy,
				{
					kind: "contract",
					collections: [],
					placements: [{ moduleId: child.id, parentModuleId: parent.id }],
				},
			],
		}),
	);
	expect(after).toEqual(before);
	expect(after.moduleCompositions[1]?.selection).toEqual(
		before.moduleCompositions[1]?.selection,
	);
	expect(after.moduleCompositions[1]?.selection).toBeDefined();
});
