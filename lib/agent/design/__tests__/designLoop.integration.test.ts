/** Offline integration of semantic design tools with the real artifact store. */

import { beforeEach, describe, expect, it } from "vitest";
import {
	type DesignArtifactWriteAuthority,
	insertDesignSourcePackage,
	readDesignReviews,
	readDispositions,
	readLatestAcceptedDesignRevision,
	readLatestDesignBuildPlanForRevision,
} from "@/lib/agent/design/artifactStore";
import {
	type AppDesignContract,
	collectContractIds,
} from "@/lib/agent/design/contract";
import { designIdSchema } from "@/lib/agent/design/ids";
import { deterministicDesignId } from "@/lib/agent/design/loop/claimSeeding";
import {
	DESIGN_STAGE_REPAIR_BUDGET,
	DesignRepairTracker,
} from "@/lib/agent/design/loop/gates";
import {
	createDesignLoopTools,
	type DesignLoopToolDeps,
} from "@/lib/agent/design/loop/tools";
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

/* The scripted reviewer emits what the live model emits: the WIRE shape —
 * source tags, element @handles, no identities. The real reviewer schema
 * resolves it against the session's actual ledger bindings, so these tests
 * exercise the symbol resolution end to end. */
function cleanReview(): unknown {
	return {
		summary: "The design is coherent and buildable.",
		findings: [],
	};
}

function correctionReview(): unknown {
	return {
		summary: "One workflow correction is needed.",
		findings: [
			{
				severity: "important",
				dispositionClass: "design-correction",
				claim: "The visit workflow needs explicit confirmation after save.",
				evidenceRefs: [{ source: "S1" }],
				affectedElements: [handleForFixtureId(ids.taskVisit)],
				proposedResolution: "Confirm the saved visit summary.",
			},
		],
	};
}

function scriptedContext(nextReview: () => unknown): StructuredModelRunContext {
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
	nextReview: () => unknown = cleanReview,
	repair = new DesignRepairTracker(),
	ancestry?: Pick<DesignLoopToolDeps, "loadAncestry" | "ancestryChanged">,
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
		loadAncestry:
			ancestry?.loadAncestry ??
			(async () => {
				const { loadDesignAncestry } = await import(
					"@/lib/agent/design/loop/gates"
				);
				return loadDesignAncestry(sessionId, pkg.packageDigest);
			}),
		/* The suite's default loadAncestry reads fresh every call, so there is
		 * no memo to drop. */
		ancestryChanged: ancestry?.ancestryChanged ?? (() => {}),
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
	"moduleCompositions",
	"formCompositions",
	"decisions",
	"assumptions",
	"openQuestions",
] as const;

const COLLECTION_TO_TOOL = {
	actors: "updateActors",
	records: "updateRecords",
	externalRequirements: "updateExternalRequirements",
	workflows: "updateWorkflows",
	lists: "updateLists",
	access: "updateAccess",
	navigation: "updateNavigation",
	moduleCompositions: "updateModuleCompositions",
	formCompositions: "updateFormCompositions",
	decisions: "updateDecisions",
	assumptions: "updateAssumptions",
	openQuestions: "updateOpenQuestions",
} as const;

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

async function authorWholeContract(
	tools: ReturnType<typeof createDesignLoopTools>,
	contract: AppDesignContract,
): Promise<void> {
	const projected = modelContract(contract) as AppDesignContract;
	await call(tools.setDesignRoot, { id: projected.id });
	for (const collection of COLLECTIONS) {
		const items = projected[collection];
		if (items.length === 0) continue;
		await call(tools[COLLECTION_TO_TOOL[collection]], {
			upserts: items,
			removeIds: [],
		});
	}
	await call(tools.setDesignRoot, { charter: projected.charter });
}

