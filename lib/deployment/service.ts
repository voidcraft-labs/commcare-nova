import "server-only";

import {
	type CommCareApiError,
	type CommCareCredentials,
	importApp,
	uploadAppMediaBundle,
} from "@/lib/commcare/client";
import { expandDoc } from "@/lib/commcare/expander";
import { readHqAppSourceProfile } from "@/lib/commcare/hq/appSource";
import type { HqLocationPush } from "@/lib/commcare/hq/locations";
import { patchHqLocations } from "@/lib/commcare/hq/locations";
import {
	type FixtureUploadRefusal,
	listHqLookupTables,
	uploadLookupTableWorkbook,
} from "@/lib/commcare/hq/lookupTables";
import { buildMediaBulkUploadZip } from "@/lib/commcare/multimedia/bulkUploadZip";
import type { CommCareServer } from "@/lib/commcare/servers";
import { COMMCARE_SERVERS } from "@/lib/commcare/servers";
import {
	projectNewAppProfileForTarget,
	projectUpdatedAppProfileForTarget,
} from "@/lib/commcare/targetProfile";
import { getCredentialsForUpload } from "@/lib/db/settings";
import { extractLookupReferenceTargets } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc } from "@/lib/domain";
import { organizationLevelsOf } from "@/lib/domain";
import { log } from "@/lib/logger";
import { getLookupDefinitions } from "@/lib/lookup/service";
import { assetWirePaths } from "@/lib/media/manifest";
import { reportMediaAttach } from "@/lib/media/uploadOutcome";
import { readOrganization } from "@/lib/organization/service";
import type { StoredLocation } from "@/lib/organization/types";
import type { ProjectSpaceCompatibilityReport } from "@/lib/publish/projectSpaceCompatibility";
import { DeploymentError } from "./errors";
import { observeDeployment } from "./observe";
import type { LocationPushPlan, LookupPushPlan } from "./preflight";
import { type PreflightCheck, runDeploymentPreflight } from "./preflight";
import {
	activeRemoteApp,
	activeResource,
	plannedInPlaceUpdate,
} from "./resources";
import {
	buildSetupArtifact,
	type SetupArtifact,
	type SetupArtifactLookupTable,
} from "./setupArtifact";
import { deploymentIsObservable } from "./stateMachine";
import {
	applyDeploymentObservation,
	type DeploymentScope,
	type DeploymentTargetKey,
	foldDeploymentAttempt,
	type RecordRemoteResourceInput,
	readDeployment,
	recordPushedResources,
	recordRemoteResource,
} from "./store";
import type {
	DeploymentAttemptRefusal,
	DeploymentFailure,
	DeploymentResourceKind,
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
	readonly projectSpaceCompatibility: ProjectSpaceCompatibilityReport | null;
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
	 * The Nova lookup tables whose name clash on the target this caller has
	 * explicitly resolved by taking the existing table over.
	 *
	 * Absent means adopt nothing, which is the only safe default: a name
	 * match is not evidence of ownership, and a publish that quietly
	 * inherited one would attach this app to somebody else's data. The
	 * publish dialog and MCP both have to name the exact tables.
	 */
	readonly adoptResourceIds?: readonly string[];
	/**
	 * Called once, after every blocking preflight edge has passed and just
	 * before anything is sent. A caller that reports progress hooks in here
	 * so a refused publish never announces an upload that was never going
	 * to happen.
	 */
	readonly onUploadStarted?: () => void;
	/**
	 * Called once everything the app depends on is on the target, before
	 * the app itself is sent, with what landed. Only fires when there was
	 * something to push, so a caller reporting progress never announces a
	 * step an app without lookup tables or places does not have.
	 */
	readonly onResourcesPushed?: (pushed: {
		readonly tables: number;
		readonly places: number;
	}) => void;
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
		lookupTables: await artifactLookupTables(scope, deployment, doc),
		pushedPlaces: pushedPlacesOf(deployment),
	});
}

