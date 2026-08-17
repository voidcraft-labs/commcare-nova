import "server-only";

import {
	type CommCareCredentials,
	importApp,
	probeHqFeatureFlags,
	uploadAppMediaBundle,
} from "@/lib/commcare/client";
import { expandDoc } from "@/lib/commcare/expander";
import { requiredHqFeatureFlags } from "@/lib/commcare/featureFlags";
import { buildMediaBulkUploadZip } from "@/lib/commcare/multimedia/bulkUploadZip";
import type { CommCareServer } from "@/lib/commcare/servers";
import { COMMCARE_SERVERS } from "@/lib/commcare/servers";
import { getCredentialsForUpload } from "@/lib/db/settings";
import type { BlueprintDoc } from "@/lib/domain";
import { log } from "@/lib/logger";
import { assetWirePaths } from "@/lib/media/manifest";
import { reportMediaAttach } from "@/lib/media/uploadOutcome";
import { readOrganization } from "@/lib/organization/service";
import type { StoredLocation } from "@/lib/organization/types";
import type { HqFeatureFlagReport } from "@/lib/publish/hqFeatureFlags";
import { featureFlagReportForUpload } from "@/lib/publish/hqFeatureFlags";
import { DeploymentError } from "./errors";
import { observeDeployment } from "./observe";
import { type PreflightCheck, runDeploymentPreflight } from "./preflight";
import { activeRemoteApp, plannedInPlaceUpdate } from "./resources";
import { buildSetupArtifact, type SetupArtifact } from "./setupArtifact";
import { deploymentIsObservable } from "./stateMachine";
import {
	applyDeploymentObservation,
	type DeploymentScope,
	type DeploymentTargetKey,
	foldDeploymentAttempt,
	readDeployment,
	recordRemoteResource,
} from "./store";
import type {
	DeploymentAttemptRefusal,
	DeploymentFailure,
	DeploymentWithResources,
} from "./types";

/**
 * The one publish lifecycle.
 *
 * Both the browser's publish dialog and the MCP `upload_app_to_hq` tool
 * come through here, so there is exactly one place that decides what a
 * publish is: preflight the dependency graph, send the app, record what
 * CommCare HQ gave back, and hand the caller the durable record. Nothing
 * publishes beside this: a second path would be a second lifecycle, and
 * the two would drift on the first bug fix.
 *
 * There is deliberately no lock held across the HQ round trips. Every
 * record write is one short transaction that folds against the fresh row
 * (`lib/deployment/store.ts`): two interleaved publishes updating the
 * mapped app record the same remote id and the live row takes the later
 * write, two interleaved creates each record their own app and the
 * ledger files whichever recorded first as superseded (the same answer
 * two sequential creates produce), and a refresh that began before a
 * publish landed discards its answers instead of overwriting the fresh
 * record (the pushed-at token in `applyDeploymentObservation`).
 */

interface PublishOutcomeShared {
	readonly checks: readonly PreflightCheck[];
	readonly artifact: SetupArtifact;
	/** Non-fatal things that happened after the app itself landed. */
	readonly warnings: readonly string[];
	readonly featureFlags: HqFeatureFlagReport | null;
	/** The app's page on CommCare HQ, once there is one. */
	readonly hqAppUrl: string | null;
}

/**
 * What one publish call amounted to, discriminated on `landed`.
 *
 * `landed` answers "did the app reach the project space on THIS call",
 * which is deliberately not derivable from the record's state: the state
 * describes the target, and a deployment already released on `acme` stays
 * released when a later publish is blocked at preflight, so reading
 * success off it would report a publish that never happened as a success.
 *
 * A landed publish always carries the record it created or advanced. A
 * refused one carries the ATTEMPT's own refusal, never scavenged from the
 * record's phase history: the failure (an expired key, a finding in the
 * current draft) belongs to the attempt, not to the app the project space
 * still holds. Its `deployment` is `null` when the app has never
 * reached the target at all: nothing on that project space exists to
 * remember, and a record row is never deleted by any code path, so
 * creating one would leave a typo'd slug in the publish dialog forever.
 */
