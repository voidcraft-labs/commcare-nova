/**
 * The deployment lifecycle's transition rules.
 *
 * Two of these are the whole reason the module exists, so they are
 * asserted directly rather than inferred from a happy path: a failure
 * never leaves a deployment holding `released` or `runnable`, and an
 * observation may walk a deployment BACKWARD when CommCare HQ stops
 * agreeing with it.
 */

import { describe, expect, it } from "vitest";
import {
	applyPhaseOutcome,
	applyPhaseOutcomes,
	applyPreflightOutcome,
	clearObservationOutcomes,
	deploymentCanRunPhase,
	deploymentDisplaysAsReached,
	deploymentHasReached,
	deploymentIsObservable,
	deploymentProgressIndex,
	deploymentResumeState,
} from "../stateMachine";
import {
	DEPLOYMENT_PHASES,
	type DeploymentPhase,
	type DeploymentRecord,
	NO_DEPLOYMENT_PHASE_OUTCOMES,
} from "../types";

const AT = "2026-08-06T00:00:00.000Z";

function record(overrides: Partial<DeploymentRecord> = {}): DeploymentRecord {
	return {
		id: "dep-1",
		appId: "app-1",
		projectId: "proj-1",
		server: "production",
		domain: "acme",
		state: "preflight",
		resumePhase: null,
		phases: NO_DEPLOYMENT_PHASE_OUTCOMES,
		createdBy: "u1",
		createdAt: AT,
		updatedAt: AT,
		lastObservedAt: null,
		...overrides,
	};
}

const ok = { status: "succeeded", at: AT } as const;
const waiting = { status: "pending", at: AT, reason: "not yet" } as const;
const broke = {
	status: "failed",
	at: AT,
	failure: { code: "hq_unreachable", message: "no", details: [] },
} as const;

describe("progress ordering", () => {
	it("gives incomplete no position on the ladder", () => {
		expect(deploymentProgressIndex("incomplete")).toBeNull();
		expect(deploymentProgressIndex("runnable")).toBe(4);
	});

	it("says a refused deployment has reached nothing, not even preflight", () => {
		const refused = record({ state: "incomplete", resumePhase: "probe" });
		expect(deploymentHasReached(refused, "preflight")).toBe(false);
		expect(deploymentHasReached(refused, "runnable")).toBe(false);
	});
});

describe("folding a phase outcome", () => {
	it("advances to the phase's success state", () => {
		const next = applyPhaseOutcome(record({ state: "uploaded" }), "build", ok);
		expect(next.state).toBe("built");
		expect(next.resumePhase).toBeNull();
	});

	it("refuses on failure and remembers the phase to resume at", () => {
		const next = applyPhaseOutcome(
			record({ state: "built" }),
			"release",
			broke,
		);
		expect(next.state).toBe("incomplete");
		expect(next.resumePhase).toBe("release");
		expect(deploymentResumeState(next)).toBe("built");
	});

	it("withholds released and runnable after ANY phase fails", () => {
		for (const phase of DEPLOYMENT_PHASES) {
			const next = applyPhaseOutcome(
				record({ state: "runnable" }),
				phase,
				broke,
			);
			expect(next.state).not.toBe("released");
			expect(next.state).not.toBe("runnable");
			expect(next.state).toBe("incomplete");
		}
	});

	it("walks a runnable deployment back when a build stops being released", () => {
		const runnable = record({
			state: "runnable",
			phases: {
				...NO_DEPLOYMENT_PHASE_OUTCOMES,
				build: ok,
				release: ok,
				probe: ok,
			},
		});
		const next = applyPhaseOutcomes(runnable, [
			["build", ok],
			["release", waiting],
		]);
		expect(next.state).toBe("built");
		// And it is genuinely no longer runnable, not merely relabelled.
		expect(deploymentHasReached(next, "runnable")).toBe(false);
	});

	it("clears a refusal once the same phase succeeds on retry", () => {
		const refused = applyPhaseOutcome(
			record({ state: "built" }),
			"release",
			broke,
		);
		const retried = applyPhaseOutcome(refused, "release", ok);
		expect(retried.state).toBe("released");
		expect(retried.resumePhase).toBeNull();
	});
});

describe("what Check status may answer", () => {
	it("refuses to observe a deployment refused before its app got there", () => {
		// It may still hold an earlier publish's mapping, and observing that
		// would fold three green outcomes over the refusal and erase the
		// retry point, from a button sitting next to it.
		for (const resumePhase of ["preflight", "upload"] as const) {
			expect(
				deploymentIsObservable(record({ state: "incomplete", resumePhase })),
			).toBe(false);
		}
	});

	it("observes every later refusal, which is what Check status is for", () => {
		for (const resumePhase of ["build", "release", "probe"] as const) {
			expect(
				deploymentIsObservable(record({ state: "incomplete", resumePhase })),
			).toBe(true);
		}
	});

	it("needs the app to have reached the project space at all", () => {
		expect(deploymentIsObservable(record({ state: "preflight" }))).toBe(false);
		expect(deploymentIsObservable(record({ state: "uploaded" }))).toBe(true);
		expect(deploymentIsObservable(record({ state: "runnable" }))).toBe(true);
	});
});

