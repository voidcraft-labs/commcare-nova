import { describe, expect, it } from "vitest";
import {
	designWorkspaceBoundError,
	designWorkspaceCandidateSummary,
	inspectDesignWorkspaceCandidate,
	replayDesignWorkspace,
} from "@/lib/agent/design/artifactWorkspaceOperations";
import { did, makeContract } from "./fixtures";

describe("design artifact workspace replay", () => {
	it("applies ordered identity upserts and removals deterministically", () => {
		const contract = makeContract();
		const actor = contract.actors[0];
		if (actor === undefined) throw new Error("fixture actor is missing");
		const replacement = { ...actor, name: "Updated worker" };
		const candidate = replayDesignWorkspace({
			kind: "contract",
			operations: [
				{
					kind: "contract",
					root: {
						id: contract.id,
						title: contract.title,
						objective: contract.objective,
						inScope: contract.inScope,
						outOfScope: contract.outOfScope,
					},
					collections: [
						{
							collection: "actors",
							upserts: contract.actors,
							removeIds: [],
						},
					],
				},
				{
					kind: "contract",
					collections: [
						{
							collection: "actors",
							upserts: [replacement],
							removeIds: [
								contract.actors.find((item) => item.id !== actor.id)?.id ??
									did(999),
							],
						},
					],
				},
			],
		});
		expect(candidate.actors).toEqual([replacement]);
		expect(
			designWorkspaceCandidateSummary("contract", candidate),
		).toMatchObject({
			counts: { actors: 1 },
			missingRootFields: [],
		});
	});

	it("starts revisions from the immutable parent and keeps unchanged collections", () => {
		const contract = makeContract();
		const question = contract.openQuestions[0];
		if (question === undefined) throw new Error("fixture question is missing");
		const candidate = replayDesignWorkspace({
			kind: "revision",
			baseContract: contract as unknown as Record<string, unknown>,
			operations: [
				{
					kind: "revision",
					collections: [
						{
							collection: "openQuestions",
							upserts: [{ ...question, blocking: false }],
							removeIds: [],
						},
					],
				},
			],
		});
		expect(candidate.facts).toEqual(contract.facts);
		expect(candidate.openQuestions).toEqual([{ ...question, blocking: false }]);
		expect(candidate.dispositions).toEqual([]);
	});

	it("returns bounded exact collection inspection", () => {
		const contract = makeContract();
		const candidate = {
			...contract,
			actors: Array.from({ length: 25 }, (_, index) => ({
				...contract.actors[0],
				id: did(800 + index),
				name: `Actor ${index}`,
			})),
		};
		const inspected = inspectDesignWorkspaceCandidate({
			kind: "contract",
			candidate,
			selection: {
				kind: "collection",
				collection: "actors",
				ids: [],
				offset: 10,
				limit: 5,
			},
		});
		expect(inspected).toMatchObject({
			collection: "actors",
			total: 25,
			offset: 10,
		});
		expect((inspected as { items: unknown[] }).items).toHaveLength(5);
	});
});

describe("design artifact workspace bounds", () => {
	it("rejects more than 32 item changes before persistence", () => {
		const operation = {
			kind: "contract" as const,
			collections: [
				{
					collection: "actors" as const,
					upserts: [],
					removeIds: Array.from({ length: 33 }, (_, index) => did(900 + index)),
				},
			],
		};
		expect(
			designWorkspaceBoundError({ input: operation, operation }),
		).toContain("at most 32");
	});
});
