import type { ProjectDataGrant } from "@/lib/auth/dataGrant";
import { verifyAssignmentWitness } from "@/lib/export/privateAssignments";
import { LookupError } from "@/lib/lookup/errors";
import "server-only";

import { gzipSync } from "node:zlib";
import { roleAllowsApp } from "@/lib/auth/projectRoles";
import type { HqApplication } from "@/lib/commcare";
import {
	type CommCareApiError,
	type CommCareCredentials,
	importApp,
	type MediaBundleUploadResult,
	uploadAppMediaBundle,
} from "@/lib/commcare/client";
import {
	type HqAppSource,
	publishReadingFactsMoved,
	readHqAppSource,
} from "@/lib/commcare/hq/appSource";
import {
	type HqAppSourceAtVersionRead,
	readHqAppSaveCounter,
	readHqAppSourceAtVersion,
} from "@/lib/commcare/hq/appSourceAtVersion";
import { classifyHqFailure, type HqFailure } from "@/lib/commcare/hq/failure";
import { readHqPlaceInventory } from "@/lib/commcare/hq/locationInventory";
import type { HqLocationPush } from "@/lib/commcare/hq/locations";
import {
	patchHqLocations,
	readHqPlaceExternalId,
} from "@/lib/commcare/hq/locations";
import {
	FIXTURE_UPLOAD_PARTIAL_CODE,
	type FixtureUploadRefusal,
	LOOKUP_ROWS_READ_CONCURRENCY,
	listHqLookupTables,
	uploadLookupTableWorkbook,
} from "@/lib/commcare/hq/lookupTables";
import {
	placeContentMatches,
	placePatch,
} from "@/lib/commcare/hq/placeTransfer";
import {
	type LookupWireNaming,
	lookupWireNaming,
} from "@/lib/commcare/lookup/naming";
import { bulkUploadAssets } from "@/lib/commcare/multimedia/hqJsonExportArchive";
import { mediaMembers } from "@/lib/commcare/multimedia/streamMedia";
import { mediaUploadBatches } from "@/lib/commcare/multimedia/uploadBatches";
import { placementsToHold } from "@/lib/commcare/placementHolds";
import type { CommCareServer } from "@/lib/commcare/servers";
import { COMMCARE_SERVERS } from "@/lib/commcare/servers";
import { streamZip } from "@/lib/commcare/streamZip";
import {
	buildProfileLanguageGaps,
	publishedLanguageCodes,
} from "@/lib/commcare/targetBuildProfiles";
import { compareToVersionFloor } from "@/lib/commcare/versionFloor";
import { getHqCredentials } from "@/lib/db/settings";
import { extractLookupReferenceTargets } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc } from "@/lib/domain";
import { declaresWebApps, organizationLevelsOf } from "@/lib/domain";
import { describeCarrier, walkAssetRefs } from "@/lib/domain/mediaRefs";
import { log } from "@/lib/logger";
import { getLookupDefinitions } from "@/lib/lookup/service";
import type { LookupTableDefinition } from "@/lib/lookup/types";
import { assetWirePaths, resolveMediaManifest } from "@/lib/media/manifest";
import { reportMediaAttach } from "@/lib/media/uploadOutcome";
import {
	readOrganization,
	readOrganizationAuthoringSnapshot,
} from "@/lib/organization/service";
import type { DriftDateOptions } from "@/lib/publish/driftReference";
import type { FirstPublishView } from "@/lib/publish/firstPublishChangeIds";
import type { KeptRefreshKind } from "@/lib/publish/keptValues";
import {
	MANAGED_TABLE_HANDED_BACK,
	MANAGED_TABLE_HANDED_BACK_AFTER_CREATE,
} from "@/lib/publish/managedData";
import type {
	AcceptPlacementMoves,
	PlacementMoveOfferView,
	PlacementOfferReason,
} from "@/lib/publish/placementMoves";
import type { ProjectSpaceCompatibilityReport } from "@/lib/publish/projectSpaceCompatibility";
import {
	PUBLISH_CLAIMS_CHANGED,
	PUBLISH_WAITS_FOR_ANOTHER_WRITE,
} from "@/lib/publish/stopPublishing";
import type { WebAppsChange } from "@/lib/publish/webApps";
import { mapWithConcurrency } from "@/lib/utils/concurrency";
import {
	asksSaveToCase,
	confirmationChecks,
	type ProjectSpaceConfirmationChecks,
} from "./confirmations";
import { publishedEntryPoints } from "./entryPointManifest";
import type { PublishedEntryPointManifest } from "./entryPointTypes";
import {
	accessLostWhilePublishing,
	appDeletedWhilePublishing,
	DeploymentAppDeletedError,
	DeploymentEndedError,
	DeploymentError,
	deploymentNotFound,
} from "./errors";
import {
	type HqMediaPath,
	type HqMediaRecord,
	movedRecordedPaths,
	nextHqMediaRecord,
	publishedMediaFiles,
	recordedHqFilePaths,
} from "./hqMedia";
import {
	filesMovedSinceSource,
	freshShellHasAffectedFiles,
	settleHqMedia,
} from "./hqMediaSettle";
import { canonicalPlace, lookupDefinitionChange } from "./hqResourceBaseline";
import {
	confirmedAppSourceMoved,
	diffHqAppSource,
	fileReviewMoved,
	importPruneSave,
	normalizeHqAppSource,
	removalLedgerPaths,
	removedHqFiles,
} from "./hqSourceBaseline";
import {
	type HqImportApplicationResult,
	hqImportApplication,
} from "./importApplication";
import { readLookupReceipt } from "./largeLookupReceipt";
import type { PlannedPlacePush } from "./locationResourcePlan";
import { prepareMediaBatch, readMediaReceipt } from "./mediaReceipt";
import { observeDeployment } from "./observe";
import { placementMoveOffer, placementMoveOfferView } from "./placementMoves";
import { recordPublishPlacements } from "./placements";
import { narrowingTo } from "./platformNarrowing";
import type { LocationPushPlan, LookupPushPlan } from "./preflight";
import {
	buildProfileLanguageFailure,
	CREATED_APP_IS_EMPTY,
	hqAppMovedWhileReadFailure,
	hqAppSourceReadFailure,
	hqMediaReadFailure,
	type PreflightCheck,
	type PreflightResult,
	planLacksWebAppsFailure,
	publishConfirmationNeeds,
	remoteAppMissingFailure,
	runDeploymentPreflight,
	versionBelowFloorFailure,
} from "./preflight";
import {
	APP_CHANGED_DURING_PUBLISH_WARNING,
	APP_PREVIEW_NOTE,
	APP_READ_BACK_FAILED_WARNING,
	HQ_CHANGED_DURING_PUSH_MESSAGE,
	lookupTableMadeAgainWarning,
	MEDIA_NOT_SENT_AFTER_ACCESS_WARNING,
	MEDIA_NOT_SENT_AFTER_LATER_PUBLISH_WARNING,
	MEDIA_NOT_SENT_AFTER_STOP_WARNING,
	RESOURCES_READ_BACK_FAILED_WARNING,
} from "./remoteChanges";
import { hqAnsweredWrite, settleFinishedMediaJobs } from "./remoteWrites";
import {
	activeRemoteApp,
	activeResource,
	deploymentEnding,
	firstPublishOf,
	nextPublishAction,
	plannedInPlaceUpdate,
	publishedRemoteApp,
} from "./resources";
import {
	buildSetupArtifact,
	type SetupArtifact,
	type SetupArtifactLookupTable,
	type SetupArtifactOrganization,
} from "./setupArtifact";
import {
	deploymentDisplaysAsReached,
	deploymentIsObservable,
} from "./stateMachine";
import {
	type AdmittedRecord,
	admitAppCreate,
	admitAppWrite,
	admitPlacesWrite,
	admitWorkbookWrite,
	applyDeploymentObservation,
	cancelUnsentImport,
	type DeploymentFence,
	type DeploymentReadSnapshot,
	type DeploymentScope,
	type DeploymentTargetKey,
	deploymentAppDeletion,
	endDeployment,
	finishDeploymentContentWrite,
	foldDeploymentAttempt,
	type HeldTargetFacts,
	holdTargetFacts,
	type LandedResource,
	markResourceBaselinesUnread,
	type RecordAnswer,
	type RecordRemoteResourceInput,
	type RemoteWriteSettlement,
	readAppBaseline,
	readDeployment,
	readFirstPublishStates,
	readResourceBaselines,
	readTargetIdentity,
	recordCreatedRemoteApp,
	recordDeploymentMediaFiles,
	recordImportAcknowledgement,
	recordOrphanedRemoteApp,
	recordPushedResources,
	recordRefreshedAppBaseline,
	recordRemoteResource,
	settleReleasedClaims,
	settleRemoteWrites,
	targetFactsOf,
	type WritesEnded,
	withDeploymentReadSnapshot,
} from "./store";
import { deploymentKeptOf } from "./targetFacts";
import { EMPTY_TARGET_IDENTITY, exportIdentityOf } from "./targetIdentity";
import type {
	AppBaseline,
	AppBaselineWrite,
	AppOwnership,
	CanonicalLookupTable,
	DeploymentAttemptRefusal,
	DeploymentConfirmationKey,
	DeploymentConfirmationNeeded,
	DeploymentFailure,
	DeploymentKept,
	DeploymentRemoteChange,
	DeploymentResource,
	DeploymentResourceConflict,
	DeploymentResourceKind,
	DeploymentWithResources,
	DrivenDeploymentPhase,
	PublishPlacements,
	RemoteChangeDiscard,
	ResourceBaselineWrite,
} from "./types";
import { createdWithoutWebApps, webAppsMovedDuringPush } from "./webApps";

/**
 * The one publish lifecycle.
 *
 * Both the browser's publish dialog and the MCP `upload_app_to_hq` tool
 * come through here, so there is exactly one place that decides what a
 * publish is: preflight the dependency graph, send the app, record what
 * CommCare HQ gave back, and hand the caller the durable record where they
 * may still read it (`store.ts::RecordAnswer`). Nothing
 * publishes beside this: a second path would be a second lifecycle, and
 * the two would drift on the first bug fix.
 *
 * There is deliberately no lock held across the HQ round trips. Every
 * record write is one short transaction that folds against the fresh row
 * (`lib/deployment/store.ts`): two interleaved publishes updating the
 * mapped app record the same remote id in CommCare HQ's save order, the
 * live row keeping the push whose import HQ acknowledged at the higher save
 * counter (`recordRemoteResource`), two interleaved creates each record
 * their own app and the ledger files whichever recorded first as superseded
 * (the same answer two sequential creates produce), and a refresh that began
 * before a publish landed discards its answers instead of overwriting the
 * fresh record (the push token in `applyDeploymentObservation`).
 */

interface PublishOutcomeShared {
	readonly checks: readonly PreflightCheck[];
	readonly artifact: SetupArtifact;
	/** Non-fatal things that happened after the app itself landed. */
	readonly warnings: readonly string[];
	readonly projectSpaceCompatibility: ProjectSpaceCompatibilityReport | null;
	/** The app's page on CommCare HQ, once there is one. */
	readonly hqAppUrl: string | null;
	/**
	 * The placements this attempt recorded as a `publish-placement` change,
	 * and how many of them an accepted move offer moved; both 0 where it
	 * recorded nothing.
	 */
	readonly placements: PublishPlacements;
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
 * A landed publish carries the record it created or advanced, to a
 * publisher who may still read it, and what it put on CommCare HQ. A
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
			/**
			 * The deployment as the import's record left it, or null where the
			 * publisher may no longer read it: removed from the app's Project,
			 * or the app deleted, after the import was admitted. The app landed
			 * and is recorded either way (`store.ts::RecordAnswer`), and such a
			 * publisher is told what this publish sent (`sent`) and nothing of
			 * the record: not its other members, its confirmations or its
			 * history.
			 */
			readonly deployment: DeploymentWithResources | null;
			/**
			 * What this publish put on CommCare HQ, as its records name it: the
			 * empty app a first publish made, the tables, the places and the
			 * app it imported, in the order they went.
			 */
			readonly sent: readonly LandedResource[];
			/**
			 * The App Preview statement, on a publish that wrote over the app
			 * without knowing it unchanged: after a confirmed discard of the
			 * app, or over a baseline the cutover recorded. Null otherwise.
			 */
			readonly appPreviewNote: string | null;
			/**
			 * The app's logo, which a publish never sends, offered for a person
			 * to add in CommCare HQ. `changed` is true when it is not the logo
			 * this deployment last offered. Null for an app with no logo.
			 */
			readonly logoStep: PublishLogoStep | null;
	  })
	| (PublishOutcomeShared & {
			readonly landed: false;
			readonly refusal: DeploymentAttemptRefusal;
			readonly deployment: DeploymentWithResources | null;
	  });

/** The logo a landed publish offers for a person to add in CommCare HQ. */
export interface PublishLogoStep {
	readonly assetId: string;
	/** `logo<ext>`, the name the download is offered under. */
	readonly fileName: string;
	readonly changed: boolean;
}

