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
import { activeRemoteApp } from "./resources";
import { buildSetupArtifact, type SetupArtifact } from "./setupArtifact";
import {
	applyAttemptOutcome,
	applyObservation,
	applyPhaseOutcome,
	deploymentIsObservable,
} from "./stateMachine";
import {
	type DeploymentScope,
	type DeploymentTargetKey,
	ensureDeployment,
	readDeployment,
	recordRemoteResource,
	recordRemoteRevision,
	saveDeploymentProgress,
	withDeploymentTargetLock,
} from "./store";
import {
	type DeploymentPhaseOutcome,
	type DeploymentWithResources,
	NO_DEPLOYMENT_PHASE_OUTCOMES,
} from "./types";

/**
 * The one publish lifecycle.
 *
 * Both the browser's publish dialog and the MCP `upload_app_to_hq` tool
 * come through here, so there is exactly one place that decides what a
 * publish is: preflight the dependency graph, send the app, record what
 * CommCare HQ gave back, and hand the caller the durable record. Nothing
 * publishes beside this — a second path would be a second lifecycle, and
 * the two would drift on the first bug fix.
 */

export interface PublishOutcome {
	/**
	 * Whether the app reached the project space on THIS call.
	 *
	 * Not derivable from the record's state, and that is the point. The
	 * state describes the target: a deployment already released on `acme`
	 * stays released when a later publish is blocked at preflight, so
	 * reading success off it would report a publish that never happened as
	 * a success. This answers only "did this attempt get there".
	 */
	readonly landed: boolean;
	readonly deployment: DeploymentWithResources;
	readonly checks: readonly PreflightCheck[];
	readonly artifact: SetupArtifact;
	/** Non-fatal things that happened after the app itself landed. */
	readonly warnings: readonly string[];
	readonly featureFlags: HqFeatureFlagReport | null;
	/** The app's page on CommCare HQ, once there is one. */
	readonly hqAppUrl: string | null;
}

export interface PublishInput {
	readonly scope: DeploymentScope;
	readonly doc: BlueprintDoc;
	readonly compiledAtSeq: number;
	readonly appName: string;
	readonly server: CommCareServer;
	readonly domain: string;
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
 * reads them once rather than once per project space — the places are the
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
		/* `readOrganization` returns exactly the locations this wants.
		 * `readOrganizationAuthoringSnapshot` also hydrates the whole
		 * blueprint, which is a large read to throw away when the caller
		 * already holds the document — and `readDeploymentsAction` did
		 * exactly that, hydrating it twice per dialog open. */
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
/**
 * The record a refused FIRST publish reports, which is never persisted.
 *
 * Nothing reached the project space, so nothing about it is durable — but
 * the caller still has to be told what happened, and every consumer reads
 * the same record shape. This is that answer, shaped like a deployment and
 * deliberately not one: it carries no id anything can later resolve.
 */
function unsavedDeploymentFor(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	outcome: DeploymentPhaseOutcome,
	now: string,
): DeploymentWithResources {
	return {
		deployment: applyAttemptOutcome(
			{
				id: "",
				appId: scope.appId,
				projectId: scope.projectId,
				server: target.server,
				domain: target.domain,
				state: "preflight",
				resumePhase: null,
				phases: NO_DEPLOYMENT_PHASE_OUTCOMES,
				createdBy: scope.actorUserId,
				createdAt: now,
				updatedAt: now,
				lastObservedAt: null,
			},
			"preflight",
			outcome,
		),
		active: [],
		superseded: [],
	};
}

export async function publishAppToHq(
	input: PublishInput,
): Promise<PublishOutcome> {
	const target: DeploymentTargetKey = {
		server: input.server,
		domain: input.domain,
	};
	/* Held across preflight, the import that mints the CommCare HQ app, and
	 * the write that records it. Two publishes of one app to one project
	 * space must not both reach `importApp`. */
	return withDeploymentTargetLock(input.scope, target, () =>
		publishWithinTargetLock(input, target),
	);
}

async function publishWithinTargetLock(
	input: PublishInput,
	target: DeploymentTargetKey,
): Promise<PublishOutcome> {
	/* Read what is already there rather than creating a row. A durable
	 * record must not exist for a project space the app never reached: it is
	 * never deleted by any code path, so a typo'd slug or a key that cannot
	 * reach the target would otherwise leave the publish dialog listing that
	 * project space forever. The row is created below, once preflight has
	 * proved the caller can actually reach it. */
	const existing = (await readDeployment(input.scope, target)) ?? null;
	let deployment = existing;
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
		/* A refusal against a target this app has never reached leaves
		 * NOTHING behind — there is nothing on that project space to
		 * remember, and the caller still gets the blocking checks that say
		 * what to fix. An existing record does record the attempt, because
		 * its app really is over there. */
		const refused =
			deployment === null
				? unsavedDeploymentFor(input.scope, target, preflight.outcome, now)
				: await saveDeploymentProgress(
						input.scope,
						deployment.deployment.id,
						applyAttemptOutcome(
							deployment.deployment,
							"preflight",
							preflight.outcome,
						),
					);
		return {
			landed: false,
			deployment: refused,
			checks: preflight.checks,
			artifact: await setupArtifactFor(input.scope, refused, input.doc),
			warnings: [],
			featureFlags: preflight.featureFlags,
			hqAppUrl: hqAppUrlFor(
				input.server,
				input.domain,
				activeRemoteApp(refused)?.remoteId ?? null,
			),
		};
	}