export type PublishOutcome =
	| (PublishOutcomeShared & {
			readonly landed: true;
			readonly refusal: null;
			/**
			 * Whether this publish updated the app CommCare HQ already held in
			 * place, or created a fresh one there (the first publish, or the
			 * recreate after the mapped app was deleted on CommCare HQ).
			 */
			readonly hqAppAction: "created" | "updated";
			readonly deployment: DeploymentWithResources;
	  })
	| (PublishOutcomeShared & {
			readonly landed: false;
			readonly refusal: DeploymentAttemptRefusal;
			readonly deployment: DeploymentWithResources | null;
	  });

export interface PublishInput {
	readonly scope: DeploymentScope;
	readonly doc: BlueprintDoc;
	readonly compiledAtSeq: number;
	readonly appName: string;
	readonly server: CommCareServer;
	readonly domain: string;
	/**
	 * Called once, after every blocking preflight edge has passed and just
	 * before the app is sent. A caller that reports progress hooks in here
	 * so a refused publish never announces an upload that was never going
	 * to happen.
	 */
	readonly onUploadStarted?: () => void;
}

function hqAppUrlFor(
	server: CommCareServer,
	domain: string,
	hqAppId: string | null,
): string | null {
	if (hqAppId === null) return null;
	return `${COMMCARE_SERVERS[server].baseUrl}/a/${domain}/apps/view/${hqAppId}/`;
}

/**
 * Regenerate the artifact for a deployment.
 *
 * Always derived, never stored. It reads the organization snapshot too,
 * because an automation that names a place has to print that place's
 * current name rather than its id.
 */
export async function setupArtifactFor(
	scope: DeploymentScope,
	deployment: DeploymentWithResources,
	doc: BlueprintDoc,
	locations?: readonly StoredLocation[],
): Promise<SetupArtifact> {
	return buildSetupArtifact({
		doc,
		server: deployment.deployment.server,
		domain: deployment.deployment.domain,
		hqAppId: activeRemoteApp(deployment)?.remoteId ?? null,
		locations: locations ?? (await artifactLocations(scope)),
	});
}

/**
 * The places an artifact names, read once.
 *
 * Exposed so a caller building artifacts for SEVERAL deployments of one app
 * reads them once rather than once per project space: the places are the
 * app's, not the target's, so the second read could only return the same
 * rows.
 *
 * Degrades to none rather than throwing: an unavailable organization read
 * must not take the artifact down with it, because every other section is
 * still exactly right and an automation that names a place falls back to
 * naming its id.
 */
export async function artifactLocations(
	scope: DeploymentScope,
): Promise<readonly StoredLocation[]> {
	try {
		/* `readOrganization` returns exactly the locations this wants without
		 * hydrating the whole blueprint beside them. Callers that already
		 * hold an organization snapshot pass its locations instead. */
		const snapshot = await readOrganization({
			appId: scope.appId,
			projectId: scope.projectId,
			role: scope.role,
			actorUserId: scope.actorUserId,
		});
		return snapshot.locations;
	} catch (error) {
		log.warn("[deployment] organization snapshot unavailable for artifact", {
			appId: scope.appId,
			error: error instanceof Error ? error.message : String(error),
		});
		return [];
	}
}

/**
 * Publish an app to a CommCare HQ project space.
 *
 * Every externally visible step happens after the blocking preflight
 * edges pass, which is the dependency-graph contract: nothing is sent
 * until the connection and the app itself are proved.
 */
