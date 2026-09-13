/** Offline integration of semantic design tools with the real artifact store. */

import { beforeEach, describe, expect } from "vitest";
import {
	type DesignLoopRunnerArgs,
	inspectAuthorizedProjectData,
	runDesignAgentLoop,
	validateAuthorizedProjectLookupEvidence,
} from "@/lib/agent/build/designLoopRunner";
import type { OrchestratorStreamWriter } from "@/lib/agent/build/orchestrator";
import {
	type DesignArtifactWriteAuthority,
	insertDesignSourcePackage,
	readDesignReviews,
	readDesignRevision,
	readDispositions,
	readLatestAcceptedDesignRevision,
	readLatestDesignBuildPlanForRevision,
} from "@/lib/agent/design/artifactStore";
import {
	type AppDesignContract,
	appDesignContractBaseSchema,
	collectContractIds,
} from "@/lib/agent/design/contract";
import { sealArtifactEnvelope } from "@/lib/agent/design/envelope";
import { designIdSchema } from "@/lib/agent/design/ids";
import { deterministicDesignId } from "@/lib/agent/design/loop/claimSeeding";
import {
	DESIGN_STAGE_REPAIR_BUDGET,
	DesignRepairTracker,
} from "@/lib/agent/design/loop/gates";
import {
	createDesignLoopTools,
	createDesignToolExecutionQueue,
	type DesignLoopToolDeps,
} from "@/lib/agent/design/loop/tools";
import {
	type BuildSourcePackageArgs,
	buildDesignSourcePackage,
	type DesignSourcePackage,
} from "@/lib/agent/design/sourcePackage";
import { askQuestionsInputSchema } from "@/lib/agent/tools/askQuestions";
import type { NovaUIMessage } from "@/lib/chat/attachmentRefs";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { loadAssetsByIds } from "@/lib/db/mediaAssets";
import {
	createLookupRow,
	createLookupTable,
	updateLookupRow,
} from "@/lib/lookup/service";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	CONTRACT_COLLECTIONS,
	designArtifactWorkspaceLineageSchema,
	normalizeStoredDesignArtifactWorkspaceOperation,
} from "../artifactWorkspaceOperations";
import {
	readDesignIdentityHandleBindings,
	stageDesignArtifactWorkspace,
} from "../artifactWorkspaceStore";
import {
	buildCapabilityCatalog,
	renderCapabilityCatalog,
} from "../capabilityCatalog";
import { DesignGenerationContext } from "../designGenerationContext";
import { withDesignResponses } from "../loop/__tests__/designAgentPeer";
import { REQUIRED_DESIGN_QUESTIONS_HEADER } from "../loop/designAgent";
import { it, reviewContext } from "./designLoopPeer";
import {
	addPatientReviewWorkflow,
	did,
	fixtureValue,
	ids,
	makeContract,
	makeLookupContract,
	makeNestedMenuContract,
	messageRef,
} from "./fixtures";

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

