// lib/deployment/stateMachine.ts
//
// The deployment lifecycle, as pure functions over a record.
//
// Everything here is total and side-effect free so the transitions can be
// reasoned about and tested without a database or CommCare HQ. The driver
// modules decide what happened; this module decides what that means.
//
// Two rules shape the whole file:
//
//   1. A failure never leaves a deployment holding a state it did not
//      reach. `released` and `runnable` are withheld the moment any phase
//      fails, which is what stops Nova telling somebody their app is live
//      when only the upload succeeded.
//   2. Observation may move a deployment BACKWARD. If a build stops being
//      released on CommCare HQ, a deployment that was `runnable` is not
//      runnable any more, and saying otherwise would leave a durable link
//      on screen that no longer works.

import {
	DEPLOYMENT_PHASE_ENTRY_STATE,
	DEPLOYMENT_PHASE_SUCCESS_STATE,
	DEPLOYMENT_PHASES,
	DEPLOYMENT_PROGRESS_STATES,
	DEPLOYMENT_STATE_PRODUCING_PHASE,
	type DeploymentPhase,
	type DeploymentPhaseOutcome,
	type DeploymentPhaseOutcomes,
	type DeploymentProgressState,
	type DeploymentRecord,
	type DeploymentState,
} from "./types";

/**
 * How far along a progress state is. `incomplete` has no position, which
 * is the point: it is a refusal, so nothing may compare it as "further
 * than uploaded" or "not yet released".
 */
export function deploymentProgressIndex(state: DeploymentState): number | null {
	const index = (DEPLOYMENT_PROGRESS_STATES as readonly string[]).indexOf(
		state,
	);
	return index === -1 ? null : index;
}

/**
 * Whether a deployment has reached at least `target`.
 *
 * `incomplete` answers `false` for every target including `preflight`:
 * a refused deployment has not reached anything, and the caller that
 * wants to know where it failed reads `resumePhase`.
 */
export function deploymentHasReached(
	record: Pick<DeploymentRecord, "state">,
	target: DeploymentProgressState,
): boolean {
	const current = deploymentProgressIndex(record.state);
	const wanted = deploymentProgressIndex(target);
	if (current === null || wanted === null) return false;
	return current >= wanted;
}

/**
 * The state a failed deployment retries from.
 *
 * Derived from `resumePhase` rather than stored beside it, so the phase a
 * retry re-enters and the state it re-enters from can never disagree.
 */
export function deploymentResumeState(
	record: Pick<DeploymentRecord, "state" | "resumePhase">,
): DeploymentProgressState | null {
	if (record.state !== "incomplete" || record.resumePhase === null) return null;
	return DEPLOYMENT_PHASE_ENTRY_STATE[record.resumePhase];
}

/**
 * Fold one phase result into a deployment.
 *
 * A success moves to that phase's success state; a pending answer settles
 * on the phase's own entry state, which is what makes an un-release walk
 * a `runnable` deployment back to `built`; a failure refuses, remembering
 * the phase so a retry resumes exactly there.
 */
export function applyPhaseOutcome(
	record: DeploymentRecord,
	phase: DeploymentPhase,
	outcome: DeploymentPhaseOutcome,
): DeploymentRecord {
	const phases: DeploymentPhaseOutcomes = {
		...record.phases,
		[phase]: outcome,
	};
	if (outcome.status === "failed") {
		return {
			...record,
			state: "incomplete",
			resumePhase: phase,
			phases,
			updatedAt: outcome.at,
		};
	}
	const state =
		outcome.status === "succeeded"
			? DEPLOYMENT_PHASE_SUCCESS_STATE[phase]
			: DEPLOYMENT_PHASE_ENTRY_STATE[phase];
	return {
		...record,
		state,
		resumePhase: null,
		phases,
		updatedAt: outcome.at,
	};
}

/** Fold an ordered run of phase results, left to right. */
export function applyPhaseOutcomes(
	record: DeploymentRecord,
	outcomes: readonly (readonly [DeploymentPhase, DeploymentPhaseOutcome])[],
): DeploymentRecord {
	return outcomes.reduce(
		(next, [phase, outcome]) => applyPhaseOutcome(next, phase, outcome),
		record,
	);
}

/**
 * Fold one observation pass.
 *
 * Every phase the pass did NOT reach is cleared, because an observation
 * stops at the first thing that has not happened: un-releasing a build
 * yields `[build ok, release pending]` and nothing about the probe, and
 * keeping the previous `probe: succeeded` would ship "released: no,
 * probed: yes" to anything reading the phase history.
 */
export function applyObservation(
	record: DeploymentRecord,
	outcomes: readonly (readonly [DeploymentPhase, DeploymentPhaseOutcome])[],
): DeploymentRecord {
	const observed = new Set(outcomes.map(([phase]) => phase));
	const cleared: DeploymentPhaseOutcomes = {
		...record.phases,
		build: observed.has("build") ? record.phases.build : null,
		release: observed.has("release") ? record.phases.release : null,
		probe: observed.has("probe") ? record.phases.probe : null,
	};
	return outcomes.reduce(
		(next, [phase, outcome]) => applyPhaseOutcome(next, phase, outcome),
		{ ...record, phases: cleared },
	);
}

