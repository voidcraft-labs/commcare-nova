import { describe, expect, it } from "vitest";
import {
	designCollectionUpdateInputSchemas,
	designWorkspaceBoundError,
	designWorkspaceCandidateSummary,
	initialDesignWorkspaceCandidate,
	inspectDesignWorkspaceCandidate,
	replayDesignWorkspace,
	setDesignRootInputSchema,
	updateFindingDispositionsInputSchema,
} from "@/lib/agent/design/artifactWorkspaceOperations";
import { did, fixtureValue, makeContract, makeV2Contract } from "./fixtures";

describe("design artifact workspaces", () => {
	it("starts new authoring at v2 and upgrades v1 only through an explicit root operation", () => {
		expect(initialDesignWorkspaceCandidate("contract")).toMatchObject({
			schemaVersion: 2,
			lookupTables: [],
		});
		const upgraded = replayDesignWorkspace({
			kind: "revision",
			baseContract: makeContract(),
			operations: [
				{
					kind: "revision",
					root: { schemaVersion: 2 },
					collections: [],
				},
			],
		});
		expect(upgraded).toMatchObject({ schemaVersion: 2, lookupTables: [] });
		expect(makeV2Contract().schemaVersion).toBe(2);
	});

	it("replays semantic root and collection updates", () => {
		const contract = makeContract();
		const root = setDesignRootInputSchema.parse({
			id: contract.id,
			charter: contract.charter,
		});
		const actors = designCollectionUpdateInputSchemas.actors.parse({
			upserts: contract.actors,
			removeIds: [],
		});
		const candidate = replayDesignWorkspace({
			kind: "contract",
			operations: [
				{ kind: "contract", root, collections: [] },
				{
					kind: "contract",
					collections: [{ collection: "actors", ...actors }],
				},
			],
		});
		expect(candidate.charter).toEqual(contract.charter);
		expect(candidate.actors).toEqual(contract.actors);
	});

	it("updates by identity without resending unchanged collections", () => {
		const contract = makeContract();
		const changed = {
			...fixtureValue(contract.actors[0], "first actor"),
			name: "Field worker",
		};
		const candidate = replayDesignWorkspace({
			kind: "revision",
			baseContract: contract,
			operations: [
				{
					kind: "revision",
					collections: [
						{ collection: "actors", upserts: [changed], removeIds: [] },
					],
				},
			],
		});
		expect((candidate.actors as typeof contract.actors)[0]?.name).toBe(
			"Field worker",
		);
		expect(candidate.records).toEqual(contract.records);
	});

	it("keeps blocking dispositions separate from contract collections", () => {
		const parsed = updateFindingDispositionsInputSchema.parse({
			upserts: [
				{
					findingId: did(500),
					status: "accepted",
					rationale: "Corrected the workflow readback.",
				},
			],
			removeIds: [],
		});
		expect(parsed.upserts).toHaveLength(1);
	});

	it("rejects empty semantic updates and bounds oversized operations", () => {
		expect(
			designCollectionUpdateInputSchemas.actors.safeParse({
				upserts: [],
				removeIds: [],
			}).success,
		).toBe(false);
		const contract = makeContract();
		const operation = {
			kind: "contract" as const,
			collections: [
				{
					collection: "actors" as const,
					upserts: Array.from({ length: 33 }, (_, index) => ({
						...fixtureValue(contract.actors[0], "first actor"),
						id: did(1000 + index),
					})),
					removeIds: [],
				},
			],
		};
		expect(
			designWorkspaceBoundError({ input: operation, operation }),
		).toContain("at most 32");
	});

	it("summarizes and inspects exact candidate state", () => {
		const contract = makeContract() as unknown as Record<string, unknown>;
		expect(
			designWorkspaceCandidateSummary("contract", contract).counts,
		).toMatchObject({
			actors: 2,
			records: 2,
			workflows: 2,
			moduleCompositions: 1,
			formCompositions: 2,
			lookupTables: 0,
		});
		const view = inspectDesignWorkspaceCandidate({
			kind: "contract",
			candidate: contract,
			selection: {
				kind: "collection",
				collection: "workflows",
				ids: [],
				offset: 0,
				limit: 1,
			},
		});
		expect(view).toMatchObject({ total: 2, truncated: true });
	});
});
