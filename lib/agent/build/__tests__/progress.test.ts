import { describe, expect, it } from "vitest";
import type { OrchestrationHead } from "@/lib/agent/build/orchestratorState";
import {
	deriveDesignBuildStage,
	deriveInterruptedMaterializedBuildStage,
	type StageFoldSession,
} from "@/lib/agent/build/progress";

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
	return {
		revision: 1,
		eventId: crypto.randomUUID(),
		digest: "a".repeat(64),
		state,
	};
}

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
