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
 * state of a freshly uploaded app and never a refusal. `failed` means Nova
 * asked and could not get a usable answer, which withholds `released` and
 * `runnable` until somebody retries.
 */

/** Everything one observation pass produced. */
export interface ObservationResult {
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
		// A 404 is CommCare HQ saying it has no such working app in this
		// project space: it was deleted, or the id names a build rather
		// than an app (`current_app_version` raises `Http404` on exactly
		// that). Either way the mapping points at something that is not
		// there, which is a different problem from a bad connection.
		const missing = versions.status === 404;
		return {
			outcomes: [
				[
					"build",
					failed(
						now,
						missing ? "remote_app_missing" : "hq_unreachable",
						missing
							? `The app Nova published to “${domain}” isn't there any more. It may have been deleted on CommCare HQ. Publish again to create a new one.`
							: "Nova couldn't reach CommCare HQ to check on this app. Try again in a moment.",
					),
				],
			],
			remoteRevision: null,
			releasedBuildId: null,
		};
	}

	const outcomes: (readonly [DeploymentPhase, DeploymentPhaseOutcome])[] = [];

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
		outcomes.push([
			"probe",
			failed(
				now,
				"hq_unreachable",
				"Nova couldn't read this app's builds from CommCare HQ, so it can't confirm the released one is ready to install. This read also needs the Access APIs permission on your CommCare HQ account.",
			),
		]);
		return {
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
			outcomes,
			remoteRevision: versions.currentVersion,
			releasedBuildId: null,
		};
	}

	const profile = await probeBuildProfile(creds, domain, released.id);
	if (!profile.ok) {
		// A redirecting project space, or CommCare HQ being unwell, is not
		// a verdict on the build. Saying "this build is broken" there would
		// accuse a healthy deployment of something it is not doing.
		outcomes.push([
			"probe",
			profile.reason === "unavailable"
				? failed(
						now,
						"hq_unreachable",
						"Nova couldn't check whether the released build is ready to install. CommCare HQ didn't answer that request. Try again in a moment.",
					)
				: failed(
						now,
						"build_not_installable",
						"The released build didn't serve the file a device installs from, so Nova can't confirm workers can open it yet. Try releasing it again on CommCare HQ, then check back.",
					),
		]);
		return {
			outcomes,
			remoteRevision: versions.currentVersion,
			releasedBuildId: released.id,
		};
	}

	outcomes.push(["probe", { status: "succeeded", at: now }]);
	return {
		outcomes,
		remoteRevision: versions.currentVersion,
		releasedBuildId: released.id,
	};
}
