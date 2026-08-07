import "server-only";

import type { CommCareCredentials } from "@/lib/commcare/client";
import {
	listAppBuilds,
	probeBuildProfile,
	readAppVersions,
} from "@/lib/commcare/client";
import type {
	DeploymentFailureCode,
	DeploymentPhase,
	DeploymentPhaseOutcome,
} from "./types";

/**
 * Watching what a person did on CommCare HQ.
 *
 * Nova cannot make a build or release one with an API key, so these three
 * phases report rather than act. That is the honest shape of the target,
 * and it is what lets the setup artifact say "make a build, then release
 * it" as a real instruction instead of pretending Nova will.
 *
 * A phase answers one of three ways. `succeeded` means the thing has
 * happened. `pending` means it has not happened YET, which is the normal
 * state of a freshly uploaded app and never a refusal. `failed` means
 * CommCare HQ answered and the answer is bad.
 *
 * **Not reaching CommCare HQ is none of those.** A pass that cannot get an
 * answer returns `unavailable` and writes nothing: a network blip must not
 * walk a `runnable` deployment down to "On CommCare HQ" and tell every
 * member of the Project their app is refused, when the app is still
 * released and workers are still using it. "Nova could not check" is a
 * fact about the check, and it belongs to the caller who asked.
 */

/** Everything one observation pass produced. */
export type ObservationResult =
	| {
			readonly kind: "checked";
			/** In phase order, ready for the state machine to fold. */
			readonly outcomes: readonly (readonly [
				DeploymentPhase,
				DeploymentPhaseOutcome,
			])[];
			/** CommCare HQ's own version of the app, when it answered. */
			readonly remoteRevision: number | null;
			/** The released build a device would install, once one is probed. */
			readonly releasedBuildId: string | null;
	  }
	/** CommCare HQ could not be asked. Nothing is written. */
	| { readonly kind: "unavailable"; readonly message: string };

function failed(
	now: string,
	code: DeploymentFailureCode,
	message: string,
	details: readonly string[] = [],
): DeploymentPhaseOutcome {
	return { status: "failed", at: now, failure: { code, message, details } };
}

function pending(now: string, reason: string): DeploymentPhaseOutcome {
	return { status: "pending", at: now, reason };
}

/**
 * Ask CommCare HQ what it has done with the app Nova published there.
 *
 * One version read answers both the build and the release question, so a
 * plain "check status" costs one request in the common case and a second
 * only when there is a released build worth probing.
 */
