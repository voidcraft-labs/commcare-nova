import { describe, expect, it } from "vitest";
import {
	designArtifactWorkspaceOperationSchema,
	designCollectionUpdateInputSchemas,
	designWorkspaceBoundError,
	designWorkspaceCandidateSummary,
	initialDesignWorkspaceCandidate,
	inspectDesignWorkspaceCandidate,
	normalizeStoredDesignArtifactWorkspaceOperation,
	prepareDesignArtifactWorkspaceOperationForStorage,
	replayDesignWorkspace,
	setDesignRootInputSchema,
	updateFindingDispositionsInputSchema,
} from "@/lib/agent/design/artifactWorkspaceOperations";
import {
	addPatientReviewWorkflow,
	did,
	fixtureValue,
	ids,
	makeContract,
} from "./fixtures";

describe("design artifact workspaces", () => {
	it("starts every authoring workspace with the complete current contract root", () => {
		expect(initialDesignWorkspaceCandidate("contract")).toMatchObject({
			schemaVersion: 1,
			lookupTables: [],
		});
		const replayed = replayDesignWorkspace({
			kind: "revision",
			baseContract: makeContract(),
			operations: [],
		});
		expect(replayed).toMatchObject({ schemaVersion: 1, lookupTables: [] });
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

	it("replays a stored list selection into exact module-wide coverage", () => {
		const contract = makeContract();
		const legacyList = {
			...fixtureValue(contract.lists[0], "patient list"),
			selectionWorkflowId: ids.taskVisit,
		};
		const rawLegacyOperation = {
			kind: "revision" as const,
			collections: [
				{
					collection: "lists" as const,
					upserts: [legacyList],
					removeIds: [],
				},
			],
		};
		expect(
			designArtifactWorkspaceOperationSchema.safeParse(rawLegacyOperation)
				.success,
		).toBe(false);
		const storedLegacyOperation =
			normalizeStoredDesignArtifactWorkspaceOperation(rawLegacyOperation);
		const currentListOperation = designArtifactWorkspaceOperationSchema.parse({
			kind: "revision",
			collections: [
				{
					collection: "lists",
					upserts: [{ ...contract.lists[0], name: "Current patient list" }],
					removeIds: [],
				},
			],
		});
		const legacyModule = structuredClone(
			fixtureValue(contract.moduleCompositions[0], "patient module"),
		) as Record<string, unknown>;
		delete legacyModule.selection;
		const moduleOperation = normalizeStoredDesignArtifactWorkspaceOperation({
			kind: "revision",
			collections: [
				{
					collection: "moduleCompositions",
					upserts: [legacyModule],
					removeIds: [],
				},
			],
		});
		const formOperation = designArtifactWorkspaceOperationSchema.parse({
			kind: "revision",
			collections: [
				{
					collection: "formCompositions",
					upserts: contract.formCompositions,
					removeIds: [],
				},
			],
		});
		const legacyBase = structuredClone(contract) as unknown as Record<
			string,
			unknown
		>;
		legacyBase.lists = [];
		legacyBase.moduleCompositions = [];
		legacyBase.formCompositions = [];

		const incomplete = replayDesignWorkspace({
			kind: "revision",
			baseContract: legacyBase,
			operations: [storedLegacyOperation, currentListOperation],
		});
		expect(incomplete.moduleCompositions).toEqual([]);
		expect(JSON.stringify(incomplete)).not.toContain("selectionWorkflowId");

		const replayed = replayDesignWorkspace({
			kind: "revision",
			baseContract: legacyBase,
			operations: [
				storedLegacyOperation,
				currentListOperation,
				moduleOperation,
				formOperation,
			],
		});
		expect(replayed.moduleCompositions).toMatchObject([
			{
				id: ids.modulePatients,
				selection: { workflowIds: [ids.taskVisit], cases: "one" },
			},
		]);
		expect(replayed.lists).toMatchObject([{ name: "Current patient list" }]);
		expect(JSON.stringify(replayed)).not.toContain("selectionWorkflowId");
	});

	it("recomputes markerless legacy module coverage as later forms arrive", () => {
		const contract = makeContract();
		addPatientReviewWorkflow(contract);
		const legacyModule = structuredClone(
			fixtureValue(contract.moduleCompositions[0], "patient module"),
		) as Record<string, unknown>;
		delete legacyModule.selection;
		const rawModuleOperation = {
			kind: "revision" as const,
			collections: [
				{
					collection: "moduleCompositions" as const,
					upserts: [legacyModule],
					removeIds: [],
				},
			],
		};
		const legacyModuleOperation =
			normalizeStoredDesignArtifactWorkspaceOperation(rawModuleOperation);
		const visitFormOperation = designArtifactWorkspaceOperationSchema.parse({
			kind: "revision",
			collections: [
				{
					collection: "formCompositions",
					upserts: [
						fixtureValue(
							contract.formCompositions.find(
								(form) => form.id === ids.formVisit,
							),
							"visit form",
						),
					],
					removeIds: [],
				},
			],
		});
		const reviewFormOperation = designArtifactWorkspaceOperationSchema.parse({
			kind: "revision",
			collections: [
				{
					collection: "formCompositions",
					upserts: [
						fixtureValue(
							contract.formCompositions.find(
								(form) => form.id === ids.formReview,
							),
							"review form",
						),
					],
					removeIds: [],
				},
			],
		});
		const legacyBase = structuredClone(contract) as unknown as Record<
			string,
			unknown
		>;
		legacyBase.moduleCompositions = [];
		legacyBase.formCompositions = [];

		const partial = replayDesignWorkspace({
			kind: "revision",
			baseContract: legacyBase,
			operations: [legacyModuleOperation, visitFormOperation],
		});
		expect(partial.moduleCompositions).toMatchObject([
			{ selection: { workflowIds: [ids.taskVisit], cases: "one" } },
		]);
		const storedModuleMutation = fixtureValue(
			legacyModuleOperation.collections[0],
			"stored legacy module mutation",
		);
		expect(
			(
				fixtureValue(
					storedModuleMutation.upserts[0],
					"stored legacy module",
				) as Record<string, unknown>
			).selection,
		).toBeUndefined();

		const complete = replayDesignWorkspace({
			kind: "revision",
			baseContract: legacyBase,
			operations: [
				legacyModuleOperation,
				visitFormOperation,
				reviewFormOperation,
			],
		});
		expect(complete.moduleCompositions).toMatchObject([
			{
				selection: {
					workflowIds: [ids.taskVisit, ids.taskReview],
					cases: "one",
				},
			},
		]);

		const currentModuleOperation =
			normalizeStoredDesignArtifactWorkspaceOperation(
				prepareDesignArtifactWorkspaceOperationForStorage(
					designArtifactWorkspaceOperationSchema.parse(rawModuleOperation),
				),
			);
		const currentCandidate = replayDesignWorkspace({
			kind: "revision",
			baseContract: legacyBase,
			operations: [
				currentModuleOperation,
				visitFormOperation,
				reviewFormOperation,
			],
		});
		expect(currentCandidate.moduleCompositions).toHaveLength(1);
		expect(
			(currentCandidate.moduleCompositions as Record<string, unknown>[])[0],
		).not.toHaveProperty("selection");
		expect(() =>
			normalizeStoredDesignArtifactWorkspaceOperation({
				storageVersion: 3,
				operation: rawModuleOperation,
			}),
		).toThrow();
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