/**
 * Which of this app's places the target holds right now, and how.
 *
 * Straight off the ledger rather than out of a fresh read: the mapping IS
 * the record of what Nova put there, and a place that has not been pushed
 * simply has no live mapping. No project space is asked anything to draw
 * this, which is what keeps watching a deployment cheap.
 */
function pushedPlacesOf(
	deployment: DeploymentWithResources,
): ReadonlyMap<string, { readonly adopted: boolean }> {
	return new Map(
		deployment.active
			.filter((resource) => resource.kind === "location")
			.map(
				(resource) =>
					[
						resource.novaResourceId,
						{ adopted: resource.ownership === "adopted" },
					] as const,
			),
	);
}

/**
 * The Project data this app reads, joined with what the target holds.
 *
 * Definitions only — no rows. This runs on every status check, and the
 * section says which tables Nova owns over there, a fact the ledger and
 * the current names answer between them. Loading every row to print a
 * count would make watching a deployment cost as much as publishing it.
 *
 * Degrades to none rather than throwing, for the same reason the places
 * read does: an unavailable Project read must not take the whole artifact
 * down when every other section is still exactly right.
 */
async function artifactLookupTables(
	scope: DeploymentScope,
	deployment: DeploymentWithResources,
	doc: BlueprintDoc,
): Promise<readonly SetupArtifactLookupTable[]> {
	const targets = extractLookupReferenceTargets(doc);
	if (targets.tableIds.length === 0) return [];
	try {
		const snapshot = await getLookupDefinitions(
			{
				projectId: scope.projectId,
				actorId: scope.actorUserId,
				role: scope.role,
			},
			targets.tableIds,
		);
		return snapshot.definitions.map((definition) => {
			const mapping = activeResource(deployment, "lookup-table", definition.id);
			return {
				name: definition.name,
				tag: definition.tag,
				/* Pushed means the mapping names THIS name. A mapping left
				 * over from before a rename describes a different table. */
				pushed: mapping?.pushedIdentity === definition.tag,
				adopted: mapping?.ownership === "adopted",
			};
		});
	} catch (error) {
		log.warn("[deployment] lookup definitions unavailable for artifact", {
			appId: scope.appId,
			error: error instanceof Error ? error.message : String(error),
		});
		return [];
	}
}

/**
 * What this app's pushable resources are called on CommCare HQ right now,
 * keyed by the Nova id the ownership ledger stores.
 *
 * Read for one question only: which of an earlier publish's resources are
 * still sitting on a project space under a name nothing in Nova uses any
 * more (`resources.ts::leftBehindResources`). A rename is what produces
 * one, so the comparison is against the CURRENT names, never the pushed
 * ones.
 *
 * `null` is "Nova could not tell", and it is a real answer rather than an
 * empty map: an unavailable Project read would otherwise look exactly like
 * every table having been deleted, and Nova would send somebody to
 * CommCare HQ to clean up tables that are perfectly fine.
 */