export async function publishAppToHq(
	input: PublishInput,
): Promise<PublishOutcome> {
	const target: DeploymentTargetKey = {
		server: input.server,
		domain: input.domain,
	};
	const now = new Date().toISOString();

	const preflight = await runDeploymentPreflight({
		doc: input.doc,
		compiledAtSeq: input.compiledAtSeq,
		access: {
			projectId: input.scope.projectId,
			role: input.scope.role,
			actorUserId: input.scope.actorUserId,
		},
		server: input.server,
		domain: input.domain,
		now,
	});

	if (preflight.ready === null) {
		/* The refusal is the attempt's to report. A target this app has
		 * never reached keeps NOTHING durable; a target it has reached
		 * keeps its record, folded only when the refusal is genuinely
		 * about the target (a publish that never completed) rather than
		 * about the attempt (a key or draft problem against a live app). */
		const refusal: DeploymentAttemptRefusal = {
			phase: "preflight",
			failure: preflight.outcome.failure,
		};
		const existing = await readDeployment(input.scope, target);
		const deployment =
			existing === null
				? null
				: await foldDeploymentAttempt(
						input.scope,
						target,
						"preflight",
						preflight.outcome,
					);
		return {
			landed: false,
			refusal,
			deployment,
			checks: preflight.checks,
			artifact: buildSetupArtifact({
				doc: input.doc,
				server: input.server,
				domain: input.domain,
				hqAppId:
					deployment === null
						? null
						: (activeRemoteApp(deployment)?.remoteId ?? null),
				locations: await artifactLocations(input.scope),
			}),
			warnings: [],
			featureFlags: preflight.featureFlags,
			hqAppUrl:
				deployment === null
					? null
					: hqAppUrlFor(
							input.server,
							input.domain,
							activeRemoteApp(deployment)?.remoteId ?? null,
						),
		};
	}

	// Reachability is proved, so the record may exist now: creation and the
	// passed preflight land in one transaction.
	let deployment = await foldDeploymentAttempt(
		input.scope,
		target,
		"preflight",
		preflight.outcome,
		{ ensure: true },
	);

	const { creds, domain, prepared } = preflight.ready;
	input.onUploadStarted?.();

	/* Update in place, or create. The predicate and its rationale live in
	 * `plannedInPlaceUpdate` (`resources.ts`), which the publish dialog
	 * also reads to say which will happen before the button is pressed. */
	const updateTarget = plannedInPlaceUpdate(deployment);
	const hqAppAction = updateTarget === null ? "created" : "updated";

	// ── Send it ─────────────────────────────────────────────────────
	// The upload consumes the exact prepared generation preflight
	// validated, so the bytes that passed are the bytes that go out.
	const hqJson = expandDoc(prepared.doc, { assets: prepared.assets });
	const result = await importApp(
		creds,
		domain,
		input.appName,
		hqJson,
		updateTarget?.remoteId,
	);
	if (!result.success) {
		if (updateTarget !== null && result.status === 404) {
			/* The update asked CommCare HQ to overwrite the mapped app, and
			 * the 404 is an authoritative answer ABOUT THE TARGET: that app
			 * is gone — the same answer observation's versions read gives.
			 * So it folds as an observation against the mapping this publish
			 * read, not as an attempt outcome (which deliberately writes
			 * nothing on a reached target). The pushed-at token keeps a slow
			 * publish's 404 from clobbering a concurrent publish that landed
			 * the same remote id meanwhile. The NEXT publish sees the failed
			 * upload phase and takes the create path, superseding this
			 * mapping with the fresh app's. */
			const failure: DeploymentFailure = {
				code: "remote_app_missing",
				message: `The app Nova published to “${domain}” isn't there any more: CommCare HQ reported it gone when Nova tried to update it. It may have been deleted there. Publish again to create a fresh one.`,
				details: [],
			};
			const observed = await applyDeploymentObservation(input.scope, target, {
				observedRemoteId: updateTarget.remoteId,
				observedPushedAt: updateTarget.pushedAt,
				outcomes: [
					[
						"upload",
						{ status: "failed", at: new Date().toISOString(), failure },
					],
				],
				remoteRevision: null,
			});
			deployment = observed.view;
			return {
				landed: false,
				refusal: { phase: "upload", failure },
				deployment,
				checks: preflight.checks,
				artifact: await setupArtifactFor(input.scope, deployment, input.doc),
				warnings: [],
				featureFlags: preflight.featureFlags,
				hqAppUrl: null,
			};
		}
		/* CommCare HQ refusing THIS upload says nothing about the app
		 * already on the project space; the fold leaves a reached record
		 * alone and moves an unreached one to `incomplete` at `upload`,
		 * which is exactly what a retry resumes from. */
		const failure: DeploymentFailure = {
			code: "hq_rejected_upload",
			message: importRejectionMessage(result.status),
			details: [],
		};
		deployment = await foldDeploymentAttempt(input.scope, target, "upload", {
			status: "failed",
			at: new Date().toISOString(),
			failure,
		});
		return {
			landed: false,
			refusal: { phase: "upload", failure },
			deployment,
			checks: preflight.checks,
			artifact: await setupArtifactFor(input.scope, deployment, input.doc),
			warnings: [],
			featureFlags: preflight.featureFlags,
			hqAppUrl: null,
		};
	}

	// ── Record what it gave back, before anything else can fail ─────
	// The mapping and the `uploaded` state land in one transaction. A
	// publish that recorded neither would leave an app sitting on the
	// project space that Nova has no memory of: no update target for the
	// next publish, and no way to name it if that publish creates afresh.
	// On an update the returned id is the one asked for, so this is the
	// store's same-remote-id arm — the live row updates in place.
	deployment = await recordRemoteResource(input.scope, target, {
		kind: "app",
		novaResourceId: input.scope.appId,
		remoteId: result.appId,
		ownership: "nova-created",
		pushedRevision: input.compiledAtSeq,
		remoteRevision: result.version,
		uploadedAt: new Date().toISOString(),
	});

	log.info("[deployment] app imported", {
		domain,
		hqAppId: result.appId,
		appId: input.scope.appId,
		action: hqAppAction,
	});

	// The target is known now, so start the flag probe alongside media
	// rather than adding its latency to an already-successful publish.
	const flagProbes = probeHqFeatureFlags(
		creds,
		domain,
		requiredHqFeatureFlags(prepared.doc),
	);

	const warnings = [...result.warnings];
	if (prepared.assets.size > 0) {
		warnings.push(
			...(await uploadMediaBytes(
				creds,
				domain,
				result.appId,
				prepared,
				input.scope.appId,
			)),
		);
	}

	return {
		landed: true,
		refusal: null,
		hqAppAction,
		deployment,
		checks: preflight.checks,
		artifact: await setupArtifactFor(input.scope, deployment, input.doc),
		warnings,
		featureFlags: featureFlagReportForUpload(domain, await flagProbes),
		hqAppUrl: hqAppUrlFor(input.server, domain, result.appId),
	};
}