describe("semantic design loop", () => {
	it("persists, reviews, accepts, and deterministically plans a clean design", async () => {
		const pkg = makePackage();
		await insertDesignSourcePackage({ pkg, authority: authority() });
		const tools = mount(pkg);
		await authorWholeContract(tools, makeContract());
		expect(await call(tools.finishDesign)).toMatchObject({ ok: true });
		expect(await call(tools.requestReview)).toMatchObject({
			ok: true,
			accepted: true,
		});

		const accepted = await readLatestAcceptedDesignRevision(sessionId);
		if (accepted === null) throw new Error("accepted revision missing");
		const plan = await readLatestDesignBuildPlanForRevision(accepted.id);
		expect(plan?.envelope.producer).toMatchObject({
			provider: "nova",
			modelId: "deterministic-build-planner-v2",
		});
		expect(plan?.envelope.payload.slices).toHaveLength(2);
	});

	it("keeps gates fresh through the runner's memoized ancestry loader", async () => {
		const pkg = makePackage();
		await insertDesignSourcePackage({ pkg, authority: authority() });
		const { createMemoizedAncestryLoader } = await import(
			"@/lib/agent/design/loop/gates"
		);
		const ancestry = createMemoizedAncestryLoader(sessionId, pkg.packageDigest);
		/* Unchanged ancestry: repeated gate evaluations share ONE load. */
		expect(ancestry.loadAncestry()).toBe(ancestry.loadAncestry());
		const tools = mount(pkg, cleanReview, new DesignRepairTracker(), ancestry);
		await authorWholeContract(tools, makeContract());
		expect(await call(tools.finishDesign)).toMatchObject({ ok: true });
		/* Each artifact insert invalidated the memo: the review gate must see
		 * the freshly submitted draft (a stale memo would refuse with "No
		 * draft exists to review"), and the acceptance path re-reads again to
		 * derive the plan from the accepted head. */
		expect(await call(tools.requestReview)).toMatchObject({
			ok: true,
			accepted: true,
		});
		expect(await readLatestAcceptedDesignRevision(sessionId)).not.toBeNull();
	});

	it("resolves readable model handles to stable server identities", async () => {
		const pkg = makePackage();
		await insertDesignSourcePackage({ pkg, authority: authority() });
		const tools = mount(pkg);
		const result = await call(tools.setDesignRoot, {
			id: { handle: "@contract" },
		});
		expect(result).toMatchObject({ ok: true });
		const inspected = await call(tools.inspectDesign, {
			selection: { kind: "root" },
		});
		const root = (inspected.view as { root: Record<string, unknown> }).root;
		expect(root.id).toEqual({ handle: "@contract" });

		const contract = makeContract();
		const sourceRecord = fixtureValue(contract.records[0], "first record");
		const record = (modelContract(contract) as AppDesignContract).records[0];
		if (record === undefined) throw new Error("record fixture missing");
		const stagedRecord = await call(tools.updateRecords, {
			upserts: [record],
			removeIds: [],
		});
		expect(stagedRecord).toMatchObject({ ok: true });
		const inspectedRecord = await call(tools.inspectDesign, {
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
		/* An unknown handle resolves to its deterministic identity and finds
		 * no item — an honest empty view, never a reference gate. */
		expect(
			await call(tools.inspectDesign, {
				selection: {
					kind: "collection",
					collection: "records",
					ids: [{ handle: "@not_declared" }],
					offset: 0,
					limit: 20,
				},
			}),
		).toMatchObject({
			ok: true,
			view: { kind: "collection", collection: "records", total: 0 },
		});
	});

	it("serializes several semantic calls emitted in one model response", async () => {
		const pkg = makePackage();
		await insertDesignSourcePackage({ pkg, authority: authority() });
		const tools = mount(pkg);
		const projected = modelContract(makeContract()) as AppDesignContract;
		const root = call(
			tools.setDesignRoot,
			{ id: projected.id, charter: projected.charter },
			"parallel-root",
		);
		const actors = call(
			tools.updateActors,
			{ upserts: projected.actors, removeIds: [] },
			"parallel-actors",
		);
		expect(await Promise.all([root, actors])).toEqual([
			expect.objectContaining({ ok: true }),
			expect.objectContaining({ ok: true }),
		]);
		expect(
			await call(tools.inspectDesign, { selection: { kind: "summary" } }),
		).toMatchObject({
			ok: true,
			view: { counts: { actors: projected.actors.length } },
		});
	});

	it("rejects raw new UUID declarations and closes forward references at submit", async () => {
		const pkg = makePackage();
		await insertDesignSourcePackage({ pkg, authority: authority() });
		const tools = mount(pkg);
		const raw = await call(tools.setDesignRoot, {
			id: did(999),
		});
		expect(raw).toMatchObject({
			diagnostic: { code: "design-creation-handle-required", issueCount: 1 },
		});
		/* Root-first staging with a forward workflow reference is legal: the
		 * reference mints its deterministic identity eagerly and staging is
		 * order-free. Submit still refuses a reference whose element never
		 * arrived — naming the handle the model wrote. */
		const forward = await call(tools.setDesignRoot, {
			id: { handle: "@contract" },
			charter: {
				...makeContract().charter,
				includedWorkflowIds: [{ handle: "@undeclared_workflow" }],
				initialWorkflowId: { handle: "@undeclared_workflow" },
			},
		});
		expect(forward).toMatchObject({ ok: true });
		const closure = await call(tools.finishDesign);
		expect(closure).toMatchObject({
			diagnostic: { code: "design-schema-rejected" },
		});
		expect(closure.error).toContain("@undeclared_workflow");
		/* The late declaration upgrades the `referenced` ledger row in place —
		 * same deterministic identity, real entity kind — instead of
		 * conflicting with it. Its own identity slots use handles too (all
		 * forward references themselves, exercising the order-free law). */
		const fixtureWorkflow = makeContract().workflows[0];
		if (fixtureWorkflow === undefined) throw new Error("fixture workflow");
		const lateDeclaration = await call(tools.updateWorkflows, {
			upserts: [
				{
					...fixtureWorkflow,
					id: { handle: "@undeclared_workflow" },
					actorIds: [{ handle: "@late_actor" }],
					inputs: fixtureWorkflow.inputs.map((input) => ({
						...input,
						propertyId: { handle: "@late_property" },
					})),
					decisions: fixtureWorkflow.decisions.map((decision) => ({
						...decision,
						inputPropertyIds: [{ handle: "@late_property" }],
					})),
					recordEffects: fixtureWorkflow.recordEffects.map((effect) => ({
						...effect,
						recordId: { handle: "@late_record" },
						writes: effect.writes.map((write) => ({
							...write,
							propertyId: { handle: "@late_property" },
						})),
					})),
					readback: fixtureWorkflow.readback.map((entry) => ({
						...entry,
						recordId: { handle: "@late_record" },
						propertyIds: [{ handle: "@late_property" }],
					})),
				},
			],
			removeIds: [],
		});
		expect(lateDeclaration).toMatchObject({ ok: true });
		/* A reserved finding handle can never enter the design namespace,
		 * even as a reference. */
		expect(
			await call(tools.setDesignRoot, {
				id: { handle: "@contract" },
				charter: {
					...makeContract().charter,
					includedWorkflowIds: [{ handle: "@f1" }],
					initialWorkflowId: { handle: "@f1" },
				},
			}),
		).toMatchObject({
			diagnostic: { code: "design-reserved-handle", issueCount: 1 },
		});
		const unknownReference = await call(tools.setDesignRoot, {
			id: { handle: "@contract" },
			charter: {
				...makeContract().charter,
				includedWorkflowIds: [did(998)],
				initialWorkflowId: did(998),
			},
		});
		expect(unknownReference).toMatchObject({
			diagnostic: { code: "design-creation-handle-required", issueCount: 1 },
		});
		expect(unknownReference.error).toContain("unknown raw design UUID");

		const unknownRemoval = await call(tools.updateRecords, {
			upserts: [],
			removeIds: [did(997)],
		});
		expect(unknownRemoval.error).toContain("unknown raw design UUID");
	});

	it("latches a fatal defect when identical semantic update rejections repeat", async () => {
		const pkg = makePackage();
		await insertDesignSourcePackage({ pkg, authority: authority() });
		const repair = new DesignRepairTracker();
		const tools = mount(pkg, cleanReview, repair);
		const rawUuidActor = {
			upserts: [
				{
					id: did(900),
					name: "Community worker",
					goals: ["Register and screen beneficiaries"],
					responsibilities: [],
					workContext: [],
					constraints: [],
				},
			],
			removeIds: [],
		};
		for (let attempt = 0; attempt < DESIGN_STAGE_REPAIR_BUDGET; attempt += 1) {
			expect(repair.fatalError()).toBeUndefined();
			const result = await call(tools.updateActors, rawUuidActor);
			expect(result).toMatchObject({
				diagnostic: { code: "design-creation-handle-required" },
			});
		}
		expect(repair.fatalError()?.code).toBe("design-stage-nonconvergent");
	});

	it("rejects duplicate declaration identities before they enter the workspace ledger", async () => {
		const pkg = makePackage();
		await insertDesignSourcePackage({ pkg, authority: authority() });
		const tools = mount(pkg);
		const contract = makeContract();
		const projected = modelContract(contract) as AppDesignContract;
		await call(tools.setDesignRoot, { id: projected.id });
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
		const rejected = await call(tools.updateRecords, {
			upserts: collidingRecords,
			removeIds: [],
		});
		expect(rejected).toMatchObject({
			diagnostic: {
				code: "design-partial-identity-rejected",
				validationStage: "partial",
				issueCount: 1,
			},
		});
		const inspected = await call(tools.inspectDesign, {
			selection: { kind: "summary" },
		});
		expect(inspected).toMatchObject({
			ok: true,
			view: { kind: "summary", counts: { records: 0 } },
		});
	});

	it("finalizes a contract that records a delegated decision as a non-blocking question", async () => {
		/* The user said "use sensible defaults": the model bakes concrete values
		 * into the design and keeps the future-facing question as a recorded,
		 * non-blocking caveat. That question must never force a user pause. */
		const pkg = makePackage();
		await insertDesignSourcePackage({ pkg, authority: authority() });
		const repair = new DesignRepairTracker();
		const tools = mount(pkg, cleanReview, repair);
		const contract = makeContract();
		contract.openQuestions.push({
			id: did(1200),
			question:
				"What exact production thresholds replace the provisional pilot values?",
			blocking: false,
			relatedElementIds: [ids.taskVisit],
		});
		await authorWholeContract(tools, contract);
		expect(await call(tools.finishDesign)).toMatchObject({ ok: true });
		expect(repair.requiredUserQuestions()).toHaveLength(0);
		expect(repair.fatalError()).toBeUndefined();
	});

	it("routes blocking open questions outside repair convergence", async () => {
		const pkg = makePackage();
		await insertDesignSourcePackage({ pkg, authority: authority() });
		const repair = new DesignRepairTracker();
		const tools = mount(pkg, cleanReview, repair);
		const contract = makeContract();
		contract.openQuestions.push(
			...Array.from({ length: 7 }, (_, index) => ({
				id: did(1100 + index),
				question: `Which construction decision ${index + 1} applies?`,
				blocking: true,
				relatedElementIds: [ids.taskVisit],
			})),
		);
		await call(tools.setDesignRoot, {
			id: (modelContract(contract) as AppDesignContract).id,
		});
		const firstSubmission = await call(tools.finishDesign);
		expect(firstSubmission).toMatchObject({
			diagnostic: { validationStage: "schema" },
		});

		await authorWholeContract(tools, contract);
		const needsInput = await call(tools.finishDesign);
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
			await call(tools.updateActors, {
				upserts: [],
				removeIds: [],
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
		await call(tools.setDesignRoot, { id: projected.id });
		expect(await call(tools.finishDesign)).toHaveProperty("error");
		await authorWholeContract(tools, contract);
		expect(await call(tools.finishDesign)).toMatchObject({ ok: true });
	});

	it("revises only affected items and dispositions after a blocking review", async () => {
		const pkg = makePackage();
		await insertDesignSourcePackage({ pkg, authority: authority() });
		const tools = mount(pkg, correctionReview);
		const contract = makeContract();
		const resolved = resolvedContract(contract);
		await authorWholeContract(tools, contract);
		await call(tools.finishDesign);
		const reviewResult = await call(tools.requestReview);
		expect(reviewResult).toMatchObject({ accepted: false });
		expect(reviewResult.message).not.toContain("expectedRevision");
		/* Findings return in the agent's symbol vocabulary: the server-minted
		 * finding identity projects to its positional @f handle and affected
		 * elements to their declared handles — the exact symbols the next
		 * state packet prints and a disposition consumes. */
		const [blockingFinding] = reviewResult.findings as Array<{
			id: unknown;
			affectedElementIds: unknown[];
		}>;
		if (blockingFinding === undefined) throw new Error("finding missing");
		expect(blockingFinding.id).toEqual({ handle: "@f1" });
		expect(blockingFinding.affectedElementIds).toEqual([
			{ handle: handleForFixtureId(ids.taskVisit) },
		]);

		/* An unknown finding handle refuses before the generic resolver could
		 * mint a plausible wrong identity for it. */
		const unknownFinding = await call(tools.updateFindingDispositions, {
			upserts: [
				{
					findingId: { handle: "@f9" },
					status: "accepted",
					rationale: "This finding does not exist.",
				},
			],
			removeIds: [],
		});
		expect(unknownFinding).toMatchObject({
			diagnostic: { code: "design-unknown-finding-handle" },
		});
		expect(String(unknownFinding.error)).toContain("@f9");
		expect(String(unknownFinding.error)).toContain("@f1");
		const collidingRevision = await call(tools.updateWorkflows, {
			upserts: [
				{
					...fixtureValue(resolved.workflows[1], "second workflow"),
					id: fixtureValue(resolved.records[0], "first record").id,
				},
			],
			removeIds: [],
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
		await call(tools.updateWorkflows, {
			upserts: [workflow],
			removeIds: [],
		});
		await call(tools.updateFindingDispositions, {
			upserts: [
				{
					findingId: { handle: "@f1" },
					status: "accepted",
					rationale: "The saved visit is now explicitly confirmed.",
				},
			],
			removeIds: [],
		});
		expect(await call(tools.finishDesign)).toMatchObject({
			ok: true,
			accepted: true,
		});
		const accepted = await readLatestAcceptedDesignRevision(sessionId);
		expect(accepted?.envelope.payload.actors).toEqual(resolved.actors);
		if (accepted?.parentRevisionId === null || accepted === null)
			throw new Error("accepted revision parent missing");
		const reviews = await readDesignReviews(accepted.parentRevisionId);
		expect(reviews).toHaveLength(1);
		/* The wrong-uuid-mint hazard, pinned dead: the persisted disposition
		 * names the server-minted finding identity, not a deterministic
		 * workspace mint of the "@f1" symbol. */
		const persistedReview = reviews[0];
		const persistedFinding = persistedReview?.envelope.payload.findings[0];
		if (persistedReview === undefined || persistedFinding === undefined)
			throw new Error("persisted review finding missing");
		const dispositions = await readDispositions(persistedReview.id);
		expect(dispositions.map((entry) => entry.findingId)).toEqual([
			persistedFinding.id,
		]);
	});

	it("refuses declaring an @f-numbered handle for a design element", async () => {
		const pkg = makePackage();
		await insertDesignSourcePackage({ pkg, authority: authority() });
		const tools = mount(pkg);
		const result = await call(tools.setDesignRoot, {
			id: { handle: "@f1" },
		});
		expect(result).toMatchObject({
			diagnostic: { code: "design-reserved-handle" },
		});
		expect(String(result.error)).toContain("@f1");
	});

	it("deduplicates an exact repeated semantic tool call after the workspace advances", async () => {
		const pkg = makePackage();
		await insertDesignSourcePackage({ pkg, authority: authority() });
		const tools = mount(pkg);
		const projected = modelContract(makeContract()) as AppDesignContract;
		const input = { id: projected.id };
		const first = await call(tools.setDesignRoot, input, "same-call");
		await call(tools.updateActors, {
			upserts: (modelContract(makeContract()) as AppDesignContract).actors,
			removeIds: [],
		});
		const second = await call(tools.setDesignRoot, input, "same-call");
		expect(first).toMatchObject({ deduplicated: false });
		expect(second).toMatchObject({ deduplicated: true });
	});
});
