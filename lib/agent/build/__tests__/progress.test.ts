import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type BuildOrchestratorState,
	buildOrchestratorStateSchema,
	type OrchestrationHead,
} from "@/lib/agent/build/orchestratorState";
import {
	deriveBuildPlanSummary,
	deriveDesignBuildStage,
	deriveDesignOutline,
	deriveInterruptedMaterializedBuildStage,
	progressEnvelope,
	type StageFoldSession,
} from "@/lib/agent/build/progress";
import {
	did,
	ids,
	makeBuildPlan,
	makeContract,
} from "@/lib/agent/design/__tests__/fixtures";
import { appDesignContractSchema } from "@/lib/agent/design/contract";
import { designReviewSchema } from "@/lib/agent/design/review";

/** A session with no holder columns — authority cleared or never claimed. */
const HOLDER_FREE = {
	awaiting_input: false,
	owner_user_id: "user-1",
	run_id: null,
	run_holder_nonce: null,
	run_actor_user_id: null,
	run_mode: null,
	run_lease_expires_at: null,
	res_period: null,
	res_reserved: null,
	res_settled: null,
	res_user_id: null,
	res_run_id: null,
	last_error_type: null,
	updated_at: new Date("2026-08-01T10:00:00.000Z"),
};

const SESSION: StageFoldSession = {
	...HOLDER_FREE,
	state: "materialized" as const,
	app_id: "app-id",
};

/** A pre-app session whose BUILD holder is stamped; the lease decides. */
function heldSession(leaseExpiresAt: Date): StageFoldSession {
	const runId = "77777777-7777-4777-8777-777777777777";
	return {
		...HOLDER_FREE,
		state: "active" as const,
		app_id: null,
		run_id: runId,
		run_holder_nonce: "88888888-8888-4888-8888-888888888888",
		run_actor_user_id: "user-1",
		run_mode: "build",
		run_lease_expires_at: leaseExpiresAt,
		res_period: "2026-08",
		res_reserved: 100,
		res_settled: false,
		res_user_id: "user-1",
		res_run_id: runId,
	};
}

