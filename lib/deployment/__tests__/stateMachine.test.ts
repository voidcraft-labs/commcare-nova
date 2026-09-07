/** Pure lifecycle semantics. Real persistence, HTTP evidence, and ownership
 * consequences are tested through the MCP deployment suites. */
import { expect, it } from "vitest";
import {
	applyAttemptOutcome,
	applyObservation,
	applyPhaseOutcome,
	applyPhaseOutcomes,
	clearObservationOutcomes,
	deploymentDisplaysAsReached,
	deploymentHasReached,
	deploymentIsObservable,
	deploymentProgressIndex,
	deploymentResumeState,
} from "../stateMachine";
import {
	type DeploymentPhase,
	type DeploymentProgressState,
	type DeploymentRecord,
	NO_DEPLOYMENT_PHASE_OUTCOMES,
} from "../types";

const BEFORE = "2026-08-06T00:00:00.000Z",
	NOW = "2026-08-07T00:00:00.000Z";
const succeeded = { status: "succeeded", at: NOW } as const;
const pending = {
	status: "pending",
	at: NOW,
	reason: "No released build",
} as const;
const failed = {
	status: "failed",
	at: NOW,
	failure: {
		code: "build_not_installable",
		message: "Could not confirm the build",
		details: ["Profile unavailable"],
	},
} as const;
function fresh(): DeploymentRecord {
	return {
		id: "dep-1",
		appId: "app-1",
		projectId: "project-1",
		server: "india",
		domain: "clinic",
		state: "preflight",
		resumePhase: null,
		phases: NO_DEPLOYMENT_PHASE_OUTCOMES,
		createdBy: "actor",
		createdAt: BEFORE,
		updatedAt: BEFORE,
		lastObservedAt: null,
	};
}
// Authored lifecycle expectations, not projections of the implementation tables.
const phases: readonly {
	phase: DeploymentPhase;
	entry: DeploymentProgressState;
	success: DeploymentProgressState;
}[] = [
	{ phase: "preflight", entry: "preflight", success: "preflight" },
	{ phase: "resources", entry: "preflight", success: "resources" },
	{ phase: "upload", entry: "resources", success: "uploaded" },
	{ phase: "build", entry: "uploaded", success: "built" },
	{ phase: "release", entry: "built", success: "released" },
	{ phase: "probe", entry: "released", success: "runnable" },
];
function live(): DeploymentRecord {
	const old = { status: "succeeded", at: BEFORE } as const;
	return {
		...fresh(),
		state: "runnable",
		lastObservedAt: BEFORE,
		phases: {
			preflight: old,
			resources: old,
			upload: old,
			build: old,
			release: old,
			probe: old,
		},
	};
}

it.each(phases)(
	"folds $phase with its exact success, waiting and retry semantics without mutating earlier evidence",
	({ phase, entry, success }) => {
		const original = live(),
			snapshot = structuredClone(original);
		for (const [outcome, state, resumePhase] of [
			[succeeded, success, null],
			[pending, entry, null],
			[failed, "incomplete", phase],
		] as const) {
			const next = applyPhaseOutcome(original, phase, outcome);
			expect(next).toEqual({
				...original,
				state,
				resumePhase,
				updatedAt: NOW,
				phases: { ...original.phases, [phase]: outcome },
			});
			expect(deploymentResumeState(next)).toBe(
				resumePhase === null ? null : entry,
			);
			expect(original).toEqual(snapshot);
		}
		const refusal = applyPhaseOutcome(original, phase, failed);
		expect(applyPhaseOutcome(refusal, phase, succeeded)).toEqual({
			...original,
			state: success,
			resumePhase: null,
			updatedAt: NOW,
			phases: { ...original.phases, [phase]: succeeded },
		});
	},
);