describe("which phases may run", () => {
	it("always allows preflight and upload — both are the author's own act", () => {
		for (const state of ["preflight", "uploaded", "runnable"] as const) {
			expect(deploymentCanRunPhase(record({ state }), "preflight")).toBe(true);
			expect(deploymentCanRunPhase(record({ state }), "upload")).toBe(true);
		}
	});

	it("withholds an observation phase until there is something to observe", () => {
		expect(deploymentCanRunPhase(record({ state: "preflight" }), "build")).toBe(
			false,
		);
		expect(deploymentCanRunPhase(record({ state: "uploaded" }), "build")).toBe(
			true,
		);
		expect(deploymentCanRunPhase(record({ state: "uploaded" }), "probe")).toBe(
			false,
		);
	});

	it("allows only the exact resume phase while refused", () => {
		const refused = record({ state: "incomplete", resumePhase: "release" });
		expect(deploymentCanRunPhase(refused, "release")).toBe(true);
		expect(deploymentCanRunPhase(refused, "build")).toBe(false);
		expect(deploymentCanRunPhase(refused, "probe")).toBe(false);
	});
});

describe("what a person sees on a refused deployment", () => {
	// A probe that failed did not undo the upload, the build, or the
	// release, and telling somebody their app is nowhere is both untrue
	// and the opposite of what the refusal says to do next.
	const refusedAtProbe = record({ state: "incomplete", resumePhase: "probe" });

	it("shows everything up to where the retry resumes", () => {
		expect(deploymentDisplaysAsReached(refusedAtProbe, "uploaded")).toBe(true);
		expect(deploymentDisplaysAsReached(refusedAtProbe, "built")).toBe(true);
		expect(deploymentDisplaysAsReached(refusedAtProbe, "released")).toBe(true);
	});

	it("shows nothing beyond it", () => {
		expect(deploymentDisplaysAsReached(refusedAtProbe, "runnable")).toBe(false);
	});

	it("shows nothing at all when the publish itself was refused", () => {
		const refusedAtUpload = record({
			state: "incomplete",
			resumePhase: "upload",
		});
		expect(deploymentDisplaysAsReached(refusedAtUpload, "uploaded")).toBe(
			false,
		);
		expect(deploymentDisplaysAsReached(refusedAtUpload, "preflight")).toBe(
			true,
		);
	});

	it("never lets the display predicate soften a DECISION", () => {
		// The strict predicate is what gates phases, and it still answers
		// false for everything while the deployment is refused.
		expect(deploymentHasReached(refusedAtProbe, "uploaded")).toBe(false);
		expect(deploymentCanRunPhase(refusedAtProbe, "release")).toBe(false);
	});

	it("keeps an attempt's failure from rewriting what the target holds", () => {
		// A refused publish attempt against an app that is already live must
		// not report the live app as having reached nothing.
		const live = record({ state: "runnable" });
		const refusedAttempt = applyPreflightOutcome(live, {
			status: "failed",
			at: AT,
			failure: { code: "hq_not_connected", message: "no key", details: [] },
		});
		expect(refusedAttempt.state).toBe("runnable");
		expect(refusedAttempt.phases.preflight?.status).toBe("failed");
	});

	it("does not walk a live deployment back to preflight on a clean check", () => {
		const live = record({ state: "runnable" });
		expect(applyPreflightOutcome(live, ok).state).toBe("runnable");
	});

	it("still moves a brand-new deployment through preflight", () => {
		const fresh = record();
		expect(applyPreflightOutcome(fresh, ok).state).toBe("preflight");
		expect(
			applyPreflightOutcome(fresh, {
				status: "failed",
				at: AT,
				failure: { code: "app_not_ready", message: "fix it", details: [] },
			}).state,
		).toBe("incomplete");
	});
});

describe("republishing", () => {
	it("drops observations that described the previous CommCare HQ app", () => {
		const cleared = clearObservationOutcomes({
			...NO_DEPLOYMENT_PHASE_OUTCOMES,
			preflight: ok,
			upload: ok,
			build: ok,
			release: ok,
			probe: ok,
		});
		expect(cleared.build).toBeNull();
		expect(cleared.release).toBeNull();
		expect(cleared.probe).toBeNull();
		// The publish's own history is evidence about THIS app and stays.
		expect(cleared.preflight).toEqual(ok);
		expect(cleared.upload).toEqual(ok);
	});
});

describe("phase and state tables agree", () => {
	it("names an entry and a success state for every phase", () => {
		const phases: readonly DeploymentPhase[] = DEPLOYMENT_PHASES;
		for (const phase of phases) {
			const next = applyPhaseOutcome(record(), phase, ok);
			expect(deploymentProgressIndex(next.state)).not.toBeNull();
		}
	});
});