	// Reachability is proved, so the record may exist now.
	deployment = await ensureDeployment(input.scope, target);
	deployment = await saveDeploymentProgress(
		input.scope,
		deployment.deployment.id,
		applyAttemptOutcome(deployment.deployment, "preflight", preflight.outcome),
	);

	const { creds, domain, prepared } = preflight.ready;

	// ── Send it ─────────────────────────────────────────────────────
	// The upload consumes the exact prepared generation preflight
	// validated, so the bytes that passed are the bytes that go out.
	const hqJson = expandDoc(prepared.doc, { assets: prepared.assets });
	const result = await importApp(creds, domain, input.appName, hqJson);
	if (!result.success) {
		const uploadFailedAt = new Date().toISOString();
		/* CommCare HQ refusing THIS upload says nothing about the app
		 * already on the project space. Folding it unconditionally walked a
		 * released, worker-facing deployment back to "reached nothing", lost
		 * the phase a retry resumes from, and left publishing again — and a
		 * duplicate app — as the only way forward. */
		const failed = applyAttemptOutcome(deployment.deployment, "upload", {
			status: "failed",
			at: uploadFailedAt,
			failure: {
				code: "hq_rejected_upload",
				message: importRejectionMessage(result.status),
				details: [],
			},
		});
		deployment = await saveDeploymentProgress(
			input.scope,
			deployment.deployment.id,
			failed,
		);
		return {
			landed: false,
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
	// project space that Nova has no memory of, and no way to name when
	// the next publish supersedes it.
	deployment = await recordRemoteResource(
		input.scope,
		deployment.deployment.id,
		{
			kind: "app",
			novaResourceId: input.scope.appId,
			remoteId: result.appId,
			ownership: "nova-created",
			pushedRevision: input.compiledAtSeq,
			progress: applyPhaseOutcome(deployment.deployment, "upload", {
				status: "succeeded",
				at: new Date().toISOString(),
			}),
		},
	);

	log.info("[deployment] app imported", {
		domain,
		hqAppId: result.appId,
		appId: input.scope.appId,
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
			"Media upload could not be completed; the app was created but its media may not display.",
		];
	}
	if (mediaResult.timedOut) {
		return [
			"The app was created and its media uploaded. CommCare is still processing it, so it may take a few minutes to appear.",
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
 * Reads only. It is the same call whether the deployment is waiting for a
 * build, waiting for a release, or already runnable, because the answer
 * is whatever CommCare HQ currently says — including an answer that walks
 * the deployment backward when a build stops being released.
 */
export async function refreshDeployment(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	doc: BlueprintDoc,
): Promise<{
	readonly deployment: DeploymentWithResources;
	readonly artifact: SetupArtifact;
} | null> {
	/* The SAME lock publishing takes. Observing reads the record, spends
	 * several seconds asking CommCare HQ about the app it names, then writes
	 * what it heard — so without this a publish landing in that window was
	 * overwritten by answers describing the app it had just replaced. */
	return withDeploymentTargetLock(scope, target, () =>
		refreshWithinTargetLock(scope, target, doc),
	);
}

async function refreshWithinTargetLock(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	doc: BlueprintDoc,
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
	 * is indistinguishable from a check that found nothing new — the author
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
	 * who clicked — not to the deployment. Writing it as a phase failure
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
	const folded = applyObservation(existing.deployment, observation.outcomes);
	const saved = await saveDeploymentProgress(
		scope,
		existing.deployment.id,
		folded,
		{ observed: true },
	);
	if (observation.remoteRevision !== null) {
		await recordRemoteRevision(scope, existing.deployment.id, {
			kind: "app",
			novaResourceId: scope.appId,
			remoteRevision: observation.remoteRevision,
		});
	}
	return {
		deployment: saved,
		artifact: await setupArtifactFor(scope, saved, doc),
	};
}
