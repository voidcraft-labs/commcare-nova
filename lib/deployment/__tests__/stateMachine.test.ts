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
	clearObservationOutcomes,
	deploymentCanRunPhase,
	deploymentDisplaysAsReached,
	deploymentHasReached,
	deploymentProgressIndex,
	deploymentResumeState,
	endpointLinkIsDurable,
	nextDeploymentPhase,
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
		expect(endpointLinkIsDurable(next)).toBe(false);
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

describe("what runs next", () => {
	it("resumes exactly where a refusal stopped", () => {
		const refused = record({ state: "incomplete", resumePhase: "probe" });
		expect(nextDeploymentPhase(refused)).toBe("probe");
	});

	it("moves from preflight to upload only once preflight passed", () => {
		expect(nextDeploymentPhase(record())).toBe("preflight");
		expect(
			nextDeploymentPhase(
				record({ phases: { ...NO_DEPLOYMENT_PHASE_OUTCOMES, preflight: ok } }),
			),
		).toBe("upload");
	});

	it("has nothing left to do on its own once runnable", () => {
		expect(nextDeploymentPhase(record({ state: "runnable" }))).toBeNull();
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
		// The strict predicate is what gates phases and durable links, and
		// it still answers false for everything while refused.
		expect(deploymentHasReached(refusedAtProbe, "uploaded")).toBe(false);
		expect(endpointLinkIsDurable(refusedAtProbe)).toBe(false);
		expect(deploymentCanRunPhase(refusedAtProbe, "release")).toBe(false);
	});
});

describe("durable links", () => {
	it("calls a link durable only once the released build was probed", () => {
		for (const state of [
			"preflight",
			"uploaded",
			"built",
			"released",
			"incomplete",
		] as const) {
			expect(endpointLinkIsDurable(record({ state }))).toBe(false);
		}
		expect(endpointLinkIsDurable(record({ state: "runnable" }))).toBe(true);
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
