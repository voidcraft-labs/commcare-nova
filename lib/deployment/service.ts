import "server-only";

import {
	type CommCareCredentials,
	importApp,
	probeHqFeatureFlags,
	readAppVersions,
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
import { readOrganizationAuthoringSnapshot } from "@/lib/organization/service";
import type { HqFeatureFlagReport } from "@/lib/publish/hqFeatureFlags";
import { featureFlagReportForUpload } from "@/lib/publish/hqFeatureFlags";
import { DeploymentError } from "./errors";
import { observeDeployment } from "./observe";
import { type PreflightCheck, runDeploymentPreflight } from "./preflight";
import {
	previewProjectSpace,
	resolvePreviewDeploymentTarget,
} from "./previewTarget";
import { buildSetupArtifact, type SetupArtifact } from "./setupArtifact";
import {
	applyPhaseOutcome,
	applyPhaseOutcomes,
	applyPreflightOutcome,
	deploymentCanRunPhase,
} from "./stateMachine";
import {
	activeRemoteApp,
	type DeploymentScope,
	type DeploymentTargetKey,
	ensureDeployment,
	readDeployment,
	readDeploymentsForApp,
	recordRemoteResource,
	recordRemoteRevision,
	saveDeploymentProgress,
} from "./store";
import type { DeploymentWithResources } from "./types";

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
): Promise<SetupArtifact> {
	let locations: Awaited<
		ReturnType<typeof readOrganizationAuthoringSnapshot>
	>["organization"]["locations"] = [];
	try {
		const snapshot = await readOrganizationAuthoringSnapshot({
			appId: scope.appId,
			projectId: scope.projectId,
			role: scope.role,
			actorUserId: scope.actorUserId,
		});
		locations = snapshot.organization.locations;
	} catch (error) {
		// An unavailable organization read must not take the artifact down
		// with it: every other section is still exactly right, and an
		// automation that names a place degrades to naming its id.
		log.warn("[deployment] organization snapshot unavailable for artifact", {
			appId: scope.appId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
	return buildSetupArtifact({
		doc,
		server: deployment.deployment.server,
		domain: deployment.deployment.domain,
		hqAppId: activeRemoteApp(deployment)?.remoteId ?? null,
		locations,
	});
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
	let deployment = await ensureDeployment(input.scope, target);
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

	const afterPreflight = applyPreflightOutcome(
		deployment.deployment,
		preflight.outcome,
	);
	deployment = await saveDeploymentProgress(
		input.scope,
		deployment.deployment.id,
		afterPreflight,
	);

	if (preflight.ready === null) {
		return {
			deployment,
			checks: preflight.checks,
			artifact: await setupArtifactFor(input.scope, deployment, input.doc),
			warnings: [],
			featureFlags: preflight.featureFlags,
			hqAppUrl: hqAppUrlFor(
				input.server,
				input.domain,
				activeRemoteApp(deployment)?.remoteId ?? null,
			),
		};
	}

	const { creds, domain, prepared } = preflight.ready;

	// ── Send it ─────────────────────────────────────────────────────
	// The upload consumes the exact prepared generation preflight
	// validated, so the bytes that passed are the bytes that go out.
	const hqJson = expandDoc(prepared.doc, { assets: prepared.assets });
	const result = await importApp(creds, domain, input.appName, hqJson);
	if (!result.success) {
		const uploadFailedAt = new Date().toISOString();
		const failed = applyPhaseOutcome(deployment.deployment, "upload", {
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
	const existing = await readDeployment(scope, target);
	if (existing === null) return null;
	const remote = activeRemoteApp(existing);
	/* Nothing to observe, or nothing observation may answer.
	 *
	 * The second case is the one worth naming: a deployment refused at
	 * `preflight` or `upload` still holds the mapping from an EARLIER
	 * publish, so observing it would fold three succeeded outcomes over
	 * the refusal and turn the record green — destroying the phase a retry
	 * resumes from, from a button sitting next to the refusal. Observation
	 * answers questions about a build; it cannot answer "did this publish
	 * get there". */
	if (remote === null || !deploymentCanRunPhase(existing.deployment, "build")) {
		return {
			deployment: existing,
			artifact: await setupArtifactFor(scope, existing, doc),
		};
	}

	const credResult = await getCredentialsForUpload(
		scope.actorUserId,
		target.domain,
	);
	const now = new Date().toISOString();
	if (!credResult.ok) {
		const failed = applyPhaseOutcome(existing.deployment, "build", {
			status: "failed",
			at: now,
			failure: {
				code:
					credResult.error === "not_configured"
						? "hq_not_connected"
						: "domain_not_authorized",
				message:
					credResult.error === "not_configured"
						? "CommCare HQ isn't connected, so Nova can't check on this deployment. Add your API key in Settings."
						: `Your API key can't reach “${target.domain}” any more, so Nova can't check on this deployment.`,
				details: [],
			},
		});
		const saved = await saveDeploymentProgress(
			scope,
			existing.deployment.id,
			failed,
		);
		return {
			deployment: saved,
			artifact: await setupArtifactFor(scope, saved, doc),
		};
	}

	const observation = await observeDeployment({
		creds: credResult.creds,
		domain: credResult.domain.name,
		hqAppId: remote.remoteId,
		now,
	});
	const folded = applyPhaseOutcomes(existing.deployment, observation.outcomes);
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

/**
 * Point a deployment at an app that is already on CommCare HQ.
 *
 * Adoption is the only way a mapping comes into existence without Nova
 * having created the thing, and it is always explicit: the caller names
 * the exact CommCare HQ app id. Nova never matches by name, and never
 * adopts one another app in the same Project already publishes to.
 */
export async function adoptRemoteApp(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	remoteId: string,
): Promise<DeploymentWithResources> {
	const credResult = await getCredentialsForUpload(
		scope.actorUserId,
		target.domain,
	);
	/* Each cause gets its own sentence. Collapsing them into one
	 * not-found would tell somebody their app moved Projects when the
	 * real answer is that they have not connected CommCare HQ. */
	if (!credResult.ok) {
		throw new DeploymentError(
			"invalid",
			credResult.error === "not_configured"
				? "CommCare HQ isn't connected on your account. Add your API key in Settings, then connect this app to its CommCare HQ app."
				: `Your API key can't reach “${target.domain}”. Ask a CommCare HQ administrator to add you to that project space.`,
		);
	}

	// Prove it is really there before recording ownership of it. An
	// adopted mapping that names nothing would report "uploaded" for an
	// app that does not exist.
	const versions = await readAppVersions(
		credResult.creds,
		credResult.domain.name,
		remoteId,
	);
	if ("success" in versions) {
		throw new DeploymentError(
			"invalid",
			versions.status === 404
				? `CommCare HQ has no app "${remoteId}" on “${target.domain}”. Check the id in the app's URL there, and that it is the app itself rather than one of its versions.`
				: `Nova couldn't reach CommCare HQ to confirm the app "${remoteId}" exists on “${target.domain}”. Try again in a moment.`,
		);
	}

	const deployment = await ensureDeployment(scope, target);
	const now = new Date().toISOString();
	return recordRemoteResource(scope, deployment.deployment.id, {
		kind: "app",
		novaResourceId: scope.appId,
		remoteId,
		ownership: "adopted",
		pushedRevision: null,
		requireUnclaimed: true,
		progress: applyPhaseOutcomes(deployment.deployment, [
			["preflight", { status: "succeeded", at: now }],
			["upload", { status: "succeeded", at: now }],
		]),
	});
}

/**
 * The project space Preview may honestly name for an app.
 *
 * Best effort by design: a deployment read that faults must not take the
 * builder page down with it. Failing to `null` degrades to the existing,
 * always-honest behavior of leaving `commcare_project` absent.
 */
export async function previewProjectSpaceFor(
	scope: DeploymentScope,
): Promise<string | null> {
	try {
		const deployments = await readDeploymentsForApp(scope);
		return previewProjectSpace(
			resolvePreviewDeploymentTarget(
				deployments.map((view) => view.deployment),
			),
		);
	} catch (error) {
		log.warn("[deployment] preview project space unavailable", {
			appId: scope.appId,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}