export async function observeDeployment(input: {
	readonly creds: CommCareCredentials;
	readonly domain: string;
	readonly hqAppId: string;
	readonly now: string;
}): Promise<ObservationResult> {
	const { creds, domain, hqAppId, now } = input;

	const versions = await readAppVersions(creds, domain, hqAppId);
	if ("success" in versions) {
		// A 404 is an ANSWER: CommCare HQ has no such working app in this
		// project space, so the mapping points at something that is not
		// there. Anything else means the question did not get through, and
		// that is not a verdict on the deployment.
		if (versions.status !== 404) {
			return {
				kind: "unavailable",
				message:
					"Nova couldn't reach CommCare HQ to check on this app. What you see below is the last thing it saw. Try again in a moment.",
			};
		}
		/* The app is GONE, so this is the UPLOAD that stopped being true,
		 * not a build that failed. Filing it under `build` left the resume
		 * state at `uploaded`, and every surface went on reporting the app
		 * as sitting on the project space, with a working "Open in
		 * CommCare HQ" link to a page that 404s, and instructions to go
		 * make a build of something that no longer exists. */
		return {
			kind: "checked",
			outcomes: [
				[
					"upload",
					failed(
						now,
						"remote_app_missing",
						`The app Nova published to “${domain}” isn't there any more. It may have been deleted on CommCare HQ. Publish again to create a new one.`,
					),
				],
			],
			remoteRevision: null,
			releasedBuildId: null,
		};
	}

	/* Answering the versions read at all proves the app is THERE, so the
	 * upload rung is confirmed on every answered pass. This is also what
	 * heals a deployment that was walked to `remote_app_missing` and then
	 * had its app restored through CommCare HQ's own undo. */
	const outcomes: (readonly [DeploymentPhase, DeploymentPhaseOutcome])[] = [
		["upload", { status: "succeeded", at: now }],
	];

	// ── Build ───────────────────────────────────────────────────────
	// "Built" means a build of what the project space currently holds,
	// not merely that some build exists. An older build with newer
	// changes sitting above it is exactly the situation an author needs
	// named, because CommCare HQ will keep serving the old one.
	if (versions.latestBuildVersion === null) {
		outcomes.push([
			"build",
			pending(
				now,
				"CommCare HQ hasn't built this app yet. Open it there and choose Make new version.",
			),
		]);
		return {
			kind: "checked",
			outcomes,
			remoteRevision: versions.currentVersion,
			releasedBuildId: null,
		};
	}
	if (versions.latestBuildVersion < versions.currentVersion) {
		outcomes.push([
			"build",
			pending(
				now,
				`The app on CommCare HQ has changed since its newest build (version ${versions.latestBuildVersion} of ${versions.currentVersion}). Make a new version there to include those changes.`,
			),
		]);
		return {
			kind: "checked",
			outcomes,
			remoteRevision: versions.currentVersion,
			releasedBuildId: null,
		};
	}
	outcomes.push(["build", { status: "succeeded", at: now }]);

	// ── Release ─────────────────────────────────────────────────────
	if (
		versions.latestReleasedVersion === null ||
		versions.latestReleasedVersion < versions.latestBuildVersion
	) {
		outcomes.push([
			"release",
			pending(
				now,
				versions.latestReleasedVersion === null
					? "No build of this app is released yet. Star the build on CommCare HQ's Releases screen to release it."
					: `The newest build isn't released (released version ${versions.latestReleasedVersion}, newest build ${versions.latestBuildVersion}). Star it on the Releases screen.`,
			),
		]);
		return {
			kind: "checked",
			outcomes,
			remoteRevision: versions.currentVersion,
			releasedBuildId: null,
		};
	}
	outcomes.push(["release", { status: "succeeded", at: now }]);

	// ── Probe ───────────────────────────────────────────────────────
	// The released build's id is resolved before anything is fetched,
	// because the profile endpoint starts a NEW build when it resolves a
	// working app rather than a build. Naming the id keeps the request on
	// this build; see `probeBuildProfile` for what that request is and is
	// not.
	const builds = await listAppBuilds(creds, domain, hqAppId);
	if ("success" in builds) {
		/* Only the PROBE could not run. CommCare HQ already answered for
		 * the build and the release on this same pass, and throwing those
		 * away to report the whole check unavailable would strand any
		 * account whose role lacks the Access APIs permission at `uploaded`
		 * forever: the one read it cannot do would erase the two it can.
		 * So the confirmed rungs stand and the probe says why it is
		 * unconfirmed. The WHY has to come from the status, because
		 * telling somebody to go ask for a permission they already hold,
		 * over a five-minute CommCare HQ blip, sends them on an errand
		 * that cannot help. */
		outcomes.push([
			"probe",
			pending(
				now,
				builds.status === 401 || builds.status === 403
					? "Nova can't confirm the released build installs on a device, because reading this app's builds needs the Access APIs permission on your CommCare HQ account. Everything above is confirmed."
					: "Nova can't confirm the released build installs on a device, because CommCare HQ didn't answer the request that lists this app's builds. Everything above is confirmed. Check again in a moment.",
			),
		]);
		return {
			kind: "checked",
			outcomes,
			remoteRevision: versions.currentVersion,
			releasedBuildId: null,
		};
	}
	const released = builds.find(
		(build) =>
			build.isReleased && build.version === versions.latestReleasedVersion,
	);
	if (released === undefined) {
		outcomes.push([
			"probe",
			pending(
				now,
				"CommCare HQ reports a released version but hasn't listed the matching build yet. Check again in a moment.",
			),
		]);
		return {
			kind: "checked",
			outcomes,
			remoteRevision: versions.currentVersion,
			releasedBuildId: null,
		};
	}

	const profile = await probeBuildProfile(creds, domain, released.id);
	if (!profile.ok) {
		// A redirecting project space, or CommCare HQ being unwell, is not
		// a verdict on the build. Saying "this build is broken" there would
		// accuse a healthy deployment of something it is not doing. It is
		// not a verdict on the whole pass either: the version and release
		// were confirmed seconds ago, and discarding them would strand a
		// deployment whose profile request never succeeds (a project space
		// with a redirect answers 302 to every one) at `uploaded` forever.
		if (profile.reason === "unavailable") {
			outcomes.push([
				"probe",
				pending(
					now,
					"Nova can't confirm the released build installs on a device, because CommCare HQ didn't answer that request. Everything above is confirmed. Check again in a moment.",
				),
			]);
			return {
				kind: "checked",
				outcomes,
				remoteRevision: versions.currentVersion,
				releasedBuildId: released.id,
			};
		}
		outcomes.push([
			"probe",
			failed(
				now,
				"build_not_installable",
				"The released build didn't serve the file a device installs from, so Nova can't confirm workers can open it yet. Try releasing it again on CommCare HQ, then check back.",
			),
		]);
		return {
			kind: "checked",
			outcomes,
			remoteRevision: versions.currentVersion,
			releasedBuildId: released.id,
		};
	}

	outcomes.push(["probe", { status: "succeeded", at: now }]);
	return {
		kind: "checked",
		outcomes,
		remoteRevision: versions.currentVersion,
		releasedBuildId: released.id,
	};
}
