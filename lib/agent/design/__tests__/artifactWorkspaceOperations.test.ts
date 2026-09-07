import { describe, expect, it } from "vitest";
import {
	designArtifactWorkspaceOperationSchema,
	designCollectionUpdateInputSchemas,
	designWorkspaceBoundError,
	designWorkspaceCandidateSummary,
	designWorkspaceMutationCount,
	initialDesignWorkspaceCandidate,
	inspectDesignWorkspaceCandidate,
	normalizeStoredDesignArtifactWorkspaceOperation,
	prepareDesignArtifactWorkspaceOperationForStorage,
	replayDesignWorkspace,
	setDesignRootInputSchema,
	updateFindingDispositionsInputSchema,
} from "@/lib/agent/design/artifactWorkspaceOperations";
import { appDesignContractSchema } from "../contract";
import {
	addPatientReviewWorkflow,
	did,
	fixtureValue,
	ids,
	makeContract,
} from "./fixtures";

describe("design artifact workspaces", () => {
	it("reconstructs an admitted complete contract from independently persisted semantic updates", () => {
		const contract = appDesignContractSchema.parse(makeContract());
		const operations = [
			designArtifactWorkspaceOperationSchema.parse({
				kind: "contract",
				root: { schemaVersion: 1, id: contract.id, charter: contract.charter },
				collections: [],
			}),
			...Object.entries(contract).flatMap(([collection, items]) =>
				Array.isArray(items) && items.length > 0
					? [
							designArtifactWorkspaceOperationSchema.parse({
								kind: "contract",
								collections: [{ collection, upserts: items, removeIds: [] }],
							}),
						]
					: [],
			),
		];
		const stored = operations.map((operation) =>
			JSON.parse(
				JSON.stringify(
					prepareDesignArtifactWorkspaceOperationForStorage(operation),
				),
			),
		);
		const candidate = replayDesignWorkspace({
			kind: "contract",
			operations: stored.map(normalizeStoredDesignArtifactWorkspaceOperation),
		});
		expect(candidate).toEqual(contract);
		expect(appDesignContractSchema.parse(candidate)).toEqual(contract);
		expect(
			replayDesignWorkspace({
				kind: "revision",
				baseContract: contract,
				operations: [],
			}),
		).toEqual({ ...contract, dispositions: [] });
		expect(() => initialDesignWorkspaceCandidate("revision")).toThrow(
			/base contract/,
		);
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

	it("applies disposition updates by finding identity without changing the contract", () => {
		const contract = appDesignContractSchema.parse(makeContract());
		const first = {
			findingId: did(500),
			status: "accepted" as const,
			rationale: "Corrected the workflow readback.",
		};
		const second = {
			findingId: did(501),
			status: "rejected" as const,
			rationale: "The existing workflow meets the request.",
		};
		const updated = {
			...first,
			rationale: "Confirmed the corrected workflow.",
		};
		const operations = [
			{ upserts: [first, second], removeIds: [] },
			{ upserts: [updated], removeIds: [second.findingId] },
		].map((input) =>
			designArtifactWorkspaceOperationSchema.parse({
				kind: "revision",
				collections: [],
				dispositions: {
					collection: "dispositions",
					...updateFindingDispositionsInputSchema.parse(input),
				},
			}),
		);
		const before = structuredClone(operations);
		expect(
			replayDesignWorkspace({
				kind: "revision",
				baseContract: contract,
				operations,
			}),
		).toEqual({ ...contract, dispositions: [updated] });
		expect(operations).toEqual(before);
		expect(
			replayDesignWorkspace({
				kind: "revision",
				baseContract: contract,
				operations: [],
			}),
		).toEqual({ ...contract, dispositions: [] });
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
		expect(view).toEqual({
			kind: "collection",
			collection: "workflows",
			items: [makeContract().workflows[0]],
			total: 2,
			offset: 0,
			truncated: true,
		});
	});
});

describe("workspace semantic boundaries", () => {
	it("preserves retained order, replaces identities and appends new identities through repeated operations", () => {
		const contract = appDesignContractSchema.parse(makeContract());
		const first = fixtureValue(contract.actors[0], "first actor");
		const second = fixtureValue(contract.actors[1], "second actor");
		const third = { ...first, id: did(600), name: "Supervisor" };
		const fourth = { ...first, id: did(601), name: "Observer" };
		const replaced = { ...second, name: "Updated existing actor" };
		const operations = [
			{ upserts: [third, replaced], removeIds: [first.id] },
			{ upserts: [fourth], removeIds: [] },
			{ upserts: [], removeIds: [third.id, did(777)] },
		].map((input) =>
			designArtifactWorkspaceOperationSchema.parse({
				kind: "revision",
				collections: [{ collection: "actors", ...input }],
			}),
		);
		const inputBefore = structuredClone({ contract, operations });
		const candidate = replayDesignWorkspace({
			kind: "revision",
			baseContract: contract,
			operations,
		});
		// This intentionally partial edit may leave actor references unresolved;
		// replay owns identity/order, while final graph admission is a separate gate.
		expect(candidate).toEqual({
			...contract,
			actors: [replaced, fourth],
			dispositions: [],
		});
		expect({ contract, operations }).toEqual(inputBefore);
		expect(() =>
			replayDesignWorkspace({ kind: "contract", operations }),
		).toThrow(/different artifact kind/);
	});
	it.each(["duplicate", "conflict", "empty", "two-collections"] as const)(
		"refuses %s semantic ambiguity before replay",
		(kind) => {
			const actor = fixtureValue(makeContract().actors[0], "actor");
			const collection = {
				collection: "actors",
				upserts: [actor],
				removeIds: [],
			};
			const candidate =
				kind === "duplicate"
					? { ...collection, upserts: [actor, actor] }
					: kind === "conflict"
						? { ...collection, removeIds: [actor.id] }
						: kind === "empty"
							? { ...collection, upserts: [] }
							: collection;
			expect(
				designArtifactWorkspaceOperationSchema.safeParse({
					kind: "contract",
					collections:
						kind === "two-collections" ? [candidate, candidate] : [candidate],
				}).success,
			).toBe(false);
		},
	);
	it("counts root, collection and disposition work together at the exact cap", () => {
		const actors = Array.from({ length: 30 }, (_, index) => ({
			...fixtureValue(makeContract().actors[0], "actor"),
			id: did(1000 + index),
		}));
		const operation = designArtifactWorkspaceOperationSchema.parse({
			kind: "revision",
			root: { id: did(800) },
			collections: [{ collection: "actors", upserts: actors, removeIds: [] }],
			dispositions: {
				collection: "dispositions",
				upserts: [
					{ findingId: did(900), status: "accepted", rationale: "Resolved." },
				],
				removeIds: [],
			},
		});
		expect(designWorkspaceMutationCount(operation)).toBe(32);
		expect(
			designWorkspaceBoundError({ input: operation, operation }),
		).toBeNull();
		const over = designArtifactWorkspaceOperationSchema.parse({
			...operation,
			root: { ...operation.root, schemaVersion: 1 },
		});
		expect(designWorkspaceBoundError({ input: over, operation: over })).toBe(
			"This call contains 33 item changes; submit at most 32 and continue in another semantic call.",
		);
	});
	it("bounds encoded input bytes, including Unicode, independently of mutation count", () => {
		const operation = designArtifactWorkspaceOperationSchema.parse({
			kind: "contract",
			root: { schemaVersion: 1 },
			collections: [],
		});
		// JSON string quotes cost two bytes; every e-acute costs two UTF-8 bytes.
		const exact = "é".repeat(24575);
		expect(designWorkspaceBoundError({ input: exact, operation })).toBeNull();
		expect(designWorkspaceBoundError({ input: `${exact}x`, operation })).toBe(
			"This call is 49153 bytes; keep each semantic call at or below 49152 bytes and continue in another call.",
		);
	});
	it("filters identities before pagination and keeps source inspection independent", () => {
		const source = appDesignContractSchema.parse(makeContract());
		const changed = {
			...source,
			charter: { ...source.charter, appName: "Edited app" },
			workflows: [...source.workflows].reverse(),
		};
		const view = (
			selection: Parameters<
				typeof inspectDesignWorkspaceCandidate
			>[0]["selection"],
		) =>
			inspectDesignWorkspaceCandidate({
				kind: "revision",
				candidate: changed,
				sourceContract: source,
				selection,
			});
		expect(view({ kind: "root" })).toEqual({
			kind: "root",
			root: { schemaVersion: 1, id: source.id, charter: changed.charter },
		});
		expect(view({ kind: "sourceRoot" })).toEqual({
			kind: "sourceRoot",
			root: { schemaVersion: 1, id: source.id, charter: source.charter },
		});
		const selected = fixtureValue(source.workflows[1], "second workflow");
		expect(
			view({
				kind: "sourceCollection",
				collection: "workflows",
				ids: [selected.id, did(999), selected.id],
				offset: 0,
				limit: 1,
			}),
		).toEqual({
			kind: "sourceCollection",
			collection: "workflows",
			items: [selected],
			total: 1,
			offset: 0,
			truncated: false,
		});
		expect(
			view({
				kind: "collection",
				collection: "workflows",
				ids: [],
				offset: 2,
				limit: 1,
			}),
		).toEqual({
			kind: "collection",
			collection: "workflows",
			items: [],
			total: 2,
			offset: 2,
			truncated: false,
		});
		expect(() =>
			inspectDesignWorkspaceCandidate({
				kind: "contract",
				candidate: source,
				selection: { kind: "sourceRoot" },
			}),
		).toThrow(/no immutable source/);
	});
});