export async function currentResourceIdentities(
	scope: DeploymentScope,
	doc: BlueprintDoc,
): Promise<ReadonlyMap<string, string> | null> {
	const identities = new Map<string, string>();
	const targets = extractLookupReferenceTargets(doc);
	if (targets.tableIds.length > 0) {
		try {
			const snapshot = await getLookupDefinitions(
				{
					projectId: scope.projectId,
					actorId: scope.actorUserId,
					role: scope.role,
				},
				targets.tableIds,
			);
			for (const definition of snapshot.definitions) {
				identities.set(definition.id, definition.tag);
			}
		} catch (error) {
			log.warn("[deployment] lookup definitions unavailable for left-behind", {
				appId: scope.appId,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}

	/* Places, by the site code they carry now. An ARCHIVED place is
	 * deliberately absent: nothing in Nova pushes it any more, so whatever
	 * an earlier publish put there is exactly what the report exists to
	 * name. CommCare HQ's v0.6 resource has no archive and no delete, so
	 * Nova could not have taken it down even if the contract allowed it. */
	if (Object.keys(organizationLevelsOf(doc)).length > 0) {
		try {
			const snapshot = await readOrganization({
				appId: scope.appId,
				projectId: scope.projectId,
				role: scope.role,
				actorUserId: scope.actorUserId,
			});
			for (const place of snapshot.locations) {
				if (place.archivedAt === null) identities.set(place.id, place.siteCode);
			}
		} catch (error) {
			log.warn("[deployment] organization unavailable for left-behind", {
				appId: scope.appId,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}
	return identities;
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

	/* Read before anything is asked of CommCare HQ: the resource push is
	 * planned against the ownership ledger, and preflight is where that
	 * decision belongs. Null is the honest answer for a project space this
	 * app has never reached — Nova owns nothing there. */
	const existing = await readDeployment(input.scope, target);

	const preflight = await runDeploymentPreflight({
		doc: input.doc,
		compiledAtSeq: input.compiledAtSeq,
		mappings: existing?.active ?? [],
		adoptResourceIds: input.adoptResourceIds ?? [],
		access: {
			appId: input.scope.appId,
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
			/* Empty unless the refusal WAS a name clash, in which case these
			 * are the exact resources a person may name back to take over. */
			resourceConflicts: preflight.conflicts,
		};
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
			/* A target this app has reached still gets its full artifact,
			 * including which Project data Nova owns there: the refusal
			 * belongs to this attempt, and none of that stopped being true.
			 * A first publish that never got there has nothing to describe
			 * beyond the app itself. */
			artifact:
				deployment === null
					? buildSetupArtifact({
							doc: input.doc,
							server: input.server,
							domain: input.domain,
							hqAppId: null,
							locations: await artifactLocations(input.scope),
						})
					: await setupArtifactFor(input.scope, deployment, input.doc),
			warnings: [],
			projectSpaceCompatibility: preflight.projectSpaceCompatibility,
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

	const { creds, domain, prepared, lookupPush, locationPush, locations } =
		preflight.ready;
	input.onUploadStarted?.();

	// ── Put everything the app depends on there first ───────────────
	// The app's selects read these tables by name at runtime and its
	// owner rules address these places, so an app that arrived first
	// would be installable and broken. Nothing about the app itself has
	// been sent at this point, which is what makes a failure here
	// resumable without re-importing anything.
	//
	// A resources refusal reads the same whichever half produced it, so
	// one shape says it: the record is folded, the attempt reports it, and
	// a republish that stumbled on the data still has last time's app over
	// there with a link that still works.
	const resourcesRefused = async (
		failure: DeploymentFailure,
	): Promise<PublishOutcome> => {
		deployment = await foldDeploymentAttempt(input.scope, target, "resources", {
			status: "failed",
			at: new Date().toISOString(),
			failure,
		});
		return {
			landed: false,
			refusal: { phase: "resources", failure, resourceConflicts: [] },
			deployment,
			checks: preflight.checks,
			artifact: await setupArtifactFor(
				input.scope,
				deployment,
				input.doc,
				locations,
			),
			warnings: [],
			projectSpaceCompatibility: preflight.projectSpaceCompatibility,
			hqAppUrl: hqAppUrlFor(
				input.server,
				input.domain,
				activeRemoteApp(deployment)?.remoteId ?? null,
			),
		};
	};

	if (lookupPush !== null) {
		const pushed = await pushLookupTables(
			input.scope,
			target,
			creds,
			domain,
			lookupPush,
		);
		/* Even a refused push can have left tables over there — CommCare
		 * HQ's `warning` verdict means it took part of the workbook — and
		 * `pushLookupTables` records those before it returns. Reading its
		 * view back keeps the refusal's report honest about what the
		 * project space now holds. */
		deployment = pushed.deployment ?? deployment;
		if (pushed.failure !== null) return resourcesRefused(pushed.failure);
	}

	/* Places after tables, and both before the app. The order between the
	 * two does not matter to CommCare HQ; it is stable so that a partial
	 * publish always stops at the same rung and a retry always resumes at
	 * the same one. */
	if (locationPush !== null) {
		const pushed = await pushLocations(
			input.scope,
			target,
			creds,
			domain,
			locationPush,
		);
		deployment = pushed.deployment ?? deployment;
		if (pushed.failure !== null) return resourcesRefused(pushed.failure);
	}

	/* An app that used to carry resources and no longer does. The ledger
	 * only learns that from a publish, and until it does, those tables and
	 * places sit on the project space under Nova's own claim with nothing
	 * reporting them. Superseding the mappings is the whole fix: nothing is
	 * deleted on CommCare HQ, Nova just stops claiming them and starts
	 * naming them in the left-behind report. */
	const droppedKinds: DeploymentResourceKind[] = [
		...(lookupPush === null ? (["lookup-table"] as const) : []),
		...(locationPush === null ? (["location"] as const) : []),
	];
	if (
		droppedKinds.some((kind) =>
			deployment.active.some((resource) => resource.kind === kind),
		)
	) {
		deployment = await recordPushedResources(input.scope, target, [], {
			status: "complete",
			kinds: droppedKinds,
			pushedAt: new Date().toISOString(),
		});
	}

	if (lookupPush !== null || locationPush !== null) {
		input.onResourcesPushed?.({
			tables: lookupPush?.pushes.length ?? 0,
			places: locationPush?.placeCount ?? 0,
		});
	}

	/* Update in place, or create. The predicate and its rationale live in
	 * `plannedInPlaceUpdate` (`resources.ts`), which the publish dialog
	 * also reads to say which will happen before the button is pressed. */
	const updateTarget = plannedInPlaceUpdate(deployment);
	const hqAppAction = updateTarget === null ? "created" : "updated";

	// ── Send it ─────────────────────────────────────────────────────
	// The upload consumes the exact prepared generation preflight
	// validated, so the bytes that passed are the bytes that go out.
	/* The naming has to travel with the app, not just with the data. A
	 * lookup-backed select compiles to an `instance(...)` reference whichever
	 * mode is emitting, and `buildXForm` refuses without it. */
	const generatedHqJson = expandDoc(prepared.doc, {
		assets: prepared.assets,
		attachmentTarget: prepared.attachmentTarget,
		...(prepared.lookupNaming && { lookupNaming: prepared.lookupNaming }),
	});
	const supportsDerivedProfile =
		preflight.projectSpaceCompatibility.advisories.some(
			(advisory) =>
				advisory.id === "large-search-performance" &&
				advisory.state === "available",
		);
	let hqJson = generatedHqJson;
	let preImportFailure: CommCareApiError | undefined;
	if (updateTarget === null) {
		hqJson = projectNewAppProfileForTarget(
			generatedHqJson,
			supportsDerivedProfile,
		).application;
	} else {
		/* This read intentionally sits immediately before import. HQ shallow-
		 * replaces the complete `profile` field when it is present, so Nova
		 * cannot safely update one derived key from a stale or invented bag. */
		const source = await readHqAppSourceProfile(
			creds,
			domain,
			updateTarget.remoteId,
		);
		if ("success" in source) {
			if (source.status === 404) {
				/* The source endpoint is authoritative about the same mapped app
				 * import would update. Route its 404 through the existing missing-app
				 * observation below so the next publish creates a fresh app instead
				 * of retrying this deleted id forever. */
				preImportFailure = source;
			} else {
				const permissions = source.status === 401 || source.status === 403;
				const failure: DeploymentFailure = {
					code: "hq_app_state_unknown",
					message: permissions
						? `Nova couldn't read the current app on “${domain}”, so it left that app unchanged. Reading it needs permission to edit apps in CommCare HQ. Check the connected account, then publish again.`
						: `Nova couldn't safely read the current app on “${domain}”, so it left that app unchanged. Check that the app still opens in CommCare HQ, then publish again.`,
					details: [],
				};
				deployment = await foldDeploymentAttempt(
					input.scope,
					target,
					"upload",
					{
						status: "failed",
						at: new Date().toISOString(),
						failure,
					},
				);
				return {
					landed: false,
					refusal: { phase: "upload", failure, resourceConflicts: [] },
					deployment,
					checks: preflight.checks,
					artifact: await setupArtifactFor(
						input.scope,
						deployment,
						input.doc,
						locations,
					),
					warnings: [],
					projectSpaceCompatibility: preflight.projectSpaceCompatibility,
					hqAppUrl: hqAppUrlFor(input.server, domain, updateTarget.remoteId),
				};
			}
		} else {
			hqJson = projectUpdatedAppProfileForTarget(
				generatedHqJson,
				source.profile,
				supportsDerivedProfile,
			).application;
		}
	}
	const result =
		preImportFailure ??
		(await importApp(
			creds,
			domain,
			input.appName,
			hqJson,
			updateTarget?.remoteId,
		));
	if (!result.success) {
		if (updateTarget !== null && result.status === 404) {
			/* The source read or update import named the mapped app, and the
			 * 404 is an authoritative answer ABOUT THE TARGET: that app is gone
			 * — the same answer observation's versions read gives.
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
				refusal: { phase: "upload", failure, resourceConflicts: [] },
				deployment,
				checks: preflight.checks,
				artifact: await setupArtifactFor(
					input.scope,
					deployment,
					input.doc,
					locations,
				),
				warnings: [],
				projectSpaceCompatibility: preflight.projectSpaceCompatibility,
				hqAppUrl: null,
			};
		}
		/* CommCare HQ refusing THIS upload says nothing about the app
		 * already on the project space; the fold leaves a reached record
		 * alone and moves an unreached one to `incomplete` at `upload`,
		 * which is exactly what a retry resumes from. */
		const failure: DeploymentFailure = {
			code: "hq_rejected_upload",
			message: importRejectionMessage(result),
			details: [],
		};
		deployment = await foldDeploymentAttempt(input.scope, target, "upload", {
			status: "failed",
			at: new Date().toISOString(),
			failure,
		});
		return {
			landed: false,
			refusal: { phase: "upload", failure, resourceConflicts: [] },
			deployment,
			checks: preflight.checks,
			artifact: await setupArtifactFor(
				input.scope,
				deployment,
				input.doc,
				locations,
			),
			warnings: [],
			projectSpaceCompatibility: preflight.projectSpaceCompatibility,
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
		artifact: await setupArtifactFor(
			input.scope,
			deployment,
			input.doc,
			locations,
		),
		warnings,
		projectSpaceCompatibility: preflight.projectSpaceCompatibility,
		hqAppUrl: hqAppUrlFor(input.server, domain, result.appId),
	};
}

/**
 * Put every table this app reads on the project space, and record what
 * Nova now owns there.
 *
 * One workbook, one upload, one ledger write. The upload is CommCare HQ's
 * whole-table replacement, so afterwards each of these tables holds
 * exactly what Nova holds — which is why a retry is simply the same push
 * again and needs no per-row bookkeeping to be safe.
 *
 * The re-read afterwards is not belt-and-braces: the fixture upload
 * answers with a human summary and no ids at all, so the only way to learn
 * what CommCare HQ called the tables it just made is to ask. A table
 * missing from that answer means the upload reported success and did not
 * produce it, which is a state Nova refuses rather than records.
 *
 * Every path that leaves tables ON the project space records them, the
 * refusals included. CommCare HQ's `warning` verdict means the workbook
 * was processed and part of it did not take, and a refusal that wrote no
 * mapping would leave Nova's own tables looking like a stranger's — the
 * next publish would stop and ask a person to confirm that tables Nova
 * made are theirs to take over.
 */
async function pushLookupTables(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	creds: CommCareCredentials,
	domain: string,
	plan: LookupPushPlan,
): Promise<{
	readonly failure: DeploymentFailure | null;
	/** What the ledger holds now. Null only when nothing was written. */
	readonly deployment: DeploymentWithResources | null;
}> {
	const upload = await uploadLookupTableWorkbook(
		creds,
		domain,
		plan.workbook.bytes,
		{ replace: true },
	);
	const refusal = upload.success === false ? upload : null;
	if (refusal !== null && !refusal.mayHaveLanded) {
		/* Nothing reached the project space: either the request never got
		 * past the view, or `validate_fixture_file_format` raised before
		 * `upload_fixture_file` ran. So there is nothing to record. */
		return { failure: lookupUploadFailure(refusal, domain), deployment: null };
	}

	const remote = await listHqLookupTables(creds, domain);
	if ("success" in remote) {
		/* Two different stories end here, and telling the wrong one is
		 * worse than saying less. If the upload itself was refused, this
		 * read was only Nova trying to find out what survived — reporting
		 * it as "CommCare HQ took your tables" would announce a success
		 * that did not happen, and would bury the one sentence naming what
		 * was actually wrong with the data. */
		if (refusal !== null) {
			return {
				failure: lookupUploadFailure(refusal, domain),
				deployment: null,
			};
		}
		return {
			failure: {
				code: "hq_resource_state_unknown",
				message: `CommCare HQ took this app's lookup tables for “${domain}” but then would not confirm them, so the app was not sent. The tables are on the project space, so publishing again may ask you to confirm they are yours before it carries on.`,
				details: [],
			},
			deployment: null,
		};
	}
	const remoteByTag = new Map(
		remote.map((table) => [table.tag, table] as const),
	);

	const mappings: RecordRemoteResourceInput[] = [];
	const missing: string[] = [];
	for (const push of plan.pushes) {
		const landed = remoteByTag.get(push.tag);
		if (landed === undefined) {
			missing.push(push.tag);
			continue;
		}
		mappings.push({
			kind: "lookup-table",
			novaResourceId: push.tableId,
			remoteId: landed.id,
			ownership: push.ownership,
			pushedIdentity: push.tag,
			adoptedBy: push.ownership === "adopted" ? scope.actorUserId : null,
			/* A lookup table's own generation, not the app's: its rows change
			 * outside the blueprint, so the app's sequence would say nothing
			 * about whether the pushed copy is current. */
			pushedRevision: null,
			remoteRevision: null,
		});
	}
	/* What is over there is over there, whether or not the whole push
	 * worked. Recording it before returning a refusal leaves Nova owning
	 * the tables it made, so a retry updates them instead of asking a
	 * person to adopt Nova's own work. `partial` supersedes nothing: a
	 * table this push never reached has not been left behind. */
	const recordPartial = async (): Promise<DeploymentWithResources | null> =>
		mappings.length === 0
			? null
			: recordPushedResources(scope, target, mappings, { status: "partial" });

	if (refusal !== null) {
		log.warn("[deployment] lookup table upload partly refused", {
			domain,
			appId: scope.appId,
			recorded: mappings.length,
		});
		return {
			failure: lookupUploadFailure(refusal, domain),
			deployment: await recordPartial(),
		};
	}

	if (missing.length > 0) {
		log.error("[deployment] lookup tables absent after upload", undefined, {
			domain,
			appId: scope.appId,
			tags: missing.join(","),
		});
		return {
			failure: {
				code: "hq_rejected_resource_push",
				message: `CommCare HQ reported this app's lookup tables as uploaded but does not list them all, so the app was not sent. Check the lookup tables on “${domain}”, then publish again.`,
				details: missing,
			},
			deployment: await recordPartial(),
		};
	}

	const deployment = await recordPushedResources(scope, target, mappings, {
		status: "complete",
		kinds: ["lookup-table"],
		pushedAt: new Date().toISOString(),
	});
	log.info("[deployment] lookup tables pushed", {
		domain,
		appId: scope.appId,
		tables: mappings.length,
	});
	return { failure: null, deployment };
}

/**
 * CommCare HQ's refusal of a workbook, in Nova's voice, with its own
 * sentence kept.
 *
 * The synchronous upload path exists for that sentence: it names the
 * sheet, the row, or the column that CommCare HQ would not take, which is
 * the only thing that tells a person what to fix. Nova supplies the part
 * CommCare HQ cannot know — that the app was held back because its data
 * was — and the permission hint only where the status says permissions
 * are the answer.
 */
function lookupUploadFailure(
	refusal: FixtureUploadRefusal,
	domain: string,
): DeploymentFailure {
	const permissions = refusal.status === 401 || refusal.status === 403;
	return {
		code: "hq_rejected_resource_push",
		/* Three sentences, because three different things happened over
		 * there. `mayHaveLanded` is the one that must not be softened: the
		 * push uses `replace`, so a workbook CommCare HQ half took has
		 * already replaced the rows in the tables it did take. Telling
		 * somebody nothing was taken would invite them to believe their
		 * project space is as they left it. */
		message: permissions
			? `CommCare HQ wouldn't let Nova put this app's lookup tables on “${domain}”, so the app was not sent. Uploading them needs the Edit Data permission on your CommCare HQ account.`
			: refusal.mayHaveLanded
				? `CommCare HQ took only part of this app's lookup tables for “${domain}”, so the app was not sent. The tables it did take now hold what Nova sent. Fix what it names below, then publish again to put the rest there.`
				: `CommCare HQ would not take this app's lookup tables for “${domain}”, so the app was not sent and nothing on the project space changed.`,
		/* One bullet per line: `_upload_fixture_api` joins a formatting
		 * complaint's errors with newlines, and a list reads as a list. */
		details: refusal.message
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line !== ""),
	};
}

/**
 * Put every live place this app holds on the project space, parents
 * first, and record what Nova now owns there.
 *
 * This is not one act, and unlike the workbook it is not even one
 * request. `patch_list` is atomic at a hundred places, so the push is a
 * batch per level and each batch is its own all-or-nothing boundary: a
 * tree that stops on its fourth level has genuinely left three levels of
 * places over there. Those are recorded rather than forgotten, because
 * they are real, a retry has to update them instead of making a second
 * copy, and the report a person reads has to say what is on their
 * project space.
 *
 * A child names its parent by the `location_id` the parent's own batch
 * returned, which is the whole reason for the ordering. Every parent is
 * therefore in an earlier batch, proved by the plan rather than assumed
 * here: `planLocationResourcePush` groups by depth over the same live set
 * this walks.
 */
async function pushLocations(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	creds: CommCareCredentials,
	domain: string,
	plan: LocationPushPlan,
): Promise<{
	readonly failure: DeploymentFailure | null;
	/** What the ledger holds now. Null only when nothing was written. */
	readonly deployment: DeploymentWithResources | null;
}> {
	const remoteIdByLocationUuid = new Map<string, string>();
	const landed: RecordRemoteResourceInput[] = [];

	const stopped = async (
		failure: DeploymentFailure,
	): Promise<{
		readonly failure: DeploymentFailure;
		readonly deployment: DeploymentWithResources | null;
	}> => ({
		failure,
		deployment:
			landed.length === 0
				? null
				: await recordPushedResources(scope, target, landed, {
						status: "partial",
					}),
	});

	for (const batch of plan.batches) {
		const places: HqLocationPush[] = [];
		for (const push of batch) {
			const parentRemoteId =
				push.parentLocationUuid === null
					? undefined
					: remoteIdByLocationUuid.get(push.parentLocationUuid);
			if (push.parentLocationUuid !== null && parentRemoteId === undefined) {
				/* Unreachable: every live place's parent is live too (archiving
				 * takes the subtree), and the plan puts a parent in an earlier
				 * batch than its child. Reaching here would mean sending a
				 * child as a root, which silently reshapes somebody's
				 * organization, so it stops instead. */
				log.error("[deployment] place pushed before its parent", undefined, {
					domain,
					appId: scope.appId,
					siteCode: push.siteCode,
				});
				return stopped({
					code: "hq_organization_mismatch",
					message: `Nova couldn't work out where “${push.name}” belongs under, so it stopped rather than put it in the wrong part of the organization on “${domain}”.`,
					details: [],
				});
			}
			places.push({
				...(push.remoteId === null ? {} : { locationId: push.remoteId }),
				name: push.name,
				siteCode: push.siteCode,
				locationTypeCode: push.levelCode,
				...(parentRemoteId === undefined
					? {}
					: { parentLocationId: parentRemoteId }),
				...(push.latitude === null ? {} : { latitude: push.latitude }),
				...(push.longitude === null ? {} : { longitude: push.longitude }),
				...(push.locationData === null
					? {}
					: { locationData: push.locationData }),
			});
		}

		const result = await patchHqLocations(creds, domain, places);
		if ("success" in result) {
			/* CommCare HQ names the offending place and why in its own
			 * sentence, including the site code, so it is passed through
			 * rather than summarized: it is more specific than anything Nova
			 * could say about a rule it did not predict. */
			const permissions = result.status === 401 || result.status === 403;
			return stopped({
				code: "hq_rejected_resource_push",
				message: permissions
					? `CommCare HQ wouldn't take this app's places for “${domain}”, so the app wasn't sent. Creating places needs the Edit Locations permission on your CommCare HQ account.`
					: `CommCare HQ wouldn't take some of this app's places for “${domain}”, so the app wasn't sent. Nothing in the group that stopped was created, and any places sent before it are on the project space. Publishing again carries on from there.`,
				details: result.message === "" ? [] : [result.message],
			});
		}

		for (const [index, remoteId] of result.ids.entries()) {
			const push = batch[index];
			if (push === undefined) continue;
			remoteIdByLocationUuid.set(push.locationUuid, remoteId);
			landed.push({
				kind: "location",
				novaResourceId: push.locationUuid,
				remoteId,
				ownership: push.ownership,
				pushedIdentity: push.siteCode,
				adoptedBy: push.ownership === "adopted" ? scope.actorUserId : null,
				/* The organization's own revision, not the app's, and it is a
				 * decimal string outside this column's range. Places change
				 * outside the blueprint, so the app's sequence would say
				 * nothing about whether the pushed copy is current either. */
				pushedRevision: null,
				remoteRevision: null,
			});
		}
	}

	const deployment = await recordPushedResources(scope, target, landed, {
		status: "complete",
		kinds: ["location"],
		pushedAt: new Date().toISOString(),
	});
	log.info("[deployment] places pushed", {
		domain,
		appId: scope.appId,
		places: landed.length,
	});
	return { failure: null, deployment };
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

function importRejectionMessage(error: CommCareApiError): string {
	/* A refusal from the edge in front of CommCare HQ, which never saw the
	 * request. Its status is a proxy's, so none of the readings below apply:
	 * reporting a 403 here as a missing Edit Apps permission sends someone
	 * to ask an administrator for access they already have. */
	if (error.edgeRefusal) {
		return "A security gateway in front of CommCare HQ turned this upload away before CommCare HQ received it, so it doesn't reflect your permissions or anything in your app. Nova can't clear this one from here. Dimagi support (support@dimagi.com) can exclude the app import endpoint from the rule that matched.";
	}
	const status = error.status;
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