/**
 * Whether observation may say anything about this deployment.
 *
 * Observation answers questions about a build on CommCare HQ, so it needs
 * the app to have got there. A deployment refused at `preflight` or
 * `upload` may still hold an EARLIER publish's mapping, and observing it
 * would fold succeeded outcomes over the refusal and turn the record
 * green, destroying the phase a retry resumes from, from a button sitting
 * next to the refusal.
 *
 * One `upload` refusal is the exception: `remote_app_missing` was WRITTEN
 * BY observation, about the current mapping, when CommCare HQ answered
 * that the app is gone. Asking again is exactly right, both to re-confirm
 * and to notice the app coming back after CommCare HQ's own undo.
 *
 * Every later refusal is observable, and that is the point of Check
 * status: a probe that failed is retried by asking CommCare HQ again.
 */
export function deploymentIsObservable(
	record: Pick<DeploymentRecord, "state" | "resumePhase" | "phases">,
): boolean {
	if (record.state !== "incomplete") {
		return deploymentHasReached(record, "uploaded");
	}
	if (record.resumePhase === "preflight") return false;
	if (record.resumePhase === "upload") {
		const upload = record.phases.upload;
		return (
			upload?.status === "failed" &&
			upload.failure.code === "remote_app_missing"
		);
	}
	return true;
}

/**
 * Fold a publish attempt's result without rewriting what the target
 * already holds.
 *
 * A deployment's state describes the PROJECT SPACE, not the attempt. If an
 * app is already released on `acme` and somebody clicks Publish with an
 * expired API key, the app on `acme` is still released; only this attempt
 * failed. Recording it as `incomplete` would make Nova report a live app
 * as having reached nothing, and a plain success would walk a `runnable`
 * deployment back to `preflight`.
 *
 * So while the deployment already has something on the project space, a
 * refused attempt changes NOTHING here: the same record is returned, by
 * reference, and the caller reports the refusal on the attempt itself
 * (`DeploymentAttemptRefusal`). Persisting it into the durable phase
 * history was tried first and produced exactly the confusion it reads
 * like: the failure often belongs to the person who clicked (their key,
 * their permissions) rather than to the target every Project member
 * shares, and once written it lingered, so a stale upload rejection from
 * last week ended up explaining today's unrelated refusal.
 *
 * Both phases a person can DRIVE come through here, and for the same
 * reason: CommCare HQ rejecting a re-upload says nothing about the app
 * already sitting on the project space. Only the observation phases fold
 * unconditionally, because those are answers ABOUT the target.
 *
 * "Has put something there" is the DISPLAY predicate, not the strict one.
 * A deployment refused at the probe is `incomplete`, which the strict
 * predicate answers `false` for at every rung, so reading it here would
 * hand the worst case the worst answer: an app that is uploaded, built and
 * released on CommCare HQ would be walked back to `preflight` by an
 * expired key, losing the phase its retry resumes from and making the
 * record unobservable, so a whole re-publish would be the only way back.
 * What matters is whether the app is THERE, and after a probe failure it
 * is.
 */
export function applyAttemptOutcome(
	record: DeploymentRecord,
	phase: "preflight" | "upload",
	outcome: DeploymentPhaseOutcome,
): DeploymentRecord {
	if (deploymentDisplaysAsReached(record, "uploaded")) {
		return record;
	}
	return applyPhaseOutcome(record, phase, outcome);
}

/**
 * Which rungs a person should see filled.
 *
 * Deliberately different from `deploymentHasReached`, and the difference
 * matters in both directions. That predicate is the strict one every
 * DECISION uses: while a deployment is refused it answers `false` for
 * everything, so nothing runs a later phase off a state the deployment
 * does not definitely hold.
 *
 * But a probe that failed did not undo the upload, the build, or the
 * release. Drawing all five rungs empty would tell an author their app is
 * nowhere, which is both untrue and the opposite of what the refusal says
 * next. So a refused deployment shows exactly the rungs whose producing
 * phase ran and succeeded BEFORE the phase that failed. Comparing phases
 * rather than states is load-bearing at the first rung: the preflight
 * phase's entry state and success state are both `preflight`, so a
 * state comparison drew "Checked" filled for the very check that failed.
 */
export function deploymentDisplaysAsReached(
	record: Pick<DeploymentRecord, "state" | "resumePhase">,
	target: DeploymentProgressState,
): boolean {
	if (record.state !== "incomplete") {
		return deploymentHasReached(record, target);
	}
	if (record.resumePhase === null) return false;
	const failedAt = DEPLOYMENT_PHASES.indexOf(record.resumePhase);
	const wanted = DEPLOYMENT_PHASES.indexOf(
		DEPLOYMENT_STATE_PRODUCING_PHASE[target],
	);
	return wanted < failedAt;
}

/**
 * Clear what a previous publish observed.
 *
 * Whether a publish updated the app in place or created a fresh one, the
 * record's build, release, and probe answers described what the project
 * space held BEFORE it: a build of the previous version is not evidence
 * about this one. They go rather than lingering as a stale green tick,
 * and the next observation re-derives the honest story, version gap and
 * all.
 */
export function clearObservationOutcomes(
	phases: DeploymentPhaseOutcomes,
): DeploymentPhaseOutcomes {
	return { ...phases, build: null, release: null, probe: null };
}
