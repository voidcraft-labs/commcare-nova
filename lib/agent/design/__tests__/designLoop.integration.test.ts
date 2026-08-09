/**
 * The design loop's server tools against the real artifact store, with a
 * SCRIPTED reviewer: offline, no provider, no spend. The scripted
 * `runStructured` parses every fixture through the REAL schema it was
 * handed, so these tests also prove the factory schemas accept what the
 * loop persists.
 *
 * What must hold (the loop plan §1, §6, §7, §13):
 *  - clean path: submitContract → requestReview (clean) → the SERVER
 *    persists the acceptance itself (empty dispositions, inputs binding
 *    the review digest) → submitPlan;
 *  - findings path: submitRevision proves disposition closure and lands
 *    the dispositions beside the accepted revision; an architecture
 *    change forces the second round, and the second revision is accepted
 *    outright (no third loop);
 *  - repairs: a submission our schemas reject returns the refinement
 *    MESSAGES as the tool result, twice latches the fatal budget error,
 *    and a quiet sensitivity downgrade rejects;
 *  - sequence gates are tool results naming the legal next action;
 *  - the §7.3 outcome: blocking questions on the accepted design refuse
 *    submitPlan, and the answers (a moved digest) reopen a fresh cycle;
 *  - requestReview reviews the draft under its OWN package: a moved digest
 *    re-renders (stubbed here), a failed re-render refuses honestly, and
 *    the reviewer receives EXACTLY the package, contract, and catalog;
 *  - the reviewer's reasoning summary reaches the event-log callback.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
	type DesignArtifactWriteAuthority,
	insertDesignSourcePackage,
	readDesignReviews,
	readDesignRevisionsForSession,
	readDispositions,
	readLatestAcceptedDesignRevision,
	readLatestDesignBuildPlanForRevision,
	readLatestDesignRevision,
} from "@/lib/agent/design/artifactStore";
import {
	DesignRepairTracker,
	evaluateDesignGates,
	loadDesignAncestry,
} from "@/lib/agent/design/loop/gates";
import {
	createDesignLoopTools,
	type DesignLoopToolDeps,
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
import {
	cloneContract,
	did,
	ids,
	makeBuildPlan,
	makeContract,
	messageRef,
} from "./fixtures";

const h = setupAppStateTestDb("design_loop_");

let sessionId: string;
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
		projectId: "proj-1",
		request: {
			blocks: [{ ref: messageRef(), text, truncated: false }],
		},
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

/** A scripted reviewer context: the fixture parses through the REAL schema
 *  the tool handed in, so an unparseable fixture behaves exactly like an
 *  unparseable model response. */
function scriptedCtx(script: ReviewerScript): ScriptedContext {
	const calls: Array<{ system: string; prompt: string | undefined }> = [];
	return {
		calls,
		userId: "u",
		projectId: "proj-1",
		runId: "run-1",
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
			if (!parsed.success) {
				return {
					object: null,
					usage: undefined,
					warnings: undefined,
					finishReason: "stop" as const,
				};
			}
			return {
				object: parsed.data,
				usage: undefined,
				warnings: undefined,
				finishReason: "stop" as const,
				...(script.reasoningText !== undefined && {
					reasoningText: script.reasoningText,
				}),
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
				claim: "Visit recording lacks a follow-up marker the request implies.",
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
		onReviewerReasoning: (text) => {
			reasoningSeen.push(text);
		},
	});
	return { tools, repair, ctx, reasoningSeen };
}

async function persistPackage(pkg: DesignSourcePackage): Promise<void> {
	await insertDesignSourcePackage({ pkg, authority });
}

type ToolResult = Record<string, unknown>;

async function call(
	tool: { execute: (input: unknown) => Promise<unknown> },
	input: unknown = {},
): Promise<ToolResult> {
	return (await tool.execute(input)) as ToolResult;
}