const packageDeps: BuildSourcePackageArgs["deps"] = {
	loadAssets: (ids, projectId) => loadAssetsByIds(ids, projectId),
	readExtract: async () => {
		throw new Error("This text-only source cannot load extracts");
	},
	loadImage: async () => {
		throw new Error("This text-only source cannot load images");
	},
};
async function makePackage(): Promise<DesignSourcePackage> {
	const ref = messageRef();
	return buildDesignSourcePackage({
		designSessionId: sessionId,
		projectId: PROJECT,
		threadId: ref.threadId,
		messages: [
			{
				id: ref.messageId,
				role: "user",
				parts: [{ type: "text", text: "Track CHW visits." }],
			},
		],
		deps: packageDeps,
	});
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

function mount(
	pkg: DesignSourcePackage,
	nextReview: () => unknown = cleanReview,
	repair = new DesignRepairTracker(),
	ancestry?: Pick<DesignLoopToolDeps, "loadAncestry" | "ancestryChanged">,
	options: {
		executionQueue?: ReturnType<typeof createDesignToolExecutionQueue>;
		requiredQuestionsWereAnswered?: DesignLoopToolDeps["requiredQuestionsWereAnswered"];
	} = {},
) {
	return createDesignLoopTools(
		{
			designSessionId: sessionId,
			runId: RUN_ID,
			authority: authority(),
			currentPkg: pkg,
			catalogText: renderCapabilityCatalog(buildCapabilityCatalog()),
			ctx: reviewContext({
				actor: ACTOR,
				project: PROJECT,
				run: RUN_ID,
				session: sessionId,
				nextReview,
			}),
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
			inspectProjectData: (input) =>
				inspectAuthorizedProjectData(
					{
						actorUserId: ACTOR,
						designSessionId: sessionId,
						holderNonce: NONCE,
						projectId: PROJECT,
						runId: RUN_ID,
					},
					input,
				),
			validateProjectLookupEvidence: (contract) =>
				validateAuthorizedProjectLookupEvidence(
					{
						actorUserId: ACTOR,
						designSessionId: sessionId,
						holderNonce: NONCE,
						projectId: PROJECT,
						runId: RUN_ID,
					},
					contract,
				),
			requiredQuestionsWereAnswered: options.requiredQuestionsWereAnswered,
		} satisfies DesignLoopToolDeps,
		options.executionQueue,
	);
}

function object(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("Expected a JSON object");
	return Object.fromEntries(Object.entries(value));
}
function array(value: unknown): unknown[] {
	if (!Array.isArray(value)) throw new Error("Expected an array");
	return value;
}
async function call(
	tool: {
		execute: (
			input: unknown,
			options: { toolCallId: string },
		) => Promise<unknown>;
	},
	input: unknown = {},
	toolCallId = `tool-${++toolCallSequence}`,
): Promise<Record<string, unknown>> {
	return object(await tool.execute(input, { toolCallId }));
}

async function workspaceRows() {
	const workspaces = await h
		.db()
		.selectFrom("design_artifact_workspaces")
		.selectAll()
		.where("design_session_id", "=", sessionId)
		.orderBy("id")
		.execute();
	const ids = workspaces.map((workspace) => workspace.id);
	const steps = ids.length
		? await h
				.db()
				.selectFrom("design_artifact_workspace_steps")
				.selectAll()
				.where("workspace_id", "in", ids)
				.orderBy("workspace_id")
				.orderBy("revision")
				.execute()
		: [];
	const handles = await readDesignIdentityHandleBindings({
		designSessionId: sessionId,
		authority: authority(),
	});
	return { workspaces, steps, handles };
}

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
	lookupTables: "updateLookupTables",
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
	return object(projectFixtureIdentities(contract, contract, "handles"));
}

function resolvedContract(contract: AppDesignContract): AppDesignContract {
	return appDesignContractBaseSchema.parse(
		projectFixtureIdentities(contract, contract, "resolved"),
	);
}

async function authorWholeContract(
	tools: ReturnType<typeof createDesignLoopTools>,
	contract: AppDesignContract,
): Promise<void> {
	const projected = modelContract(contract);
	expect(await call(tools.setDesignRoot, { id: projected.id })).toMatchObject({
		ok: true,
	});
	for (const collection of CONTRACT_COLLECTIONS) {
		const items = array(projected[collection]);
		if (items.length === 0) continue;
		expect(
			await call(tools[COLLECTION_TO_TOOL[collection]], {
				upserts: items,
				removeIds: [],
			}),
		).toMatchObject({ ok: true });
	}
	expect(
		await call(tools.setDesignRoot, { charter: projected.charter }),
	).toMatchObject({ ok: true });
}

