/** Offline integration of staged design tools with the real artifact store. */

import { beforeEach, describe, expect, it } from "vitest";
import {
	type DesignArtifactWriteAuthority,
	insertDesignSourcePackage,
	readDesignReviews,
	readLatestAcceptedDesignRevision,
	readLatestDesignBuildPlanForRevision,
} from "@/lib/agent/design/artifactStore";
import {
	type AppDesignContract,
	collectContractIds,
} from "@/lib/agent/design/contract";
import { designIdSchema } from "@/lib/agent/design/ids";
import { deterministicDesignId } from "@/lib/agent/design/loop/claimSeeding";
import { DesignRepairTracker } from "@/lib/agent/design/loop/gates";
import {
	createDesignLoopTools,
	type DesignLoopToolDeps,
} from "@/lib/agent/design/loop/tools";
import type { DesignReview } from "@/lib/agent/design/review";
import {
	computeSourcePackageDigest,
	type DesignSourcePackage,
} from "@/lib/agent/design/sourcePackage";
import type {
	StructuredModelRunArgs,
	StructuredModelRunContext,
} from "@/lib/agent/modelRunContext";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { did, fixtureValue, ids, makeContract, messageRef } from "./fixtures";

const h = setupAppStateTestDb("design_loop_staged_");
const RUN_ID = "run-1";
const ACTOR = "owner-test";
const PROJECT = "proj-1";
const NONCE = "6a0a35a4-1111-4222-8333-944445555668";
let sessionId: string;
let toolCallSequence = 0;

const authority = (): DesignArtifactWriteAuthority => ({
	actorUserId: ACTOR,
	runId: RUN_ID,
	holderNonce: NONCE,
	expectedProjectId: PROJECT,
});

beforeEach(async () => {
	toolCallSequence = 0;
	sessionId = await h.seedDesignSession({
		owner_user_id: ACTOR,
		project_id: PROJECT,
		run_id: RUN_ID,
		run_holder_nonce: NONCE,
		run_actor_user_id: ACTOR,
		run_lease_expires_at: new Date(Date.now() + 60_000),
		reservation: {
			period: "2026-08",
			reserved: 1,
			settled: false,
			userId: ACTOR,
			runId: RUN_ID,
		},
	});
});

function makePackage(): DesignSourcePackage {
	const unsealed: Omit<DesignSourcePackage, "packageDigest"> = {
		schemaVersion: 1,
		designSessionId: sessionId,
		projectId: PROJECT,
		request: {
			blocks: [
				{ ref: messageRef(), text: "Track CHW visits.", truncated: false },
			],
		},
		claims: [],
		attachments: [],
		images: [],
		platformConstraints: [],
		sources: [{ ref: messageRef() }],
	};
	return { ...unsealed, packageDigest: computeSourcePackageDigest(unsealed) };
}

function cleanReview(): DesignReview {
	return {
		schemaVersion: 1,
		id: did(500),
		summary: "The design is coherent and buildable.",
		findings: [],
	};
}

function correctionReview(): DesignReview {
	return {
		schemaVersion: 1,
		id: did(501),
		summary: "One workflow correction is needed.",
		findings: [
			{
				id: did(502),
				category: "workflow-gap",
				severity: "important",
				basis: "source-supported",
				dispositionClass: "design-correction",
				claim: "The visit workflow needs explicit confirmation after save.",
				evidenceRefs: [messageRef()],
				affectedElementIds: [resolvedFixtureId(ids.taskVisit)],
				proposedResolution: "Confirm the saved visit summary.",
			},
		],
	};
}

function scriptedContext(
	nextReview: () => DesignReview,
): StructuredModelRunContext {
	return {
		userId: ACTOR,
		projectId: PROJECT,
		runId: RUN_ID,
		get target() {
			return { kind: "design-session" as const, designSessionId: sessionId };
		},
		model: () => {
			throw new Error("no live model in this test");
		},
		trackSubGeneration: () => {},
		async runStructured<T>(args: StructuredModelRunArgs<T>) {
			const parsed = args.schema.safeParse(nextReview());
			return parsed.success
				? {
						object: parsed.data,
						usage: undefined,
						warnings: undefined,
						finishReason: "stop" as const,
					}
				: {
						object: null,
						usage: undefined,
						warnings: undefined,
						finishReason: "stop" as const,
					};
		},
	};
}