describe("clean path: contract → clean review → server acceptance → plan", () => {
	it("persists every artifact in order with the store's bindings intact", async () => {
		const pkg = makePackage();
		await persistPackage(pkg);
		const { tools, ctx, reasoningSeen } = mountTools({
			pkg,
			reviewer: {
				review: cleanReview,
				reasoningText: "Weighed the queue shape.",
			},
		});

		const submitted = await call(tools.submitContract, makeContract());
		expect(submitted).toMatchObject({ ok: true });
		expect(String(submitted.message)).toContain("requestReview");

		const reviewed = await call(tools.requestReview);
		expect(reviewed).toMatchObject({ ok: true, accepted: true });
		/* The reviewer received EXACTLY the package, the contract, and the
		 * catalog, under its own fresh-context prompt. */
		expect(ctx.calls).toHaveLength(1);
		expect(ctx.calls[0]?.system).toBe(DESIGN_REVIEWER_SYSTEM);
		expect(ctx.calls[0]?.prompt).toBe(
			renderReviewPrompt(pkg, makeContract(), "CATALOG"),
		);
		expect(reasoningSeen).toEqual(["Weighed the queue shape."]);

		/* The server minted the acceptance: same content, empty dispositions,
		 * inputs binding the draft AND the review. */
		const accepted = await readLatestAcceptedDesignRevision(sessionId);
		expect(accepted).not.toBeNull();
		const reviews = await readDesignReviews(accepted?.parentRevisionId ?? "");
		expect(reviews).toHaveLength(1);
		expect(accepted?.envelope.inputArtifactDigests).toContain(
			reviews[0]?.artifactDigest,
		);
		expect(await readDispositions(reviews[0]?.id ?? "")).toHaveLength(0);

		const planned = await call(tools.submitPlan, {
			slices: makeBuildPlan().slices,
			externalActions: [],
			intentOwnership: makeBuildPlan().intentOwnership,
		});
		expect(planned).toMatchObject({ ok: true });
		const plan = await readLatestDesignBuildPlanForRevision(accepted?.id ?? "");
		expect(plan).not.toBeNull();
	});

	it("reports blocking-action policy with structural plan errors so one repair can address both", async () => {
		const pkg = makePackage();
		await persistPackage(pkg);
		const { tools, repair } = mountTools({ pkg });
		await call(tools.submitContract, makeContract());
		await call(tools.requestReview);

		const invalid = makeBuildPlan();
		const actionId = did(998);
		const slice = invalid.slices[1];
		if (slice === undefined)
			throw new Error("Fixture is missing its second slice.");
		slice.prerequisiteSliceIds = [did(999)];
		slice.externalActionIds = [actionId];
		invalid.externalActions = [
			{
				id: actionId,
				kind: "manual",
				timing: "before-slice",
				requiredFor: "construction",
				description: "Complete an external prerequisite.",
				idempotencyOwner: "user",
				completionEvidence: "The prerequisite is complete.",
			},
		];
		const rejected = await call(tools.submitPlan, {
			slices: invalid.slices,
			externalActions: invalid.externalActions,
			intentOwnership: invalid.intentOwnership,
		});
		expect(String(rejected.error)).toContain("prerequisite");
		expect(String(rejected.error)).toContain(
			"no registered completion producer",
		);
		expect(repair.fatalError()).toBeUndefined();

		const repaired = makeBuildPlan();
		const planned = await call(tools.submitPlan, {
			slices: repaired.slices,
			externalActions: repaired.externalActions,
			intentOwnership: repaired.intentOwnership,
		});
		expect(planned).toMatchObject({ ok: true });
		expect(repair.fatalError()).toBeUndefined();
	});
});

