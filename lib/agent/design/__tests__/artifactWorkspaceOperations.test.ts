import { describe, expect, it } from "vitest";
import {
	designWorkspaceBoundError,
	designWorkspaceCandidateSummary,
	inspectDesignWorkspaceCandidate,
	replayDesignWorkspace,
	stageContractInputSchema,
	stageRevisionInputSchema,
} from "@/lib/agent/design/artifactWorkspaceOperations";
import { did, fixtureValue, makeContract } from "./fixtures";

describe("design artifact workspaces", () => {
	it("stages a lean contract root and coherent collections", () => {
		const contract = makeContract();
		const root = stageContractInputSchema.parse({
			expectedRevision: 0,
			root: { id: contract.id, charter: contract.charter },
			collections: [],
		});
		const actors = stageContractInputSchema.parse({
			expectedRevision: 1,
			collections: [
				{ collection: "actors", upserts: contract.actors, removeIds: [] },
			],
		});
		const candidate = replayDesignWorkspace({
			kind: "contract",
			operations: [
				{ kind: "contract", root: root.root, collections: root.collections },
				{ kind: "contract", collections: actors.collections },
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
		const parsed = stageRevisionInputSchema.parse({
			expectedRevision: 0,
			collections: [],
			dispositions: {
				collection: "dispositions",
				upserts: [
					{
						findingId: did(500),
						status: "accepted",
						rationale: "Corrected the workflow readback.",
					},
				],
				removeIds: [],
			},
		});
		expect(parsed.dispositions?.upserts).toHaveLength(1);
	});

	it("rejects empty stages and bounds oversized stages", () => {
		expect(
			stageContractInputSchema.safeParse({
				expectedRevision: 0,
				collections: [],
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