it("folds ordered progress through data, app, build and release before declaring the app runnable", () => {
	const initial = fresh();
	const results = phases.map(({ phase }) => [phase, succeeded] as const);
	for (let count = 1; count <= results.length; count++) {
		const current = applyPhaseOutcomes(initial, results.slice(0, count));
		expect(current.state).toBe(phases[count - 1].success);
		expect(
			phases.map(({ success }) => deploymentHasReached(current, success)),
		).toEqual(phases.map((_, index) => index < count));
	}
	expect(deploymentProgressIndex("incomplete")).toBeNull();
	expect(deploymentProgressIndex("runnable")).toBe(5);
});

it("separates the retry decision from visible completed rungs at every refusal point", () => {
	for (const [index, { phase }] of phases.entries()) {
		const refused = applyPhaseOutcome(live(), phase, failed);
		expect(
			phases.map(({ success }) => deploymentHasReached(refused, success)),
		).toEqual([false, false, false, false, false, false]);
		expect(
			phases.map(({ success }) =>
				deploymentDisplaysAsReached(refused, success),
			),
		).toEqual(phases.map((_, rung) => rung < index));
		expect(deploymentIsObservable(refused)).toBe(index >= 3);
	}
	expect(deploymentIsObservable(fresh())).toBe(false);
	expect(deploymentIsObservable(live())).toBe(true);
});

it("observes a missing remote app again, while an ordinary upload refusal stays refused", () => {
	const missing = applyPhaseOutcome(live(), "upload", {
		...failed,
		failure: {
			code: "remote_app_missing",
			message: "App is no longer there",
			details: [],
		},
	});
	expect(deploymentIsObservable(missing)).toBe(true);
	const rejected = applyPhaseOutcome(live(), "upload", {
		...failed,
		failure: {
			code: "hq_rejected_upload",
			message: "Upload refused",
			details: [],
		},
	});
	expect(deploymentIsObservable(rejected)).toBe(false);
});

it("withdraws runnable status and clears stale probe evidence when the build is no longer released", () => {
	const original = live(),
		snapshot = structuredClone(original);
	const next = applyObservation(original, [
		["build", succeeded],
		["release", pending],
	]);
	expect(next).toEqual({
		...original,
		state: "built",
		updatedAt: NOW,
		phases: {
			...original.phases,
			build: succeeded,
			release: pending,
			probe: null,
		},
	});
	expect(deploymentHasReached(next, "runnable")).toBe(false);
	expect(original).toEqual(snapshot);
	const noBuild = applyObservation(original, [["build", pending]]);
	expect(noBuild.state).toBe("uploaded");
	expect(noBuild.phases).toEqual({
		...original.phases,
		build: pending,
		release: null,
		probe: null,
	});
});

it("protects an uploaded target from every driven attempt until a new app is confirmed", () => {
	const uploaded = applyPhaseOutcomes(fresh(), [
		["preflight", succeeded],
		["resources", succeeded],
		["upload", succeeded],
	]);
	const refusedProbe = applyPhaseOutcome(live(), "probe", failed);
	for (const target of [uploaded, live(), refusedProbe]) {
		const snapshot = structuredClone(target);
		for (const phase of ["preflight", "resources", "upload"] as const)
			for (const outcome of [succeeded, pending, failed])
				expect(applyAttemptOutcome(target, phase, outcome)).toBe(target);
		expect(target).toEqual(snapshot);
	}
	const firstFailure = applyAttemptOutcome(fresh(), "upload", failed);
	expect(firstFailure.state).toBe("incomplete");
	expect(firstFailure.resumePhase).toBe("upload");
	const retried = applyAttemptOutcome(firstFailure, "preflight", succeeded);
	expect(retried.state).toBe("preflight");
	expect(retried.resumePhase).toBeNull();
	expect(retried.phases.preflight).toEqual(succeeded);
});

it("clears only observations when a new published app replaces their subject", () => {
	const original = live().phases,
		snapshot = structuredClone(original);
	expect(clearObservationOutcomes(original)).toEqual({
		...original,
		build: null,
		release: null,
		probe: null,
	});
	expect(original).toEqual(snapshot);
});