describe("findings path and the second round", () => {
	it("lands dispositions beside the revision, and accepts without a second round when nothing warrants one", async () => {
		const pkg = makePackage();
		await persistPackage(pkg);
		const { tools } = mountTools({ pkg, reviewer: { review: gatedReview } });

		await call(tools.submitContract, makeContract());
		const reviewed = await call(tools.requestReview);
		expect(reviewed).toMatchObject({ ok: true, accepted: false });

		const revised = await call(tools.submitRevision, {
			contract: makeContract(),
			dispositions: [
				{
					findingId: did(502),
					status: "accepted",
					rationale: "Added a follow-up marker to visit recording.",
					resultingIntentIds: [ids.taskVisit],
				},
			],
		});
		expect(revised).toMatchObject({ ok: true, accepted: true });

		const accepted = await readLatestAcceptedDesignRevision(sessionId);
		const reviews = await readDesignReviews(accepted?.parentRevisionId ?? "");
		const dispositions = await readDispositions(reviews[0]?.id ?? "");
		expect(dispositions).toHaveLength(1);
		expect(dispositions[0]?.disposition.status).toBe("accepted");
	});

	it("an architecture change forces the second review, and the second revision accepts outright", async () => {
		const pkg = makePackage();
		await persistPackage(pkg);
		const { tools } = mountTools({ pkg, reviewer: { review: gatedReview } });

		await call(tools.submitContract, makeContract());
		await call(tools.requestReview);

		const flipped = cloneContract(makeContract());
		const decision = flipped.decisions[0];
		if (decision) decision.selectedOptionId = ids.decisionOptionB;
		const revised = await call(tools.submitRevision, {
			contract: flipped,
			dispositions: [
				{
					findingId: did(502),
					status: "accepted",
					rationale: "Reshaped visits to address the gap.",
					resultingIntentIds: [ids.taskVisit],
				},
			],
		});
		expect(revised).toMatchObject({ ok: true, accepted: false });
		expect(String(revised.message)).toContain("requestReview");

		const secondReview = await call(tools.requestReview);
		expect(secondReview).toMatchObject({ ok: true, accepted: false });
		const revisedAgain = await call(tools.submitRevision, {
			contract: flipped,
			dispositions: [
				{
					findingId: did(502),
					status: "accepted",
					rationale: "Held the reshaped visits.",
					resultingIntentIds: [ids.taskVisit],
				},
			],
		});
		/* Round 2 never opens a third loop: the revision lands accepted. */
		expect(revisedAgain).toMatchObject({ ok: true, accepted: true });
	});
});

describe("repairs", () => {
	it("returns refinement messages and latches the budget after two rejections", async () => {
		const pkg = makePackage();
		await persistPackage(pkg);
		const { tools, repair } = mountTools({ pkg });

		const broken = cloneContract(makeContract());
		broken.acceptanceScenarios = [];
		const first = await call(tools.submitContract, broken);
		expect(String(first.error)).toContain("acceptanceScenarios");
		expect(repair.fatalError()).toBeUndefined();
		const second = await call(tools.submitContract, broken);
		expect(String(second.error)).toBeTruthy();
		expect(repair.fatalError()?.message).toContain("submitContract");
	});

	it("rejects a quiet sensitivity downgrade", async () => {
		const pkg = makePackage();
		await persistPackage(pkg);
		const { tools } = mountTools({ pkg, reviewer: { review: gatedReview } });
		await call(tools.submitContract, makeContract());
		await call(tools.requestReview);

		const lowered = cloneContract(makeContract());
		const risk = lowered.facts.find((fact) => fact.id === ids.factRisk);
		if (risk) risk.sensitivity = "ordinary";
		const revised = await call(tools.submitRevision, {
			contract: lowered,
			dispositions: [
				{
					findingId: did(502),
					status: "accepted",
					rationale: "Addressed the coverage gap.",
					resultingIntentIds: [ids.taskVisit],
				},
			],
		});
		expect(String(revised.error)).toContain("sensitivity");
	});
});

describe("sequence gates", () => {
	it("every out-of-order call is a tool result naming the legal action", async () => {
		const pkg = makePackage();
		await persistPackage(pkg);
		const { tools } = mountTools({ pkg });

		expect(String((await call(tools.requestReview)).error)).toContain(
			"submitContract",
		);
		expect(String((await call(tools.submitPlan, {})).error)).toContain(
			"submitContract",
		);

		await call(tools.submitContract, makeContract());
		expect(
			String((await call(tools.submitContract, makeContract())).error),
		).toContain("requestReview");
		expect(String((await call(tools.submitRevision, {})).error)).toContain(
			"requestReview",
		);
	});
});

