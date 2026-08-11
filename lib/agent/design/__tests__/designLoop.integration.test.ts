/** Offline integration of staged design tools with the real artifact store. */

import { beforeEach, describe, expect, it } from "vitest";
import {
	type DesignArtifactWriteAuthority,
	insertDesignSourcePackage,
	readDesignReviews,
	readLatestAcceptedDesignRevision,
	readLatestDesignBuildPlanForRevision,
} from "@/lib/agent/design/artifactStore";
import type { AppDesignContract } from "@/lib/agent/design/contract";
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
				affectedElementIds: [ids.taskVisit],
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
) {
	return createDesignLoopTools({
		designSessionId: sessionId,
		runId: RUN_ID,
		authority: authority(),
		currentPkg: pkg,
		catalogText: "CATALOG",
		ctx: scriptedContext(nextReview),
		signal: new AbortController().signal,
		repair: new DesignRepairTracker(),
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
	"workflows",
	"lists",
	"access",
	"navigation",
	"externalRequirements",
	"decisions",
	"assumptions",
	"openQuestions",
] as const;

async function stageWholeContract(
	tools: ReturnType<typeof createDesignLoopTools>,
	contract: AppDesignContract,
	startRevision = 0,
): Promise<number> {
	let revision = startRevision;
	if (revision === 0) {
		const root = await call(tools.stageContract, {
			expectedRevision: revision,
			root: { id: contract.id, charter: contract.charter },
			collections: [],
		});
		revision = Number(root.workspaceRevision);
	}
	for (const collection of COLLECTIONS) {
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
			root: {
				id: { handle: "@contract" },
				charter: {
					...makeContract().charter,
					includedWorkflowIds: [{ handle: "@register" }],
					initialWorkflowId: { handle: "@register" },
				},
			},
			collections: [],
		});
		expect(result).toMatchObject({ ok: true, workspaceRevision: 1 });
		const inspected = await call(tools.inspectDesignWorkspace, {
			artifactKind: "contract",
			expectedRevision: 1,
			selection: { kind: "root" },
		});
		const root = (inspected.view as { root: Record<string, unknown> }).root;
		expect(root.id).toBe(
			deterministicDesignId(`design-workspace-v1:${sessionId}:@contract`),
		);
	});

	it("keeps an invalid candidate open so only missing collections are added", async () => {
		const pkg = makePackage();
		await insertDesignSourcePackage({ pkg, authority: authority() });
		const tools = mount(pkg);
		const contract = makeContract();
		const root = await call(tools.stageContract, {
			expectedRevision: 0,
			root: { id: contract.id, charter: contract.charter },
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
		const contractRevision = await stageWholeContract(tools, contract);
		await call(tools.submitContract, { expectedRevision: contractRevision });
		expect(await call(tools.requestReview)).toMatchObject({ accepted: false });

		const workflow = {
			...fixtureValue(contract.workflows[1], "second workflow"),
			readback: [
				{
					recordId: ids.recVisit,
					purpose: "Confirm the visit was saved",
					propertyIds: [ids.factVisitSummary],
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
		expect(accepted?.envelope.payload.actors).toEqual(contract.actors);
		if (accepted?.parentRevisionId === null || accepted === null)
			throw new Error("accepted revision parent missing");
		expect(await readDesignReviews(accepted.parentRevisionId)).toHaveLength(1);
	});

	it("deduplicates an exact repeated stage tool call", async () => {
		const pkg = makePackage();
		await insertDesignSourcePackage({ pkg, authority: authority() });
		const tools = mount(pkg);
		const input = {
			expectedRevision: 0,
			root: { id: makeContract().id, charter: makeContract().charter },
			collections: [],
		};
		const first = await call(tools.stageContract, input, "same-call");
		const second = await call(tools.stageContract, input, "same-call");
		expect(first).toMatchObject({ deduplicated: false });
		expect(second).toMatchObject({ deduplicated: true });
	});
});