function mount(
	pkg: DesignSourcePackage,
	nextReview: () => DesignReview = cleanReview,
	repair = new DesignRepairTracker(),
) {
	return createDesignLoopTools({
		designSessionId: sessionId,
		runId: RUN_ID,
		authority: authority(),
		currentPkg: pkg,
		catalogText: "CATALOG",
		ctx: scriptedContext(nextReview),
		signal: new AbortController().signal,
		repair,
		loadAncestry: async () => {
			const { loadDesignAncestry } = await import(
				"@/lib/agent/design/loop/gates"
			);
			return loadDesignAncestry(sessionId, pkg.packageDigest);
		},
		rebuildPackageForDigest: async () => null,
	} satisfies DesignLoopToolDeps);
}

async function call(
	tool: { execute: (...args: never[]) => Promise<unknown> },
	input: unknown = {},
	toolCallId = `tool-${++toolCallSequence}`,
): Promise<Record<string, unknown>> {
	const execute = tool.execute as (
		input: unknown,
		options: { toolCallId: string },
	) => Promise<unknown>;
	return (await execute(input, { toolCallId })) as Record<string, unknown>;
}

const COLLECTIONS = [
	"actors",
	"records",
	"externalRequirements",
	"workflows",
	"lists",
	"access",
	"navigation",
	"decisions",
	"assumptions",
	"openQuestions",
] as const;

function handleForFixtureId(id: string): string {
	return `@design_${id.replaceAll("-", "").slice(-24)}`;
}

function resolvedFixtureId(id: string) {
	return designIdSchema.parse(
		deterministicDesignId(
			`design-workspace-v1:${sessionId}:${handleForFixtureId(id)}`,
		),
	);
}

function projectFixtureIdentities(
	value: unknown,
	contract: AppDesignContract,
	mode: "handles" | "resolved",
): unknown {
	const declared = collectContractIds(contract);
	const visit = (entry: unknown): unknown => {
		if (typeof entry === "string" && declared.has(entry)) {
			return mode === "handles"
				? { handle: handleForFixtureId(entry) }
				: resolvedFixtureId(entry);
		}
		if (Array.isArray(entry)) return entry.map(visit);
		if (entry === null || typeof entry !== "object") return entry;
		return Object.fromEntries(
			Object.entries(entry).map(([key, nested]) => [key, visit(nested)]),
		);
	};
	return visit(value);
}

function modelContract(contract: AppDesignContract) {
	return projectFixtureIdentities(contract, contract, "handles") as never;
}

function resolvedContract(contract: AppDesignContract): AppDesignContract {
	return projectFixtureIdentities(
		contract,
		contract,
		"resolved",
	) as AppDesignContract;
}

async function stageWholeContract(
	tools: ReturnType<typeof createDesignLoopTools>,
	contract: AppDesignContract,
	startRevision = 0,
): Promise<number> {
	const projected = modelContract(contract) as AppDesignContract;
	let revision = startRevision;
	if (revision === 0) {
		const root = await call(tools.stageContract, {
			expectedRevision: revision,
			root: { id: projected.id },
			collections: [],
		});
		revision = Number(root.workspaceRevision);
	}
	for (const collection of COLLECTIONS) {
		const items = projected[collection];
		if (items.length === 0) continue;
		const staged = await call(tools.stageContract, {
			expectedRevision: revision,
			collections: [{ collection, upserts: items, removeIds: [] }],
		});
		revision = Number(staged.workspaceRevision);
	}
	const charter = await call(tools.stageContract, {
		expectedRevision: revision,
		root: { charter: projected.charter },
		collections: [],
	});
	revision = Number(charter.workspaceRevision);
	return revision;
}