describe("the §7.3 outcome: blocking questions reopen a fresh cycle", () => {
	it("refuses the plan, then reopens on the moved digest", async () => {
		const pkg = makePackage();
		await persistPackage(pkg);
		const withBlocking = cloneContract(makeContract());
		const question = withBlocking.openQuestions[0];
		if (question) question.blocking = true;
		const { tools } = mountTools({ pkg });

		await call(tools.submitContract, withBlocking);
		const reviewed = await call(tools.requestReview);
		expect(reviewed).toMatchObject({ ok: true, accepted: true });
		expect(String(reviewed.message)).toContain("askQuestions");

		const planned = await call(tools.submitPlan, {});
		expect(String(planned.error)).toContain("askQuestions");

		/* The answered round moves the digest: a new turn mounts new deps. */
		const answeredPkg = makePackage("Track CHW visits. Archived: yes.");
		await persistPackage(answeredPkg);
		const reopened = mountTools({ pkg: answeredPkg });
		const resubmitted = await call(
			reopened.tools.submitContract,
			makeContract(),
		);
		expect(resubmitted).toMatchObject({ ok: true });

		/* The new draft parents the accepted revision: one linear chain. */
		const revisions = await readDesignRevisionsForSession(sessionId);
		const head = revisions.at(-1);
		expect(head?.lifecycle).toBe("draft");
		expect(head?.parentRevisionId).toBe(revisions.at(-2)?.id);
		/* And the reopened cycle's review budget is fresh. */
		const gates = evaluateDesignGates(
			await loadDesignAncestry(sessionId, answeredPkg.packageDigest),
		);
		expect(gates.openCycleReviews).toBe(0);
		expect(gates.verdicts.requestReview.legal).toBe(true);
	});
});

describe("reviewing a draft under its own package", () => {
	it("re-renders the draft's package when the digest moved, and the review binds it", async () => {
		const pkg = makePackage();
		await persistPackage(pkg);
		const mounted = mountTools({ pkg });
		await call(mounted.tools.submitContract, makeContract());

		/* A question round intervened: this turn's package differs. */
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
		const reviewed = await call(later.tools.requestReview);
		expect(reviewed).toMatchObject({ ok: true });
		expect(rebuilt).toEqual([pkg.packageDigest]);

		const draft = await readLatestDesignRevision(sessionId);
		const reviews = await readDesignReviews(
			draft?.parentRevisionId ?? draft?.id ?? "",
		);
		expect(reviews[0]?.envelope.sourcePackageDigest).toBe(pkg.packageDigest);
	});

	it("refuses honestly when the sources no longer reproduce the draft's digest", async () => {
		const pkg = makePackage();
		await persistPackage(pkg);
		const mounted = mountTools({ pkg });
		await call(mounted.tools.submitContract, makeContract());

		const laterPkg = makePackage("Changed sources.");
		await persistPackage(laterPkg);
		const later = mountTools({ pkg: laterPkg, rebuild: async () => null });
		const reviewed = await call(later.tools.requestReview);
		expect(String(reviewed.error)).toContain("submitContract");
	});
});

describe("a failed reviewer call leaves the draft unreviewed", () => {
	it("returns an honest error and persists no review", async () => {
		const pkg = makePackage();
		await persistPackage(pkg);
		const { tools } = mountTools({ pkg, reviewer: { review: () => null } });
		await call(tools.submitContract, makeContract());
		const reviewed = await call(tools.requestReview);
		expect(String(reviewed.error)).toContain("unreviewed");

		const draft = await readLatestDesignRevision(sessionId);
		expect(draft?.lifecycle).toBe("draft");
		expect(await readDesignReviews(draft?.id ?? "")).toHaveLength(0);
	});
});

describe("resume convergence", () => {
	it("a fresh mount over the same ancestry reaches the same verdicts", async () => {
		const pkg = makePackage();
		await persistPackage(pkg);
		const first = mountTools({ pkg, reviewer: { review: gatedReview } });
		await call(first.tools.submitContract, makeContract());
		await call(first.tools.requestReview);

		/* The process died; a new POST mounts fresh tools over the durable
		 * record. The only legal forward move is still the revision. */
		const resumed = mountTools({ pkg, reviewer: { review: gatedReview } });
		const gates = evaluateDesignGates(
			await loadDesignAncestry(sessionId, pkg.packageDigest),
		);
		expect(gates.verdicts.submitRevision.legal).toBe(true);
		expect(gates.verdicts.requestReview.legal).toBe(false);
		const reviewedAgain = await call(resumed.tools.requestReview);
		expect(String(reviewedAgain.error)).toContain("submitRevision");
	});
});
