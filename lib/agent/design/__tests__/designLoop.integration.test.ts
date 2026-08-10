/**
 * The design loop's staged server tools against the real artifact store, with
 * a scripted reviewer: offline, no provider, no spend. These tests pin the
 * durable authoring protocol: bounded stages survive remounts, exact
 * tool-call replay is idempotent, finalization is atomic, and review/plan
 * legality still derives from immutable ancestry.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
	type DesignArtifactWriteAuthority,
	insertDesignSourcePackage,
	readDesignReviews,
	readDispositions,
	readLatestAcceptedDesignRevision,
	readLatestDesignBuildPlanForRevision,
	readLatestDesignRevision,
} from "@/lib/agent/design/artifactStore";
import {
	loadDesignArtifactWorkspaceSummary,
	stageDesignArtifactWorkspace,
} from "@/lib/agent/design/artifactWorkspaceStore";
import type { BuildPlanDraft } from "@/lib/agent/design/buildPlan";
import type { AppDesignContract } from "@/lib/agent/design/contract";
import {
	DesignRepairTracker,
	evaluateDesignGates,
	loadDesignAncestry,
} from "@/lib/agent/design/loop/gates";
import {
	createDesignLoopTools,
	type DesignLoopToolDeps,
	designWorkspaceLineageForGates,
} from "@/lib/agent/design/loop/tools";
import {
	DESIGN_REVIEWER_SYSTEM,
	renderReviewPrompt,
} from "@/lib/agent/design/prompts";
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
import { getAppDb } from "@/lib/db/pg";
import {
	cloneContract,
	did,
	ids,
	makeBuildPlan,
	makeContract,
	messageRef,
} from "./fixtures";

const h = setupAppStateTestDb("design_loop_staged_");

let sessionId: string;
let toolCallSequence = 0;
const RUN_ID = "run-1";
const ACTOR = "owner-test";
const PROJECT = "proj-1";
const NONCE = "6a0a35a4-1111-4222-8333-944445555668";
const authority: DesignArtifactWriteAuthority = {
	actorUserId: ACTOR,
	runId: RUN_ID,
	holderNonce: NONCE,
	expectedProjectId: PROJECT,
};

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

function makePackage(text = "Track CHW visits."): DesignSourcePackage {
	const unsealed: Omit<DesignSourcePackage, "packageDigest"> = {
		schemaVersion: 1,
		designSessionId: sessionId,
		projectId: PROJECT,
		request: { blocks: [{ ref: messageRef(), text, truncated: false }] },
		claims: [],
		attachments: [],
		images: [],
		platformConstraints: [],
		sources: [{ ref: messageRef() }],
	};
	return { ...unsealed, packageDigest: computeSourcePackageDigest(unsealed) };
}

interface ReviewerScript {
	review: () => DesignReview | null;
	reasoningText?: string;
}

interface ScriptedContext extends StructuredModelRunContext {
	calls: Array<{ system: string; prompt: string | undefined }>;
}

function scriptedCtx(script: ReviewerScript): ScriptedContext {
	const calls: Array<{ system: string; prompt: string | undefined }> = [];
	return {
		calls,
		userId: ACTOR,
		projectId: PROJECT,
		runId: RUN_ID,
		get target() {
			return { kind: "design-session" as const, designSessionId: sessionId };
		},
		model: () => {
			throw new Error("the scripted context resolves no real model");
		},
		trackSubGeneration: () => {},
		async runStructured<T>(args: StructuredModelRunArgs<T>) {
			calls.push({ system: args.system, prompt: args.prompt });
			const fixture = script.review();
			if (fixture === null) {
				return {
					object: null,
					usage: undefined,
					warnings: undefined,
					finishReason: "error" as const,
				};
			}
			const parsed = args.schema.safeParse(fixture);
			return parsed.success
				? {
						object: parsed.data,
						usage: undefined,
						warnings: undefined,
						finishReason: "stop" as const,
						...(script.reasoningText !== undefined && {
							reasoningText: script.reasoningText,
						}),
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

function cleanReview(): DesignReview {
	return {
		schemaVersion: 1,
		id: did(500),
		summary: "Sound design; nothing gated.",
		findings: [],
	};
}

function gatedReview(): DesignReview {
	return {
		schemaVersion: 1,
		id: did(501),
		summary: "One coverage gap.",
		findings: [
			{
				id: did(502),
				category: "requirement-coverage",
				severity: "important",
				basis: "source-supported",
				claim: "Visit recording needs an explicit follow-up marker.",
				evidenceRefs: [messageRef()],
				affectedIntentIds: [ids.taskVisit],
				confidence: 0.8,
			},
		],
	};
}

interface LoopHarness {
	tools: ReturnType<typeof createDesignLoopTools>;
	repair: DesignRepairTracker;
	ctx: ScriptedContext;
	reasoningSeen: string[];
}

function mountTools(args: {
	pkg: DesignSourcePackage;
	reviewer?: ReviewerScript;
	rebuild?: DesignLoopToolDeps["rebuildPackageForDigest"];
}): LoopHarness {
	const repair = new DesignRepairTracker();
	const reasoningSeen: string[] = [];
	const ctx = scriptedCtx(args.reviewer ?? { review: cleanReview });
	const tools = createDesignLoopTools({
		designSessionId: sessionId,
		runId: RUN_ID,
		authority,
		currentPkg: args.pkg,
		catalogText: "CATALOG",
		ctx,
		signal: new AbortController().signal,
		repair,
		loadAncestry: () => loadDesignAncestry(sessionId, args.pkg.packageDigest),
		rebuildPackageForDigest: args.rebuild ?? (async () => null),
		onReviewerReasoning: (text) => reasoningSeen.push(text),
	});
	return { tools, repair, ctx, reasoningSeen };
}

type ToolResult = Record<string, unknown>;

async function call(
	tool: {
		execute:
			| ((input: unknown) => Promise<unknown>)
			| ((
					input: unknown,
					options: { readonly toolCallId: string },
			  ) => Promise<unknown>);
	},
	input: unknown = {},
	toolCallId = `tool-${++toolCallSequence}`,
): Promise<ToolResult> {
	const execute = tool.execute as (
		input: unknown,
		options: { readonly toolCallId: string },
	) => Promise<unknown>;
	return (await execute(input, { toolCallId })) as ToolResult;
}

const CONTRACT_COLLECTIONS = [
	"sourceClaims",
	"actors",
	"records",
	"facts",
	"rules",
	"tasks",
	"transitions",
	"readModels",
	"lookupIntents",
	"accessPolicies",
	"navigation",
	"decisions",
	"assumptions",
	"openQuestions",
	"acceptanceScenarios",
	"deferredRequirements",
] as const;

async function stageContract(
	tools: LoopHarness["tools"],
	contract: AppDesignContract,
): Promise<number> {
	let revision = 0;
	const root = await call(tools.stageContract, {
		expectedRevision: revision,
		root: {
			id: contract.id,
			title: contract.title,
			objective: contract.objective,
			inScope: contract.inScope,
			outOfScope: contract.outOfScope,
		},
		collections: [],
	});
	revision = Number(root.workspaceRevision);
	for (const collection of CONTRACT_COLLECTIONS) {
		const items = contract[collection];
		if (items.length === 0) continue;
		const staged = await call(tools.stageContract, {
			expectedRevision: revision,
			collections: [{ collection, upserts: items, removeIds: [] }],
		});
		revision = Number(staged.workspaceRevision);
	}
	return revision;
}

async function stagePlan(
	tools: LoopHarness["tools"],
	plan: BuildPlanDraft,
): Promise<number> {
	let revision = 0;
	for (const collection of [
		"slices",
		"externalActions",
		"intentOwnership",
	] as const) {
		const items = plan[collection];
		if (items.length === 0) continue;
		const staged = await call(tools.stagePlan, {
			expectedRevision: revision,
			collections: [{ collection, upserts: items, removeIds: [] }],
		});
		revision = Number(staged.workspaceRevision);
	}
	return revision;
}

async function persistPackage(pkg: DesignSourcePackage): Promise<void> {
	await insertDesignSourcePackage({ pkg, authority });
}

describe("durable staged contract and plan", () => {
	it("persists each immutable artifact in order and closes its workspace", async () => {
		const pkg = makePackage();
		await persistPackage(pkg);
		const mounted = mountTools({
			pkg,
			reviewer: {
				review: cleanReview,
				reasoningText: "Weighed the queue shape.",
			},
		});

		const contractRevision = await stageContract(mounted.tools, makeContract());
		const submitted = await call(mounted.tools.submitContract, {
			expectedRevision: contractRevision,
		});
		expect(submitted).toMatchObject({
			ok: true,
			effortLevel: "standard",
			roughTimeEstimate: "about an hour",
		});
		const db = await getAppDb();
		const finalized = await db
			.selectFrom("design_artifact_workspaces")
			.select(["status", "finalized_artifact_id"])
			.where("design_session_id", "=", sessionId)
			.where("artifact_kind", "=", "contract")
			.executeTakeFirstOrThrow();
		expect(finalized).toMatchObject({
			status: "finalized",
			finalized_artifact_id: submitted.revisionId,
		});

		const reviewed = await call(mounted.tools.requestReview);
		expect(reviewed).toMatchObject({ ok: true, accepted: true });
		expect(mounted.ctx.calls[0]).toEqual({
			system: DESIGN_REVIEWER_SYSTEM,
			prompt: renderReviewPrompt(pkg, makeContract(), "CATALOG"),
		});
		expect(mounted.reasoningSeen).toEqual(["Weighed the queue shape."]);

		const accepted = await readLatestAcceptedDesignRevision(sessionId);
		expect(accepted).not.toBeNull();
		const reviews = await readDesignReviews(accepted?.parentRevisionId ?? "");
		expect(accepted?.envelope.inputArtifactDigests).toContain(
			reviews[0]?.artifactDigest,
		);
		expect(await readDispositions(reviews[0]?.id ?? "")).toHaveLength(0);

		const sourceTasks = await call(mounted.tools.inspectDesignWorkspace, {
			artifactKind: "plan",
			expectedRevision: 0,
			selection: {
				kind: "sourceCollection",
				collection: "tasks",
				ids: [],
				offset: 0,
				limit: 20,
			},
		});
		expect(sourceTasks).toMatchObject({
			ok: true,
			workspaceRevision: 0,
			view: {
				kind: "sourceCollection",
				collection: "tasks",
				total: makeContract().tasks.length,
			},
		});

		const planRevision = await stagePlan(mounted.tools, makeBuildPlan());
		expect(
			await call(mounted.tools.submitPlan, {
				expectedRevision: planRevision,
			}),
		).toMatchObject({ ok: true });
		expect(
			await readLatestDesignBuildPlanForRevision(accepted?.id ?? ""),
		).not.toBeNull();

		const finalGates = evaluateDesignGates(
			await loadDesignAncestry(sessionId, pkg.packageDigest),
		);
		expect(finalGates.plan).not.toBeNull();
	});

	it("resumes staged work after a remount and inspects exact state", async () => {
		const pkg = makePackage();
		await persistPackage(pkg);
		const first = mountTools({ pkg });
		const contract = makeContract();
		const root = await call(first.tools.stageContract, {
			expectedRevision: 0,
			root: {
				id: contract.id,
				title: contract.title,
				objective: contract.objective,
				inScope: contract.inScope,
				outOfScope: contract.outOfScope,
			},
			collections: [],
		});
		expect(root.workspaceRevision).toBe(1);

		const resumed = mountTools({ pkg });
		const inspected = await call(resumed.tools.inspectDesignWorkspace, {
			artifactKind: "contract",
			expectedRevision: 1,
			selection: { kind: "root" },
		});
		expect(inspected).toMatchObject({
			ok: true,
			workspaceRevision: 1,
			view: { root: { id: contract.id, title: contract.title } },
		});
	});

	it("inherits a prior contract while isolating work by source package", async () => {
		const pkg = makePackage();
		await persistPackage(pkg);
		const initial = mountTools({ pkg });
		const contract = makeContract();
		const initialRevision = await stageContract(initial.tools, contract);
		await call(initial.tools.submitContract, {
			expectedRevision: initialRevision,
		});

		const updatedPkg = makePackage("Track visits and include a consent note.");
		await persistPackage(updatedPkg);
		const updated = mountTools({ pkg: updatedPkg });
		const inherited = await call(updated.tools.inspectDesignWorkspace, {
			artifactKind: "contract",
			expectedRevision: 0,
			selection: {
				kind: "collection",
				collection: "facts",
				ids: [],
				offset: 0,
				limit: 20,
			},
		});
		expect(inherited).toMatchObject({
			ok: true,
			view: { total: contract.facts.length },
		});
		await call(updated.tools.stageContract, {
			expectedRevision: 0,
			root: { title: "Updated title" },
			collections: [],
		});

		const newestPkg = makePackage("Track visits and require verbal consent.");
		await persistPackage(newestPkg);
		const newest = mountTools({ pkg: newestPkg });
		const isolated = await call(newest.tools.inspectDesignWorkspace, {
			artifactKind: "contract",
			expectedRevision: 0,
			selection: { kind: "root" },
		});
		expect(isolated).toMatchObject({
			ok: true,
			view: { root: { title: contract.title } },
		});
	});

	it("deduplicates an exact provider call and rejects identity reuse with new bytes", async () => {
		const pkg = makePackage();
		await persistPackage(pkg);
		const { tools } = mountTools({ pkg });
		const contract = makeContract();
		const input = {
			expectedRevision: 0,
			root: { id: contract.id, title: contract.title },
			collections: [],
		};
		const first = await call(tools.stageContract, input, "same-call");
		const replay = await call(tools.stageContract, input, "same-call");
		expect(first).toMatchObject({ ok: true, workspaceRevision: 1 });
		expect(replay).toMatchObject({
			ok: true,
			workspaceRevision: 1,
			deduplicated: true,
		});
		const collision = await call(
			tools.stageContract,
			{
				expectedRevision: 1,
				root: { id: contract.id, title: "Different" },
				collections: [],
			},
			"same-call",
		);
		expect(String(collision.error)).toContain("different staged input");
		const revisionCollision = await call(
			tools.stageContract,
			{
				expectedRevision: 1,
				root: { id: contract.id, title: contract.title },
				collections: [],
			},
			"same-call",
		);
		expect(String(revisionCollision.error)).toContain("different staged input");
	});

	it("rejects staging after the exact live holder capability changes", async () => {
		const pkg = makePackage();
		await persistPackage(pkg);
		const gates = evaluateDesignGates(
			await loadDesignAncestry(sessionId, pkg.packageDigest),
		);
		await expect(
			stageDesignArtifactWorkspace({
				designSessionId: sessionId,
				lineage: designWorkspaceLineageForGates("contract", gates),
				authority: { ...authority, holderNonce: did(997) },
				toolCallId: "stale-holder",
				expectedRevision: 0,
				operation: {
					kind: "contract",
					root: { id: makeContract().id, title: "Stale" },
					collections: [],
				},
			}),
		).rejects.toThrow(/newer request took over/i);
	});
});

describe("focused repair and reviewed revision", () => {
	it("keeps a rejected candidate durable and accepts only the corrected item", async () => {
		const pkg = makePackage();
		await persistPackage(pkg);
		const mounted = mountTools({ pkg });
		const complete = makeContract();
		const broken = cloneContract(complete);
		broken.acceptanceScenarios = [];
		let revision = await stageContract(mounted.tools, broken);

		const rejected = await call(mounted.tools.submitContract, {
			expectedRevision: revision,
		});
		expect(String(rejected.error)).toContain("acceptanceScenarios");
		expect(await readLatestDesignRevision(sessionId)).toBeNull();

		const correction = await call(mounted.tools.stageContract, {
			expectedRevision: revision,
			collections: [
				{
					collection: "acceptanceScenarios",
					upserts: complete.acceptanceScenarios,
					removeIds: [],
				},
			],
		});
		revision = Number(correction.workspaceRevision);
		expect(
			await call(mounted.tools.submitContract, {
				expectedRevision: revision,
			}),
		).toMatchObject({ ok: true });
		expect(
			(await readLatestDesignRevision(sessionId))?.envelope.payload,
		).toEqual(complete);
	});

	it("inherits unchanged reviewed content and persists complete dispositions", async () => {
		const pkg = makePackage();
		await persistPackage(pkg);
		const mounted = mountTools({ pkg, reviewer: { review: gatedReview } });
		const contractRevision = await stageContract(mounted.tools, makeContract());
		await call(mounted.tools.submitContract, {
			expectedRevision: contractRevision,
		});
		await call(mounted.tools.requestReview);

		const staged = await call(mounted.tools.stageRevision, {
			expectedRevision: 0,
			collections: [],
			dispositions: {
				collection: "dispositions",
				upserts: [
					{
						findingId: did(502),
						status: "accepted",
						rationale: "Added the follow-up marker to visit recording.",
						resultingIntentIds: [ids.taskVisit],
					},
				],
				removeIds: [],
			},
		});
		const revised = await call(mounted.tools.submitRevision, {
			expectedRevision: staged.workspaceRevision,
		});
		expect(revised).toMatchObject({ ok: true, accepted: true });

		const accepted = await readLatestAcceptedDesignRevision(sessionId);
		const reviews = await readDesignReviews(accepted?.parentRevisionId ?? "");
		expect(await readDispositions(reviews[0]?.id ?? "")).toHaveLength(1);
	});

	it("rejects an undispositioned sensitivity downgrade", async () => {
		const pkg = makePackage();
		await persistPackage(pkg);
		const mounted = mountTools({ pkg, reviewer: { review: gatedReview } });
		const contract = makeContract();
		const contractRevision = await stageContract(mounted.tools, contract);
		await call(mounted.tools.submitContract, {
			expectedRevision: contractRevision,
		});
		await call(mounted.tools.requestReview);

		const risk = cloneContract(contract).facts.find(
			(fact) => fact.id === ids.factRisk,
		);
		if (risk === undefined) throw new Error("fixture risk fact is missing");
		risk.sensitivity = "ordinary";
		const staged = await call(mounted.tools.stageRevision, {
			expectedRevision: 0,
			collections: [{ collection: "facts", upserts: [risk], removeIds: [] }],
			dispositions: {
				collection: "dispositions",
				upserts: [
					{
						findingId: did(502),
						status: "accepted",
						rationale: "Addressed the coverage gap.",
						resultingIntentIds: [ids.taskVisit],
					},
				],
				removeIds: [],
			},
		});
		const rejected = await call(mounted.tools.submitRevision, {
			expectedRevision: staged.workspaceRevision,
		});
		expect(String(rejected.error)).toContain("sensitivity");
	});
});

describe("ancestry gates and reviewer recovery", () => {
	it("names the legal next action for out-of-order staging and finalization", async () => {
		const pkg = makePackage();
		await persistPackage(pkg);
		const { tools } = mountTools({ pkg });
		expect(String((await call(tools.requestReview)).error)).toContain(
			"submitContract",
		);
		expect(
			String(
				(
					await call(tools.stagePlan, {
						expectedRevision: 0,
						collections: [
							{
								collection: "slices",
								upserts: [],
								removeIds: [did(999)],
							},
						],
					})
				).error,
			),
		).toContain("submitContract");
	});

	it("reviews the draft under its own reproducible source package", async () => {
		const pkg = makePackage();
		await persistPackage(pkg);
		const first = mountTools({ pkg });
		const contractRevision = await stageContract(first.tools, makeContract());
		await call(first.tools.submitContract, {
			expectedRevision: contractRevision,
		});

		const laterPkg = makePackage("Track CHW visits. Answered: offline.");
		await persistPackage(laterPkg);
		const rebuilt: string[] = [];
		const later = mountTools({
			pkg: laterPkg,
			rebuild: async (digest) => {
				rebuilt.push(digest);
				return pkg;
			},
		});
		expect(await call(later.tools.requestReview)).toMatchObject({ ok: true });
		expect(rebuilt).toEqual([pkg.packageDigest]);
	});

	it("keeps a failed reviewer call unreviewed", async () => {
		const pkg = makePackage();
		await persistPackage(pkg);
		const mounted = mountTools({ pkg, reviewer: { review: () => null } });
		const contractRevision = await stageContract(mounted.tools, makeContract());
		await call(mounted.tools.submitContract, {
			expectedRevision: contractRevision,
		});
		const reviewed = await call(mounted.tools.requestReview);
		expect(String(reviewed.error)).toContain("unreviewed");
		const draft = await readLatestDesignRevision(sessionId);
		expect(await readDesignReviews(draft?.id ?? "")).toHaveLength(0);
	});

	it("exposes the exact open workspace summary used after compaction", async () => {
		const pkg = makePackage();
		await persistPackage(pkg);
		const mounted = mountTools({ pkg });
		const contract = makeContract();
		await call(mounted.tools.stageContract, {
			expectedRevision: 0,
			root: { id: contract.id, title: contract.title },
			collections: [],
		});
		const gates = evaluateDesignGates(
			await loadDesignAncestry(sessionId, pkg.packageDigest),
		);
		const summary = await loadDesignArtifactWorkspaceSummary({
			designSessionId: sessionId,
			lineage: designWorkspaceLineageForGates("contract", gates),
			authority,
		});
		expect(summary).toMatchObject({
			revision: 1,
			stepCount: 1,
			missingRootFields: ["objective", "inScope", "outOfScope"],
		});
	});
});