describe("semantic design loop", () => {
	it("refuses genuinely changed Project choice evidence before persisting a draft", async () => {
		const pkg = await makePackage();
		await insertDesignSourcePackage({ pkg, authority: authority() });
		const scope = { projectId: PROJECT, actorId: ACTOR, role: "owner" };
		const table = await createLookupTable(scope, {
			name: "Risk levels",
			tag: "risk_levels",
			columns: [{ wireName: "risk", label: "Risk", dataType: "text" }],
		});
		const column = fixtureValue(table.columns[0], "risk column");
		const row = await createLookupRow(scope, {
			tableId: table.id,
			expectedTableRevision: table.tableRevision,
			toIndex: 0,
			values: { [column.id]: "routine" },
		});
		const secondRow = await createLookupRow(scope, {
			tableId: table.id,
			expectedTableRevision: row.tableRevision,
			toIndex: 1,
			values: { [column.id]: "priority" },
		});
		const tools = mount(pkg);
		const inspected = await tools.inspectProjectData.execute({
			tableId: table.id,
			choiceProjection: { valueColumnId: column.id, labelColumnId: column.id },
		});
		if (
			!("kind" in inspected) ||
			inspected.kind !== "rows" ||
			!inspected.choiceProjection
		)
			throw new Error("The native choice inspection is missing");
		const contract = makeContract();
		const risk = fixtureValue(
			contract.records
				.flatMap((record) => record.properties)
				.find((property) => property.id === ids.factRisk),
			"risk property",
		);
		delete risk.choiceValues;
		risk.choiceSource = {
			kind: "existing-project-lookup",
			tableId: table.id,
			valueColumnId: column.id,
			labelColumnId: column.id,
			inspection: inspected.choiceProjection.inspection,
		};
		expect(
			await validateAuthorizedProjectLookupEvidence(
				{
					actorUserId: ACTOR,
					designSessionId: sessionId,
					holderNonce: NONCE,
					projectId: PROJECT,
					runId: RUN_ID,
				},
				contract,
			),
		).toEqual([]);
		await authorWholeContract(tools, contract);
		await updateLookupRow(scope, {
			tableId: table.id,
			expectedTableRevision: secondRow.tableRevision,
			rowId: row.rowId,
			values: { [column.id]: "urgent" },
		});
		expect(await call(tools.finishDesign)).toMatchObject({
			diagnostic: { validationStage: "construction" },
			error: expect.stringContaining("changed"),
		});
		expect(
			await h
				.db()
				.selectFrom("design_revisions")
				.selectAll()
				.where("design_session_id", "=", sessionId)
				.execute(),
		).toEqual([]);
		expect(await readLatestAcceptedDesignRevision(sessionId)).toBeNull();
	});

	it.each([false, true])(
		"persists, independently reviews, accepts and plans a clean design (lookup tables: %s)",
		async (withLookup) => {
			const pkg = await makePackage();
			await insertDesignSourcePackage({ pkg, authority: authority() });
			const tools = mount(pkg);
			const contract = withLookup ? makeLookupContract() : makeContract();
			await authorWholeContract(tools, contract);
			expect(await call(tools.finishDesign)).toMatchObject({ ok: true });
			expect(await call(tools.requestReview)).toMatchObject({
				ok: true,
				accepted: true,
			});

			const accepted = await readLatestAcceptedDesignRevision(sessionId);
			if (accepted === null) throw new Error("accepted revision missing");
			expect(accepted.envelope.payload).toEqual(resolvedContract(contract));
			const plan = await readLatestDesignBuildPlanForRevision(accepted.id);
			expect(plan?.envelope.producer).toMatchObject({
				provider: "nova",
				modelId: "deterministic-build-planner-v2",
			});
			expect(plan?.envelope.payload.slices).toHaveLength(2);
		},
	);

	it("reviews, accepts, and plans a normalized historical multi-consumer draft", async () => {
		const pkg = await makePackage();
		await insertDesignSourcePackage({ pkg, authority: authority() });
		const currentContract = makeContract();
		addPatientReviewWorkflow(currentContract);
		const currentModule = fixtureValue(
			currentContract.moduleCompositions[0],
			"patient module composition",
		);
		currentModule.selection = {
			workflowIds: [ids.taskVisit, ids.taskReview],
			cases: "one",
		};
		const legacyPayload = object(structuredClone(currentContract));
		delete fixtureValue(
			object(array(legacyPayload.moduleCompositions)[0]),
			"legacy patient module composition",
		).selection;
		const legacyList = fixtureValue(
			object(array(legacyPayload.lists)[0]),
			"legacy patient list",
		);
		delete legacyList.selection;
		legacyList.selectionWorkflowId = ids.taskVisit;
		const legacyDraft = sealArtifactEnvelope({
			artifactType: "design-contract",
			artifactSchemaVersion: 1,
			artifactId: crypto.randomUUID(),
			designSessionId: sessionId,
			revision: 1,
			parentArtifactId: null,
			sourcePackageDigest: pkg.packageDigest,
			inputArtifactDigests: [],
			promptVersion: "design-author-v1",
			producer: {
				provider: "openai",
				modelId: "gpt-test",
				finishReason: "stop",
			},
			createdAt: new Date().toISOString(),
			payload: legacyPayload,
		});
		await h
			.db()
			.insertInto("design_revisions")
			.values({
				id: legacyDraft.artifactId,
				design_session_id: sessionId,
				revision: 1,
				parent_revision_id: null,
				lifecycle: "draft",
				artifact_digest: legacyDraft.artifactDigest,
				contract_digest: canonicalJsonDigest(legacyPayload),
				source_package_digest: pkg.packageDigest,
				producer_model: legacyDraft.producer.modelId,
				prompt_version: legacyDraft.promptVersion,
				created_by_run_id: RUN_ID,
				envelope: JSON.stringify(legacyDraft),
			})
			.execute();

		const result = await call(mount(pkg).requestReview);
		expect(result).toMatchObject({ ok: true, accepted: true });
		const accepted = await readLatestAcceptedDesignRevision(sessionId);
		if (accepted === null) throw new Error("accepted revision missing");
		expect(accepted.parentRevisionId).toBe(legacyDraft.artifactId);
		expect(accepted.envelope.inputArtifactDigests).toContain(
			legacyDraft.artifactDigest,
		);
		expect(accepted.envelope.payload.moduleCompositions[0]?.selection).toEqual({
			workflowIds: [ids.taskVisit, ids.taskReview],
			cases: "one",
		});
		expect(
			await readLatestDesignBuildPlanForRevision(accepted.id),
		).not.toBeNull();
	});

	it("keeps gates fresh through the runner's memoized ancestry loader", async () => {
		const pkg = await makePackage();
		await insertDesignSourcePackage({ pkg, authority: authority() });
		const { createMemoizedAncestryLoader } = await import(
			"@/lib/agent/design/loop/gates"
		);
		const ancestry = createMemoizedAncestryLoader(sessionId, pkg.packageDigest);
		// Prime the real memo before mutations; each semantic artifact transition
		// must invalidate it for the next phase to observe the new durable head.
		await ancestry.loadAncestry();
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
		const pkg = await makePackage();
		await insertDesignSourcePackage({ pkg, authority: authority() });
		const tools = mount(pkg);
		const result = await call(tools.setDesignRoot, {
			id: { handle: "@contract" },
		});
		expect(result).toMatchObject({ ok: true });
		const inspected = await call(tools.inspectDesign, {
			selection: { kind: "root" },
		});
		const root = object(object(inspected.view).root);
		expect(root.id).toEqual({ handle: "@contract" });

		const contract = makeContract();
		const sourceRecord = fixtureValue(contract.records[0], "first record");
		const record = array(modelContract(contract).records)[0];
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

	it("commits reserved response order when SDK callbacks attach out of order", async () => {
		const pkg = await makePackage();
		await insertDesignSourcePackage({ pkg, authority: authority() });
		const executionQueue = createDesignToolExecutionQueue();
		const tools = mount(
			pkg,
			cleanReview,
			new DesignRepairTracker(),
			undefined,
			{ executionQueue },
		);
		const projected = modelContract(makeContract());
		const actor = object(array(projected.actors)[0]);
		executionQueue.beginResponse();
		const rootInput = executionQueue.register("setDesignRoot", {
			id: projected.id,
			charter: projected.charter,
		});
		const firstInput = executionQueue.register("updateActors", {
			upserts: [{ ...actor, name: "First update" }],
			removeIds: [],
		});
		const secondInput = executionQueue.register("updateActors", {
			upserts: [{ ...actor, name: "Second update" }],
			removeIds: [],
		});
		const second = call(tools.updateActors, secondInput, "second");
		const first = call(tools.updateActors, firstInput, "first");
		const root = call(tools.setDesignRoot, rootInput, "root");
		const results = await Promise.allSettled([root, first, second]);
		expect(results).toEqual(
			Array.from({ length: 3 }, () => ({
				status: "fulfilled",
				value: expect.objectContaining({ ok: true, deduplicated: false }),
			})),
		);
		const stored = await workspaceRows();
		expect(stored.workspaces).toHaveLength(1);
		expect(stored.workspaces[0].revision).toBe("3");
		expect(
			stored.steps.map((step) => [step.revision, step.tool_call_id]),
		).toEqual([
			["1", "root"],
			["2", "first"],
			["3", "second"],
		]);
		const inspected = await call(tools.inspectDesign, {
			selection: {
				kind: "collection",
				collection: "actors",
				ids: [],
				offset: 0,
				limit: 20,
			},
		});
		expect(array(object(inspected.view).items)).toEqual([
			{ ...actor, name: "Second update" },
		]);
	});

	it("rejects raw new UUID declarations and closes forward references at submit", async () => {
		const pkg = await makePackage();
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
		const forwardBinding = (await workspaceRows()).handles.find(
			(binding) => binding.handle === "@undeclared_workflow",
		);
		expect(forwardBinding).toMatchObject({
			handle: "@undeclared_workflow",
			entityKind: "referenced",
		});
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
		const declaredBinding = (await workspaceRows()).handles.find(
			(binding) => binding.handle === "@undeclared_workflow",
		);
		expect(declaredBinding).toEqual({
			...forwardBinding,
			entityKind: "workflow",
		});
		const beforeRefusals = await workspaceRows();
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
		expect(await workspaceRows()).toEqual(beforeRefusals);
	});

	it("latches a fatal defect when identical semantic update rejections repeat", async () => {
		const pkg = await makePackage();
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
		const pkg = await makePackage();
		await insertDesignSourcePackage({ pkg, authority: authority() });
		const tools = mount(pkg);
		const contract = makeContract();
		const projected = modelContract(contract);
		expect(await call(tools.setDesignRoot, { id: projected.id })).toMatchObject(
			{ ok: true },
		);
		const baseRecord = fixtureValue(contract.records[0], "first record");
		const collidingRecords = Array.from({ length: 6 }, (_, index) => {
			const identity = { handle: `@collision_${index}` };
			return {
				...object(projectFixtureIdentities(baseRecord, contract, "handles")),
				id: identity,
				name: `record_${index}`,
				properties: [
					{
						...object(
							projectFixtureIdentities(
								fixtureValue(baseRecord.properties[0], "first property"),
								contract,
								"handles",
							),
						),
						id: identity,
						name: `property_${index}`,
					},
				],
			};
		});
		const beforeCollision = await workspaceRows();
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
		expect(await workspaceRows()).toEqual(beforeCollision);
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
		const pkg = await makePackage();
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
		const pkg = await makePackage();
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
		expect(
			await call(tools.setDesignRoot, { id: modelContract(contract).id }),
		).toMatchObject({ ok: true });
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
		expect(array(object(needsInput.needsUserInput).questions)).toHaveLength(7);
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
			array(object(needsInput.needsUserInput).questions),
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

	it("resumes a native required-question card and applies the person's confirmed decision before acceptance", async () => {
		const pkg = await makePackage();
		await insertDesignSourcePackage({ pkg, authority: authority() });
		const contract = makeContract();
		const question = {
			id: did(1250),
			question: "Which thresholds should the pilot use?",
			blocking: true,
			relatedElementIds: [ids.taskVisit],
		};
		contract.openQuestions = [question];
		const tools = mount(pkg);
		await authorWholeContract(tools, contract);
		expect(await call(tools.finishDesign)).toMatchObject({
			diagnostic: { code: "design-construction-needs-input" },
		});
		const original = fixtureValue(
			contract.assumptions[0],
			"existing assumption",
		);
		const settledAssumption = {
			...original,
			statement: "The user confirmed clinic protocol thresholds for the pilot.",
		};
		const questionInput = {
			header: REQUIRED_DESIGN_QUESTIONS_HEADER,
			questions: [{ question: question.question, options: [] }],
		};
		await withDesignResponses(
			[
				[
					{
						type: "tool",
						name: "askQuestions",
						callId: "required-pilot-card",
						input: questionInput,
					},
				],
				[
					{
						type: "tool",
						name: "updateAssumptions",
						callId: "record-confirmed-choice",
						input: {
							upserts: [
								projectFixtureIdentities(
									settledAssumption,
									contract,
									"handles",
								),
							],
							removeIds: [],
						},
					},
					{
						type: "tool",
						name: "updateOpenQuestions",
						callId: "settle-pilot-question",
						input: {
							upserts: [
								projectFixtureIdentities(
									{ ...question, blocking: false },
									contract,
									"handles",
								),
							],
							removeIds: [],
						},
					},
					{
						type: "tool",
						name: "finishDesign",
						callId: "finish-confirmed-design",
						input: {},
					},
				],
				[
					{
						type: "tool",
						name: "requestReview",
						callId: "review-confirmed-design",
						input: {},
					},
				],
				[{ type: "text", text: JSON.stringify(cleanReview()) }],
			],
			async (_model, requests, transport) => {
				const chunks: Parameters<OrchestratorStreamWriter["write"]>[0][] = [];
				const messages: NovaUIMessage[] = [
					{
						id: "m1",
						role: "user",
						parts: [{ type: "text", text: "Track CHW visits." }],
					},
				];
				const args: DesignLoopRunnerArgs = {
					designSessionId: sessionId,
					projectId: PROJECT,
					threadId: messageRef().threadId,
					runId: RUN_ID,
					actorUserId: ACTOR,
					holderNonce: NONCE,
					responseMessageId: "pilot-question",
					messages,
					pkg,
					designCtx: new DesignGenerationContext({
						apiKey: "synthetic-local-only",
						transport,
						userId: ACTOR,
						projectId: PROJECT,
						runId: RUN_ID,
						designSessionId: sessionId,
					}),
					writer: {
						write: (chunk) => {
							chunks.push(chunk);
						},
					},
					signal: new AbortController().signal,
					head: () => null,
					packageDeps,
				};
				expect(await runDesignAgentLoop(args)).toEqual({
					kind: "awaiting-input",
					headRevisionId: null,
				});
				expect(requests).toHaveLength(1);
				const card = chunks.find(
					(chunk) =>
						chunk.type === "tool-input-available" &&
						"toolCallId" in chunk &&
						chunk.toolCallId === "required-pilot-card",
				);
				if (
					card?.type !== "tool-input-available" ||
					!("input" in card) ||
					!("toolCallId" in card) ||
					typeof card.toolCallId !== "string"
				)
					throw new Error("The native question card is missing");
				const cardInput = askQuestionsInputSchema.parse(card.input);
				expect(cardInput).toEqual(questionInput);
				const beforeAnswer = await workspaceRows();
				expect(
					await call(tools.updateOpenQuestions, {
						upserts: [
							projectFixtureIdentities(
								{ ...question, blocking: false },
								contract,
								"handles",
							),
						],
						removeIds: [],
					}),
				).toMatchObject({
					diagnostic: { code: "design-required-question-pending" },
				});
				expect(await workspaceRows()).toEqual(beforeAnswer);
				const answered: NovaUIMessage = {
					id: "pilot-question",
					role: "assistant",
					parts: [
						{
							type: "tool-askQuestions",
							toolCallId: card.toolCallId,
							state: "output-available",
							input: cardInput,
							output: { "0": "Use clinic protocol thresholds for the pilot." },
						},
					],
				};
				const result = await runDesignAgentLoop({
					...args,
					responseMessageId: "confirmed-design",
					messages: [...messages, answered],
				});
				if (result.kind !== "planned")
					throw new Error(`Expected planned design: ${JSON.stringify(result)}`);
				expect(requests).toHaveLength(4);
				expect(JSON.stringify(requests[1].input)).toContain(
					"Use clinic protocol thresholds for the pilot.",
				);
				contract.assumptions[0] = settledAssumption;
				contract.openQuestions = [{ ...question, blocking: false }];
				expect(result.revision.envelope.payload).toEqual(
					resolvedContract(contract),
				);
				expect(await readLatestAcceptedDesignRevision(sessionId)).toEqual(
					result.revision,
				);
				expect(
					await readLatestDesignBuildPlanForRevision(result.revision.id),
				).toEqual(result.plan);
				const items = await h
					.db()
					.selectFrom("design_model_context_items")
					.innerJoin(
						"design_model_contexts",
						"design_model_contexts.id",
						"design_model_context_items.context_id",
					)
					.selectAll("design_model_context_items")
					.where("design_model_contexts.design_session_id", "=", sessionId)
					.execute();
				expect(
					items.filter((item) =>
						item.append_key.startsWith("required-question-card-v1:"),
					),
				).toHaveLength(1);
				const after = await workspaceRows();
				expect(
					after.steps
						.slice(beforeAnswer.steps.length)
						.map((step) => step.tool_call_id),
				).toEqual(["record-confirmed-choice", "settle-pilot-question"]);
			},
		);
	});

	it("keeps an invalid candidate open so only missing collections are added", async () => {
		const pkg = await makePackage();
		await insertDesignSourcePackage({ pkg, authority: authority() });
		const tools = mount(pkg);
		const contract = makeContract();
		const projected = modelContract(contract);
		expect(await call(tools.setDesignRoot, { id: projected.id })).toMatchObject(
			{ ok: true },
		);
		expect(await call(tools.finishDesign)).toHaveProperty("error");
		await authorWholeContract(tools, contract);
		expect(await call(tools.finishDesign)).toMatchObject({ ok: true });
	});

	it("revises only affected items and dispositions after a blocking review", async () => {
		const pkg = await makePackage();
		await insertDesignSourcePackage({ pkg, authority: authority() });
		let reviewCount = 0;
		const tools = mount(pkg, () =>
			reviewCount++ === 0 ? correctionReview() : cleanReview(),
		);
		const contract = makeContract();
		const resolved = resolvedContract(contract);
		await authorWholeContract(tools, contract);
		const initialDraft = await call(tools.finishDesign);
		expect(initialDraft).toMatchObject({
			ok: true,
			revisionId: expect.any(String),
		});
		const initialDraftId = String(initialDraft.revisionId);
		const immutableDraft = await readDesignRevision(initialDraftId);
		const reviewResult = await call(tools.requestReview);
		expect(reviewResult).toMatchObject({ accepted: false });
		expect(reviewResult.message).not.toContain("expectedRevision");
		/* Findings return in the agent's symbol vocabulary: the server-minted
		 * finding identity projects to its positional @f handle and affected
		 * elements to their declared handles — the exact symbols the next
		 * state packet prints and a disposition consumes. */
		const blockingFinding = object(array(reviewResult.findings)[0]);
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
		expect(
			await call(tools.updateWorkflows, { upserts: [workflow], removeIds: [] }),
		).toMatchObject({ ok: true });
		expect(
			await call(tools.updateFindingDispositions, {
				upserts: [
					{
						findingId: { handle: "@f1" },
						status: "accepted",
						rationale: "The saved visit is now explicitly confirmed.",
					},
				],
				removeIds: [],
			}),
		).toMatchObject({ ok: true });
		expect(await call(tools.finishDesign)).toMatchObject({
			ok: true,
			accepted: false,
		});
		expect(await readLatestAcceptedDesignRevision(sessionId)).toBeNull();
		expect(await call(tools.requestReview)).toMatchObject({
			ok: true,
			accepted: true,
		});
		const accepted = await readLatestAcceptedDesignRevision(sessionId);
		expect(accepted?.envelope.payload).toEqual({
			...resolved,
			workflows: resolved.workflows.map((item) =>
				item.id === workflow.id ? workflow : item,
			),
		});
		expect(await readDesignRevision(initialDraftId)).toEqual(immutableDraft);
		expect(
			await readLatestDesignBuildPlanForRevision(String(accepted?.id)),
		).not.toBeNull();
		if (accepted?.parentRevisionId === null || accepted === null)
			throw new Error("accepted revision parent missing");
		const cleanReviews = await readDesignReviews(accepted.parentRevisionId);
		expect(cleanReviews).toHaveLength(1);
		expect(cleanReviews[0]?.envelope.payload.findings).toEqual([]);
		/* The wrong-uuid-mint hazard, pinned dead: the persisted disposition
		 * names the server-minted finding identity, not a deterministic
		 * workspace mint of the "@f1" symbol. */
		const blockingReviews = await readDesignReviews(initialDraftId);
		const persistedReview = blockingReviews[0];
		const persistedFinding = persistedReview?.envelope.payload.findings[0];
		if (persistedReview === undefined || persistedFinding === undefined)
			throw new Error("persisted review finding missing");
		const dispositions = await readDispositions(persistedReview.id);
		expect(
			dispositions.map(({ reviewId, resultingRevisionId, disposition }) => ({
				reviewId,
				resultingRevisionId,
				disposition,
			})),
		).toEqual([
			{
				reviewId: persistedReview.id,
				resultingRevisionId: accepted.parentRevisionId,
				disposition: {
					findingId: persistedFinding.id,
					status: "accepted",
					rationale: "The saved visit is now explicitly confirmed.",
				},
			},
		]);
	});

	it("refuses declaring an @f-numbered handle for a design element", async () => {
		const pkg = await makePackage();
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

	it.each([false, true])(
		"deduplicates an exact repeated semantic call after workspace advances (forward declarations arrived: %s)",
		async (declared) => {
			const pkg = await makePackage();
			await insertDesignSourcePackage({ pkg, authority: authority() });
			const tools = mount(pkg);
			const projected = modelContract(makeContract());
			const input = { id: projected.id, charter: projected.charter };
			const first = await call(tools.setDesignRoot, input, "same-call");
			expect(
				await call(
					tools.updateActors,
					{
						upserts: modelContract(makeContract()).actors,
						removeIds: [],
					},
					"update-actors",
				),
			).toMatchObject({ ok: true });
			if (declared)
				expect(
					await call(
						tools.updateWorkflows,
						{ upserts: projected.workflows, removeIds: [] },
						"declare-workflows",
					),
				).toMatchObject({ ok: true });
			const beforeReplay = await workspaceRows();
			expect(
				beforeReplay.handles.find(
					(binding) => binding.handle === handleForFixtureId(ids.taskVisit),
				)?.entityKind,
			).toBe(declared ? "workflow" : "referenced");
			const second = await call(tools.setDesignRoot, input, "same-call");
			expect(first).toMatchObject({ deduplicated: false });
			expect(second).toMatchObject({ ok: true, deduplicated: true });
			expect(beforeReplay.steps.map((step) => step.tool_call_id)).toEqual([
				"same-call",
				"update-actors",
				...(declared ? ["declare-workflows"] : []),
			]);
			expect(await workspaceRows()).toEqual(beforeReplay);
			expect(
				await call(
					tools.setDesignRoot,
					{
						...input,
						charter: { ...object(input.charter), appName: "A different app" },
					},
					"same-call",
				),
			).toMatchObject({
				error: expect.stringContaining("different staged input"),
			});
			const originalStep = fixtureValue(
				beforeReplay.steps[0],
				"original workspace step",
			);
			const workspace = fixtureValue(
				beforeReplay.workspaces[0],
				"original workspace",
			);
			const rootBinding = fixtureValue(
				beforeReplay.handles.find(
					(binding) => binding.entityKind === "contract",
				),
				"contract binding",
			);
			const invalidBindings = [
				{
					handle: "@unproven_binding",
					designId: did(1800),
					entityKind: "referenced" as const,
				},
				{ ...rootBinding, designId: did(1801) },
				{ ...rootBinding, entityKind: "actor" as const },
			];
			for (const binding of invalidBindings) {
				await expect(
					stageDesignArtifactWorkspace({
						designSessionId: sessionId,
						lineage: designArtifactWorkspaceLineageSchema.parse(
							workspace.lineage,
						),
						authority: authority(),
						toolCallId: "same-call",
						expectedRevision: Number(workspace.revision),
						operation: normalizeStoredDesignArtifactWorkspaceOperation(
							originalStep.operation,
						),
						handleBindings: [binding],
					}),
				).rejects.toThrow("different staged input");
			}
			expect(await workspaceRows()).toEqual(beforeReplay);
		},
	);
});

describe("durable placement grammar", () => {
	it("moves by handle with null first-position input and rolls back an invalid batch", async () => {
		const pkg = await makePackage();
		await insertDesignSourcePackage({ pkg, authority: authority() });
		const tools = mount(pkg);
		const projected = modelContract(makeNestedMenuContract());
		expect(
			await call(tools.updateModuleCompositions, {
				upserts: projected.moduleCompositions,
				removeIds: [],
			}),
		).toMatchObject({ ok: true });
		const placements = [
			{
				moduleId: { handle: handleForFixtureId(ids.moduleVisits) },
				parentModuleId: { handle: handleForFixtureId(ids.modulePatients) },
				afterModuleId: null,
			},
		];
		expect(
			await call(tools.placeModules, { placements }, "place-child"),
		).toMatchObject({ ok: true });
		const before = await workspaceRows();
		expect(
			await call(tools.placeModules, { placements }, "place-child"),
		).toMatchObject({ ok: true, deduplicated: true });
		expect(await workspaceRows()).toEqual(before);
		const failed = await call(tools.placeModules, {
			placements: [
				{ ...placements[0], parentModuleId: null },
				{
					moduleId: { handle: handleForFixtureId(ids.modulePatients) },
					parentModuleId: null,
					afterModuleId: { handle: "@missing-sibling" },
				},
			],
		});
		expect(failed).toMatchObject({
			error: expect.stringContaining("@missing-sibling"),
		});
		expect(await workspaceRows()).toEqual(before);
	});
	it("deduplicates an old semantic call without rewriting its historical operation version", async () => {
		const pkg = await makePackage();
		await insertDesignSourcePackage({ pkg, authority: authority() });
		await stageDesignArtifactWorkspace({
			designSessionId: sessionId,
			lineage: {
				schemaVersion: 1,
				artifactKind: "contract",
				sourcePackageDigest: pkg.packageDigest,
				reviewArtifacts: [],
			},
			authority: authority(),
			toolCallId: "old-root",
			expectedRevision: 0,
			operation: {
				kind: "contract",
				root: { id: ids.contract },
				collections: [],
			},
		});
		const before = await workspaceRows();
		expect(
			await call(mount(pkg).setDesignRoot, { id: ids.contract }, "old-root"),
		).toMatchObject({ ok: true, deduplicated: true });
		expect(await workspaceRows()).toEqual(before);
	});
});
