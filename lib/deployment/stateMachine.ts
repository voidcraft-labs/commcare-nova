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
	DEPLOYMENT_PROGRESS_STATES,
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
 * The phase a plain "carry on" would run.
 *
 * A refused deployment resumes exactly where it stopped. A `runnable` one
 * has nothing left to do on its own — publishing again is a deliberate
 * act, never something Nova rolls into "next".
 */
export function nextDeploymentPhase(
	record: Pick<DeploymentRecord, "state" | "resumePhase" | "phases">,
): DeploymentPhase | null {
	if (record.state === "incomplete") return record.resumePhase;
	switch (record.state) {
		case "preflight":
			return record.phases.preflight?.status === "succeeded"
				? "upload"
				: "preflight";
		case "uploaded":
			return "build";
		case "built":
			return "release";
		case "released":
			return "probe";
		case "runnable":
			return null;
	}
}

/**
 * Whether a phase may run against a deployment in this state.
 *
 * `preflight` and `upload` are always available: the first reads nothing
 * external and the second is the author's own deliberate publish. The
 * three observation phases need the deployment to have got far enough for
 * there to be anything to observe, or to be resuming at that exact phase.
 */
export function deploymentCanRunPhase(
	record: Pick<DeploymentRecord, "state" | "resumePhase">,
	phase: DeploymentPhase,
): boolean {
	if (phase === "preflight" || phase === "upload") return true;
	if (record.state === "incomplete") return record.resumePhase === phase;
	return deploymentHasReached(record, DEPLOYMENT_PHASE_ENTRY_STATE[phase]);
}

/**
 * Whether a link into CommCare HQ may be presented as a durable place to
 * send workers.
 *
 * Only a probed, released deployment qualifies. Everything earlier is a
 * link to something that exists but is not yet what a worker would open,
 * and the surfaces say which.
 */
export function endpointLinkIsDurable(
	record: Pick<DeploymentRecord, "state">,
): boolean {
	return record.state === "runnable";
}

/**
 * Which rungs a person should see filled.
 *
 * Deliberately different from `deploymentHasReached`, and the difference
 * matters in both directions. That predicate is the strict one every
 * DECISION uses: while a deployment is refused it answers `false` for
 * everything, so nothing offers a durable link or runs a later phase off
 * a state the deployment does not definitely hold.
 *
 * But a probe that failed did not undo the upload, the build, or the
 * release. Drawing all five rungs empty would tell an author their app is
 * nowhere, which is both untrue and the opposite of what the refusal says
 * next ("nothing before this needs doing again"). So a refused deployment
 * shows everything up to the state its retry resumes from, and nothing
 * beyond it.
 */
export function deploymentDisplaysAsReached(
	record: Pick<DeploymentRecord, "state" | "resumePhase">,
	target: DeploymentProgressState,
): boolean {
	if (record.state !== "incomplete") {
		return deploymentHasReached(record, target);
	}
	const resume = deploymentResumeState(record);
	if (resume === null) return false;
	const reached = deploymentProgressIndex(resume);
	const wanted = deploymentProgressIndex(target);
	if (reached === null || wanted === null) return false;
	return wanted <= reached;
}

/**
 * Clear what a previous publish observed.
 *
 * CommCare HQ has no atomic app update, so publishing again produces a
 * different app there. Its build, release, and probe answers described
 * the old one and are not evidence about the new one, so they go rather
 * than lingering as a stale green tick.
 */
export function clearObservationOutcomes(
	phases: DeploymentPhaseOutcomes,
): DeploymentPhaseOutcomes {
	return { ...phases, build: null, release: null, probe: null };
}