/**
 * Ship the media bytes for an app that already exists on CommCare HQ.
 *
 * A media failure never fails the publish: the app is already there, so
 * the honest report is a warning about the pictures rather than a claim
 * that nothing happened.
 */
async function uploadMediaBytes(
	creds: CommCareCredentials,
	domain: string,
	hqAppId: string,
	prepared: {
		readonly assets: Parameters<typeof assetWirePaths>[0];
		readonly doc: BlueprintDoc;
	},
	appId: string,
): Promise<string[]> {
	const mediaResult = await uploadAppMediaBundle(
		creds,
		domain,
		hqAppId,
		buildMediaBulkUploadZip(prepared.assets),
	);
	if ("success" in mediaResult) {
		log.error("[deployment] media bundle upload failed", undefined, {
			domain,
			hqAppId,
			appId,
			status: mediaResult.status,
		});
		return [
			"Media upload could not be completed; the app was published but its media may not display.",
		];
	}
	if (mediaResult.timedOut) {
		return [
			"The app was published and its media uploaded. CommCare is still processing it, so it may take a few minutes to appear.",
		];
	}
	return reportMediaAttach({
		result: mediaResult,
		assetWirePath: assetWirePaths(prepared.assets),
		doc: prepared.doc,
		logPrefix: "[deployment]",
		logContext: { domain, hqAppId, appId },
	});
}

function importRejectionMessage(status: number): string {
	if (status === 401)
		return "CommCare HQ didn't accept your API key. Update it in Settings, then publish again.";
	if (status === 403)
		return "Your CommCare HQ account can't create apps in this project space. Ask an administrator there for the Edit Apps permission.";
	if (status === 429)
		return "CommCare HQ is rate limiting requests right now. Wait a moment and publish again.";
	if (status >= 500)
		return "CommCare HQ is unavailable right now. Try publishing again in a few minutes.";
	return `CommCare HQ refused the app (HTTP ${status}).`;
}

/**
 * Prove the caller's stored key belongs to the server this deployment
 * targets.
 *
 * `getCredentialsForUpload` takes no server: it returns whichever
 * installation the caller's own key is on. A Project co-member whose key
 * is on India, refreshing a `production` deployment whose domain slug also
 * exists there, would otherwise read the wrong installation and be told
 * their app had been deleted. The server is part of the deployment's key
 * precisely because a key issued by one authenticates nowhere else, so it
 * has to be compared rather than assumed.
 */