export interface PublishInput {
	/** Bearer permission to copy HQ data into Nova. A browser session has no bearer restriction. */
	readonly requireHqImport: (() => void) | null;
	readonly dataGrant?: ProjectDataGrant;
	readonly scope: DeploymentScope;
	readonly doc: BlueprintDoc;
	readonly compiledAtSeq: number;
	/** Reads the app's current head again, under the caller's own access check. */
	readonly reloadHead: () => Promise<{
		readonly doc: BlueprintDoc;
		readonly seq: number;
	}>;
	/**
	 * A placement offer a person accepted after a refusal offered it, named
	 * by its reason and digest. Never defaulted from an earlier attempt.
	 */
	readonly acceptPlacementMoves?: AcceptPlacementMoves;
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
	 * HQ-side changes the person chose to write over, each bound to the
	 * state they were shown. A digest for a state HQ has since left is
	 * refused with the new state's digest. Absent means none: a change is
	 * never written over without being named here.
	 */
	readonly discardRemoteChanges?: readonly RemoteChangeDiscard[];
	/**
	 * What a person confirmed about the project space for this publish,
	 * each named after an `hq_confirmation_needed` refusal asked for it.
	 * Stored only once a preflight passes, so a caller sends them again
	 * until one does. Absent means none.
	 */
	readonly confirm?: readonly DeploymentConfirmationKey[];
	/**
	 * The Web App setting a person agreed to write after an
	 * `hq_web_apps_change` refusal. Never defaulted from an earlier attempt.
	 */
	readonly confirmWebApps?: boolean;
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
	/**
	 * Whose calendar day a sentence about a change made in CommCare HQ names
	 * where it is measured against the day Nova brought the app in. Absent
	 * reads as the UTC day.
	 */
	readonly driftDate?: DriftDateOptions;
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
 * current name rather than its id, and whether CommCare HQ manages the
 * places on this project space decides what the organization's sections
 * say. A caller holding a snapshot passes it.
 */
export async function setupArtifactFor(
	scope: DeploymentScope,
	deployment: DeploymentWithResources,
	doc: BlueprintDoc,
	/** The caller's read of the organization; null where that read failed. */
	organization?: SetupArtifactOrganization | null,
): Promise<SetupArtifact> {
	return buildSetupArtifact({
		doc,
		server: deployment.deployment.server,
		domain: deployment.deployment.domain,
		/* Links into the app's pages only where its content is there: a
		 * shell holds nothing, and a gone app holds nothing at all. */
		hqAppId: publishedRemoteApp(deployment)?.remoteId ?? null,
		organization:
			organization === undefined
				? await artifactOrganization(scope)
				: organization,
		confirmedWorkerLevels: new Set(
			deployment.confirmations
				.filter((confirmation) => confirmation.kind === "worker-level")
				.map((confirmation) => confirmation.subject),
		),
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
export async function artifactOrganization(
	scope: DeploymentScope,
): Promise<SetupArtifactOrganization | null> {
	try {
		/* `readOrganization` returns exactly the places and their origin this
		 * wants without hydrating the whole blueprint beside them. Callers
		 * that already hold an organization snapshot pass it instead. */
		const snapshot = await readOrganization({
			appId: scope.appId,
			projectId: scope.projectId,
			role: scope.role,
			actorUserId: scope.actorUserId,
		});
		return snapshot;
	} catch (error) {
		log.warn("[deployment] organization snapshot unavailable for artifact", {
			appId: scope.appId,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

/**
 * What a publish to a project space would ask a person to confirm, with
 * each item's state from the confirmations the deployment there holds
 * (none where the app has no deployment there).
 *
 * The pre-publish check reads this so the dialog and MCP show the rows
 * before the first press instead of after a refusal. It asks CommCare HQ
 * nothing, and reads the needs through the helper the `plan-features` edge
 * reads (`preflight.ts::publishConfirmationNeeds`), under the naming of the
 * Project's current definitions of the tables the app reads, as the export
 * boundary names them for the publish (`lookupWireNaming` of the same
 * definitions, without their rows). Each row is about one project space, so
 * with none chosen there is nothing to ask and neither the app's
 * organization nor its tables are read.
 */
export async function projectSpaceConfirmations(
	scope: DeploymentScope,
	doc: BlueprintDoc,
	target: DeploymentTargetKey | null,
): Promise<ProjectSpaceConfirmationChecks> {
	if (target === null) return confirmationChecks([], [], null);
	const lookups = await projectLookupNaming(scope, doc);
	const { needed } = await publishConfirmationNeeds(
		scope,
		doc,
		target,
		lookups?.naming,
		/* The tables CommCare HQ manages from the target, which a publish there
		 * leaves out of its workbook. */
		new Set(
			(lookups?.definitions ?? []).flatMap((definition) =>
				definition.hq?.managedBy === "commcare-hq" &&
				definition.hq.server === target.server &&
				definition.hq.domain === target.domain
					? [definition.id]
					: [],
			),
		),
	);
	const deployment = await readDeployment(scope, target);
	return confirmationChecks(
		needed,
		deployment?.confirmations ?? [],
		asksSaveToCase(needed) ? saveToCaseOfferView(doc) : null,
	);
}

/**
 * What the tables `doc` reads are called on the wire, from the Project's
 * definitions in one snapshot, or `undefined` for an app that reads no
 * table, as `boundaryValidation.ts::prepareWithRegistry` names them, with
 * the definitions it was read from.
 */
async function projectLookupNaming(
	scope: DeploymentScope,
	doc: BlueprintDoc,
): Promise<
	| {
			readonly naming: LookupWireNaming;
			readonly definitions: readonly LookupTableDefinition[];
	  }
	| undefined
> {
	const { tableIds } = extractLookupReferenceTargets(doc);
	if (tableIds.length === 0) return undefined;
	const snapshot = await getLookupDefinitions(
		{
			projectId: scope.projectId,
			actorId: scope.actorUserId,
			role: scope.role,
		},
		tableIds,
	);
	return {
		naming: lookupWireNaming(snapshot.definitions),
		definitions: snapshot.definitions,
	};
}

/** The document's `save-to-case` move offer as a person sees it, or `null`. */
function saveToCaseOfferView(doc: BlueprintDoc): PlacementMoveOfferView | null {
	return offerView(doc, "save-to-case");
}

/** The document's move offer for `reason` as a person sees it, or `null`. */
function offerView(
	doc: BlueprintDoc,
	reason: PlacementOfferReason,
): PlacementMoveOfferView | null {
	const offer = placementMoveOffer(doc, reason);
	return offer === null ? null : placementMoveOfferView(offer);
}

/**
 * The move a preflight refusal offers, or `null`. Where the plan may lack
 * Save to Case (`hq_confirmation_needed` with that need), the case changes
 * Nova can keep in Case Management instead, which a person may accept in
 * place of the confirmation. Where the project space may drop the link
 * between cases of the same type (`project_space_incompatible` with
 * `same-type-child-links` missing or unverified), the same-type children
 * moved to Save to Case blocks, which keep that link whatever the project
 * space says.
 */
function refusalPlacementMoves(
	doc: BlueprintDoc,
	code: DeploymentFailure["code"],
	confirmationsNeeded: readonly DeploymentConfirmationNeeded[],
	compatibility: ProjectSpaceCompatibilityReport | null,
): PlacementMoveOfferView | null {
	if (code === "hq_confirmation_needed") {
		return asksSaveToCase(confirmationsNeeded)
			? offerView(doc, "save-to-case")
			: null;
	}
	if (code === "project_space_incompatible") {
		const sameType = compatibility?.required_capabilities.find(
			(capability) => capability.id === "same-type-child-links",
		);
		return sameType?.state === "missing" || sameType?.state === "unverified"
			? offerView(doc, "same-type-child-links")
			: null;
	}
	return null;
}

/**
 * Publish an app to a CommCare HQ project space.
 *
 * Every externally visible step happens after the blocking preflight
 * edges pass, which is the dependency-graph contract: nothing is sent
 * until the connection, the app itself, and the app already on the target
 * are proved.
 *
 * The order of the writes is fixed by one rule: every stop a person could
 * decide differently comes before the first write of Project data. For an
 * app that is already there, preflight holds every such stop. A first
 * publish creates the empty app (the shell) and reads it before any lookup
 * table or place is pushed, then fills it with the same in-place update a
 * republish sends. The shell holds no menu, so HQ has no form id to re-mint
 * and cannot build it.
 *
 * Between preflight and the first write, the publish records where CommCare
 * HQ keeps each case change and query repeat it carries for the first time,
 * as one `publish-placement` change at the head preflight read, so every
 * later publish keeps them there. The document that change leaves is the
 * one sent, and its sequence is the pushed revision.
 */
export async function publishAppToHq(
	input: PublishInput,
): Promise<PublishOutcome> {
	const target: DeploymentTargetKey = {
		server: input.server,
		domain: input.domain,
	};
	const now = new Date().toISOString();

	/* What this attempt holds, kept outside the publish below so that a stop
	 * by an ending reports it: the document (the recorded one where it
	 * recorded), the placements it recorded, the phase it was in, whether it
	 * had sent CommCare HQ anything, and the checks its last preflight made. */
	let doc = input.doc;
	let seq = input.compiledAtSeq;
	let recorded = 0;
	let moved = 0;
	const placements = (): PublishPlacements => ({ recorded, moved });
	let phase: DrivenDeploymentPhase = "preflight";
	/* Every write this publish let out to CommCare HQ, by its admission: the
	 * records of what they made rest on these, not on the app staying live or
	 * its publisher keeping edit (`store.ts::withRecordRow`). */
	const letOut: string[] = [];
	/* What those writes put on CommCare HQ, as their records name it: the
	 * publisher's own work, answered to them whether or not they may still
	 * read the deployment (`store.ts::RecordAnswer`). */
	const sentToHq: LandedResource[] = [];
	/* Each once: a first publish's import lands on the empty app it made. */
	const noteSent = (recorded: RecordAnswer): void => {
		for (const resource of recorded.landed)
			if (
				!sentToHq.some(
					(earlier) =>
						earlier.kind === resource.kind &&
						earlier.novaResourceId === resource.novaResourceId &&
						earlier.remoteId === resource.remoteId,
				)
			)
				sentToHq.push(resource);
	};
	/* The deployment a record of this publish answers, for the publish to go
	 * on from. A publisher who may no longer read it can send nothing more,
	 * since every admission needs `edit`, so the publish stops there as the
	 * next admission would, and the stop says that something had gone. */
	const goOnFrom = (recorded: RecordAnswer): DeploymentWithResources => {
		noteSent(recorded);
		if (recorded.deployment === null) throw deploymentNotFound();
		return recorded.deployment;
	};
	let checked: Pick<
		PreflightRefusalExtras,
		"checks" | "projectSpaceCompatibility"
	> = { checks: [], projectSpaceCompatibility: null };

	const publish = async (): Promise<PublishOutcome> => {
		/* Read before anything is asked of CommCare HQ: the resource push is
		 * planned against the ownership ledger, and preflight is where that
		 * decision belongs. Null is the honest answer for a project space this
		 * app has never reached — Nova owns nothing there. */
		let existing = await readDeployment(input.scope, target);
		/* A live app mapping whose HQ app another Nova app took while this one
		 * was in recently deleted is settled before anything else, and before
		 * CommCare HQ is asked anything: taken back where nobody holds it, or
		 * the deployment ended where a live Nova app publishes there now, and
		 * this publish then goes on as a first publish there. */
		if (
			existing !== null &&
			(activeRemoteApp(existing)?.releasedAt ?? null) !== null
		) {
			const settle = await settleReleasedClaims(input.scope);
			const waits =
				settle.settled &&
				settle.waiting.some(
					(space) =>
						space.server === target.server && space.domain === target.domain,
				);
			if (!settle.settled || waits) {
				return preflightRefusal(
					input,
					target,
					existing,
					waits ? ANOTHER_APPS_WRITE_IN_FLIGHT : CLAIMS_CHANGED,
					{
						at: now,
						doc,
						checks: [],
						projectSpaceCompatibility: null,
						placements: placements(),
					},
				);
			}
			existing = await readDeployment(input.scope, target);
		}
		/* Every store write of this publish carries the count of endings read
		 * here, 0 where the target has no record yet. */
		const fence: DeploymentFence = {
			expectedEndings: existing?.deployment.endings ?? 0,
		};
		/* Where this project space keeps what the document doesn't hold: the
		 * ids of menus and forms, the prefix each keyed create's cases stand
		 * under, the paths of files. Every body this publish builds prints
		 * under it (`targetIdentity.ts::exportIdentityOf`). */
		const targetIdentity =
			existing === null
				? EMPTY_TARGET_IDENTITY
				: await readTargetIdentity(input.scope, target);
		/* Update in place, fill the empty app an earlier try made, or create.
		 * The predicates live in `resources.ts`, which the publish dialog also
		 * reads to say which will happen before the button is pressed. */
		const inPlaceUpdate =
			existing === null ? null : plannedInPlaceUpdate(existing);
		/* On an app Nova brought in from CommCare HQ, a language's display name
		 * and a seeded setting the project space holds no value for are the
		 * project space's: the overlay leaves both as they are, and the drift
		 * comparison reads no language name. Never for an app this publish
		 * creates, which has no mapping to update. */
		const languageNames =
			inPlaceUpdate?.ownership === "adopted" ? "target" : "nova";
		const seeds = languageNames;
		/* Computed over the document each body is built from, since the
		 * placements recorded below can change it. */
		const keyedCaseIdPrefixesOf = (built: BlueprintDoc) =>
			exportIdentityOf(built, targetIdentity).keyedCaseIdPrefixes;
		const hqAppAction =
			nextPublishAction(existing) === "updates" ? "updated" : "created";

		/* A stop before anything is sent folds and reports exactly as a blocked
		 * preflight does, over the document this attempt holds now. */
		const refuseBeforeSending = (
			failure: DeploymentFailure,
			extras: Pick<
				PreflightRefusalExtras,
				"checks" | "projectSpaceCompatibility" | "placementMoves"
			> = { checks: [], projectSpaceCompatibility: null },
		): Promise<PublishOutcome> =>
			preflightRefusal(input, target, existing, failure, {
				...extras,
				at: now,
				doc,
				placements: placements(),
			});

		/* A move offer a person accepted, recorded before preflight: it is a pure
		 * function of the document, so it needs no read of CommCare HQ, and
		 * preflight then reads the document that holds it. The offer is derived
		 * again from the head this attempt holds, so a retry after an attempt
		 * that already recorded it finds nothing left to move and goes on. */
		const accepted = input.acceptPlacementMoves;
		if (accepted !== undefined) {
			for (let attempt = 1; ; attempt++) {
				const offer = placementMoveOffer(doc, accepted.reason);
				if (offer === null) break;
				if (offer.digest !== accepted.digest) {
					return refuseBeforeSending(placementMovesChangedFailure(offer), {
						checks: [],
						projectSpaceCompatibility: null,
						placementMoves: placementMoveOfferView(offer),
					});
				}
				const record = await recordPublishPlacements({
					scope: input.scope,
					expectedHeadSeq: seq,
					holds: offer.holds,
				});
				if (record.kind === "recorded") {
					doc = record.doc;
					seq = record.seq;
					recorded += record.count;
					moved = record.count;
					break;
				}
				if (record.kind === "refused") {
					return refuseBeforeSending(appNotReadyFailure(record.message));
				}
				if (attempt === 2)
					return refuseBeforeSending(APP_CHANGED_WHILE_PUBLISHING);
				({ doc, seq } = await input.reloadHead());
			}
		}

		/* Preflight, then the placements this publish carries for the first
		 * time, recorded only while the head is still the one preflight read: a
		 * moved head means preflight read a document that is no longer the app,
		 * so it runs again over the head as it stands. Three attempts at most,
		 * so a busy app cannot keep preflight's reads of CommCare HQ going. A
		 * stop after this keeps the holds, and the next publish carries them. */
		let preflight: PassedPreflight;
		for (let attempt = 1; ; attempt++) {
			const run = await runDeploymentPreflight({
				compiledIdentity: targetIdentity,
				requireHqImport: input.requireHqImport,
				dataGrant: input.dataGrant,
				doc,
				compiledAtSeq: seq,
				mappings: existing?.active ?? [],
				inPlaceUpdate,
				languageNames,
				adoptResourceIds: input.adoptResourceIds ?? [],
				discardRemoteChanges: input.discardRemoteChanges ?? [],
				confirmations: existing?.confirmations ?? [],
				confirm: input.confirm ?? [],
				confirmWebApps: input.confirmWebApps,
				access: {
					appId: input.scope.appId,
					projectId: input.scope.projectId,
					role: input.scope.role,
					actorUserId: input.scope.actorUserId,
				},
				server: input.server,
				domain: input.domain,
				now,
				...(input.driftDate !== undefined && { driftDate: input.driftDate }),
			});
			checked = {
				checks: run.checks,
				projectSpaceCompatibility: run.projectSpaceCompatibility,
			};

			if (run.ready === null) {
				/* HQ reported the mapped app gone. That is an answer about the
				 * target, so it folds as an observation of the mapping preflight
				 * read, as Check status's would, and the next publish creates. */
				if (run.remoteAppGone !== undefined) {
					return remoteAppGoneOutcome(
						input,
						target,
						run.remoteAppGone,
						run.outcome.failure,
						{
							doc,
							checks: run.checks,
							projectSpaceCompatibility: run.projectSpaceCompatibility,
							placements: placements(),
						},
					);
				}
				/* The refusal is the attempt's to report. A target this app has
				 * never reached keeps NOTHING durable; a target it has reached
				 * keeps its record, folded only when the refusal is genuinely
				 * about the target (a publish that never completed) rather than
				 * about the attempt (a key or draft problem against a live app). */
				const confirmationsNeeded = run.confirmationsNeeded ?? [];
				return preflightRefusal(input, target, existing, run.outcome.failure, {
					at: run.outcome.at,
					doc,
					checks: run.checks,
					projectSpaceCompatibility: run.projectSpaceCompatibility,
					placements: placements(),
					resourceConflicts: run.conflicts,
					remoteChanges: run.remoteChanges ?? [],
					confirmationsNeeded,
					webAppsChange: run.webAppsChange ?? null,
					placementMoves: refusalPlacementMoves(
						doc,
						run.outcome.failure.code,
						confirmationsNeeded,
						run.projectSpaceCompatibility,
					),
				});
			}

			const holds = placementsToHold(doc);
			if (holds.length === 0) {
				preflight = run;
				break;
			}
			const record = await recordPublishPlacements({
				scope: input.scope,
				expectedHeadSeq: seq,
				holds,
			});
			if (record.kind === "recorded") {
				doc = record.doc;
				seq = record.seq;
				recorded += record.count;
				preflight = run;
				break;
			}
			const ran = {
				checks: run.checks,
				projectSpaceCompatibility: run.projectSpaceCompatibility,
			};
			if (record.kind === "refused") {
				return refuseBeforeSending(appNotReadyFailure(record.message), ran);
			}
			if (attempt === 3) {
				return refuseBeforeSending(APP_CHANGED_WHILE_PUBLISHING, ran);
			}
			({ doc, seq } = await input.reloadHead());
		}

		/* The recorded document goes out. The holds are the emitter's own
		 * derivation, so everything preflight prepared beside the document
		 * (lookups, media, compatibility, confirmations) stays true, and the HQ
		 * body comes from the document that holds the placements, under the
		 * sequence the pushed revision names. */
		const ready = {
			...preflight.ready,
			prepared: { ...preflight.ready.prepared, doc, compiledAtSeq: seq },
		};

		/* Only the files HQ can match to app content will be sent. Check their
		 * complete Project bytes, one stream at a time, before creating even a
		 * shell. The upload reopens the same immutable GCS generations. */
		const bulkAssets = bulkUploadAssets(
			ready.prepared.doc,
			ready.prepared.assets,
		);
		for (const asset of bulkAssets.values()) {
			if (!asset.byteSource) continue;
			try {
				for await (const _chunk of asset.byteSource.open()) {
					// A completed read verifies both the length and SHA-256.
				}
			} catch (error) {
				log.warn(
					"[deployment] Project media could not be verified before publish",
					{
						errorName: error instanceof Error ? error.name : "unknown",
					},
				);
				const locations = [...walkAssetRefs(ready.prepared.doc)]
					.filter((ref) => ref.assetId === asset.assetId)
					.map(describeCarrier);
				const failure: DeploymentFailure = {
					code: "app_not_ready",
					message:
						"Nova couldn't verify a media file in this Project. You can try again or choose another file for the places listed below.",
					details: locations,
				};
				return refuseBeforeSending(failure, {
					projectSpaceCompatibility: preflight.projectSpaceCompatibility,
					checks: preflight.checks.map((check) =>
						check.id === "app-readiness"
							? {
									...check,
									status: "blocked",
									detail: failure.message,
									items: locations,
								}
							: check,
					),
				});
			}
		}

		/* What the landed publish says about the logo, worked out before any
		 * write: once HQ has imported the app, nothing may fail between the
		 * import and the record of it, or the next publish would not know the
		 * app it made. Only that record writes the offered hash, so the one read
		 * at the start is the one it replaces. */
		const logoStep = logoStepFor(
			ready.prepared,
			existing?.deployment.offeredLogoContentHash ?? null,
		);

		// Reachability is proved, so the record may exist now: creation, the
		// passed preflight and what the person confirmed for it land in one
		// transaction.
		let deployment = await foldDeploymentAttempt(
			input.scope,
			target,
			"preflight",
			preflight.outcome,
			{
				ensure: true,
				confirmations: preflight.ready.confirmations,
				...fence,
			},
		);
		phase = "resources";

		const {
			creds,
			domain,
			prepared,
			lookupPush,
			locationPush,
			organization,
			targetApp,
			appBaseline,
			confirmedChanges,
			targetEmptyCaseListText,
		} = ready;
		const { identity } = exportIdentityOf(prepared.doc, targetIdentity);
		const published = publishedMediaFiles(bulkAssets);
		// This generation becomes durable only if a write is admitted.
		const contentGeneration = crypto.randomUUID();
		let entryPointManifest: PublishedEntryPointManifest | null = null;
		try {
			input.onUploadStarted?.();

			/* A refused attempt after preflight reads the same whichever step
			 * produced it, so one shape says it: the record is folded at the
			 * phase the stop belongs to, and the attempt reports it. A republish
			 * that stumbled still has last time's app over there with a link
			 * that still works. */
			const refused = async (
				phase: "resources" | "upload",
				failure: DeploymentFailure,
				options: {
					/** The confirmations HQ's own answer contradicted, withdrawn in the fold. */
					readonly withdraw?: readonly DeploymentConfirmationKey[];
				} = {},
			): Promise<PublishOutcome> => {
				deployment = await foldDeploymentAttempt(
					input.scope,
					target,
					phase,
					{
						status: "failed",
						at: new Date().toISOString(),
						failure,
					},
					options.withdraw === undefined
						? fence
						: { ...fence, withdraw: options.withdraw },
				);
				return {
					landed: false,
					refusal: {
						phase,
						failure,
						resourceConflicts: [],
						remoteChanges: [],
						confirmationsNeeded: [],
						webAppsChange: null,
						placementMoves: null,
					},
					deployment,
					checks: preflight.checks,
					artifact: await setupArtifactFor(
						input.scope,
						deployment,
						doc,
						organization,
					),
					warnings: [],
					projectSpaceCompatibility: preflight.projectSpaceCompatibility,
					hqAppUrl: hqAppUrlFor(
						input.server,
						input.domain,
						activeRemoteApp(deployment)?.remoteId ?? null,
					),
					placements: placements(),
				};
			};

			/* HQ reported the app gone while this publish was writing. The same
			 * observation preflight's `target-app` edge records, against the
			 * mapping as it stands now. */
			const remoteAppGone = (): Promise<PublishOutcome> => {
				const mapped = activeRemoteApp(deployment);
				if (mapped === null) {
					throw new Error(
						"A publish heard its app was gone with no app mapped to record it on.",
					);
				}
				return remoteAppGoneOutcome(
					input,
					target,
					mapped,
					remoteAppMissingFailure(domain),
					{
						doc,
						checks: preflight.checks,
						projectSpaceCompatibility: preflight.projectSpaceCompatibility,
						placements: placements(),
						organization,
					},
				);
			};

			// ── Make sure the HQ app exists, before any Project data ────────
			// Only on a first publish (or after HQ reported the app gone). The
			// shell is recorded whether or not its read answered, and only then
			// does a failed read refuse, so a stop from here on keeps the mapping
			// and the next publish fills this same app rather than creating a
			// second one. These stops fold at
			// `resources`: nothing of that phase has run, and folding them at
			// `upload` would draw the Project data as pushed.
			let appId: string;
			let importMapping: DeploymentResource | null;
			let source: HqAppSource;
			let createdApp = false;
			/* The read this publish holds of the app, normalized, and how the
			 * second read is compared with it: under the stored baseline's
			 * ownership, or none where Nova could not read the baseline, and as a
			 * shell while the app holds no content of Nova's yet. */
			let heldRead: unknown;
			let heldOwnership: AppOwnership | null;
			let shell: boolean;
			/* HQ's save counter just before the read the import is built over:
			 * a single increment proves the import replaced that read. */
			let counterBeforeRead: number;
			let comparedSource: string | null | undefined;
			if (targetApp === null) {
				const shellBody = hqImportApplication({
					prepared,
					target,
					compatibility: preflight.projectSpaceCompatibility,
					update: null,
					identity,
					languageNames,
					seeds,
					keyedCaseIdPrefixes: keyedCaseIdPrefixesOf(prepared.doc),
				});
				/* The create crosses no claim, but its record keeps a Project
				 * move waiting while it may still land. */
				const createWrite = await admitAppCreate(input.scope, target, {
					...fence,
					firstContentGeneration: contentGeneration,
				});
				letOut.push(createWrite);
				const created = await importApp(
					creds,
					domain,
					input.appName,
					shellBody.application,
				);
				if (!created.success) {
					await settleQuietly(
						[createWrite],
						hqAnsweredWrite(created)
							? { kind: "settled" }
							: { kind: "unanswered" },
					);
					return refused("resources", {
						code: "hq_rejected_upload",
						message: importRejectionMessage(
							classifyHqFailure(created, "app-import"),
						),
						details: [],
					});
				}
				/* HQ's one save of a new empty app leaves version 1. A counter
				 * first sampled after the create could already include another
				 * save, so bind the source to the known creation version. */
				const read = await readHqAppSourceAtVersion(
					creds,
					domain,
					created.appId,
					1,
				);
				const createBaseline = appBaselineFor({
					origin: "create",
					remoteAppId: created.appId,
					read,
					ownership: shellBody.ownership,
					novaRevision: null,
					discard: null,
				});
				/* The create stays open, naming no app, until this record names
				 * it and settles it: no other Nova app takes an HQ app on the
				 * project space before then. */
				const createRecord = {
					writeIds: [createWrite],
					settle: [
						{
							writeIds: [createWrite],
							how: { kind: "settled", resourceId: created.appId },
						},
					],
				} as const;
				try {
					deployment = goOnFrom(
						await recordCreatedRemoteApp(
							input.scope,
							target,
							{
								remoteId: created.appId,
								baseline: createBaseline.write,
								...fence,
							},
							createRecord,
						),
					);
				} catch (error) {
					/* Ended while HQ made the app: name it as an app this
					 * deployment left there, so it never stands unnamed. */
					if (error instanceof DeploymentEndedError) {
						await recordOrphanedRemoteApp(
							input.scope,
							target,
							{
								remoteId: created.appId,
								publishStartedAt: new Date(now),
							},
							createRecord,
						);
					}
					throw error;
				}
				createdApp = true;
				log.info("[deployment] empty app created", {
					domain,
					hqAppId: created.appId,
					appId: input.scope.appId,
				});
				if (!("success" in read) && read.kind === "moved") {
					return refused("resources", hqAppMovedWhileReadFailure(domain, true));
				}
				if (!("success" in read) && read.kind === "unbound") {
					return refused(
						"resources",
						hqAppSourceReadFailure(read.counter, domain, true),
					);
				}
				if ("success" in read || read.kind !== "source-at") {
					return refused(
						"resources",
						hqAppSourceReadFailure(read, domain, true),
					);
				}
				if (freshShellHasAffectedFiles(read.source, published)) {
					return refused("resources", {
						code: "hq_changed",
						message:
							"CommCare HQ created the app with a file this publish would change. You can publish again to review the file.",
						details: [],
					});
				}
				if (createBaseline.normalized === null) {
					return refused(
						"resources",
						hqAppSourceReadFailure(MALFORMED_SOURCE, domain, true),
					);
				}
				/* HQ's create sets the new app's Web App setting from the plan
				 * (`_create_app_from_doc`), so off for an app that runs in Web Apps
				 * means the plan has no Web Apps, whatever the person confirmed.
				 * Before the floor, whose remedy is wasted on an app that can't land
				 * on this plan; the mapping is kept, and the person's `web-apps`
				 * answer is withdrawn in the same fold, so the next publish asks it
				 * again. */
				if (
					createdWithoutWebApps({
						declaresWebApps: declaresWebApps(prepared.doc),
						shell: read.source,
					})
				) {
					return refused(
						"resources",
						planLacksWebAppsFailure(
							domain,
							narrowingTo(prepared.doc, "android"),
						),
						{ withdraw: [{ kind: "plan-feature", subject: "web-apps" }] },
					);
				}
				/* HQ's default CommCare version for a new app can be known only
				 * once the app exists, so the floor reads the read after the
				 * create, before any lookup table, place or content is written.
				 * The mapping is kept: the next publish fills this same app. */
				const floor = compareToVersionFloor(read.source.buildSpecVersion);
				if (floor === "below") {
					return refused(
						"resources",
						versionBelowFloorFailure(
							domain,
							read.source.buildSpecVersion,
							true,
						),
					);
				}
				if (floor === "unreadable") {
					return refused(
						"resources",
						hqAppSourceReadFailure(MALFORMED_SOURCE, domain, true),
					);
				}
				appId = created.appId;
				importMapping = activeRemoteApp(deployment);
				source = read.source;
				comparedSource = createBaseline.write.sourceDigest;
				heldRead = createBaseline.normalized;
				heldOwnership = shellBody.ownership;
				shell = true;
				counterBeforeRead = read.version;
			} else {
				appId = targetApp.appId;
				importMapping = inPlaceUpdate;
				source = targetApp.source;
				counterBeforeRead = targetApp.saveCounter;
				comparedSource =
					appBaseline === null
						? null
						: appBaseline.origin === "unread"
							? undefined
							: appBaseline.sourceDigest;
				heldRead = targetApp.normalized;
				heldOwnership =
					appBaseline === null || appBaseline.origin === "unread"
						? null
						: appBaseline.ownership;
				shell = appBaseline?.origin === "create";
			}

			if (
				importMapping?.remoteId !== appId ||
				importMapping.releasedAt !== null
			)
				return refused("upload", APP_CHANGED_WHILE_PUBLISHING);

			// ── Put everything the app depends on there first ───────────────
			// The app's selects read these tables by name at runtime and its
			// owner rules address these places, so content that arrived first
			// would be installable and broken. None of the app's content has
			// been sent at this point, which is what makes a failure here
			// resumable without re-importing anything.
			const resourceWarnings: string[] = [];
			const files =
				lookupPush?.files ?? (lookupPush ? [lookupPush.workbook] : []);
			const earlierLookups: { novaResourceId: string; remoteId: string }[] = [];
			const pendingFiles: (typeof files)[number][] = [];
			if (lookupPush)
				for (const file of files) {
					if (
						!file.tables.every(({ tableId }) =>
							lookupPush.verifiedFiles.has(tableId),
						)
					) {
						pendingFiles.push(file);
						continue;
					}
					const checkedFile = await checkWorkbookHandoff(
						input.scope,
						target,
						lookupPush,
						file,
						fence,
						createdApp,
						true,
					);
					if ("failure" in checkedFile)
						return refused("resources", checkedFile.failure);
					for (const { tableId } of file.tables) {
						const remoteId = lookupPush.verifiedFiles.get(tableId);
						if (!remoteId)
							throw new Error("An observed workbook lost its table binding.");
						earlierLookups.push({ novaResourceId: tableId, remoteId });
					}
				}
			if (files.length && !pendingFiles.length)
				deployment = goOnFrom(
					await recordPushedResources(
						input.scope,
						target,
						[],
						{
							status: "complete",
							kinds: ["lookup-table"],
							previousLookups: earlierLookups,
							pushedAt: new Date().toISOString(),
						},
						fence,
					),
				);
			if (lookupPush !== null)
				for (const [fileIndex, file] of pendingFiles.entries()) {
					const selected = new Set(
						file.tables.map((table) => table.tableId as string),
					);
					const pushed = await pushLookupTables(
						input.scope,
						target,
						creds,
						domain,
						{
							...lookupPush,
							workbook: file,
							pushes: lookupPush.pushes.filter((push) =>
								selected.has(push.tableId),
							),
							lastFile: fileIndex === pendingFiles.length - 1,
							previousVerified: earlierLookups,
						},
						createdApp,
						confirmedChanges,
						fence,
						contentGeneration,
						letOut,
					);
					if (pushed.readBackFailed) {
						resourceWarnings.push(RESOURCES_READ_BACK_FAILED_WARNING);
					}
					resourceWarnings.push(...pushed.warnings);
					/* Even a refused push can have left tables over there — CommCare
					 * HQ's `warning` verdict means it took part of the workbook — and
					 * `pushLookupTables` records those before it returns. Reading its
					 * view back keeps the refusal's report honest about what the
					 * project space now holds. */
					if (pushed.recorded !== null) deployment = goOnFrom(pushed.recorded);
					if (pushed.failure !== null)
						return refused("resources", pushed.failure);
					if (fileIndex !== pendingFiles.length - 1)
						for (const item of deployment.active)
							if (
								item.kind === "lookup-table" &&
								selected.has(item.novaResourceId)
							)
								earlierLookups.push({
									novaResourceId: item.novaResourceId,
									remoteId: item.remoteId,
								});
				}

			/* Places after tables, and both before the app's content. The order
			 * between the two does not matter to CommCare HQ; it is stable so
			 * that a partial publish always stops at the same rung and a retry
			 * always resumes at the same one. */
			if (locationPush !== null) {
				const pushed = await pushLocations(
					input.scope,
					target,
					creds,
					domain,
					locationPush,
					createdApp,
					confirmedChanges,
					fence,
					contentGeneration,
					letOut,
				);
				if (
					pushed.readBackFailed &&
					!resourceWarnings.includes(RESOURCES_READ_BACK_FAILED_WARNING)
				) {
					resourceWarnings.push(RESOURCES_READ_BACK_FAILED_WARNING);
				}
				if (pushed.recorded !== null) deployment = goOnFrom(pushed.recorded);
				if (pushed.failure !== null)
					return refused("resources", pushed.failure);
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
				deployment = goOnFrom(
					await recordPushedResources(
						input.scope,
						target,
						[],
						{
							status: "complete",
							kinds: droppedKinds,
							pushedAt: new Date().toISOString(),
						},
						fence,
					),
				);
			}

			phase = "upload";
			let builtOverSecondRead: HqImportApplicationResult<HqApplication> | null =
				null;
			/* The published files whose id moved between the two reads, settled,
			 * and the ids among them found to hold this app's bytes. */
			let settledBetween: readonly HqMediaPath[] = [];
			let learnedBetween: HqMediaRecord = {};
			if (lookupPush !== null || locationPush !== null) {
				input.onResourcesPushed?.({
					tables: lookupPush?.pushes.length ?? 0,
					places: locationPush?.placeCount ?? 0,
				});

				/* The second read. The pushes took time, and HQ may have changed
				 * the app meanwhile, so the import is built on the source as it
				 * stands now rather than on the read before the pushes. A key Nova
				 * writes that moved since the read this publish holds stops it
				 * here: the person decided over the earlier state, not this one.
				 * A confirmed overwrite also checks the exact save and normalized
				 * source the person reviewed. An ordinary publish keeps later
				 * changes to values that Nova passes through. An
				 * app this publish created that reads as gone keeps its mapping,
				 * as the import's 404 does below: the next publish reads it at
				 * `target-app` and records it gone there if it is. */
				await settleFinishedMediaJobs(creds, {
					server: target.server,
					domain,
					remoteAppId: appId,
				});
				const counter = await readHqAppSaveCounter(creds, domain, appId);
				const read = await readHqAppSource(creds, domain, appId);
				if (!("success" in read) && read.kind === "gone" && !createdApp) {
					return remoteAppGone();
				}
				if (typeof counter !== "number") {
					return refused(
						"upload",
						hqAppSourceReadFailure(counter, domain, createdApp),
					);
				}
				counterBeforeRead = counter;
				if ("success" in read || read.kind !== "source") {
					return refused(
						"upload",
						hqAppSourceReadFailure(read, domain, createdApp),
					);
				}
				const second = normalizeHqAppSource(read.source.raw);
				if ("malformed" in second) {
					return refused(
						"upload",
						hqAppSourceReadFailure(MALFORMED_SOURCE, domain, createdApp),
					);
				}
				/* With no stored ownership the comparison takes the ownership of
				 * the body built over this read, which is the body sent below. */
				let comparedOwnership = heldOwnership;
				if (comparedOwnership === null) {
					builtOverSecondRead = hqImportApplication({
						prepared,
						target,
						compatibility: preflight.projectSpaceCompatibility,
						update: { appId, source: fillSource(read.source, shell) },
						identity,
						languageNames,
						seeds,
						keyedCaseIdPrefixes: keyedCaseIdPrefixesOf(prepared.doc),
					});
					comparedOwnership = builtOverSecondRead.ownership;
				}
				const moved = diffHqAppSource({
					baseline: heldRead,
					current: second.normalized,
					ownership: comparedOwnership,
					importFiles: { published, recorded: appBaseline?.mediaFiles ?? null },
					shell,
					languageNames,
				});
				/* The Web App setting is left out of the drift comparison, to its
				 * own question, so its move is read here: the person decided over
				 * the earlier value, and the next publish's preflight asks afresh.
				 * A shell is exempt, as it is from the question. */
				const changedDuringPush: DeploymentFailure = {
					code: "hq_changed",
					message: HQ_CHANGED_DURING_PUSH_MESSAGE,
					details: [],
				};
				if (
					moved.length > 0 ||
					confirmedAppSourceMoved(
						confirmedChanges.some((change) => change.kind === "app")
							? targetApp
							: null,
						counter,
						second.digest,
					) ||
					(!shell && webAppsMovedDuringPush(source, read.source))
				) {
					return refused("upload", changedDuringPush);
				}
				/* A file at a path this publish sends, which no comparison of the
				 * source reads: the upload below would write over it. A file
				 * whose id moved is settled by its content, as preflight settles
				 * one it holds no record for, since Nova's own earlier upload may
				 * have mapped it while the data went; only a file that is not
				 * this app's stops the publish. */
				const secondMap = read.source.multimediaMap;
				if (secondMap === null) {
					return refused(
						"upload",
						hqAppSourceReadFailure(MALFORMED_SOURCE, domain, createdApp),
					);
				}
				const between = filesMovedSinceSource(source, read.source, published);
				settledBetween = between;
				if (
					!between.some((path) => path.standing === "replaced") &&
					between.some((path) => path.standing === "unrecorded")
				) {
					const settled = await settleHqMedia(creds, between, {});
					if (settled.kind === "failed") {
						return refused("upload", hqMediaReadFailure(domain));
					}
					settledBetween = settled.paths;
					learnedBetween = settled.learned;
				}
				if (settledBetween.some((path) => path.standing === "replaced")) {
					return refused("upload", changedDuringPush);
				}
				/* A build profile saved in HQ while the tables and places went is
				 * held to the same rule preflight holds the first read to: no API
				 * key can change one, so the content is not sent over it. */
				const gaps = buildProfileLanguageGaps(
					publishedLanguageCodes(prepared.doc),
					read.source.buildProfiles,
				);
				if (gaps.length > 0) {
					return refused(
						"upload",
						buildProfileLanguageFailure(domain, gaps, {
							duringPush: true,
							hqLangs: read.source.langs,
						}),
					);
				}
				source = read.source;
			}

			// ── Send it ─────────────────────────────────────────────────────
			// The upload consumes the exact prepared generation preflight
			// validated, so the bytes that passed are the bytes that go out.
			const { application: hqJson, ownership } =
				builtOverSecondRead ??
				hqImportApplication({
					prepared,
					target,
					compatibility: preflight.projectSpaceCompatibility,
					update: { appId, source: fillSource(source, shell) },
					identity,
					languageNames,
					seeds,
					keyedCaseIdPrefixes: keyedCaseIdPrefixesOf(prepared.doc),
				});
			/* Admitted under the deployment's live mapping of this HQ app,
			 * immediately before it goes: an ending since stops the publish
			 * here, and no other Nova app is granted the HQ app until the import
			 * has settled. */
			const comparedFiles = {
				files: appBaseline?.mediaFiles ?? null,
				paths: [
					...published.map((file) => file.wirePath),
					...removalLedgerPaths(source.raw, published),
				],
			};
			const importAdmission = await admitAppWrite(input.scope, target, {
				...(confirmedChanges.some((change) => change.kind === "app") && {
					reviewedRole: input.scope.role,
				}),
				firstContentGeneration:
					letOut.length === 0 ? contentGeneration : undefined,
				compiledIdentity: targetIdentity,
				...fence,
				remoteAppId: appId,
				observedPushToken: importMapping.pushToken,
				comparedReview: importMapping.reviewGeneration ?? null,
				comparedSource,
				comparedFiles,
				writeKind: "import",
				compiledAtSeq: seq,
			});
			if (importAdmission.kind !== "admitted") {
				return refused("upload", APP_CHANGED_WHILE_PUBLISHING);
			}
			const importWrite = importAdmission.writeId;
			const result = await importApp(
				creds,
				domain,
				input.appName,
				hqJson,
				appId,
				counterBeforeRead,
			);
			if ("kind" in result) {
				await cancelUnsentImport(importAdmission);
				return refused(
					"upload",
					typeof result.counter === "number"
						? {
								code: "hq_changed",
								message:
									"CommCare HQ saved this app again while Nova was preparing its content. Publishing again checks what changed before sending the app.",
								details: [],
							}
						: hqAppSourceReadFailure(result.counter, domain, createdApp),
				);
			}
			// A final 429 also explicitly precedes the view, including one whose
			// wait exhausted the deadline. No content was let out by this import.
			if (!result.success && result.status === 429) {
				await cancelUnsentImport(importAdmission);
			} else {
				letOut.push(importWrite);
			}
			if (!result.success) {
				if (result.status !== 429)
					await settleQuietly(
						[importWrite],
						hqAnsweredWrite(result)
							? { kind: "settled" }
							: { kind: "unanswered" },
					);
				/* HQ answering that the mapped app is gone is a fact about the
				 * target. Not for the app this publish just created, though: its
				 * mapping is kept, so the next publish reads it at `target-app`
				 * and never creates a second one. */
				if (result.status === 404 && !createdApp) return remoteAppGone();
				/* CommCare HQ refusing THIS upload says nothing about the app
				 * already on the project space; the fold leaves a reached record
				 * alone and moves an unreached one to `incomplete` at `upload`,
				 * which is exactly what a retry resumes from. */
				return refused("upload", {
					code: "hq_rejected_upload",
					message: importRejectionMessage(
						classifyHqFailure(result, "app-import"),
					),
					details: [],
				});
			}

			// A review can now order the import against the save it read, even
			// if the publisher is still waiting for the verification read below.
			const acceptedVersion =
				result.version !== null &&
				result.version > counterBeforeRead &&
				result.appId === appId
					? result.version
					: null;
			if (acceptedVersion !== null)
				await recordImportAcknowledgement(
					importWrite,
					result.appId,
					acceptedVersion,
				).catch((error: unknown) => {
					// Its open hold still fences a conflicting review. Continue to
					// record the import that HQ accepted, including its read-back.
					log.error(
						"[deployment] could not order the import before an HQ review",
						error,
						{ appId: input.scope.appId },
					);
				});

			// ── Read it back: the next publish compares with this ───────────
			// Before the media upload, which moves nothing the comparison reads.
			// A failed read lands the app all the same, with an `unread`
			// baseline that makes the next publish ask before writing over it.
			const appDiscard = confirmedChanges.find(
				(change) => change.kind === "app",
			);
			/* Bound to the save counter HQ acknowledged: only a read the
			 * counter proves is what this import left becomes a `push`
			 * baseline. HQ's import saves a second time in the same request
			 * when it prunes media map keys the app no longer uses; a read at
			 * that second save is this import's own only where the map lost
			 * exactly the keys it predicted and nothing the import leaves alone
			 * moved (`importPruneSave`). Any other extra save may be another
			 * writer and leaves the baseline unconfirmed. */
			const readBack: HqAppSourceAtVersionRead | null =
				result.version === null
					? null
					: await readHqAppSourceAtVersion(
							creds,
							domain,
							result.appId,
							result.version,
						);
			const pruneSave =
				result.version === counterBeforeRead + 2 &&
				readBack !== null &&
				!("success" in readBack) &&
				readBack.kind === "source-at" &&
				importPruneSave({
					before: source.raw,
					after: readBack.source.raw,
					body: hqJson,
					published,
				});
			const extraSave =
				!pruneSave &&
				result.version !== null &&
				(result.version > counterBeforeRead + 1 ||
					(readBack !== null &&
						!("success" in readBack) &&
						readBack.kind === "moved" &&
						readBack.version > counterBeforeRead + 1));
			const forwardRead = acceptedVersion === null ? null : readBack;
			const pushBaseline = appBaselineFor({
				// An extra save leaves authorship open. An exact read of a forward
				// counter still tells downloads and Preview which settings HQ holds.
				origin: extraSave ? "observed" : "push",
				remoteAppId: result.appId,
				read: forwardRead,
				ownership,
				novaRevision: seq,
				discard:
					appDiscard === undefined
						? null
						: { digest: appDiscard.observedDigest },
			});

			// ── Record what it gave back, before anything else can fail ─────
			// The mapping, its baseline and the `uploaded` state land in one
			// transaction, on the import's admission, which settles with them,
			// so no other Nova app is granted the HQ app before the record. The
			// returned id is the one asked for, so this is the store's
			// same-remote-id arm: the live row updates in place, and a mapping
			// HQ had reported gone is no longer.
			const imported = await recordRemoteResource(
				input.scope,
				target,
				{
					...fence,
					kind: "app",
					novaResourceId: input.scope.appId,
					remoteId: result.appId,
					/* A publish keeps the ownership of the mapping it updates, an app
					 * Nova brought in among them, with its first attribution. An app
					 * this publish created is Nova's, the recreate after HQ reported an
					 * adopted app gone among them. */
					...(!createdApp && inPlaceUpdate?.ownership === "adopted"
						? { ownership: "adopted", adoptedBy: inPlaceUpdate.adoptedBy }
						: { ownership: "nova-created" }),
					pushedRevision: seq,
					remoteRevision: acceptedVersion,
					uploadedAt: new Date().toISOString(),
					baseline: pushBaseline.write,
					offeredLogoContentHash: logoStep?.contentHash ?? null,
					/* A failed read leaves the column as an earlier publish wrote it,
					 * and never blocks: the flag only decides a `.ccz`'s empty-list text. */
					...(targetEmptyCaseListText !== null && { targetEmptyCaseListText }),
				},
				{
					writeIds: [importWrite],
					settle: [{ writeIds: [importWrite], how: { kind: "settled" } }],
				},
			);
			noteSent(imported);
			/* The app is there whoever may read its record now, so the publish
			 * lands either way; a publisher who may no longer read the
			 * deployment is answered what it sent and nothing of the record
			 * (`landedRecord` null), and no media goes, since its admission
			 * needs `edit`. */
			const landedRecord = imported.deployment;

			const entries = publishedEntryPoints(prepared, hqJson, input.appName, {
				server: target.server,
				domain: target.domain,
				appId: result.appId,
			});

			entryPointManifest =
				imported.pushToken === null
					? null
					: {
							generation: contentGeneration,
							remoteAppId: result.appId,
							sourceSequence: seq,
							entries,
							dependencies: imported.dependencies,
						};
			log.info("[deployment] app imported", {
				domain,
				hqAppId: result.appId,
				appId: input.scope.appId,
				action: hqAppAction,
			});

			const warnings = [...resourceWarnings, ...result.warnings];
			if (extraSave) {
				log.warn("[deployment] additional HQ save during publish", {
					domain,
					hqAppId: result.appId,
					appId: input.scope.appId,
					counterBeforeRead,
					acknowledged: result.version,
					readBack:
						readBack === null || "success" in readBack
							? "failed"
							: readBack.kind,
				});
				warnings.push(APP_CHANGED_DURING_PUBLISH_WARNING);
			} else if (pushBaseline.normalized === null) {
				log.warn("[deployment] app read back failed after import", {
					domain,
					hqAppId: result.appId,
					appId: input.scope.appId,
				});
				warnings.push(APP_READ_BACK_FAILED_WARNING);
			}
			let upload: {
				readonly warnings: readonly string[];
				readonly reported: HqMediaRecord;
			} = { warnings: [], reported: {} };
			/* The import and the bundle, whose admissions the media record rests on. */
			const mediaWrites: string[] = [importWrite];
			let mediaUnverified = false;
			/* What each batch's check found at its destinations after the
			 * import, before the batch was sent. */
			const afterImportPaths: HqMediaPath[] = [];
			if (imported.laterObservation?.compatible === false) {
				warnings.push(
					"CommCare HQ changed after accepting the app. You can review what it holds before publishing again.",
				);
			} else if (imported.retainedTake) {
				warnings.push(
					"CommCare HQ accepted the upload. Nova kept the changes you reviewed there. You can check for further changes before publishing again.",
				);
			} else if (imported.obsoleteClaim) {
				warnings.push(
					"Where this app publishes changed while CommCare HQ accepted the upload. You can review changes from CommCare HQ before publishing again.",
				);
			} else if (imported.obsoleteFold) {
				warnings.push(
					"CommCare HQ accepted an earlier revision of this app. You can review what changed there before publishing again.",
				);
			} else if (bulkAssets.size > 0 && imported.pushToken === null) {
				warnings.push(MEDIA_NOT_SENT_AFTER_LATER_PUBLISH_WARNING);
			} else if (bulkAssets.size > 0 && imported.pushToken !== null) {
				/* Admitted as the import was. An ending after the app landed
				 * leaves the publish landed, with its media not sent, and so does
				 * an app deleted, or a publisher who lost edit, since: the app is
				 * there, and nothing more is sent for it. */
				const settled = new Map(
					[...(ready.media?.paths ?? []), ...settledBetween].map((p) => [
						p.wirePath,
						p,
					]),
				);
				for (const batch of mediaUploadBatches(bulkAssets)) {
					const mediaAdmission = await admitAppWrite(input.scope, target, {
						compiledIdentity: targetIdentity,
						...fence,
						remoteAppId: result.appId,
						observedPushToken: imported.pushToken,
						comparedReview: importMapping.reviewGeneration ?? null,
						comparedSource:
							imported.laterObservation?.digest ??
							pushBaseline.write.sourceDigest,
						comparedFiles,
						writeKind: "media",
					}).catch((error: unknown) => {
						if (error instanceof DeploymentEndedError)
							return { kind: "stopped" as const };
						if (error instanceof DeploymentError && error.code === "not_found")
							return { kind: "no-access" as const };
						throw error;
					});
					if (mediaAdmission.kind === "admitted") {
						letOut.push(mediaAdmission.writeId);
						mediaWrites.push(mediaAdmission.writeId);
					}
					if (mediaAdmission.kind !== "admitted") {
						upload = {
							...upload,
							warnings: [
								...upload.warnings,
								mediaAdmission.kind === "no-access"
									? MEDIA_NOT_SENT_AFTER_ACCESS_WARNING
									: MEDIA_NOT_SENT_AFTER_STOP_WARNING,
							],
						};
						break;
					}
					const {
						verified,
						changed,
						needed,
						settled: checked,
					} = await prepareMediaBatch(
						creds,
						domain,
						result.appId,
						batch,
						settled,
						source,
						forwardRead,
					);
					afterImportPaths.push(...checked);
					upload = { ...upload, reported: { ...upload.reported, ...verified } };
					if (changed.length > 0) {
						mediaUnverified = true;
						await settleQuietly([mediaAdmission.writeId], { kind: "settled" });
						warnings.push(
							"CommCare HQ accepted the app. Nova couldn't verify the files at their destinations. You can review the files in CommCare HQ and publish again.",
						);
						break;
					}
					if (needed.size === 0) {
						await settleQuietly([mediaAdmission.writeId], { kind: "settled" });
						continue;
					}
					const part = await uploadMediaBytes(
						creds,
						domain,
						result.appId,
						{ assets: needed, doc: prepared.doc },
						input.scope.appId,
						mediaAdmission.writeId,
					);
					upload = {
						warnings: [...upload.warnings, ...part.warnings],
						reported: { ...upload.reported, ...part.reported },
					};
					if (part.warnings.length > 0) break;
				}
			}
			warnings.push(...upload.warnings);

			/* The record of which file stands at each path this publish sent:
			 * the id CommCare HQ reported for it, else one found by content
			 * before the upload, else what the baseline knew. Against the
			 * baseline this publish wrote, so a later publish's is left to that
			 * publish. */
			const previousMedia =
				appBaseline?.remoteAppId === result.appId
					? appBaseline.mediaFiles
					: null;
			const mediaRecorded = mediaUnverified
				? null
				: await recordDeploymentMediaFiles(input.scope, target, {
						...fence,
						remoteAppId: result.appId,
						sourceDigest:
							imported.laterObservation?.digest ??
							pushBaseline.write.sourceDigest,
						pushToken: imported.pushToken,
						novaRevision: pushBaseline.write.novaRevision,
						files: {
							read: previousMedia,
							next: nextHqMediaRecord({
								published,
								previous: previousMedia,
								learned: {
									...ready.media?.learned,
									...learnedBetween,
								},
								reported: upload.reported,
								settled: [
									...(ready.media?.paths ?? []),
									...settledBetween,
									...afterImportPaths,
								],
							}),
						},
						admitted: { writeIds: mediaWrites, settle: [] },
					});
			if (
				!imported.retainedTake &&
				!imported.obsoleteFold &&
				!imported.obsoleteClaim &&
				imported.laterObservation?.compatible !== false &&
				mediaRecorded === "superseded" &&
				published.length > 0
			)
				warnings.push(
					"File information changed while Nova published. You can review changes from CommCare HQ to see the files it holds now.",
				);

			return {
				landed: true,
				refusal: null,
				hqAppAction,
				deployment: landedRecord,
				sent: sentToHq,
				logoStep:
					logoStep === null
						? null
						: {
								assetId: logoStep.assetId,
								fileName: logoStep.fileName,
								changed: logoStep.changed,
							},
				/* Only a write over the app can replace a form HQ may have checked,
				 * so a discard of a table or place alone carries no statement. The
				 * first publish over an app Nova brought in, or over changes made in
				 * CommCare HQ that Nova brought in, replaces every form HQ checked
				 * there. */
				appPreviewNote:
					appDiscard !== undefined ||
					appBaseline?.origin === "cutover" ||
					appBaseline?.origin === "read" ||
					appBaseline?.origin === "changes"
						? APP_PREVIEW_NOTE
						: null,
				checks: preflight.checks,
				/* Without the record, the document's own steps for the app it
				 * sent, as for a caller with no deployment to speak for. */
				artifact:
					landedRecord === null
						? buildSetupArtifact({
								doc,
								server: input.server,
								domain,
								hqAppId: result.appId,
								organization: null,
							})
						: await setupArtifactFor(
								input.scope,
								landedRecord,
								doc,
								organization,
							),
				warnings,
				projectSpaceCompatibility: preflight.projectSpaceCompatibility,
				hqAppUrl: hqAppUrlFor(input.server, domain, result.appId),
				placements: placements(),
			};
		} finally {
			await finishDeploymentContentWrite(
				input.scope,
				target,
				contentGeneration,
				entryPointManifest,
				fence,
				{ writeIds: letOut, settle: [] },
			);
		}
	};

	/* An ending that lands while this publish runs refuses every later store
	 * write of it (`DeploymentEndedError`), and the publish stops there. So
	 * does the app going to recently deleted: every later write and admission
	 * is refused, and its member is told so, saying whether anything went;
	 * the attempt is not folded, since the record belongs to a deleted app,
	 * and what each write made is already recorded on its admission. A read
	 * outside the store (the app's places, its tables) answers a deleted app
	 * as missing, so a not-found is asked once why. */
	try {
		return await publish();
	} catch (error) {
		if (error instanceof LookupError && error.code === "not_found")
			throw new DeploymentError("not_permitted", error.message, {
				cause: error,
			});
		const deleted =
			error instanceof DeploymentAppDeletedError
				? error
				: error instanceof DeploymentError && error.code === "not_found"
					? await deploymentAppDeletion(input.scope, "edit")
					: null;
		if (deleted !== null)
			throw deleted.restated(
				appDeletedWhilePublishing(input.domain, letOut.length > 0),
			);
		/* A publisher who can no longer publish the app (removed from its
		 * Project, or no longer allowed to edit it) after something went is
		 * told that it went and was recorded, and nothing else. */
		if (
			error instanceof DeploymentError &&
			error.code === "not_found" &&
			letOut.length > 0
		)
			throw new DeploymentError(
				"not_found",
				accessLostWhilePublishing(input.domain),
				{ cause: error },
			);
		if (!(error instanceof DeploymentEndedError)) throw error;
		return publishingStoppedOutcome(input, target, {
			phase,
			sent: letOut.length > 0,
			doc,
			...checked,
			placements: placements(),
		});
	}
}

/**
 * Record that CommCare HQ reported the mapped app gone, and refuse this
 * publish with it.
 *
 * It folds as an observation of the mapping that was read, not as an
 * attempt outcome (which deliberately writes nothing on a reached target):
 * the app being gone is information about the target. The observation's
 * remote id and push token guard keep a slow publish's answer from
 * clobbering a concurrent publish that landed meanwhile. The fold sets the
 * mapping's `remoteMissingAt`, so the next publish creates a new app and
 * supersedes this mapping with it.
 */
async function remoteAppGoneOutcome(
	input: PublishInput,
	target: DeploymentTargetKey,
	mapped: DeploymentResource,
	failure: DeploymentFailure,
	context: {
		/** The document this attempt holds, the recorded one where it recorded. */
		readonly doc: BlueprintDoc;
		readonly checks: readonly PreflightCheck[];
		readonly projectSpaceCompatibility: ProjectSpaceCompatibilityReport | null;
		readonly placements: PublishPlacements;
		readonly organization?: SetupArtifactOrganization;
	},
): Promise<PublishOutcome> {
	const observed = await applyDeploymentObservation(input.scope, target, {
		observedRemoteId: mapped.remoteId,
		observedPushToken: mapped.pushToken,
		outcomes: [
			["upload", { status: "failed", at: new Date().toISOString(), failure }],
		],
		remoteRevision: null,
	});
	return {
		landed: false,
		refusal: {
			phase: "upload",
			failure,
			resourceConflicts: [],
			remoteChanges: [],
			confirmationsNeeded: [],
			webAppsChange: null,
			placementMoves: null,
		},
		deployment: observed.view,
		checks: context.checks,
		artifact: await setupArtifactFor(
			input.scope,
			observed.view,
			context.doc,
			context.organization,
		),
		warnings: [],
		projectSpaceCompatibility: context.projectSpaceCompatibility,
		hqAppUrl: null,
		placements: context.placements,
	};
}

/** A preflight that passed: its `ready` holds what the publish sends. */
type PassedPreflight = Exclude<PreflightResult, { readonly ready: null }>;

/** What a refusal before anything is sent reports beside its failure. */
interface PreflightRefusalExtras {
	/** When the stop was decided, for the fold of an unreached target. */
	readonly at: string;
	/** The document this attempt holds, the recorded one where it recorded. */
	readonly doc: BlueprintDoc;
	readonly checks: readonly PreflightCheck[];
	readonly projectSpaceCompatibility: ProjectSpaceCompatibilityReport | null;
	readonly placements: PublishPlacements;
	readonly resourceConflicts?: readonly DeploymentResourceConflict[];
	readonly remoteChanges?: readonly DeploymentRemoteChange[];
	readonly confirmationsNeeded?: readonly DeploymentConfirmationNeeded[];
	readonly webAppsChange?: WebAppsChange | null;
	readonly placementMoves?: PlacementMoveOfferView | null;
}

/**
 * A publish refused before anything was sent: a blocked preflight edge, or
 * a stop while the publish recorded its placements.
 *
 * The refusal is the attempt's to report. A target this app has never
 * reached keeps nothing durable; a target it has reached keeps its record,
 * folded only when the refusal is genuinely about the target (a publish
 * that never completed) rather than about the attempt (a key or draft
 * problem against a live app).
 */
async function preflightRefusal(
	input: PublishInput,
	target: DeploymentTargetKey,
	existing: DeploymentWithResources | null,
	failure: DeploymentFailure,
	extras: PreflightRefusalExtras,
): Promise<PublishOutcome> {
	const refusal: DeploymentAttemptRefusal = {
		phase: "preflight",
		failure,
		/* Empty unless the refusal WAS a name clash, in which case these
		 * are the exact resources a person may name back to take over. */
		resourceConflicts: extras.resourceConflicts ?? [],
		/* Empty unless the refusal was `hq_changed`, in which case these
		 * are the changes a person may name back to publish over. */
		remoteChanges: extras.remoteChanges ?? [],
		/* Empty unless the refusal was `hq_confirmation_needed`. Nothing a
		 * person confirmed is stored by a refused attempt. */
		confirmationsNeeded: extras.confirmationsNeeded ?? [],
		/* Non-null exactly for `hq_web_apps_change`. Nothing was sent. */
		webAppsChange: extras.webAppsChange ?? null,
		placementMoves: extras.placementMoves ?? null,
	};
	const deployment =
		existing === null
			? null
			: await foldDeploymentAttempt(
					input.scope,
					target,
					"preflight",
					{
						status: "failed",
						at: extras.at,
						failure,
					},
					{ expectedEndings: existing.deployment.endings },
				);
	return {
		landed: false,
		refusal,
		deployment,
		checks: extras.checks,
		/* A target this app has reached still gets its full artifact,
		 * including which Project data Nova owns there: the refusal belongs
		 * to this attempt, and none of that stopped being true. A first
		 * publish that never got there has nothing to describe beyond the
		 * app itself. */
		artifact:
			deployment === null
				? buildSetupArtifact({
						doc: extras.doc,
						server: input.server,
						domain: input.domain,
						hqAppId: null,
						organization: await artifactOrganization(input.scope),
					})
				: await setupArtifactFor(input.scope, deployment, extras.doc),
		warnings: [],
		projectSpaceCompatibility: extras.projectSpaceCompatibility,
		hqAppUrl:
			deployment === null
				? null
				: hqAppUrlFor(
						input.server,
						input.domain,
						activeRemoteApp(deployment)?.remoteId ?? null,
					),
		placements: extras.placements,
	};
}

/** The stop after three moved heads while the publish recorded its placements. */
const APP_CHANGED_WHILE_PUBLISHING: DeploymentFailure = {
	code: "app_changed_while_publishing",
	message:
		"This app kept changing while Nova got it ready to publish, so nothing was sent. Publish again once the edits settle.",
	details: [],
};

/**
 * The stop for a publish whose settling of a released app mapping found the
 * claims changed under its locks three times. Nothing was written or sent.
 */
const CLAIMS_CHANGED: DeploymentFailure = {
	code: "app_changed_while_publishing",
	message: PUBLISH_CLAIMS_CHANGED,
	details: [],
};

/**
 * A publish of an app whose HQ app it gave up while it was deleted, where a
 * write another Nova app let out to that HQ app has not settled: the HQ app
 * is not taken back yet, so nothing is sent.
 */
const ANOTHER_APPS_WRITE_IN_FLIGHT: DeploymentFailure = {
	code: "app_changed_while_publishing",
	message: PUBLISH_WAITS_FOR_ANOTHER_WRITE,
	details: [],
};

/**
 * A publish whose deployment someone ended while it ran: every store write
 * after the ending is refused but the record of tables and places a push
 * made, which an ending keeps, so the publish reports the deployment as it
 * now stands, in the phase it was in. Whether CommCare HQ may hold part of
 * it decides the sentence.
 */
async function publishingStoppedOutcome(
	input: PublishInput,
	target: DeploymentTargetKey,
	stop: {
		readonly phase: DrivenDeploymentPhase;
		/** Whether this publish had sent CommCare HQ anything. */
		readonly sent: boolean;
		readonly doc: BlueprintDoc;
		readonly checks: readonly PreflightCheck[];
		readonly projectSpaceCompatibility: ProjectSpaceCompatibilityReport | null;
		readonly placements: PublishPlacements;
	},
): Promise<PublishOutcome> {
	const failure: DeploymentFailure = {
		code: "publishing_stopped",
		message: stop.sent
			? `Someone stopped publishing this app to “${input.domain}” while this publish was running. CommCare HQ may hold part of what this publish had already sent there. Publishing again makes a new app there.`
			: `Someone stopped publishing this app to “${input.domain}” while Nova was getting this publish ready, so nothing was sent. Publishing again makes a new app there.`,
		details: [],
	};
	const deployment = await readDeployment(input.scope, target);
	return {
		landed: false,
		refusal: {
			phase: stop.phase,
			failure,
			resourceConflicts: [],
			remoteChanges: [],
			confirmationsNeeded: [],
			webAppsChange: null,
			placementMoves: null,
		},
		deployment,
		checks: stop.checks,
		artifact:
			deployment === null
				? buildSetupArtifact({
						doc: stop.doc,
						server: input.server,
						domain: input.domain,
						hqAppId: null,
						organization: await artifactOrganization(input.scope),
					})
				: await setupArtifactFor(input.scope, deployment, stop.doc),
		warnings: [],
		projectSpaceCompatibility: stop.projectSpaceCompatibility,
		hqAppUrl: null,
		placements: stop.placements,
	};
}

/** The stop for an accepted offer that no longer names what would move. */
function placementMovesChangedFailure(
	offer: PlacementMoveOfferView,
): DeploymentFailure {
	return {
		code: "hq_placement_moves_changed",
		message:
			"The case changes Nova offered to move have changed since you agreed, so nothing was moved or sent. Here's what would move now.",
		details: offer.moves.map((move) => move.sentence),
	};
}

/** The commit kernel's refusal of a publish's placements, in its own words. */
function appNotReadyFailure(message: string): DeploymentFailure {
	return { code: "app_not_ready", message, details: [] };
}

/**
 * The source an update is built over. While the app is the empty shell of
 * a first publish (its baseline's origin is `create`), its profile settings
 * are the ones HQ's settings page wrote when someone saved it to raise the
 * CommCare version, chosen by nobody, so the fill takes none of them and the
 * profile overlay writes Nova's own values for every setting it seeds.
 */
function fillSource(source: HqAppSource, shell: boolean): HqAppSource {
	if (!shell) return source;
	return { ...source, profile: { ...source.profile, properties: {} } };
}

/**
 * The logo step a landed publish offers, keyed by the logo's content hash,
 * which a Project move's asset id remap leaves unchanged. Null for an app
 * with no logo.
 */
function logoStepFor(
	prepared: {
		readonly assets: Parameters<typeof assetWirePaths>[0];
		readonly doc: BlueprintDoc;
	},
	offeredContentHash: string | null,
): (PublishLogoStep & { readonly contentHash: string }) | null {
	const logo = prepared.doc.logo;
	if (logo === undefined) return null;
	const asset = prepared.assets.get(logo);
	if (asset === undefined) {
		throw new Error(
			`The app's logo ${logo} is not among the assets this publish resolved, so Nova cannot offer it.`,
		);
	}
	return {
		assetId: logo,
		fileName: `logo${asset.extension}`,
		changed: asset.contentHash !== offeredContentHash,
		contentHash: asset.contentHash,
	};
}

/**
 * Say how admitted writes ended. A failure to say so is logged and leaves
 * each write open until its admission's hold ends, which only delays a
 * bring-in of the HQ app: it never fails a write that landed.
 */
async function settleQuietly(
	writeIds: readonly string[],
	how: RemoteWriteSettlement,
): Promise<void> {
	try {
		await settleRemoteWrites(writeIds, how);
	} catch (error) {
		log.error("[deployment] could not settle a write to CommCare HQ", error, {
			writes: writeIds.length,
			how: how.kind,
		});
	}
}

/** A read whose body is not an app source Nova can compare. */
const MALFORMED_SOURCE: CommCareApiError = {
	success: false,
	status: 502,
	cause: "malformed",
};

/**
 * The app baseline one read gives: HQ's read, normalized and compressed
 * before the transaction that stores it, or `unread` when the read did not
 * give a source. An observation at the acknowledged counter across multiple
 * saves keeps its source for target settings but cannot establish authorship.
 */
function appBaselineFor(input: {
	readonly origin: "create" | "push" | "observed";
	readonly remoteAppId: string;
	/**
	 * The read after the write, bound to the save counter the write left; null
	 * where the acknowledgement did not advance the counter. Only a read
	 * at the acknowledged version provides even an observation.
	 */
	readonly read: HqAppSourceAtVersionRead | null;
	readonly ownership: AppOwnership;
	/** The sequence a push sent; null for the empty app a create made. */
	readonly novaRevision: number | null;
	readonly discard: AppBaselineWrite["discard"];
}): { readonly write: AppBaselineWrite; readonly normalized: unknown | null } {
	/* Either write ends the list of what the first publish over an app Nova
	 * brought in changes: a push made those changes, and a create is another
	 * app. A new app holds no file of CommCare HQ's, and a push or a failed
	 * read-back leaves what Nova knew of each path true. */
	const firstPublish = { kind: "set", list: null } as const;
	const mediaFiles =
		input.origin === "create"
			? ({ kind: "set", files: null } as const)
			: ({ kind: "keep" } as const);
	const observedAt = new Date().toISOString();
	const normalized =
		input.read === null ||
		"success" in input.read ||
		input.read.kind !== "source-at"
			? null
			: normalizeHqAppSource(input.read.source.raw);
	if (normalized === null || "malformed" in normalized) {
		return {
			write: {
				origin: "unread",
				remoteAppId: input.remoteAppId,
				sourceGzip: null,
				sourceBytes: null,
				sourceDigest: null,
				ownership: null,
				observedAt,
				discard: input.discard,
				novaRevision: null,
				mediaFiles,
				firstPublish,
			},
			normalized: null,
		};
	}
	return {
		write: {
			origin: input.origin === "observed" ? "unread" : input.origin,
			remoteAppId: input.remoteAppId,
			sourceGzip: gzipSync(Buffer.from(normalized.text, "utf8")),
			sourceBytes: normalized.bytes,
			sourceDigest: normalized.digest,
			ownership: input.ownership,
			observedAt,
			discard: input.discard,
			novaRevision: input.origin === "observed" ? null : input.novaRevision,
			mediaFiles,
			firstPublish,
		},
		normalized: normalized.normalized,
	};
}

/** The discard a person confirmed for one resource, recorded with its next baseline. */
function confirmedDiscard(
	confirmed: readonly DeploymentRemoteChange[],
	kind: DeploymentRemoteChange["kind"],
	novaResourceId: string,
): ResourceBaselineWrite["discard"] {
	const change = confirmed.find(
		(candidate) =>
			candidate.kind === kind && candidate.novaResourceId === novaResourceId,
	);
	return change === undefined ? null : { digest: change.observedDigest };
}

/** A baseline write for an HQ table or place Nova could not read back. */
function unreadResourceBaseline(
	kind: ResourceBaselineWrite["kind"],
	remoteId: string,
	discard: ResourceBaselineWrite["discard"] = null,
): ResourceBaselineWrite {
	return {
		origin: "unread",
		kind,
		remoteId,
		canonical: null,
		digest: null,
		observedAt: new Date().toISOString(),
		discard,
	};
}

/**
 * The clause a stop before the app's content says, in its two forms.
 *
 * A first publish has already made the empty app when a lookup table or a
 * place push stops, so the sentence says so; a retry of that publish sends
 * no create, and the shorter form is then true. `apostrophe` keeps the
 * typographic one in the messages written with it.
 */
function stoppedBeforeContent(createdApp: boolean, apostrophe = "'"): string {
	const stop = `so Nova stopped before sending the app${apostrophe}s content.`;
	return createdApp ? `${stop} ${CREATED_APP_IS_EMPTY}` : stop;
}

async function checkWorkbookHandoff(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	plan: LookupPushPlan,
	file: LookupPushPlan["workbook"],
	fence: DeploymentFence,
	createdApp: boolean,
	observedOnly: boolean,
	firstContentGeneration?: string,
): Promise<{ writeIds: readonly string[] } | { failure: DeploymentFailure }> {
	try {
		if ("check" in file) await file.check();
		const tableIds = file.tables.map((table) => table.tableId);
		const owners = tableIds.flatMap(
			(id) => plan.authority.tables.get(id)?.assignment ?? [],
		);
		if (owners.length)
			await verifyAssignmentWitness(
				{ scope, target, grant: plan.authority.grant, purpose: "publish" },
				{ target, tables: owners },
			);
		const admission = await admitWorkbookWrite(scope, target, {
			firstContentGeneration,
			...fence,
			tableIds,
			authority: plan.authority,
			observedOnly,
		});
		if (admission.kind === "admitted") return admission;
		if (admission.kind === "handed-back")
			return {
				failure: {
					code: "managed_table_handed_back",
					message: createdApp
						? MANAGED_TABLE_HANDED_BACK_AFTER_CREATE
						: MANAGED_TABLE_HANDED_BACK,
					details: [],
				},
			};
		return {
			failure: {
				code: "app_not_ready",
				message:
					"The lookup data or its audience changed while Nova prepared this workbook. You can review the table in Project data and publish again.",
				details: [],
			},
		};
	} catch (error) {
		if (!(error instanceof LookupError)) throw error;
		return {
			failure: { code: "app_not_ready", message: error.message, details: [] },
		};
	}
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
 * Each table found there is then read back, rows and all, and its
 * canonical value stored as the baseline the next publish compares with; a
 * table that cannot be read back is stored `unread`, so that publish asks
 * before writing over it.
 *
 * Every path that leaves tables ON the project space records them, the
 * refusals included. CommCare HQ's `warning` verdict means the workbook
 * was processed and part of it did not take, and a refusal that wrote no
 * mapping would leave Nova's own tables looking like a stranger's — the
 * next publish would stop and ask a person to confirm that tables Nova
 * made are theirs to take over.
 *
 * Each record rests on the workbook's admission, which it settles, so the
 * tables are recorded though the app is deleted, or its publisher loses edit,
 * meanwhile, and no hand-back of a table it carries lands before the record.
 * The workbook's admission joins `letOut`.
 */
async function pushLookupTables(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	creds: CommCareCredentials,
	domain: string,
	plan: LookupPushPlan,
	createdApp: boolean,
	confirmed: readonly DeploymentRemoteChange[],
	fence: DeploymentFence,
	contentGeneration: string,
	letOut: string[],
): Promise<{
	readonly failure: DeploymentFailure | null;
	/** What the push's record answers. Null only when nothing was written. */
	readonly recorded: RecordAnswer | null;
	/** Some table this push may have changed could not be read back. */
	readonly readBackFailed: boolean;
	/** What the person should know of a push that landed. */
	readonly warnings: readonly string[];
}> {
	/* The tables this deployment mapped before the push, which it may have
	 * rewritten whether or not the push reports success. */
	const mappedRefs = plan.pushes.flatMap((push) =>
		push.mappedRemoteId === null
			? []
			: [{ kind: "lookup-table" as const, remoteId: push.mappedRemoteId }],
	);
	/* Read before the push writes over them: a table HQ makes again under a
	 * new id is named only where its baseline shows the definition unchanged. */
	const priorBaselines = new Map(
		(await readResourceBaselines(scope, target, mappedRefs)).map(
			(baseline) => [baseline.remoteId, baseline] as const,
		),
	);
	/* Admitted under each table's lock, immediately before the workbook
	 * goes: a table handed back to CommCare HQ from this project space since
	 * preflight is CommCare HQ's again, and writing it would replace what a
	 * person chose to leave there, so nothing is sent; otherwise a hand-back
	 * of any table the workbook carries waits until the upload has settled. */
	const admission = await checkWorkbookHandoff(
		scope,
		target,
		plan,
		plan.workbook,
		fence,
		createdApp,
		false,
		letOut.length === 0 ? contentGeneration : undefined,
	);
	if ("failure" in admission)
		return {
			failure: admission.failure,
			recorded: null,
			readBackFailed: false,
			warnings: [],
		};
	letOut.push(...admission.writeIds);
	const upload = await uploadLookupTableWorkbook(
		creds,
		domain,
		"open" in plan.workbook ? plan.workbook.open() : plan.workbook.bytes,
		{ replace: true },
	);
	const ended: WritesEnded = {
		writeIds: admission.writeIds,
		how:
			upload.success !== false || hqAnsweredWrite(upload)
				? { kind: "settled" }
				: { kind: "unanswered" },
	};
	const admitted: AdmittedRecord = {
		writeIds: admission.writeIds,
		settle: [ended],
	};
	const refusal = upload.success === false ? upload : null;
	if (refusal !== null && !refusal.mayHaveLanded) {
		/* Nothing reached the project space: either the request never got
		 * past the view, or `validate_fixture_file_format` raised before
		 * `upload_fixture_file` ran. So there is nothing to record. */
		await settleQuietly(ended.writeIds, ended.how);
		return {
			failure: lookupUploadFailure(refusal, domain, createdApp),
			recorded: null,
			readBackFailed: false,
			warnings: [],
		};
	}

	const remote = await listHqLookupTables(creds, domain);
	if ("success" in remote) {
		await markResourceBaselinesUnread(
			scope,
			target,
			mappedRefs,
			fence,
			admitted,
		);
		/* Two different stories end here, and telling the wrong one is
		 * worse than saying less. If the upload itself was refused, this
		 * read was only Nova trying to find out what survived — reporting
		 * it as "CommCare HQ took your tables" would announce a success
		 * that did not happen, and would bury the one sentence naming what
		 * was actually wrong with the data. */
		if (refusal !== null) {
			return {
				failure: lookupUploadFailure(refusal, domain, createdApp),
				recorded: null,
				readBackFailed: true,
				warnings: [],
			};
		}
		return {
			failure: {
				code: "hq_resource_state_unknown",
				message: `CommCare HQ took this app's lookup tables for “${domain}” but then would not confirm them, ${stoppedBeforeContent(createdApp)} The tables are on the project space, so publishing again may ask you to confirm they are yours before it carries on.`,
				details: [],
			},
			recorded: null,
			readBackFailed: true,
			warnings: [],
		};
	}
	const remoteByTag = new Map(
		remote.map((table) => [table.tag, table] as const),
	);

	const mappings: RecordRemoteResourceInput[] = [];
	const baselines: ResourceBaselineWrite[] = [];
	const missing: string[] = [];
	/* The same tables by Nova's own ids, for the log line: a tag is the app's
	 * word, and no log line holds one. */
	const missingTableIds: string[] = [];
	const madeAgain: string[] = [];
	let readBackFailed = false;
	/* The tables are independent, so their rows are read a few at a time,
	 * and the records below keep the plan's order. */
	const landedRows = await mapWithConcurrency(
		plan.pushes,
		LOOKUP_ROWS_READ_CONCURRENCY,
		async (push) => {
			const landed = remoteByTag.get(push.tag);
			const expected = plan.expected.get(push.tableId);
			if (expected === undefined)
				throw new Error(
					"The lookup workbook is missing its intended read-back.",
				);
			return landed === undefined
				? null
				: readLookupReceipt(
						creds,
						domain,
						landed,
						expected,
						"check" in plan.workbook ? plan.workbook.check : undefined,
					);
		},
	);
	for (const [index, push] of plan.pushes.entries()) {
		const discard = confirmedDiscard(confirmed, "lookup-table", push.tableId);
		const landed = remoteByTag.get(push.tag);
		const rows = landedRows[index] ?? null;
		if (landed === undefined || rows === null) {
			missing.push(push.tag);
			missingTableIds.push(push.tableId);
			if (push.mappedRemoteId !== null) {
				readBackFailed = true;
				baselines.push(
					unreadResourceBaseline("lookup-table", push.mappedRemoteId),
				);
			}
			continue;
		}
		/* A tag in a successful upload report does not identify the table now
		 * occupying it. A failed receipt can invalidate our prior baseline but
		 * cannot create or repoint a mapping for an unverified remote id. */
		if ("success" in rows || "kind" in rows) {
			readBackFailed = true;
			if (push.mappedRemoteId !== null)
				baselines.push(
					unreadResourceBaseline("lookup-table", push.mappedRemoteId, discard),
				);
			continue;
		}
		/* HQ made the table again under a new id though every part of its
		 * table key Nova can read is what the baseline holds: a description
		 * or an indexed flag differed, or the table was deleted in HQ between
		 * preflight's read and the push. */
		const prior =
			push.mappedRemoteId === null
				? undefined
				: priorBaselines.get(push.mappedRemoteId);
		if (
			push.mappedRemoteId !== null &&
			landed.id !== push.mappedRemoteId &&
			prior !== undefined &&
			prior.origin !== "unread" &&
			lookupDefinitionChange(prior.canonical as CanonicalLookupTable, landed)
				.length === 0
		) {
			madeAgain.push(
				lookupTableMadeAgainWarning(plan.names.get(push.tableId) ?? push.tag),
			);
		}
		const canonical = rows.canonical;
		baselines.push({
			origin: "push",
			kind: "lookup-table",
			remoteId: landed.id,
			canonical,
			digest: canonical.digest,
			observedAt: new Date().toISOString(),
			discard,
		});
		mappings.push({
			kind: "lookup-table",
			novaResourceId: push.tableId,
			remoteId: landed.id,
			ownership: push.ownership,
			pushedIdentity: push.tag,
			/* Who handed the table to Nova: the standing a sibling's adoption or
			 * a takeover carries, or the person this push adopts it for. */
			adoptedBy:
				push.ownership === "adopted"
					? (push.adoption?.by ?? scope.actorUserId)
					: null,
			adoptedAt:
				push.ownership === "adopted" ? (push.adoption?.at ?? null) : null,
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
	const recordPartial = async (): Promise<RecordAnswer | null> => {
		if (mappings.length === 0) {
			await markResourceBaselinesUnread(
				scope,
				target,
				baselines.map(({ kind, remoteId }) => ({ kind, remoteId })),
				fence,
				admitted,
			);
			return null;
		}
		return recordPushedResources(
			scope,
			target,
			mappings,
			{ status: "partial" },
			{ baselines, ...fence, admitted },
		);
	};

	if (refusal !== null) {
		log.warn("[deployment] lookup table upload partly refused", {
			domain,
			appId: scope.appId,
			recorded: mappings.length,
		});
		return {
			failure: lookupUploadFailure(refusal, domain, createdApp),
			recorded: await recordPartial(),
			readBackFailed,
			warnings: [],
		};
	}

	if (missing.length > 0) {
		log.error("[deployment] lookup tables absent after upload", undefined, {
			domain,
			appId: scope.appId,
			tableIds: missingTableIds,
		});
		return {
			failure: {
				code: "hq_rejected_resource_push",
				message: `CommCare HQ reported this app's lookup tables as uploaded but does not list them all, ${stoppedBeforeContent(createdApp)} Check the lookup tables on “${domain}”, then publish again.`,
				details: missing,
			},
			recorded: await recordPartial(),
			readBackFailed,
			warnings: [],
		};
	}

	if (readBackFailed) {
		return {
			failure: {
				code: "hq_resource_state_unknown",
				message:
					"The workbook reached CommCare HQ. Nova could not verify the complete table there. Check the destination’s rows and publish again.",
				details: plan.workbook.tables.map(
					(table) => plan.names.get(table.tableId) ?? table.tag,
				),
			},
			recorded: await recordPartial(),
			readBackFailed,
			warnings: [],
		};
	}

	const recorded = await recordPushedResources(
		scope,
		target,
		mappings,
		plan.lastFile === false
			? { status: "partial" }
			: {
					previousLookups: plan.previousVerified,
					status: "complete",
					kinds: ["lookup-table"],
					pushedAt: new Date().toISOString(),
				},
		{ baselines, ...fence, admitted },
	);
	log.info("[deployment] lookup tables pushed", {
		domain,
		appId: scope.appId,
		tables: mappings.length,
	});
	return { failure: null, recorded, readBackFailed, warnings: madeAgain };
}

/**
 * CommCare HQ's refusal of a workbook, in Nova's voice, with its own
 * sentence kept.
 *
 * The synchronous upload path exists for that sentence: it names the
 * sheet, the row, or the column that CommCare HQ would not take, which is
 * the only thing that tells a person what to fix. Nova supplies the part
 * CommCare HQ cannot know — that the app's content was held back because
 * its data was, and whether this publish left an empty app there — and the
 * permission hint only where the status says permissions are the answer.
 */
function lookupUploadFailure(
	refusal: FixtureUploadRefusal,
	domain: string,
	createdApp: boolean,
): DeploymentFailure {
	/* The plan page: the plan check in front of the upload view turned the
	 * workbook away before anything was written. A first publish has already
	 * made the empty app, so what the project space holds differs by
	 * `createdApp`. */
	if (refusal.upgradeRequired) {
		return {
			code: "hq_rejected_resource_push",
			message: createdApp
				? `The plan for “${domain}” doesn't include Lookup Tables, so CommCare HQ took none of this app's lookup tables and Nova stopped before sending the app's content. Nova created the app there, and it is empty for now. Nothing else on the project space changed. Once the plan includes Lookup Tables, publishing again sends the tables and fills the app in.`
				: `The plan for “${domain}” doesn't include Lookup Tables, so CommCare HQ took none of this app's lookup tables and Nova stopped before sending the app's content. Nothing on the project space changed. Once the plan includes Lookup Tables, publishing again sends the tables and then the app's content.`,
			details: [],
		};
	}
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
			? `CommCare HQ wouldn't let Nova put this app's lookup tables on “${domain}”, ${stoppedBeforeContent(createdApp)} Uploading them needs the Edit Data permission on your CommCare HQ account.`
			: refusal.status === FIXTURE_UPLOAD_PARTIAL_CODE
				? `CommCare HQ took only part of this app's lookup tables for “${domain}”, ${stoppedBeforeContent(createdApp)} The tables it did take now hold what Nova sent. Fix what it names below, then publish again to put the rest there.`
				: refusal.mayHaveLanded
					? `Nova couldn’t confirm how much of this app’s lookup data CommCare HQ saved for “${domain}”, ${stoppedBeforeContent(createdApp, "’")} Some tables may now hold what Nova sent. Publishing again checks what is there before updating it.`
					: `CommCare HQ would not take this app's lookup tables for “${domain}”, ${stoppedBeforeContent(createdApp)} ${createdApp ? "Nothing else on the project space changed." : "Nothing on the project space changed."}`,
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
 * One inventory read after the last batch, or after a stop, reads back
 * every place that landed, and its canonical value is stored as the
 * baseline the next publish compares with; a place the read does not show,
 * and every updated place of a batch whose outcome is unknown, is stored
 * `unread`, so that publish asks before writing over it.
 *
 * A child names its parent by the `location_id` the parent's own batch
 * returned, which is the whole reason for the ordering. Every parent is
 * therefore in an earlier batch, proved by the plan rather than assumed
 * here: `planLocationResourcePush` groups by depth over the same live set
 * this walks.
 *
 * Each batch is admitted immediately before it goes (`admitPlacesWrite`), and
 * joins `letOut`; the record rests on the batches' admissions and settles
 * them, so the places are recorded though the app is deleted, or its
 * publisher loses edit, meanwhile, and no Project move lands before the
 * record. A batch the admission refuses (an ending, a deletion, lost edit)
 * is not sent, and what the earlier batches made is recorded first.
 */
async function pushLocations(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	creds: CommCareCredentials,
	domain: string,
	plan: LocationPushPlan,
	createdApp: boolean,
	confirmed: readonly DeploymentRemoteChange[],
	fence: DeploymentFence,
	contentGeneration: string,
	letOut: string[],
): Promise<{
	readonly failure: DeploymentFailure | null;
	/** What the push's record answers. Null only when nothing was written. */
	readonly recorded: RecordAnswer | null;
	/** Some place this push may have changed could not be read back. */
	readonly readBackFailed: boolean;
}> {
	const remoteIdByLocationUuid = new Map<string, string>();
	const externalIdMismatches: string[] = [];
	const landed: RecordRemoteResourceInput[] = [];
	const landedPushes: { push: PlannedPlacePush; remoteId: string }[] = [];
	/* Every batch's admission, and how CommCare HQ ended each batch. */
	const admittedIds: string[] = [];
	const ended: WritesEnded[] = [];
	const admitted = (): AdmittedRecord => ({
		writeIds: [...admittedIds],
		settle: [...ended],
	});

	/* One inventory read for every place that landed; `uncertain` names the
	 * places an unknown batch outcome may have updated, which no read can
	 * tell apart from places it left alone. */
	const readBack = async (
		uncertain: readonly string[],
	): Promise<{
		readonly baselines: readonly ResourceBaselineWrite[];
		readonly failed: boolean;
	}> => {
		const unreadOf = (remoteIds: readonly string[]) =>
			remoteIds.map((remoteId) => unreadResourceBaseline("location", remoteId));
		if (landedPushes.length === 0) {
			return { baselines: unreadOf(uncertain), failed: uncertain.length > 0 };
		}
		const inventory = await readHqPlaceInventory(creds, domain);
		if (inventory.kind !== "read") {
			return {
				baselines: [
					...landedPushes.map(({ push, remoteId }) =>
						unreadResourceBaseline(
							"location",
							remoteId,
							confirmedDiscard(confirmed, "location", push.locationUuid),
						),
					),
					...unreadOf(uncertain),
				],
				failed: true,
			};
		}
		const byId = new Map(
			inventory.places.map((place) => [place.locationId, place] as const),
		);
		let failed = uncertain.length > 0;
		const baselines: ResourceBaselineWrite[] = [];
		for (const { push, remoteId } of landedPushes) {
			const discard = confirmedDiscard(
				confirmed,
				"location",
				push.locationUuid,
			);
			const place = byId.get(remoteId);
			if (
				place === undefined ||
				!placeContentMatches(
					push,
					place,
					push.parentLocationUuid
						? (remoteIdByLocationUuid.get(push.parentLocationUuid) ?? null)
						: null,
					push.ownedKeys,
					push.desiredWire,
				)
			) {
				failed = true;
				baselines.push(unreadResourceBaseline("location", remoteId, discard));
				continue;
			}
			if (
				push.externalId !== undefined &&
				(push.externalId !== null || place.observation?.externalId != null)
			) {
				const detail = await readHqPlaceExternalId(creds, domain, remoteId);
				if (
					"success" in detail ||
					detail.siteCode !== place.siteCode ||
					detail.externalId !== place.observation?.externalId
				) {
					failed = true;
					baselines.push(unreadResourceBaseline("location", remoteId, discard));
					continue;
				}
				if (push.externalId !== detail.externalId)
					externalIdMismatches.push(push.siteCode);
			}
			const canonical = {
				...canonicalPlace(place, push.ownedKeys),
				...(push.stagedWire &&
					push.externalId !== undefined &&
					push.externalId !== place.observation?.externalId && {
						pendingExternalId: push.externalId,
					}),
			};
			baselines.push({
				origin: "push",
				kind: "location",
				remoteId,
				canonical,
				digest: canonical.digest,
				observedAt: new Date().toISOString(),
				discard,
			});
		}
		return { baselines: [...baselines, ...unreadOf(uncertain)], failed };
	};

	/* What the batches sent so far made, recorded as a push that stopped. */
	const recordStop = async (
		uncertain: readonly string[],
	): Promise<{
		readonly recorded: RecordAnswer | null;
		readonly readBackFailed: boolean;
	}> => {
		const read = await readBack(uncertain);
		if (landed.length === 0) {
			await markResourceBaselinesUnread(
				scope,
				target,
				read.baselines.map(({ kind, remoteId }) => ({ kind, remoteId })),
				fence,
				admitted(),
			);
			return { recorded: null, readBackFailed: read.failed };
		}
		return {
			recorded: await recordPushedResources(
				scope,
				target,
				landed,
				{ status: "partial" },
				{ baselines: read.baselines, ...fence, admitted: admitted() },
			),
			readBackFailed: read.failed,
		};
	};

	const stopped = async (
		failure: DeploymentFailure,
		uncertain: readonly string[] = [],
	): Promise<{
		readonly failure: DeploymentFailure;
		readonly recorded: RecordAnswer | null;
		readonly readBackFailed: boolean;
	}> => ({ failure, ...(await recordStop(uncertain)) });

	for (const batch of plan.batches) {
		const places: HqLocationPush[] = [];
		const sentIndices: number[] = [];
		const batchIds = batch.map((push) => push.remoteId);
		for (const [index, push] of batch.entries()) {
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
					locationUuid: push.locationUuid,
					parentLocationUuid: push.parentLocationUuid,
				});
				return stopped({
					code: "hq_organization_mismatch",
					message: `Nova couldn't work out where “${push.name}” belongs under, so it stopped rather than put it in the wrong part of the organization on “${domain}”.`,
					details: [],
				});
			}
			const patch = placePatch(push, push.current, parentRemoteId ?? null);
			if (patch !== null) {
				sentIndices.push(index);
				places.push(patch);
			}
		}

		let batchWrites: readonly string[];
		try {
			batchWrites = await admitPlacesWrite(scope, target, {
				firstContentGeneration:
					letOut.length === 0 ? contentGeneration : undefined,
				...fence,
				locationUuids: batch.map((push) => push.locationUuid),
				organizationRevision: plan.organizationRevision,
			});
		} catch (error) {
			if (admittedIds.length > 0) await recordStop([]);
			throw error;
		}
		admittedIds.push(...batchWrites);
		letOut.push(...batchWrites);
		const result = places.length
			? await patchHqLocations(creds, domain, places)
			: { ids: [] };
		/* A batch whose answer leaves it unknown may still be applied after
		 * Nova stopped waiting, so it stays open for its grace. */
		ended.push({
			writeIds: batchWrites,
			how:
				"success" in result && result.mayHaveLanded
					? { kind: "unanswered" }
					: { kind: "settled" },
		});
		if ("success" in result) {
			/* CommCare HQ names the offending place and why in its own
			 * sentence, including the site code, so it is passed through
			 * rather than summarized: it is more specific than anything Nova
			 * could say about a rule it did not predict. */
			const permissions = result.status === 401 || result.status === 403;
			const uncertain = result.mayHaveLanded
				? batch.flatMap((push) =>
						push.remoteId === null ? [] : [push.remoteId],
					)
				: [];
			return stopped(
				{
					code: "hq_rejected_resource_push",
					message: result.mayHaveLanded
						? `Nova couldn’t confirm whether CommCare HQ saved the last group of places for “${domain}”, ${stoppedBeforeContent(createdApp, "’")} Earlier confirmed groups are recorded. Publishing again checks what is there and may ask you to confirm which existing places Nova can update.`
						: permissions
							? `CommCare HQ wouldn't take this app's places for “${domain}”, ${stoppedBeforeContent(createdApp)} Creating places needs the Edit Locations permission on your CommCare HQ account.`
							: `CommCare HQ wouldn't take some of this app's places for “${domain}”, ${stoppedBeforeContent(createdApp)} Nothing in the group that stopped was created, and any places sent before it are on the project space. Publishing again carries on from there.`,
					details: result.message === "" ? [] : [result.message],
				},
				uncertain,
			);
		}

		for (const [index, id] of result.ids.entries())
			batchIds[sentIndices[index]] = id;
		for (const [index, remoteId] of batchIds.entries()) {
			if (remoteId === null)
				throw new Error(
					"A place receipt was missing its destination identity.",
				);
			const push = batch[index];
			if (push === undefined) continue;
			remoteIdByLocationUuid.set(push.locationUuid, remoteId);
			landedPushes.push({ push, remoteId });
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

	const read = await readBack([]);
	const recorded = await recordPushedResources(
		scope,
		target,
		landed,
		read.failed || externalIdMismatches.length
			? { status: "partial" }
			: {
					status: "complete",
					kinds: ["location"],
					pushedAt: new Date().toISOString(),
				},
		{ baselines: read.baselines, ...fence, admitted: admitted() },
	);
	log.info("[deployment] places pushed", {
		domain,
		appId: scope.appId,
		places: landed.length,
	});
	return {
		failure: read.failed
			? {
					code: "hq_resource_state_unknown",
					message: `Nova could not verify the places on “${domain}” after publishing them. Your app content is still waiting. Check that project space, then publish again.`,
					details: [],
				}
			: externalIdMismatches.length
				? {
						code: "hq_place_ids_need_setup",
						message: `The places on “${domain}” need their IDs in another system before this app can use them. Apply the organization workbook there, then publish again.`,
						details: externalIdMismatches,
					}
				: null,
		recorded,
		readBackFailed: read.failed,
	};
}

/**
 * Ship the media bytes for an app that already exists on CommCare HQ.
 *
 * The app is already there. Its media step completes only for the verified
 * subset. An uncertain remote job keeps its ledger entry for reconciliation.
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
	/** The admitted write this upload is, settled by how it ends. */
	writeId: string,
): Promise<{
	readonly warnings: readonly string[];
	readonly reported: HqMediaRecord;
}> {
	let jobId: string | null = null;
	let mediaResult: Awaited<ReturnType<typeof uploadAppMediaBundle>> | null =
		null;
	try {
		mediaResult = await uploadAppMediaBundle(
			creds,
			domain,
			hqAppId,
			streamZip(mediaMembers(prepared.assets)),
			{
				onAccepted: async (processingId) => {
					jobId = processingId;
					await settleRemoteWrites([writeId], {
						kind: "media-job",
						jobId: processingId,
					});
				},
			},
		);
	} catch (error) {
		await settleMediaWrite(writeId, jobId, null);
		// Import and its ownership mapping are already committed. A byte
		// upload or status-read failure cannot turn that fact into a failed
		// publish. Keep the URL and report which remaining work is uncertain.
		log.error("[deployment] media attachment could not be confirmed", error, {
			domain,
			hqAppId,
			appId,
		});
		return {
			warnings: [
				"Media upload could not be confirmed; the app was published but its media may not display. Publish again to retry the media upload.",
			],
			reported: {},
		};
	}
	await settleMediaWrite(writeId, jobId, mediaResult);
	if ("success" in mediaResult) {
		log.error("[deployment] media bundle upload failed", undefined, {
			domain,
			hqAppId,
			appId,
			status: mediaResult.status,
		});
		return {
			warnings: [
				"Media upload could not be confirmed; the app was published but its media may not display. Publish again to retry the media upload.",
			],
			reported: {},
		};
	}
	if (mediaResult.timedOut) {
		return {
			warnings: [
				"The app was published and CommCare HQ accepted its media. Nova could not confirm whether processing finished. Check the app’s media in CommCare HQ, or publish again to retry.",
			],
			reported: {},
		};
	}
	const receipt = await readMediaReceipt(
		creds,
		domain,
		hqAppId,
		prepared.assets,
		mediaResult,
	);
	const missing = new Set(mediaResult.unmatchedFiles.map((file) => file.path));
	const unmatchedFiles = [
		...mediaResult.unmatchedFiles,
		...receipt.missing
			.filter((path) => !missing.has(path))
			.map((path) => ({
				path,
				reason: "The destination file did not match this upload.",
				unverified: true as const,
			})),
	];
	return {
		warnings: reportMediaAttach({
			result: {
				...mediaResult,
				unmatched: unmatchedFiles.length,
				unmatchedFiles,
			},
			assetWirePath: assetWirePaths(prepared.assets),
			doc: prepared.doc,
			logPrefix: "[deployment]",
			logContext: { domain, hqAppId, appId },
		}),
		reported: receipt.files,
	};
}

/**
 * How a media upload's write ends. A job HQ reported done settles at once. A
 * job HQ accepted and Nova stopped watching (timed out, or a status read that
 * failed) stays open with its id for the hour HQ keeps its status, so a
 * bring-in polls it. A bundle HQ refused before accepting it settles. A
 * request with no job id that HQ may still have accepted (no answer, or an
 * answer Nova could not read) is left open for its admission's hold, since
 * nothing can poll it.
 */
async function settleMediaWrite(
	writeId: string,
	jobId: string | null,
	result: MediaBundleUploadResult | CommCareApiError | null,
): Promise<void> {
	if (result !== null && !("success" in result) && !result.timedOut) {
		await settleQuietly([writeId], { kind: "settled" });
		return;
	}
	if (jobId !== null) {
		await settleQuietly([writeId], { kind: "media-job", jobId });
		return;
	}
	if (result !== null && "success" in result && hqAnsweredWrite(result)) {
		await settleQuietly([writeId], { kind: "settled" });
	}
}

/**
 * The sentence for an import CommCare HQ or its edge refused, chosen by the
 * failure's kind. A page for a browser in place of an answer is worded by
 * its status, as it always has been.
 */
export function importRejectionMessage(failure: HqFailure): string {
	switch (failure.kind) {
		/* A refusal from the edge in front of CommCare HQ, which never saw the
		 * request. Its status is a proxy's, so none of the readings below
		 * apply: reporting a 403 here as a missing Edit Apps permission sends
		 * someone to ask an administrator for access they already have. */
		case "gateway-refused":
			return "A security gateway in front of CommCare HQ turned this upload away before CommCare HQ received it, so it doesn't reflect your permissions or anything in your app. Nova can't clear this one from here. Dimagi support (support@dimagi.com) can exclude the app import endpoint from the rule that matched.";
		case "key-not-accepted":
		case "plan-lacks-api-access":
		case "api-cut-off":
			return "CommCare HQ didn't accept your API key. Update it in Settings, then publish again.";
		case "permission":
		case "not-a-member":
			return "Your CommCare HQ account can't create apps in this project space. Ask an administrator there for the Edit Apps permission.";
		case "rate-limited":
			return "CommCare HQ is rate limiting requests right now. Wait a moment and publish again.";
		case "hq-unavailable":
		case "timed-out":
		case "too-large":
		case "answer-unreadable":
			return IMPORT_UNAVAILABLE;
		case "browser-only":
			return failure.status >= 500
				? IMPORT_UNAVAILABLE
				: importRefused(failure.status);
		case "not-found":
		case "refused":
			return importRefused(failure.status);
	}
}

const IMPORT_UNAVAILABLE =
	"CommCare HQ is unavailable right now. Try publishing again in a few minutes.";

function importRefused(status: number): string {
	return `CommCare HQ refused the app (HTTP ${status}).`;
}

/**
 * Prove the caller's stored key belongs to the server this deployment
 * targets.
 *
 * `getHqCredentials` takes no server: it returns whichever
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
	throw otherServerError(creds, target);
}

/** What a member whose key is on another CommCare server than the deployment is told. */
function otherServerError(
	creds: CommCareCredentials,
	target: DeploymentTargetKey,
): DeploymentError {
	return new DeploymentError(
		"invalid",
		`This deployment is on the ${COMMCARE_SERVERS[target.server].label} CommCare server, and your API key is on ${COMMCARE_SERVERS[creds.server].label}. Those are separate installations with separate accounts, so your key cannot see it. Add a key for ${COMMCARE_SERVERS[target.server].label} in Settings.`,
	);
}

/**
 * "Stop publishing here": end this app's deployment to one project space.
 * The one lifecycle the builder and MCP share. CommCare HQ is asked nothing,
 * so a person whose key no longer reaches the project space can still stop,
 * and the app there stays exactly as it is. An admin or owner of the app's
 * Project may (`store.ts::endDeployment`).
 *
 * The ending has committed before the setup artifact is read, so a fault
 * reading it answers `artifact: null`, logged by the fault's class and code
 * alone, rather than reporting a stop that landed as one that failed: a person
 * told nothing changed would stop again and be told there is nothing to stop.
 */
export async function stopPublishing(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	/** The HQ app the person looked at: the stop ends its mapping or nothing. */
	hqAppId: string,
	doc: BlueprintDoc,
	organization?: SetupArtifactOrganization,
): Promise<{
	readonly deployment: DeploymentWithResources;
	readonly artifact: SetupArtifact | null;
}> {
	const deployment = await endDeployment(scope, target, hqAppId);
	try {
		return {
			deployment,
			artifact: await setupArtifactFor(scope, deployment, doc, organization),
		};
	} catch (error) {
		log.error(
			"[deployment] setup artifact unavailable after a stop landed",
			undefined,
			{
				appId: scope.appId,
				domain: target.domain,
				errorName: error instanceof Error ? error.name : typeof error,
				errorCode: faultCode(error),
			},
		);
		return { deployment, artifact: null };
	}
}

/** What Check status and a refresh of the kept values say of a deployment someone stopped. */
function endedDeploymentError(target: DeploymentTargetKey): DeploymentError {
	return new DeploymentError(
		"invalid",
		`Nova stopped publishing this app to “${target.domain}”, so there's nothing there for it to check on. Publishing there again makes a new app.`,
	);
}

/** What Check status says of a live mapping whose HQ app another Nova app took. */
function releasedMappingError(target: DeploymentTargetKey): DeploymentError {
	return new DeploymentError(
		"invalid",
		`Another Nova app publishes to this app's CommCare HQ app in “${target.domain}” now, so Nova has nothing to check there for this one. You can publish there again. Nova updates that app if no other Nova app publishes to it by then, and makes a new one beside it otherwise.`,
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
	organization?: SetupArtifactOrganization,
): Promise<{
	readonly deployment: DeploymentWithResources;
	readonly artifact: SetupArtifact;
} | null> {
	const existing = await readDeployment(scope, target);
	if (existing === null) return null;
	/* A deployment someone stopped has no app there for Nova to ask about,
	 * and saying it hasn't reached the project space would be false. */
	if (deploymentEnding(existing) !== null) throw endedDeploymentError(target);
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
	/* Another Nova app took this HQ app while this one was in recently
	 * deleted. What CommCare HQ says of it is about that app's publishes,
	 * so nothing is asked and nothing is written until a publish of this
	 * app settles where it publishes. */
	if (remote.releasedAt !== null) throw releasedMappingError(target);
	/* A mapping HQ reported gone is always asked about again, even after a
	 * later failed create overwrote the refusal's code: HQ's own undo is
	 * how that app comes back, and only an answered check clears it. */
	if (
		!deploymentIsObservable(existing.deployment) &&
		remote.remoteMissingAt === null
	) {
		throw new DeploymentError(
			"invalid",
			"This publish stopped before the app's content reached CommCare HQ, so checking there would say nothing about it. Fix what stopped it and publish again.",
		);
	}

	const credResult = await getHqCredentials(scope.actorUserId, target.domain);
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
		observedPushToken: remote.pushToken,
		outcomes: observation.outcomes,
		remoteRevision: observation.remoteRevision,
	});
	return {
		deployment: view,
		artifact: await setupArtifactFor(scope, view, doc, organization),
	};
}

/**
 * The kept list a deployment's card, its MCP projection and a publish answer
 * show: the label ids `keptListFor` names over the stored baseline's facts,
 * with the baseline's date and the digest of its values
 * (`targetFacts.ts::deploymentKeptOf`). Null where the app's content is not on the
 * project space, and where the baseline gives no facts (none stored, an
 * unread one, a shell's, or one that does not verify).
 */
export async function deploymentKept(
	scope: DeploymentScope,
	view: DeploymentWithResources,
): Promise<DeploymentKept | null> {
	if (!keptOnTarget(view)) return null;
	return keptFromHeld(
		await withDeploymentReadSnapshot(scope, "view", (snapshot) =>
			holdDeploymentKept(snapshot, view),
		),
	);
}

/** What `holdDeploymentKept` read of one deployment's kept list: null where it has none. */
export type HeldDeploymentKept = HeldTargetFacts | null;

/**
 * `deploymentKept` read inside a caller's snapshot: the facts' bytes only
 * (`store.ts::holdTargetFacts`), which `keptFromHeld` projects once the
 * snapshot has given its connection back.
 */
export async function holdDeploymentKept(
	snapshot: DeploymentReadSnapshot,
	view: DeploymentWithResources,
): Promise<HeldDeploymentKept> {
	if (!keptOnTarget(view)) return null;
	return holdTargetFacts(snapshot, {
		server: view.deployment.server,
		domain: view.deployment.domain,
	});
}

/** The kept list `holdDeploymentKept` read. */
export function keptFromHeld(held: HeldDeploymentKept): DeploymentKept | null {
	if (held === null) return null;
	const facts = targetFactsOf(held);
	return facts === null ? null : deploymentKeptOf(facts);
}

/** Whether the app's content is on the deployment's project space, so it keeps a list. */
function keptOnTarget(view: DeploymentWithResources): boolean {
	return (
		publishedRemoteApp(view) !== null &&
		deploymentDisplaysAsReached(view.deployment, "uploaded")
	);
}

/** The action whose write landed before its answer read the kept list. */
export type KeptReadAfter =
	| "publish"
	| "check-status"
	| "kept-refresh"
	| "stop"
	| "withdraw";

/**
 * `deploymentKept` for the answer to an action whose write has landed: a
 * publish, Check status, a refresh of the kept values, or MCP's stop or
 * withdrawal of a confirmation. A
 * fault reading the list is logged and answers `unread`, which the answer
 * leaves out (a
 * card keeps the list it shows), so a store fault after the write never
 * reports a write that landed as one that failed, and nobody repeats it over
 * it. The next read of the records reads the list again.
 *
 * The line names the fault by its class and its code alone: the list is a
 * projection of the app as CommCare HQ holds it, and a fault's message can
 * quote what it was reading.
 */
export async function landedDeploymentKept(
	scope: DeploymentScope,
	view: DeploymentWithResources,
	after: KeptReadAfter,
): Promise<DeploymentKept | null | "unread"> {
	try {
		return await deploymentKept(scope, view);
	} catch (error) {
		log.error(
			"[deployment] kept list unavailable after a write landed",
			undefined,
			{
				appId: scope.appId,
				domain: view.deployment.domain,
				after,
				errorName: error instanceof Error ? error.name : typeof error,
				errorCode: faultCode(error),
			},
		);
		return "unread";
	}
}

/**
 * The first-publish list a view shows, for the answer to an action whose
 * write has landed: a fault reading it is logged as `landedDeploymentKept`
 * logs one and answers `unread`, which a card answers by keeping the list it
 * shows (`keptListModel.ts::refreshedViewToShow`). None of these writes
 * changes the stored list but a push, which clears it.
 */
export async function landedFirstPublish(
	scope: DeploymentScope,
	view: DeploymentWithResources,
	doc: BlueprintDoc,
	after: KeptReadAfter,
): Promise<FirstPublishView | null | "unread"> {
	try {
		const states = await readFirstPublishStates(scope);
		return firstPublishOf(view, states.get(view.deployment.id), doc);
	} catch (error) {
		log.error(
			"[deployment] first-publish list unavailable after a write landed",
			undefined,
			{
				appId: scope.appId,
				domain: view.deployment.domain,
				after,
				errorName: error instanceof Error ? error.name : typeof error,
				errorCode: faultCode(error),
			},
		);
		return "unread";
	}
}

/** A fault's own code where it carries a string one (a Postgres SQLSTATE, a Node system code), else null. */
export function faultCode(error: unknown): string | null {
	if (typeof error !== "object" || error === null || !("code" in error))
		return null;
	return typeof error.code === "string" ? error.code : null;
}

/**
 * What Refresh from CommCare HQ amounted to. `refreshed` leaves the baseline
 * holding what this read saw, written by it or already stored by another
 * read that saw the same; every other kind wrote nothing.
 */
export type KeptRefreshOutcome =
	| { readonly kind: "refreshed"; readonly deployment: DeploymentWithResources }
	/** Something Nova publishes differs from the baseline. Nothing is written. */
	| { readonly kind: "changed-in-hq" }
	/**
	 * A publish, or another refresh that read something else, replaced the
	 * baseline while CommCare HQ was being read. Nothing is written.
	 */
	| {
			readonly kind: "superseded";
			readonly deployment: DeploymentWithResources;
	  }
	| { readonly kind: "no-baseline" }
	| { readonly kind: "app-gone" }
	/** CommCare HQ answered with something that is no app Nova can read. */
	| { readonly kind: "unreadable" }
	/** The app's source is larger than Nova reads, on every attempt. */
	| { readonly kind: "too-large" }
	/** CommCare HQ answered with a page meant for a person: a sign-in another way, or an inactive project space. */
	| { readonly kind: "browser-only" }
	/** CommCare HQ did not accept the stored key for this read. */
	| { readonly kind: "key-not-accepted" }
	/** CommCare HQ turned the account away for this read. */
	| { readonly kind: "no-permission" }
	| { readonly kind: "unavailable" };

/* The client-safe copy restates the kinds; each must name exactly the other's. */
type _KeptKindsAgree = [KeptRefreshOutcome["kind"]] extends [KeptRefreshKind]
	? [KeptRefreshKind] extends [KeptRefreshOutcome["kind"]]
		? true
		: never
	: never;
const _keptKindsAgree: _KeptKindsAgree = true;

/**
 * What a failed read of the app's source answers, by the source read's
 * ladder. The source view runs `api_auth` and `require_can_edit_apps` with
 * no plan check and no cut-off check (`app_manager/views/apps.py::app_source`),
 * so a 401 there is the key alone; the plan and cut-off kinds are answered
 * as the account's permission all the same, should one arrive.
 */
function keptReadFailure(
	error: CommCareApiError,
): Exclude<KeptRefreshOutcome["kind"], "refreshed" | "superseded"> {
	if (error.cause === "malformed") return "unreadable";
	switch (classifyHqFailure(error, "app-source").kind) {
		case "key-not-accepted":
			return "key-not-accepted";
		case "not-a-member":
		case "permission":
		case "plan-lacks-api-access":
		case "api-cut-off":
			return "no-permission";
		case "answer-unreadable":
			return "unreadable";
		/* Both answer the same on every attempt, so neither is worded as a
		 * read that may work in a moment. */
		case "too-large":
			return "too-large";
		case "browser-only":
			return "browser-only";
		default:
			return "unavailable";
	}
}

/**
 * Read the settings a project space keeps in CommCare HQ again, without a
 * publish.
 *
 * Nova otherwise reads them only when a publish reads the app's source, so a
 * person who turns fuzzy search on in CommCare HQ would wait for the next
 * publish before Preview and a downloaded `.ccz` follow it. This is that read
 * alone. The baseline is replaced whole, and only where the read compares
 * equal to it by the publish's own comparison: a baseline stays one read of
 * CommCare HQ with one date, and replacing it where nothing Nova publishes
 * has moved changes no later drift verdict. Where something has, nothing is
 * written and the person is told. An adopted target or one with a pending
 * Publishing list also retains its comparison source when a change affects
 * the reading of its media or Web Apps state.
 *
 * It authorizes `edit`, as Check status does: it writes the baseline and
 * reads CommCare HQ with the acting member's own key, whose absence or reach
 * is raised as a `DeploymentError` that writes nothing.
 */
export async function refreshKeptValues(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
): Promise<KeptRefreshOutcome> {
	if (!roleAllowsApp(scope.role, "edit")) throw deploymentNotFound();

	/* A deployment someone stopped has nothing there to read, said as Check
	 * status says it, before anything is read. */
	const existing = await readDeployment(scope, target);
	if (existing === null) return { kind: "no-baseline" };
	if (deploymentEnding(existing) !== null) throw endedDeploymentError(target);

	/* 1. to 6. The deployment's baseline and CommCare HQ's app now, compared
	 * as a publish compares them (`compareWithHq`), which reads the baseline
	 * only once the live mapping is one it compares. */
	const compared = await compareWithHq(scope, existing, {
		baseline: () => readAppBaseline(scope, target),
	});
	switch (compared.kind) {
		case "no-baseline":
		case "app-gone":
		case "unreadable":
		case "changed-in-hq":
			return { kind: compared.kind };
		case "read-failed":
			return { kind: keptReadFailure(compared.error) };
		case "not-connected":
			throw new DeploymentError(
				"hq_not_connected",
				"CommCare HQ isn't connected on your account, so Nova can't read these again. You can add your API key in Settings, then refresh.",
			);
		case "cannot-reach":
			throw new DeploymentError(
				"domain_not_authorized",
				`Your CommCare HQ API key can't reach “${target.domain}”, so Nova can't read these again. What you see is the last thing Nova saw.`,
			);
		case "other-server":
			throw otherServerError(compared.creds, target);
		case "unchanged":
			break;
	}
	const { remote, baseline, normalized, observedAt } = compared;

	/* 7. Nothing Nova publishes moved: the fresh read replaces the baseline,
	 * or the baseline already holds what it read. Someone may have stopped
	 * publishing here while CommCare HQ was answering; the write then
	 * refuses, and the answer is the one an ended deployment gets before the
	 * read. */
	const written = await recordRefreshedAppBaseline(scope, target, {
		expectedEndings: existing.deployment.endings,
		remoteAppId: remote.remoteId,
		comparedDigest: baseline.sourceDigest,
		comparedPushToken: remote.pushToken,
		keptMediaMap: compared.mediaMap,
		keptRemovalFiles: {
			read: baseline.mediaFiles,
			paths: compared.removalPaths,
		},
		comparedRevision: baseline.novaRevision,
		comparedFold: baseline.foldBinding?.foldSeq,
		read: {
			sourceGzip: gzipSync(Buffer.from(normalized.text, "utf8")),
			sourceBytes: normalized.bytes,
			sourceDigest: normalized.digest,
			observedAt,
		},
	}).catch((error: unknown) => {
		if (error instanceof DeploymentEndedError) {
			throw endedDeploymentError(target);
		}
		throw error;
	});
	return written.outcome === "current"
		? { kind: "refreshed", deployment: written.deployment }
		: { kind: "superseded", deployment: written.deployment };
}

/**
 * Whether the app this deployment publishes changed in CommCare HQ since its
 * baseline: `refreshKeptValues`' steps 1 to 6 (`compareWithHq`), with no
 * write. `unknown` is
 * every answer but those two: no edit role, an ended deployment, no live
 * mapping or one another Nova app took, no baseline Nova compares as a
 * publish's, no key or a key on another server or one that does not reach
 * the project space, a read that failed or cannot be read, an app gone. A
 * file whose id moved at a path the baseline's record holds is a change; a
 * path with no record says nothing, since nothing is fetched.
 *
 * It holds no row lock and no pooled connection while CommCare HQ answers:
 * the deployment and its baseline are short reads of their own.
 */
export async function peekHqAppChanged(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	options: { readonly cancel?: AbortSignal },
): Promise<"changed" | "unchanged" | "unknown"> {
	if (!roleAllowsApp(scope.role, "edit")) return "unknown";
	const existing = await readDeployment(scope, target);
	if (existing === null) return "unknown";
	return peekChanged(
		scope,
		existing,
		() => readAppBaseline(scope, target),
		options,
	);
}

/**
 * `peekHqAppChanged` over a deployment and its baseline the caller already
 * read, so a caller that has them (the check when the builder opens) unzips
 * and verifies each baseline once.
 */
export async function peekReadDeploymentChanged(
	scope: DeploymentScope,
	existing: DeploymentWithResources,
	baseline: AppBaseline | null,
	options: { readonly cancel?: AbortSignal },
): Promise<"changed" | "unchanged" | "unknown"> {
	return peekChanged(scope, existing, async () => baseline, options);
}

/** `peekReadDeploymentChanged` over a baseline read only once the comparison needs it. */
async function peekChanged(
	scope: DeploymentScope,
	existing: DeploymentWithResources,
	baseline: () => Promise<AppBaseline | null>,
	options: { readonly cancel?: AbortSignal },
): Promise<"changed" | "unchanged" | "unknown"> {
	if (!roleAllowsApp(scope.role, "edit")) return "unknown";
	if (deploymentEnding(existing) !== null) return "unknown";
	const compared = await compareWithHq(scope, existing, {
		baseline,
		...(options.cancel !== undefined && { cancel: options.cancel }),
	});
	switch (compared.kind) {
		case "changed-in-hq":
			return "changed";
		case "unchanged":
			return "unchanged";
		/* A read that failed or that Nova cannot read is a failure; an app
		 * gone is an answer. Neither is a change Nova could bring in. */
		case "read-failed":
		case "unreadable":
			log.warn("[hq-changes] check read failed", { appId: scope.appId });
			return "unknown";
		default:
			return "unknown";
	}
}

/**
 * Steps 1 to 6 of Refresh from CommCare HQ, which the check when the builder
 * opens asks too: whether the deployment's live app mapping has a baseline
 * Nova compares as a publish's (`no-baseline`: none, an `unread` or a shell's,
 * one of another HQ app, or a mapping another Nova app took), the caller's own
 * connection, CommCare HQ's source now, and the publish's own comparison of
 * the two. On an app Nova brought in, the live mapping's ownership leaves the
 * language names out of it, as it does for a publish. A file whose id moved at
 * a path the baseline's record holds is a change too. On an adopted app or one
 * with a pending list, a map entry the baseline's source lacks is a change
 * unless the record holds its path at that id: Nova's own upload added it
 * after the publish read the app back. `observedAt` is taken before the
 * request is sent, so a slow answer never outdates a publish that imported
 * after that moment. It writes nothing and holds no row lock and no pooled
 * connection while CommCare HQ answers. The baseline is read (and its source
 * unzipped and verified) only once the live mapping is one it compares, so a
 * released or missing mapping reads none.
 */
async function compareWithHq(
	scope: DeploymentScope,
	existing: DeploymentWithResources,
	options: {
		readonly baseline: () => Promise<AppBaseline | null>;
		readonly cancel?: AbortSignal;
	},
): Promise<
	| { readonly kind: "no-baseline" | "not-connected" | "cannot-reach" }
	| { readonly kind: "other-server"; readonly creds: CommCareCredentials }
	| { readonly kind: "read-failed"; readonly error: CommCareApiError }
	| { readonly kind: "app-gone" | "unreadable" | "changed-in-hq" }
	| {
			readonly kind: "unchanged";
			readonly remote: DeploymentResource;
			readonly mediaMap: NonNullable<HqAppSource["multimediaMap"]>;
			readonly removalPaths: readonly string[];
			readonly baseline: Exclude<AppBaseline, { readonly origin: "unread" }>;
			readonly normalized: Extract<
				ReturnType<typeof normalizeHqAppSource>,
				{ readonly digest: string }
			>;
			readonly observedAt: string;
	  }
> {
	const remote = activeRemoteApp(existing);
	if (remote === null || remote.releasedAt !== null)
		return { kind: "no-baseline" };
	const baseline = await options.baseline();
	if (
		baseline === null ||
		baseline.origin === "unread" ||
		baseline.origin === "create" ||
		baseline.remoteAppId !== remote.remoteId
	)
		return { kind: "no-baseline" };
	const domain = existing.deployment.domain;
	const credentials = await getHqCredentials(scope.actorUserId, domain);
	if (!credentials.ok)
		return {
			kind:
				credentials.error === "not_configured"
					? "not-connected"
					: "cannot-reach",
		};
	if (credentials.creds.server !== existing.deployment.server)
		return { kind: "other-server", creds: credentials.creds };
	const observedAt = new Date().toISOString();
	const read = await readHqAppSource(
		credentials.creds,
		credentials.domain.name,
		remote.remoteId,
		{ ...(options.cancel !== undefined && { cancel: options.cancel }) },
	);
	if ("success" in read) return { kind: "read-failed", error: read };
	if (read.kind === "gone") return { kind: "app-gone" };
	if (read.kind === "unsupported") return { kind: "unreadable" };
	const normalized = normalizeHqAppSource(read.source.raw);
	if ("malformed" in normalized) return { kind: "unreadable" };
	let removalPaths = removalLedgerPaths(normalized.normalized, []);
	if (
		removalPaths.length ||
		baseline.hasFileRemovalWarning ||
		baseline.approvedFileRemovals?.length
	) {
		const head = await readOrganizationAuthoringSnapshot(scope);
		const identity = await readTargetIdentity(scope, existing.deployment);
		const manifest = await resolveMediaManifest(
			head.blueprint,
			scope.projectId,
			{
				withBytes: false,
				heldPaths: exportIdentityOf(head.blueprint, identity).heldMediaPaths,
			},
		);
		const published = publishedMediaFiles(
			bulkUploadAssets(head.blueprint, manifest),
		);
		const removed = removedHqFiles(normalized.normalized, {
			published,
			recorded: baseline.mediaFiles,
		});
		if (fileReviewMoved(removed, baseline)) return { kind: "changed-in-hq" };
		removalPaths = removalLedgerPaths(normalized.normalized, published);
	}
	const parts = diffHqAppSource({
		baseline: baseline.source,
		current: normalized.normalized,
		ownership: baseline.ownership,
		shell: false,
		languageNames: remote.ownership === "adopted" ? "target" : "nova",
		mediaChanged: movedRecordedPaths(
			baseline.mediaFiles,
			read.source.multimediaMap ?? [],
		),
	});
	if (
		baseline.firstPublishReview === "required" ||
		parts.length > 0 ||
		((remote.ownership === "adopted" || baseline.hasPublishList) &&
			publishReadingFactsMoved(
				baseline.source,
				read.source,
				recordedHqFilePaths(
					baseline.mediaFiles,
					read.source.multimediaMap ?? [],
				),
			))
	)
		return { kind: "changed-in-hq" };
	return {
		kind: "unchanged",
		remote,
		baseline,
		normalized,
		observedAt,
		mediaMap: read.source.multimediaMap ?? [],
		removalPaths,
	};
}