describe("staged design loop", () => {
	it("persists, reviews, accepts, and deterministically plans a clean design", async () => {
		const pkg = makePackage();
		await insertDesignSourcePackage({ pkg, authority: authority() });
		const tools = mount(pkg);
		const workspaceRevision = await stageWholeContract(tools, makeContract());
		expect(
			await call(tools.submitContract, { expectedRevision: workspaceRevision }),
		).toMatchObject({ ok: true });
		expect(await call(tools.requestReview)).toMatchObject({
			ok: true,
			accepted: true,
		});

		const accepted = await readLatestAcceptedDesignRevision(sessionId);
		if (accepted === null) throw new Error("accepted revision missing");
		const plan = await readLatestDesignBuildPlanForRevision(accepted.id);
		expect(plan?.envelope.producer).toMatchObject({
			provider: "nova",
			modelId: "deterministic-build-planner-v1",
		});
		expect(plan?.envelope.payload.slices).toHaveLength(2);
	});

	it("resolves readable model handles to stable server identities", async () => {
		const pkg = makePackage();
		await insertDesignSourcePackage({ pkg, authority: authority() });
		const tools = mount(pkg);
		const result = await call(tools.stageContract, {
			expectedRevision: 0,
			root: { id: { handle: "@contract" } },
			collections: [],
		});
		expect(result).toMatchObject({ ok: true, workspaceRevision: 1 });
		const inspected = await call(tools.inspectDesignWorkspace, {
			artifactKind: "contract",
			expectedRevision: 1,
			selection: { kind: "root" },
		});
		const root = (inspected.view as { root: Record<string, unknown> }).root;
		expect(root.id).toEqual({ handle: "@contract" });

		const contract = makeContract();
		const sourceRecord = fixtureValue(contract.records[0], "first record");
		const record = (modelContract(contract) as AppDesignContract).records[0];
		if (record === undefined) throw new Error("record fixture missing");
		const stagedRecord = await call(tools.stageContract, {
			expectedRevision: 1,
			collections: [
				{ collection: "records", upserts: [record], removeIds: [] },
			],
		});
		expect(stagedRecord).toMatchObject({ ok: true, workspaceRevision: 2 });
		const inspectedRecord = await call(tools.inspectDesignWorkspace, {
			artifactKind: "contract",
			expectedRevision: 2,
			selection: {
				kind: "collection",
				collection: "records",
				ids: [{ handle: handleForFixtureId(sourceRecord.id) }],
				offset: 0,
				limit: 20,
			},
		});
		expect(inspectedRecord).toMatchObject({
			ok: true,
			view: {
				kind: "collection",
				collection: "records",
				total: 1,
				items: [{ id: { handle: handleForFixtureId(sourceRecord.id) } }],
			},
		});
		expect(
			await call(tools.inspectDesignWorkspace, {
				artifactKind: "contract",
				expectedRevision: 2,
				selection: {
					kind: "collection",
					collection: "records",
					ids: [{ handle: "@not_declared" }],
					offset: 0,
					limit: 20,
				},
			}),
		).toMatchObject({
			diagnostic: { code: "design-unbound-handle", issueCount: 1 },
		});
	});

	it("rejects raw new UUID declarations and undeclared symbolic references", async () => {
		const pkg = makePackage();
		await insertDesignSourcePackage({ pkg, authority: authority() });
		const tools = mount(pkg);
		const raw = await call(tools.stageContract, {
			expectedRevision: 0,
			root: { id: did(999) },
			collections: [],
		});
		expect(raw).toMatchObject({
			diagnostic: { code: "design-creation-handle-required", issueCount: 1 },
		});
		const unbound = await call(tools.stageContract, {
			expectedRevision: 0,
			root: {
				id: { handle: "@contract" },
				charter: {
					...makeContract().charter,
					includedWorkflowIds: [{ handle: "@undeclared_workflow" }],
					initialWorkflowId: { handle: "@undeclared_workflow" },
				},
			},
			collections: [],
		});
		expect(unbound).toMatchObject({
			diagnostic: { code: "design-unbound-handle", issueCount: 1 },
		});
		const unknownReference = await call(tools.stageContract, {
			expectedRevision: 0,
			root: {
				id: { handle: "@contract" },
				charter: {
					...makeContract().charter,
					includedWorkflowIds: [did(998)],
					initialWorkflowId: did(998),
				},
			},
			collections: [],
		});
		expect(unknownReference).toMatchObject({
			diagnostic: { code: "design-creation-handle-required", issueCount: 1 },
		});
		expect(unknownReference.error).toContain("unknown raw design UUID");

		const unknownRemoval = await call(tools.stageContract, {
			expectedRevision: 0,
			collections: [
				{ collection: "records", upserts: [], removeIds: [did(997)] },
			],
		});
		expect(unknownRemoval.error).toContain("unknown raw design UUID");
	});

	it("rejects duplicate declaration identities before they enter the workspace ledger", async () => {
		const pkg = makePackage();
		await insertDesignSourcePackage({ pkg, authority: authority() });
		const tools = mount(pkg);
		const contract = makeContract();
		const projected = modelContract(contract) as AppDesignContract;
		const root = await call(tools.stageContract, {
			expectedRevision: 0,
			root: { id: projected.id },
			collections: [],
		});
		const baseRecord = fixtureValue(contract.records[0], "first record");
		const collidingRecords = Array.from({ length: 6 }, (_, index) => {
			const identity = { handle: `@collision_${index}` };
			return {
				...(projectFixtureIdentities(
					baseRecord,
					contract,
					"handles",
				) as object),
				id: identity,
				name: `record_${index}`,
				properties: [
					{
						...(projectFixtureIdentities(
							fixtureValue(baseRecord.properties[0], "first property"),
							contract,
							"handles",
						) as object),
						id: identity,
						name: `property_${index}`,
					},
				],
			};
		});
		const rejected = await call(tools.stageContract, {
			expectedRevision: root.workspaceRevision,
			collections: [
				{
					collection: "records",
					upserts: collidingRecords,
					removeIds: [],
				},
			],
		});
		expect(rejected).toMatchObject({
			diagnostic: {
				code: "design-partial-identity-rejected",
				validationStage: "partial",
				issueCount: 1,
			},
		});
		const inspected = await call(tools.inspectDesignWorkspace, {
			artifactKind: "contract",
			expectedRevision: root.workspaceRevision,
			selection: { kind: "summary" },
		});
		expect(inspected).toMatchObject({
			ok: true,
			workspaceRevision: 1,
			stepCount: 1,
		});
	});

	it("routes construction-bearing open questions outside repair convergence", async () => {
		const pkg = makePackage();
		await insertDesignSourcePackage({ pkg, authority: authority() });
		const repair = new DesignRepairTracker();
		const tools = mount(pkg, cleanReview, repair);
		const contract = makeContract();
		contract.openQuestions.push(
			...Array.from({ length: 7 }, (_, index) => ({
				id: did(1100 + index),
				question: `Which construction decision ${index + 1} applies?`,
				structuralImpact: "local" as const,
				blocking: true,
				relatedElementIds: [ids.taskVisit],
			})),
		);
		const root = await call(tools.stageContract, {
			expectedRevision: 0,
			root: { id: (modelContract(contract) as AppDesignContract).id },
			collections: [],
		});
		const firstSubmission = await call(tools.submitContract, {
			expectedRevision: root.workspaceRevision,
		});
		expect(firstSubmission).toMatchObject({
			diagnostic: { validationStage: "schema" },
		});

		const completeRevision = await stageWholeContract(
			tools,
			contract,
			Number(root.workspaceRevision),
		);
		const needsInput = await call(tools.submitContract, {
			expectedRevision: completeRevision,
		});
		expect(needsInput).toMatchObject({
			diagnostic: {
				code: "design-construction-needs-input",
				validationStage: "construction",
				issueCount: 7,
			},
			needsUserInput: { maxQuestionsPerRound: 5 },
		});
		expect(
			(needsInput.needsUserInput as { questions: string[] }).questions,
		).toHaveLength(7);
		expect(repair.requiredUserQuestions()).toHaveLength(7);
		expect(repair.fatalError()).toBeUndefined();

		/* A replacement process has no repair tracker state. The open workspace is
		 * the durable authority, so it must recover the same exact questions before
		 * permitting another design operation. */
		const { readRequiredDesignQuestionsFromWorkspace } = await import(
			"@/lib/agent/build/designLoopRunner"
		);
		const { evaluateDesignGates, loadDesignAncestry } = await import(
			"@/lib/agent/design/loop/gates"
		);
		const recovered = await readRequiredDesignQuestionsFromWorkspace({
			designSessionId: sessionId,
			gates: evaluateDesignGates(
				await loadDesignAncestry(sessionId, pkg.packageDigest),
			),
			authority: authority(),
		});
		expect(recovered.map((question) => question.question)).toEqual(
			(needsInput.needsUserInput as { questions: string[] }).questions,
		);
		expect(
			await call(tools.stageContract, {
				expectedRevision: completeRevision,
				collections: [],
			}),
		).toMatchObject({
			diagnostic: {
				code: "design-required-question-pending",
				validationStage: "construction",
				issueCount: 7,
			},
		});
	});

	it("keeps an invalid candidate open so only missing collections are added", async () => {
		const pkg = makePackage();
		await insertDesignSourcePackage({ pkg, authority: authority() });
		const tools = mount(pkg);
		const contract = makeContract();
		const projected = modelContract(contract) as AppDesignContract;
		const root = await call(tools.stageContract, {
			expectedRevision: 0,
			root: { id: projected.id },
			collections: [],
		});
		expect(
			await call(tools.submitContract, {
				expectedRevision: root.workspaceRevision,
			}),
		).toHaveProperty("error");
		const completeRevision = await stageWholeContract(
			tools,
			contract,
			Number(root.workspaceRevision),
		);
		expect(
			await call(tools.submitContract, { expectedRevision: completeRevision }),
		).toMatchObject({ ok: true });
	});

	it("revises only affected items and dispositions after a blocking review", async () => {
		const pkg = makePackage();
		await insertDesignSourcePackage({ pkg, authority: authority() });
		const tools = mount(pkg, correctionReview);
		const contract = makeContract();
		const resolved = resolvedContract(contract);
		const contractRevision = await stageWholeContract(tools, contract);
		await call(tools.submitContract, { expectedRevision: contractRevision });
		expect(await call(tools.requestReview)).toMatchObject({ accepted: false });
		const collidingRevision = await call(tools.stageRevision, {
			expectedRevision: 0,
			collections: [
				{
					collection: "workflows",
					upserts: [
						{
							...fixtureValue(resolved.workflows[1], "second workflow"),
							id: fixtureValue(resolved.records[0], "first record").id,
						},
					],
					removeIds: [],
				},
			],
		});
		expect(collidingRevision).toMatchObject({
			diagnostic: {
				code: "design-partial-identity-rejected",
				validationStage: "partial",
				issueCount: 1,
			},
		});

		const workflow = {
			...fixtureValue(resolved.workflows[1], "second workflow"),
			readback: [
				{
					recordId: resolvedFixtureId(ids.recVisit),
					purpose: "Confirm the visit was saved",
					propertyIds: [resolvedFixtureId(ids.factVisitSummary)],
				},
			],
		};
		const staged = await call(tools.stageRevision, {
			expectedRevision: 0,
			collections: [
				{ collection: "workflows", upserts: [workflow], removeIds: [] },
			],
			dispositions: {
				collection: "dispositions",
				upserts: [
					{
						findingId: did(502),
						status: "accepted",
						rationale: "The saved visit is now explicitly confirmed.",
					},
				],
				removeIds: [],
			},
		});
		expect(
			await call(tools.submitRevision, {
				expectedRevision: staged.workspaceRevision,
			}),
		).toMatchObject({ ok: true, accepted: true });
		const accepted = await readLatestAcceptedDesignRevision(sessionId);
		expect(accepted?.envelope.payload.actors).toEqual(resolved.actors);
		if (accepted?.parentRevisionId === null || accepted === null)
			throw new Error("accepted revision parent missing");
		expect(await readDesignReviews(accepted.parentRevisionId)).toHaveLength(1);
	});

	it("deduplicates an exact repeated stage tool call", async () => {
		const pkg = makePackage();
		await insertDesignSourcePackage({ pkg, authority: authority() });
		const tools = mount(pkg);
		const projected = modelContract(makeContract()) as AppDesignContract;
		const input = {
			expectedRevision: 0,
			root: { id: projected.id },
			collections: [],
		};
		const first = await call(tools.stageContract, input, "same-call");
		const second = await call(tools.stageContract, input, "same-call");
		expect(first).toMatchObject({ deduplicated: false });
		expect(second).toMatchObject({ deduplicated: true });
	});
});