function assertCredentialsMatchServer(
	creds: CommCareCredentials,
	target: DeploymentTargetKey,
): void {
	if (creds.server === target.server) return;
	throw new DeploymentError(
		"invalid",
		`This deployment is on the ${COMMCARE_SERVERS[target.server].label} CommCare server, and your API key is on ${COMMCARE_SERVERS[creds.server].label}. Those are separate installations with separate accounts, so your key cannot see it. Add a key for ${COMMCARE_SERVERS[target.server].label} in Settings.`,
	);
}

/**
 * Ask CommCare HQ what has happened to a published app since last time.
 *
 * Reads only against the target. It is the same call whether the
 * deployment is waiting for a build, waiting for a release, or already
 * runnable, because the answer is whatever CommCare HQ currently says,
 * including an answer that walks the deployment backward when a build
 * stops being released.
 *
 * The record write at the end applies only while the mapping the
 * observation asked about is still the active one, so a publish landing
 * while CommCare HQ was being asked wins and the stale answers are
 * discarded (`applyDeploymentObservation`).
 */
export async function refreshDeployment(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	doc: BlueprintDoc,
	locations?: readonly StoredLocation[],
): Promise<{
	readonly deployment: DeploymentWithResources;
	readonly artifact: SetupArtifact;
} | null> {
	const existing = await readDeployment(scope, target);
	if (existing === null) return null;
	const remote = activeRemoteApp(existing);
	/* Nothing to observe, or nothing observation may answer. A deployment
	 * refused before its app reached CommCare HQ may still hold an earlier
	 * publish's mapping, and observing that would erase the refusal; every
	 * later refusal is exactly what Check status is for.
	 *
	 * Said out loud rather than returned unchanged, because a silent no-op
	 * is indistinguishable from a check that found nothing new: the author
	 * would press Check status forever waiting for a rung Nova was never
	 * going to ask about. */
	if (remote === null) {
		throw new DeploymentError(
			"invalid",
			`This app hasn't reached “${target.domain}” yet, so there's nothing on CommCare HQ to check on. Publish it first.`,
		);
	}
	if (!deploymentIsObservable(existing.deployment)) {
		throw new DeploymentError(
			"invalid",
			"This publish stopped before the app reached CommCare HQ, so checking there would say nothing about it. Fix what stopped it and publish again.",
		);
	}

	const credResult = await getCredentialsForUpload(
		scope.actorUserId,
		target.domain,
	);
	const now = new Date().toISOString();
	/* Whose problem this is decides who hears about it. A missing key, or
	 * one that no longer reaches the project space, belongs to the person
	 * who clicked, not to the deployment. Writing it as a phase failure
	 * would knock a live app down to `incomplete` for every member of the
	 * Project because one editor never connected CommCare HQ. So it is
	 * raised to the caller and nothing is written. */
	if (!credResult.ok) {
		throw credResult.error === "not_configured"
			? new DeploymentError(
					"hq_not_connected",
					"CommCare HQ isn't connected on your account, so Nova can't check on this deployment. Add your API key in Settings, then try again.",
				)
			: new DeploymentError(
					"domain_not_authorized",
					`Your CommCare HQ API key can't reach “${target.domain}”, so Nova can't check on this deployment. What you see is the last thing Nova saw.`,
				);
	}

	assertCredentialsMatchServer(credResult.creds, target);

	const observation = await observeDeployment({
		creds: credResult.creds,
		domain: credResult.domain.name,
		hqAppId: remote.remoteId,
		now,
	});
	/* Not reaching CommCare HQ writes nothing. A network blip must not walk
	 * a `runnable` deployment down and tell every member of the Project
	 * their app is refused while it is still released and in use. */
	if (observation.kind === "unavailable") {
		throw new DeploymentError("invalid", observation.message);
	}
	const { view } = await applyDeploymentObservation(scope, target, {
		observedRemoteId: remote.remoteId,
		observedPushedAt: remote.pushedAt,
		outcomes: observation.outcomes,
		remoteRevision: observation.remoteRevision,
	});
	return {
		deployment: view,
		artifact: await setupArtifactFor(scope, view, doc, locations),
	};
}
