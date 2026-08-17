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
	applyAttemptOutcome,
	applyObservation,
	applyPhaseOutcome,
	clearObservationOutcomes,
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
	failure: { code: "build_not_installable", message: "no", details: [] },
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
		const next = applyObservation(runnable, [
			["build", ok],
			["release", waiting],
		]);
		expect(next.state).toBe("built");
		// And it is genuinely no longer runnable, not merely relabelled.
		expect(deploymentHasReached(next, "runnable")).toBe(false);
		// The probe answer described a release that no longer exists, so it
		// must not survive as "released: no, probed: yes".
		expect(next.phases.probe).toBeNull();
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

	it("still observes an app CommCare HQ reported missing, so it can heal", () => {
		/* `remote_app_missing` was written BY observation, about the CURRENT
		 * mapping — not by a publish that never landed. Re-asking is exactly
		 * right: it re-confirms the deletion, or notices the app coming back
		 * through CommCare HQ's own undo, at which point the answered
		 * versions read folds the upload rung back to succeeded. */
		expect(
			deploymentIsObservable(
				record({
					state: "incomplete",
					resumePhase: "upload",
					phases: {
						...NO_DEPLOYMENT_PHASE_OUTCOMES,
						upload: {
							status: "failed",
							at: AT,
							failure: {
								code: "remote_app_missing",
								message: "gone",
								details: [],
							},
						},
					},
				}),
			),
		).toBe(true);
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

	it("never fills the Checked rung for the very check that failed", () => {
		/* The preflight phase's entry state and success state are both
		 * `preflight`, so a state comparison cannot tell "about to be
		 * checked" from "checked and passed" — and drew a green tick above
		 * an amber box explaining that the check is what stopped the
		 * publish. The phase comparison can. */
		const refusedAtPreflight = record({
			state: "incomplete",
			resumePhase: "preflight",
		});
		expect(deploymentDisplaysAsReached(refusedAtPreflight, "preflight")).toBe(
			false,
		);
		expect(deploymentDisplaysAsReached(refusedAtPreflight, "uploaded")).toBe(
			false,
		);
	});

	it("never lets the display predicate soften a DECISION", () => {
		// The strict predicate is what gates phases, and it still answers
		// false for everything while the deployment is refused.
		expect(deploymentHasReached(refusedAtProbe, "uploaded")).toBe(false);
	});

	it("keeps an attempt's failure from touching what the target holds", () => {
		/* A refused publish attempt against an app that is already live must
		 * not report the live app as having reached nothing — and it must not
		 * write the failure into the durable phase history either. The
		 * failure belongs to the ATTEMPT (often to the person whose key
		 * expired), and once persisted it lingered, so a stale rejection from
		 * one attempt ended up explaining a later, unrelated refusal. The
		 * same record coming back BY REFERENCE is the store's signal to write
		 * nothing at all. */
		const live = record({ state: "runnable" });
		const refusedAttempt = applyAttemptOutcome(live, "preflight", {
			status: "failed",
			at: AT,
			failure: { code: "hq_not_connected", message: "no key", details: [] },
		});
		expect(refusedAttempt).toBe(live);
	});

	it("does not walk a live deployment back to preflight on a clean check", () => {
		const live = record({ state: "runnable" });
		expect(applyAttemptOutcome(live, "preflight", ok).state).toBe("runnable");
	});

	it("still moves a brand-new deployment through preflight", () => {
		const fresh = record();
		expect(applyAttemptOutcome(fresh, "preflight", ok).state).toBe("preflight");
		expect(
			applyAttemptOutcome(fresh, "preflight", {
				status: "failed",
				at: AT,
				failure: { code: "app_not_ready", message: "fix it", details: [] },
			}).state,
		).toBe("incomplete");
	});

	it("protects a deployment that is already REFUSED at a later phase", () => {
		/* The case the strict predicate gets wrong, and the one that hurts
		 * most: the app is uploaded, built and released on CommCare HQ and
		 * only the probe failed. An expired key must not walk that back to
		 * `preflight` — doing so loses the phase a retry resumes from and
		 * makes the record unobservable, so a whole re-publish would be the
		 * only way forward. */
		const probeRefused = record({
			state: "incomplete",
			resumePhase: "probe",
		});
		const after = applyAttemptOutcome(probeRefused, "preflight", {
			status: "failed",
			at: AT,
			failure: { code: "hq_not_connected", message: "no key", details: [] },
		});
		expect(after).toBe(probeRefused);
	});

	it("keeps a live deployment live when a RE-UPLOAD is rejected", () => {
		/* The publish path's own failure, not preflight's. CommCare HQ
		 * answering 500 to a republish does not remove the app already
		 * released on the project space, and reporting `incomplete` would
		 * make Nova tell workers' administrators their live app is nowhere
		 * — with publishing all over again as the only exit. */
		const live = record({ state: "runnable" });
		const after = applyAttemptOutcome(live, "upload", {
			status: "failed",
			at: AT,
			failure: { code: "hq_rejected_upload", message: "500", details: [] },
		});
		expect(after).toBe(live);
		expect(deploymentIsObservable(after)).toBe(true);
	});

	it("still refuses a FIRST upload that CommCare HQ rejected", () => {
		const fresh = record({ state: "preflight" });
		const after = applyAttemptOutcome(fresh, "upload", {
			status: "failed",
			at: AT,
			failure: { code: "hq_rejected_upload", message: "500", details: [] },
		});
		expect(after.state).toBe("incomplete");
		expect(after.resumePhase).toBe("upload");
	});

	it("still rewrites a deployment refused BEFORE its app got there", () => {
		// Nothing reached the project space, so there is nothing to protect.
		const uploadRefused = record({
			state: "incomplete",
			resumePhase: "upload",
		});
		const after = applyAttemptOutcome(uploadRefused, "preflight", {
			status: "failed",
			at: AT,
			failure: { code: "app_not_ready", message: "fix it", details: [] },
		});
		expect(after.state).toBe("incomplete");
		expect(after.resumePhase).toBe("preflight");
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