function head(state: OrchestrationHead["state"]): OrchestrationHead {
	buildOrchestratorStateSchema.parse(state);
	return {
		revision: 1,
		eventId: crypto.randomUUID(),
		digest: "a".repeat(64),
		state,
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-09-06T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

const DESIGNING = () =>
	head({
		kind: "designing",
		designSessionId: "11111111-1111-4111-8111-111111111111",
		sourcePackageDigest: "b".repeat(64),
	});

describe("dead-run evidence in the stage fold", () => {
	it("reports incomplete for a killed run whose lease lapsed before any reaper ran", () => {
		/* No failure flush recorded the death (`last_error_type` stays null):
		 * the lapsed holder lease is the only durable evidence, and the reaper
		 * that would stamp the error type fires only from a later claim's
		 * admission scan. Without this arm the page wears active-work copy
		 * with no resume control — observed live on a dev server killed
		 * mid-review. */
		const lapsed = heldSession(new Date(Date.now() - 60_000));
		expect(deriveDesignBuildStage(lapsed, DESIGNING())).toBe("incomplete");
		expect(deriveDesignBuildStage(lapsed, null)).toBe("incomplete");
	});

	it("keeps a live holder's active-work stage", () => {
		const live = heldSession(new Date(Date.now() + 300_000));
		expect(deriveDesignBuildStage(live, DESIGNING())).toBe("designing");
		expect(deriveDesignBuildStage(live, null)).toBe("understanding");
	});

	it("keeps an abandoned paused round on needs-input, not incomplete", () => {
		/* A lapsed PAUSED round still resumes through the answer POST's
		 * reacquire, so the question stays the stage. */
		const lapsedPause = {
			...heldSession(new Date(Date.now() - 60_000)),
			awaiting_input: true,
		};
		expect(deriveDesignBuildStage(lapsedPause, DESIGNING())).toBe(
			"needs-input",
		);
	});

	it("does not read a cleared holder as a death", () => {
		const cleared = { ...HOLDER_FREE, state: "active" as const, app_id: null };
		expect(deriveDesignBuildStage(cleared, DESIGNING())).toBe("designing");
	});
});

describe("interrupted materialized build progress", () => {
	it("offers exact recovery when infrastructure failed before a terminal event", () => {
		expect(
			deriveInterruptedMaterializedBuildStage(
				SESSION,
				head({
					kind: "planning",
					designRevisionId: crypto.randomUUID(),
					designRevisionDigest: "b".repeat(64),
				}),
			),
		).toBe("incomplete");
		expect(deriveInterruptedMaterializedBuildStage(SESSION, null)).toBe(
			"incomplete",
		);
	});

	it("does not turn a deterministic build defect into a retry strategy", () => {
		expect(
			deriveInterruptedMaterializedBuildStage(
				SESSION,
				head({
					kind: "failed",
					failureId: crypto.randomUUID(),
					recoverable: false,
					errorType: "final-verification-failed",
				}),
			),
		).toBe("failed");
	});
});

const ID = "11111111-1111-4111-8111-111111111111";
const HASH = "b".repeat(64);
const STATES: Array<[BuildOrchestratorState, string, string]> = [
	[
		{ kind: "designing", designSessionId: ID, sourcePackageDigest: HASH },
		"designing",
		"incomplete",
	],
	[
		{
			kind: "awaiting-user",
			designSessionId: ID,
			designRevisionId: ID,
			blockingQuestionIds: [did(888)],
		},
		"needs-input",
		"needs-input",
	],
	[
		{
			kind: "awaiting-user-questions",
			designSessionId: ID,
			designRevisionId: null,
		},
		"needs-input",
		"needs-input",
	],
	[
		{ kind: "planning", designRevisionId: ID, designRevisionDigest: HASH },
		"planning",
		"incomplete",
	],
	[
		{
			kind: "executing-slice",
			designRevisionId: ID,
			buildPlanId: ID,
			sliceId: did(889),
			changeSetId: ID,
			attempt: 1,
		},
		"building-first-workflow",
		"incomplete",
	],
	[
		{
			kind: "translating",
			designRevisionId: ID,
			buildPlanId: ID,
			appId: "app",
			sourceSeq: 1,
		},
		"translating",
		"incomplete",
	],
	[{ kind: "finished", appId: "app", appSeq: 2 }, "ready", "ready"],
	[
		{ kind: "accepted-partial", appId: "app", appSeq: 2 },
		"incomplete",
		"incomplete",
	],
	[
		{ kind: "failed", failureId: ID, recoverable: true, errorType: "network" },
		"incomplete",
		"incomplete",
	],
	[
		{ kind: "failed", failureId: ID, recoverable: false, errorType: "invalid" },
		"failed",
		"failed",
	],
];

it.each(STATES)(
	"projects $kind under active, failed, expired and waiting session evidence",
	(state, active, dead) => {
		const live = heldSession(new Date(Date.now() + 1));
		const observed = head(state);
		expect(deriveDesignBuildStage(live, observed)).toBe(active);
		expect(
			deriveDesignBuildStage(
				{ ...live, last_error_type: "interrupted" },
				observed,
			),
		).toBe(dead);
		expect(
			deriveDesignBuildStage(
				{ ...live, run_lease_expires_at: new Date(Date.now()) },
				observed,
			),
		).toBe(dead);
		expect(
			deriveDesignBuildStage({ ...live, state: "abandoned" }, observed),
		).toBe("failed");
		expect(
			deriveDesignBuildStage(
				{ ...live, state: "abandoned", awaiting_input: true },
				observed,
			),
		).toBe("needs-input");
		if (state.kind === "executing-slice")
			expect(deriveDesignBuildStage({ ...live, app_id: "app" }, observed)).toBe(
				"building",
			);
	},
);

it("projects only safe outline fields from admitted contracts and real review records", () => {
	const contract = makeContract();
	contract.actors[0].constraints = ["private-source-marker"];
	contract.openQuestions = [
		{
			id: did(900),
			question: "Which villages?",
			blocking: true,
			relatedElementIds: [ids.recPatient],
		},
		{
			id: did(901),
			question: "private-question-marker",
			blocking: false,
			relatedElementIds: [],
		},
	];
	appDesignContractSchema.parse(contract);
	const review = designReviewSchema.parse({
		schemaVersion: 1,
		id: did(902),
		summary: "private-review-marker",
		findings: [],
	});
	const before = structuredClone(contract);
	const result = deriveDesignOutline(contract, [review]);
	expect(result).toEqual({
		objective:
			"Help community health workers register patients and record visits with supervisor oversight.",
		actors: ["Community health worker", "Supervisor"],
		tasks: ["Register patient", "Record visit"],
		records: ["Patient", "Visit"],
		lists: ["Patients"],
		assumptions: [
			"Workers can identify the correct patient before recording a visit.",
		],
		blockingQuestions: ["Which villages?"],
		outOfScope: ["Billing"],
		reviewed: true,
	});
	expect(JSON.stringify(result)).not.toContain("private-");
	expect(deriveDesignOutline(contract, []).reviewed).toBe(false);
	expect(contract).toEqual(before);
});

it("wraps projections with the actual head and summarizes only accepted plan counts and names", () => {
	const plan = makeBuildPlan();
	const projection = deriveBuildPlanSummary(plan);
	expect(projection).toEqual({
		sliceCount: 2,
		sliceNames: ["Register patient", "Record visit"],
		externalActionCount: 0,
	});
	const observed = DESIGNING();
	expect(progressEnvelope(ID, observed, projection)).toEqual({
		eventVersion: 1,
		designSessionId: ID,
		orchestrationEventId: observed.eventId,
		orchestrationRevision: 1,
		data: projection,
	});
	expect(progressEnvelope(ID, null, projection)).toEqual({
		eventVersion: 1,
		designSessionId: ID,
		orchestrationEventId: "",
		orchestrationRevision: 0,
		data: projection,
	});
});
