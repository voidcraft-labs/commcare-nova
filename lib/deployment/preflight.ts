import { dataAccessLost, type ProjectDataGrant } from "@/lib/auth/dataGrant";
import { authorizeAssignmentExport } from "@/lib/export/privateAssignments";
import {
	plannedWorkbookTables,
	type WorkbookAuthority,
} from "./workbookAuthority";
import "server-only";

import type { Transaction } from "kysely";
import { greatestFoldBaselineSeq } from "@/lib/agent/change-set/baseLoader";
import { changesUnownedAndroidApps } from "@/lib/commcare/androidAppDependencies";
import type {
	CommCareApiError,
	CommCareCredentials,
} from "@/lib/commcare/client";
import { probeHqProjectSpaceCompatibility } from "@/lib/commcare/client";
import {
	type HqAppSource,
	type HqAppSourceRead,
	readHqAppSource,
} from "@/lib/commcare/hq/appSource";
import { readHqAppSaveCounter } from "@/lib/commcare/hq/appSourceAtVersion";
import {
	HQ_LOCATION_INVENTORY_MAX_ROWS,
	HQ_LOOKUP_INLINE_READ_MAX_ROWS,
	HQ_LOOKUP_TABLE_ROWS_MAX_BYTES,
} from "@/lib/commcare/hq/bounds";
import {
	classifyHqFailure,
	type HqFailure,
	type HqFailureKind,
} from "@/lib/commcare/hq/failure";
import { readHqPlaceInventory } from "@/lib/commcare/hq/locationInventory";
import {
	type HqLocation,
	readHqPlaceExternalId,
} from "@/lib/commcare/hq/locations";
import { readSelectedHqLookupRows } from "@/lib/commcare/hq/lookupSource";
import {
	type HqLookupTable,
	LOOKUP_ROWS_READ_CONCURRENCY,
	listHqLookupTables,
} from "@/lib/commcare/hq/lookupTables";
import {
	type PlaceIdUpdate,
	PlaceWorkbookMismatch,
	placeIdWorkbookMembers,
} from "@/lib/commcare/hq/placeWorkbook";
import { sourceCapturesLocation } from "@/lib/commcare/locationCapture";
import type { StreamLookupWorkbook } from "@/lib/commcare/lookup/archiveWorkbooks";
import type { LookupWireNaming } from "@/lib/commcare/lookup/naming";
import type { LookupWorkbook } from "@/lib/commcare/lookup/workbook";
import {
	type ExpectedLookupData,
	inlineWorkbookReceipts,
} from "@/lib/commcare/lookup/workbookReceipt";
import { bulkUploadAssets } from "@/lib/commcare/multimedia/hqJsonExportArchive";
import { formsUsingWorkerRecord } from "@/lib/commcare/planPrivileges";
import { projectSpaceCompatibilityProbePlan } from "@/lib/commcare/projectSpaceCompatibility";
import { levelsAsPublished } from "@/lib/commcare/reader/worldEntities";
import { COMMCARE_SERVERS, type CommCareServer } from "@/lib/commcare/servers";
import {
	type BuildProfileLanguageGap,
	buildProfileLanguageGaps,
	buildProfileLanguageLabel,
	publishedLanguageCodes,
} from "@/lib/commcare/targetBuildProfiles";
import {
	COMMCARE_VERSION_FLOOR,
	compareToVersionFloor,
} from "@/lib/commcare/versionFloor";
import { type AppDatabase, getAppDb, withAppTx } from "@/lib/db/pg";
import { getHqCredentials } from "@/lib/db/settings";
import { extractLookupReferenceTargets } from "@/lib/doc/lookupReferences";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import {
	type BlueprintDoc,
	declaresWebApps,
	locationPropertiesOf,
	organizationLevelsOf,
} from "@/lib/domain";
import type { PreparedExportBoundary } from "@/lib/export/boundaryValidation";
import { prepareExportBoundary } from "@/lib/export/boundaryValidation";
import { getLookupDefinitions } from "@/lib/lookup/service";
import { OrganizationError } from "@/lib/organization/errors";
import { readOrganization } from "@/lib/organization/service";
import { type DriftDateOptions, driftDate } from "@/lib/publish/driftReference";
import {
	HAND_BACK_OFFERED,
	MANAGED_DATA_CHANGED,
	managedDataPassed,
	managedDataUnreadable,
	managedDataUnreadablePermission,
	managedPlacesPassed,
	managedTableFromElsewhereCurrentItem,
	managedTableFromElsewhereItem,
	managedTableRowsUnreadable,
	managedTablesLeftOut,
	USE_HQ_TABLE_OFFERED,
} from "@/lib/publish/managedData";
import type { PlatformNarrowing } from "@/lib/publish/planFeatures";
import type { ProjectSpaceCompatibilityReport } from "@/lib/publish/projectSpaceCompatibility";
import {
	planLacksWebAppsMessage,
	webAppsChangeMessage,
	webAppsCheckAnsweredDetail,
	webAppsCheckMatchesDetail,
	webAppsCheckNoContentDetail,
} from "@/lib/publish/webApps";
import { mapWithConcurrency } from "@/lib/utils/concurrency";
import { appRemoteChange } from "./appRemoteChange";
import { attachmentUrlTarget } from "./attachmentTarget";
import {
	confirmationNeededMessage,
	requiredConfirmations,
	settleConfirmations,
} from "./confirmations";
import { DeploymentError } from "./errors";
import { usablePair } from "./hqChanges/reference";
import {
	type HqMediaPath,
	type HqMediaRecord,
	hqMediaStandings,
	publishedMediaFiles,
} from "./hqMedia";
import { settleHqMedia } from "./hqMediaSettle";
import {
	ABSENT_RESOURCE_DIGEST,
	baselinePlaceKeys,
	canonicalLookupTable,
	canonicalPlace,
	lookupDefinitionChange,
	lookupDefinitionDigest,
	lookupIdentityChange,
	lookupRowsChange,
	placeChange,
} from "./hqResourceBaseline";
import { appConfirmationScope, normalizeHqAppSource } from "./hqSourceBaseline";
import {
	matchesRecordedLookup,
	observeLargeLookup,
} from "./largeLookupReceipt";
import {
	ambiguousReverseHopsOnTarget,
	authoredReverseHops,
	type PlacePushProblem,
	type PlannedPlace,
	type PlannedPlacePush,
	planLocationResourcePush,
	plannedPlacesFor,
	projectedTargetTree,
} from "./locationResourcePlan";
import {
	describeUnsupportedLookupContent,
	type PlannedLookupPush,
	planLookupResourcePush,
} from "./lookupResourcePlan";
import {
	baselineFromTableOrigin,
	isAccountRefusal,
	type LookupTableOriginRead,
	managedTableChangeItem,
	readLookupTableOrigins,
	refreshManagedPlacesFromRead,
	reReadManagedTablesForPublish,
} from "./managedData";
import {
	boundedParts,
	decideRemoteChanges,
	describeLookupChange,
	describePlaceChange,
	driftReferenceOf,
	HQ_CHANGES_NOTHING_TO_COMPARE_DETAIL,
	hqChangedMessage,
	hqChangesConfirmedDetail,
	hqChangesNoneDetail,
	LOOKUP_DISCARD_NOTE,
} from "./remoteChanges";
import { settleFinishedMediaJobs } from "./remoteWrites";
import {
	placesManagedOn,
	type SetupArtifactOrganization,
} from "./setupArtifact";
import {
	type DeploymentTargetKey,
	readAppBaseline,
	readResourceBaselines,
	readSiblingLookupMappings,
	readTargetIdentity,
} from "./store";
import { exportIdentityOf, type TargetIdentity } from "./targetIdentity";
import type {
	AppBaseline,
	CanonicalLookupTable,
	CanonicalPlace,
	DeploymentConfirmation,
	DeploymentConfirmationKey,
	DeploymentConfirmationNeeded,
	DeploymentFailure,
	DeploymentRemoteChange,
	DeploymentResource,
	DeploymentResourceConflict,
	RemoteChangeDiscard,
	ResourceBaseline,
} from "./types";
import { type WebAppsChange, webAppsChange } from "./webApps";
import { describeRequiredWorkerDataGaps } from "./workerProvisionPlan";
import { workerRecordSetup } from "./workerRecordRequirements";

/**
 * The dependency graph Nova checks before anything externally visible
 * happens.
 *
 * It is a graph rather than a list, and the edges are of two kinds.
 * A **blocking** check is a real prerequisite: without it the publish
 * cannot happen at all, and a failure leaves the deployment `incomplete`
 * rather than succeeding with a warning attached. An **attention** check
 * is something the target needs that Nova cannot do from here, so it
 * becomes a line in the setup artifact instead of a refusal.
 *
 * The split is not a softening of the contract. It is what keeps the
 * contract truthful: refusing to publish an app because a persona has no
 * value for a required worker property would refuse a publish that would
 * have worked, since Nova creates no workers yet.
 *
 * `plan-features` asks CommCare HQ nothing: no API key reads a project
 * space's plan, so the person confirms each plan feature the app needs, and
 * the two project-space settings no API reads, once per project space.
 *
 * `managed-data` reads the lookup tables the app reads that CommCare HQ
 * manages, and refreshes Nova's copy of them, before the export boundary
 * validates the generation that results; it is the one edge before
 * `plan-features` that asks CommCare HQ anything, because it only reads and
 * what it writes is Nova's own copy. A table that changed there in a way the
 * app depends on stops the publish before anything is sent.
 *
 * `project-data` and `organization` talk to CommCare HQ here, and both are
 * blocking for the same reason: each is the only thing standing between a
 * publish and quietly writing over a lookup table or a place somebody else
 * made. They appear only when the app actually carries one. `target-app`
 * reads the app this publish is about to update, and appears only when
 * there is one: it is where a publish learns the app is gone or is not an
 * app Nova updates, before anything is written.
 *
 * The same three edges compare what CommCare HQ holds now with what Nova
 * last read back from it there (the baselines), and `hq-changes` decides
 * over everything they collected: a change nobody chose to publish over
 * stops the whole publish before any write, because a stop after a table or
 * place went out would leave them overwritten. `build-profiles` holds the
 * `target-app` read's build profiles to the languages this publish writes
 * only after that verdict, so a language added in CommCare HQ since Nova's
 * last push is first asked about as the change it is.
 *
 * `organization` is also where the shapes CommCare HQ will not hold are
 * caught. Places go out in atomic batches of a hundred, one level at a
 * time, so a tree refused on its fourth level has already put three
 * levels of places on somebody's project space. Everything knowable is
 * therefore decided here, before the first batch is sent.
 */
export const PREFLIGHT_CHECK_IDS = [
	"hq-connection",
	"managed-data",
	"app-readiness",
	"plan-features",
	"project-data",
	"organization",
	"project-space-compatibility",
	"target-app",
	"hq-changes",
	"build-profiles",
	"web-apps",
	"required-worker-data",
	"worker-record-access",
] as const;
export type PreflightCheckId = (typeof PREFLIGHT_CHECK_IDS)[number];

export type PreflightCheckStatus =
	/** Nothing to do. */
	| "passed"
	/** A real prerequisite is missing; the publish does not happen. */
	| "blocked"
	/** Somebody must do something on the target; the publish still happens. */
	| "attention"
	/** Nova could not find out, and says so rather than guessing. */
	| "unavailable";

export interface PreflightCheck {
	readonly id: PreflightCheckId;
	readonly title: string;
	readonly status: PreflightCheckStatus;
	/** One sentence a person can act on. */
	readonly detail: string;
	/** The specific things, when there are specific things. */
	readonly items: readonly string[];
}

/**
 * The two shapes a preflight run resolves to, discriminated on `ready` so
 * a refusal PROVES its failed outcome: the caller that reports "why this
 * attempt stopped" reads the failure straight off the type instead of
 * re-checking a status the control flow already decided.
 */
export type PreflightResult =
	| {
			readonly checks: readonly PreflightCheck[];
			/** The phase outcome the state machine folds in. */
			readonly outcome: { readonly status: "succeeded"; readonly at: string };
			/**
			 * The exact prepared generation the upload must consume, so the
			 * bytes that were validated are the bytes that go out.
			 */
			readonly ready: {
				readonly creds: CommCareCredentials;
				readonly domain: string;
				readonly prepared: PreparedExportBoundary;
				/**
				 * What to put on the project space before the app goes out,
				 * and the ownership claim each table travels under. Absent
				 * when the app references no Project data.
				 */
				readonly lookupPush: LookupPushPlan | null;
				/**
				 * The places to put there, in the order CommCare HQ can take
				 * them. Absent when the app has no organization or no live
				 * places in it.
				 */
				readonly locationPush: LocationPushPlan | null;
				/**
				 * The app's places and where CommCare HQ manages them, read
				 * once. Handed back so the caller can build the setup artifact
				 * from the same snapshot this ran against rather than reading
				 * the organization a second time.
				 */
				readonly organization: SetupArtifactOrganization;
				/**
				 * The `target-app` read of the app this publish updates in
				 * place, or null when it creates one.
				 */
				readonly targetApp: {
					readonly appId: string;
					readonly source: HqAppSource;
					/** The same read, normalized (`hqSourceBaseline.ts::normalizeHqAppSource`). */
					readonly normalized: unknown;
					readonly sourceDigest: string;
					/**
					 * HQ's save counter, read just before the source: an import
					 * built over this read and acknowledged at one more replaced
					 * exactly the app this read showed.
					 */
					readonly saveCounter: number;
				} | null;
				/**
				 * The stored baseline of the app `target-app` read, as the
				 * comparison used it: null when that edge did not run or no
				 * baseline of that HQ app was ever written.
				 */
				readonly appBaseline: AppBaseline | null;
				/** The HQ-side changes a person named back to publish over. */
				readonly confirmedChanges: readonly DeploymentRemoteChange[];
				/**
				 * The standing of each file this publish sends against the
				 * `target-app` read, settled by content where its id alone could
				 * not say, and the ids found to hold this app's own bytes. Null
				 * where that edge did not run or the app it read holds no
				 * content of Nova's yet.
				 */
				readonly media: {
					readonly paths: readonly HqMediaPath[];
					readonly learned: HqMediaRecord;
				} | null;
				/**
				 * Whether the project space holds `USH_EMPTY_CASE_LIST_TEXT`, read
				 * by every publish whatever the app holds; `null` where the read
				 * failed. The publish stores a definite answer with the
				 * deployment, and a `.ccz` made for it writes the empty-list text
				 * exactly where HQ's build there does.
				 */
				readonly targetEmptyCaseListText: boolean | null;
				/**
				 * What the person confirmed with this publish that the app
				 * needs, for the fold of this passed preflight to store.
				 */
				readonly confirmations: readonly DeploymentConfirmationKey[];
			};
			readonly projectSpaceCompatibility: ProjectSpaceCompatibilityReport;
	  }
	| {
			readonly checks: readonly PreflightCheck[];
			readonly outcome: {
				readonly status: "failed";
				readonly at: string;
				readonly failure: DeploymentFailure;
			};
			readonly ready: null;
			readonly projectSpaceCompatibility: ProjectSpaceCompatibilityReport | null;
			/**
			 * The resources this run refused to write over. Empty for every
			 * refusal that is not a name clash, and the caller passes it
			 * straight to the attempt's refusal so a person can name the ones
			 * they recognize.
			 */
			readonly conflicts: readonly DeploymentResourceConflict[];
			/**
			 * The mapped app `target-app` found gone. A fact about the target
			 * rather than the attempt, so the caller records it as an
			 * observation of that mapping.
			 */
			readonly remoteAppGone?: DeploymentResource;
			/** What changed in CommCare HQ, listed exactly when the refusal is `hq_changed`. */
			readonly remoteChanges?: readonly DeploymentRemoteChange[];
			/** What a person has to confirm, listed exactly when the refusal is `hq_confirmation_needed`. */
			readonly confirmationsNeeded?: readonly DeploymentConfirmationNeeded[];
			/** The Web Apps question, exactly when the refusal is `hq_web_apps_change`. */
			readonly webAppsChange?: WebAppsChange;
	  };

/** The tables to push, and what Nova may claim about each. */
export interface LookupPushPlan {
	readonly workbook: LookupWorkbook | StreamLookupWorkbook;
	readonly expected: ReadonlyMap<string, ExpectedLookupData>;
	readonly files?: readonly (LookupWorkbook | StreamLookupWorkbook)[];
	readonly verifiedFiles: ReadonlyMap<string, string>;
	readonly previousVerified?: readonly {
		novaResourceId: string;
		remoteId: string;
	}[];
	readonly lastFile?: boolean;
	readonly authority: WorkbookAuthority;
	readonly pushes: readonly PlannedLookupPush[];
	/** The author's name for each table, by Nova table id. */
	readonly names: ReadonlyMap<string, string>;
}

/**
 * The places to push, already grouped the way CommCare HQ takes them.
 *
 * Batched rather than a flat list because the batching IS the plan: a
 * child names its parent by the id the parent's own batch returned, and
 * `patch_list` is atomic at a hundred, so the grouping decides both the
 * order and where a partial push can stop.
 */
export interface LocationPushPlan {
	readonly batches: readonly (readonly PlannedPlacePush[])[];
	/** Every place across every batch, for the sentence that describes it. */
	readonly placeCount: number;
	readonly organizationRevision: string;
}

export interface PreflightInput {
	/** The publish uses these same bindings to compile and admit its outbound requests. */
	readonly compiledIdentity?: TargetIdentity;
	/** Bearer permission to copy HQ data into Nova. A browser session has no bearer restriction. */
	readonly requireHqImport: (() => void) | null;
	readonly dataGrant?: ProjectDataGrant;
	readonly doc: BlueprintDoc;
	readonly compiledAtSeq: number;
	/**
	 * The deployment's live resource mappings, read before anything is
	 * asked of CommCare HQ. Empty for a project space this app has never
	 * reached, which is exactly right: Nova owns nothing there yet.
	 */
	readonly mappings: readonly DeploymentResource[];
	/**
	 * The mapped app this publish updates in place
	 * (`resources.ts::plannedInPlaceUpdate`), or null when it creates one.
	 */
	readonly inPlaceUpdate: DeploymentResource | null;
	/**
	 * Whose language names the app comparison leaves out: `"target"` where
	 * `inPlaceUpdate` is `adopted`, whose names the project space keeps
	 * (`hqSourceBaseline.ts::diffHqAppSource`), `"nova"` otherwise.
	 */
	readonly languageNames: "nova" | "target";
	/**
	 * Nova table ids whose name clash on the target the caller has
	 * explicitly resolved by taking the existing table over. Never
	 * defaulted, never inferred from a previous attempt.
	 */
	readonly adoptResourceIds: readonly string[];
	/**
	 * HQ-side changes the caller says a person chose to write over, each
	 * bound to the state they were shown. Never defaulted from an earlier
	 * attempt.
	 */
	readonly discardRemoteChanges: readonly RemoteChangeDiscard[];
	/**
	 * What the deployment already holds confirmed about this project space.
	 * Empty for a project space this app has never reached.
	 */
	readonly confirmations: readonly DeploymentConfirmation[];
	/**
	 * What the caller says a person confirmed with this publish. Never
	 * defaulted from an earlier attempt.
	 */
	readonly confirm: readonly DeploymentConfirmationKey[];
	/**
	 * The Web App setting a person agreed to write after an
	 * `hq_web_apps_change` refusal. Never defaulted from an earlier attempt.
	 */
	readonly confirmWebApps: boolean | undefined;
	readonly access: {
		/** The app whose organization this reads. Authorized by the caller. */
		readonly appId: string;
		readonly projectId: string;
		readonly role: string;
		readonly actorUserId: string;
	};
	readonly server: CommCareServer;
	readonly domain: string;
	readonly now: string;
	/**
	 * Whose calendar day the `hq-changes` and `web-apps` edges name where a
	 * change is measured against the day the app was brought in. Absent reads
	 * as the default's, the UTC day.
	 */
	readonly driftDate?: DriftDateOptions;
}

/**
 * What a publish of `doc` to `target` asks a person to confirm, and the
 * places it sends, with the organization snapshot they were planned from. The `plan-features` edge and the pre-publish check
 * (`service.ts::projectSpaceConfirmations`) both read this, so the rows a
 * person ticks before the first press are the ones the publish asks for.
 *
 * It asks CommCare HQ nothing. The places come from the app's organization,
 * read authoritatively: everywhere else an unavailable organization read
 * degrades to no places, because the artifact is still right without them,
 * but here that reading would push nothing and then tell somebody their
 * organization is on the project space. The `organization` edge plans the
 * push from the same snapshot. Places CommCare HQ manages from the target
 * are never sent there, so none is planned (`placesManagedHere`). The
 * publish sends a lookup table workbook exactly when the app reads a table
 * CommCare HQ does not manage from the target: `managedTableIds` are the
 * tables the app reads that it does, which the workbook leaves out. Its
 * capture links resolve against the target, as `attachmentUrlTarget` hands
 * them to the emitter. `lookupNaming` is the naming of the Project's lookup
 * definitions the publish emits under (`undefined` for an app that reads no
 * table).
 */
export async function publishConfirmationNeeds(
	access: PreflightInput["access"],
	doc: BlueprintDoc,
	target: DeploymentTargetKey,
	lookupNaming: LookupWireNaming | undefined,
	managedTableIds: ReadonlySet<string>,
): Promise<{
	readonly organization: SetupArtifactOrganization & { revision: string };
	readonly places: readonly PlannedPlace[];
	/** Whether the app has levels and CommCare HQ manages its places from the target. */
	readonly placesManagedHere: boolean;
	readonly needed: DeploymentConfirmationNeeded[];
}> {
	const organized = Object.keys(organizationLevelsOf(doc)).length > 0;
	const organization = organized
		? await readAppOrganization(access)
		: { locations: [], revision: "0" };
	const placesManagedHere = placesManagedOn(organization.hq, target);
	const places =
		organized && !placesManagedHere
			? plannedPlacesFor(doc, organization.locations)
			: [];
	return {
		organization,
		places,
		placesManagedHere,
		needed: requiredConfirmations(
			doc,
			{
				lookupTables: extractLookupReferenceTargets(doc).tableIds.some(
					(tableId) => !managedTableIds.has(tableId),
				),
				places: places.length > 0,
			},
			attachmentUrlTarget(target),
			lookupNaming,
		),
	};
}

/**
 * The app's places and where CommCare HQ manages them, if it does. An app
 * this caller can no longer reach (moved to another Project, deleted, or its
 * access withdrawn since the caller authorized it) is an expected rejection,
 * said as one; any other failure is operational and stays as it is.
 */
async function readAppOrganization(
	access: PreflightInput["access"],
): Promise<SetupArtifactOrganization & { revision: string }> {
	try {
		const snapshot = await readOrganization(
			{
				appId: access.appId,
				projectId: access.projectId,
				role: access.role,
				actorUserId: access.actorUserId,
			},
			{ includeSource: true },
		);
		return snapshot;
	} catch (error) {
		if (error instanceof OrganizationError && error.code === "not_found") {
			throw new DeploymentError("not_found", error.message, { cause: error });
		}
		throw error;
	}
}

function blockedOutcome(
	now: string,
	code:
		| "hq_not_connected"
		| "domain_not_authorized"
		| "app_not_ready"
		| "project_space_incompatible"
		| "hq_resource_state_unknown"
		| "hq_resource_conflict"
		| "hq_table_content_unsupported"
		| "hq_managed_data_changed"
		| "hq_organization_mismatch"
		| "hq_place_ids_need_setup"
		| "hq_app_state_unknown"
		| "remote_app_missing"
		| "hq_changed"
		| "hq_confirmation_needed"
		| "hq_web_apps_change"
		| "hq_app_version_below_floor"
		| "hq_build_profile_language_missing",
	message: string,
	details: readonly string[] = [],
): {
	readonly status: "failed";
	readonly at: string;
	readonly failure: DeploymentFailure;
} {
	return { status: "failed", at: now, failure: { code, message, details } };
}

/**
 * Why a publish stops over a lookup table HQ holds with content Nova's push
 * would remove. One line per table follows it.
 */
export const LOOKUP_CONTENT_UNSUPPORTED_MESSAGE =
	"Nova can't keep everything CommCare HQ holds in this app's lookup tables yet, so it stopped before sending anything: publishing over them would remove it. You can give a table a new export tag in Project data, and Nova then publishes its own table and leaves CommCare HQ's as it is.";

/** "1 lookup table" / "3 lookup tables", counted for a sentence. */
function describeTableCount(count: number): string {
	return count === 1 ? "1 lookup table" : `${count} lookup tables`;
}

function describeRowCount(count: number): string {
	return count === 1 ? "1 row" : `${count.toLocaleString("en-US")} rows`;
}

/** "1 place" / "12 places", counted for a sentence. */
function describePlaceCount(count: number): string {
	return count === 1 ? "1 place" : `${count.toLocaleString("en-US")} places`;
}

/**
 * The push, summarized by level rather than listed place by place.
 *
 * A tree runs to thousands of places, so naming each one would bury the
 * sentence above it. The level codes are what a person compares against
 * CommCare HQ's own Organization Levels page anyway.
 */
function describePlacesByLevel(
	places: readonly { readonly levelCode: string }[],
): readonly string[] {
	const counts = new Map<string, number>();
	for (const place of places) {
		counts.set(place.levelCode, (counts.get(place.levelCode) ?? 0) + 1);
	}
	return [...counts.entries()].map(
		([levelCode, count]) => `${levelCode} (${describePlaceCount(count)})`,
	);
}

/**
 * One place CommCare HQ will not take, and what to change about it.
 *
 * Each sentence names the place both ways a person can recognize it, then
 * says what CommCare HQ's rule is rather than quoting the error it would
 * eventually produce.
 */
function describePlaceProblem(problem: PlacePushProblem): string {
	const place = `${problem.name} (${problem.siteCode})`;
	switch (problem.kind) {
		case "site-code-mismatch":
			return `${place} has a site code this destination would change. Set up a destination place with the exact spelling and name, then publish again.`;
		case "site-code-taken":
			return `${place} shares its destination code with another place when CommCare HQ compares the spellings. Check both places on the destination.`;
		case "external-id-spelling":
			return `${place} has an external ID with whitespace that an organization workbook would remove. The destination needs the exact ID before this app can use it.`;
		case "metadata-order":
			return `${place} has a structured value whose exact worker text Nova cannot verify on this destination. Check the original place information there before publishing.`;
		case "level-missing":
			return `${place} stands at the level “${problem.levelCode}”, which isn't one of the levels on this project space.`;
		case "level-not-under-parent":
			return `${place} stands at “${problem.levelCode}” under ${problem.parentName} at “${problem.parentLevelCode}”. CommCare HQ takes a place only at the level directly below its parent's, so the rungs in between have to exist there and be filled in.`;
		case "duplicate-sibling-name":
			return problem.parentName === null
				? `${place} shares its name with another place at the top of the organization, and CommCare HQ needs those to differ.`
				: `${place} shares its name with another place under ${problem.parentName}, and CommCare HQ needs those to differ.`;
		case "cannot-become-root":
			return `${place} is at the top of the organization in Nova and sits under ${problem.remoteParentName} on CommCare HQ. Moving a place back to the top can only be done there.`;
	}
}

/**
 * A clash, named the two ways a person has to recognize it: what they call
 * the table in Nova, and what they will see in CommCare HQ's own list.
 */
function describeConflicts(
	conflicts: readonly DeploymentResourceConflict[],
): readonly string[] {
	return conflicts.map((conflict) => `${conflict.name} (${conflict.identity})`);
}

/**
 * Run the graph.
 *
 * Order matters and is the graph's whole point: the connection is proved
 * before the app is compiled, and the app is proved ready before anything
 * is sent. Nothing below the first blocked edge runs, because a check that
 * depends on a missing prerequisite can only produce a misleading answer.
 */
export async function runDeploymentPreflight(
	input: PreflightInput,
): Promise<PreflightResult> {
	const checks: PreflightCheck[] = [];
	const target = { server: input.server, domain: input.domain };
	/* What the three comparing edges collect for the verdict. `compared`
	 * says whether any of them had something of Nova's here to compare. */
	const observed: DeploymentRemoteChange[] = [];
	let compared = false;

	// ── 1. Can we reach that project space at all? ──────────────────
	const credResult = await getHqCredentials(
		input.access.actorUserId,
		input.domain,
	);
	if (!credResult.ok) {
		if (credResult.error === "not_configured") {
			const detail =
				"CommCare HQ isn't connected yet. Add your API key in Settings, picking the server your account lives on.";
			checks.push({
				id: "hq-connection",
				title: "CommCare HQ connection",
				status: "blocked",
				detail,
				items: [],
			});
			return {
				checks,
				outcome: blockedOutcome(input.now, "hq_not_connected", detail),
				ready: null,
				projectSpaceCompatibility: null,
				conflicts: [],
			};
		}
		const reachable = credResult.available.map((space) => space.name);
		const detail =
			credResult.error === "not_authorized"
				? `Your API key can't reach the project space “${input.domain}”. Pick one it does reach, or ask a CommCare HQ administrator to add you to that space.`
				: "No project space was chosen for this deployment.";
		checks.push({
			id: "hq-connection",
			title: "CommCare HQ connection",
			status: "blocked",
			detail,
			items: reachable,
		});
		return {
			checks,
			outcome: blockedOutcome(
				input.now,
				"domain_not_authorized",
				detail,
				reachable,
			),
			ready: null,
			projectSpaceCompatibility: null,
			conflicts: [],
		};
	}
	const { creds } = credResult;
	const domain = credResult.domain.name;
	/* The caller resolved the target server from the stored key moments
	 * ago, but the key can change between that read and this one: another
	 * tab saving a key for a different CommCare installation. The import
	 * would then land on the server the NEW key belongs to while the
	 * durable record named the old one, and every later check would read
	 * the wrong installation. The two reads have to agree before anything
	 * is sent. */
	if (creds.server !== input.server) {
		const detail = `Your CommCare HQ connection changed while this publish was being prepared: it now points at the ${COMMCARE_SERVERS[creds.server].label} CommCare server, and this publish targeted ${COMMCARE_SERVERS[input.server].label}. Close the publish dialog and try again.`;
		checks.push({
			id: "hq-connection",
			title: "CommCare HQ connection",
			status: "blocked",
			detail,
			items: [],
		});
		return {
			checks,
			outcome: blockedOutcome(input.now, "hq_not_connected", detail),
			ready: null,
			projectSpaceCompatibility: null,
			conflicts: [],
		};
	}
	checks.push({
		id: "hq-connection",
		title: "CommCare HQ connection",
		status: "passed",
		detail: `Your API key reaches “${credResult.domain.displayName}” on the ${COMMCARE_SERVERS[input.server].label} CommCare server.`,
		items: [],
	});

	// The publisher's grant, checked again before each page of a paged read.
	const grant = input.dataGrant;
	let archiveBinding: string | undefined;
	const checkPublishAccess = grant
		? async (tx: Transaction<AppDatabase>) => {
				const binding = await authorizeAssignmentExport(
					tx,
					input.access,
					grant,
					target,
					"publish",
					credResult.connectionDigest,
				);
				if (archiveBinding !== undefined && archiveBinding !== binding)
					return dataAccessLost();
				archiveBinding = binding;
			}
		: undefined;

	// ── 1a. Does the data CommCare HQ manages still hold what the app reads?
	// Blocking, and before the export boundary: refreshing Nova's copy of a
	// table changes the lookup generation, and the boundary validates and
	// emits the one that results. It only reads CommCare HQ, and what it
	// writes is Nova's own copy, which a publish refused later keeps: it is
	// CommCare HQ's current state, what Refresh would have written.
	const managedHere = await managedDataEdge(
		input,
		creds,
		domain,
		checkPublishAccess && (() => withAppTx(checkPublishAccess)),
	);
	if (managedHere !== null) {
		checks.push(managedHere.check);
		if (managedHere.failure !== null) {
			return {
				checks,
				outcome: {
					status: "failed",
					at: input.now,
					failure: managedHere.failure,
				},
				ready: null,
				projectSpaceCompatibility: null,
				conflicts: [],
			};
		}
	}

	// ── 2. Is the app itself ready to leave Nova? ───────────────────
	// The same zero-tolerance boundary every export path runs. One guard
	// here is still closed: an owner set to one PARTICULAR place, which
	// travels as Nova's own place id and so names nobody on CommCare HQ.
	// Lookup tables and an owner beneath the current case owner both pass
	// now, the first because this publish pushes them and the second
	// because it never carried a Nova identity to begin with.
	const boundary = await prepareExportBoundary({
		mode: "hq-upload",
		streamMedia: true,
		...(checkPublishAccess && {
			beforeLookupRead: () => withAppTx(checkPublishAccess),
		}),
		...(grant &&
			checkPublishAccess && {
				archiveActor: () => ({
					appId: input.access.appId,
					grant,
					recheck: checkPublishAccess,
				}),
			}),
		...(input.dataGrant && {
			assignmentAccess: {
				scope: input.access,
				grant: input.dataGrant,
				target,
				purpose: "publish" as const,
			},
		}),
		access: input.access,
		doc: input.doc,
		compiledAtSeq: input.compiledAtSeq,
		/* The paths CommCare HQ keeps this target's files under, for an app
		 * brought in from it: the bulk upload's entries and every reference
		 * of the body name them. Empty everywhere else. */
		heldMediaPaths: exportIdentityOf(
			input.doc,
			input.compiledIdentity ??
				(await readTargetIdentity(input.access, target)),
		).heldMediaPaths,
		// A publish knows its target exactly: it IS this server and this
		// project space. So it never consults the deployment record the
		// download paths fall back on — the record describes where the app
		// has been, and this is where it is going.
		attachmentTarget: attachmentUrlTarget({
			server: input.server,
			domain: input.domain,
		}),
		/* A table CommCare HQ manages in this project space is never written
		 * there, so the workbook leaves it out. */
		lookupTarget: target,
	});
	if (!boundary.ok) {
		const details = boundary.violations.map(userFacingError);
		const detail =
			"This app isn't ready to publish yet. Fix the issues below, then try again.";
		checks.push({
			id: "app-readiness",
			title: "App readiness",
			status: "blocked",
			detail,
			items: details,
		});
		return {
			checks,
			outcome: blockedOutcome(input.now, "app_not_ready", detail, details),
			ready: null,
			projectSpaceCompatibility: null,
			conflicts: [],
		};
	}
	checks.push({
		id: "app-readiness",
		title: "App readiness",
		status: "passed",
		detail: "Everything this app needs to compile is in place.",
		items: [],
	});

	/* The app's places and what this publish asks a person to confirm, read
	 * before anything is asked of CommCare HQ, by the helper the pre-publish
	 * check reads too. */
	const { organization, places, placesManagedHere, needed } =
		await publishConfirmationNeeds(
			input.access,
			boundary.prepared.doc,
			{ server: input.server, domain: input.domain },
			boundary.prepared.lookupNaming,
			new Set(
				boundary.prepared.managedLookupTables.map((table) => table.tableId),
			),
		);
	if (placesManagedHere) input.requireHqImport?.();
	const settled = settleConfirmations({
		needed,
		live: input.confirmations,
		confirm: input.confirm,
	});
	if (settled.missing.length > 0) {
		const detail = confirmationNeededMessage(input.domain);
		const items = settled.missing.map((need) => need.label);
		checks.push({
			id: "plan-features",
			title: "What this project space needs",
			status: "blocked",
			detail,
			items,
		});
		return {
			checks,
			outcome: blockedOutcome(
				input.now,
				"hq_confirmation_needed",
				detail,
				items,
			),
			ready: null,
			projectSpaceCompatibility: null,
			conflicts: [],
			confirmationsNeeded: settled.missing,
		};
	}
	checks.push({
		id: "plan-features",
		title: "What this project space needs",
		status: "passed",
		detail:
			needed.length === 0
				? "This app needs nothing of the project space's plan or settings that Nova would ask about."
				: "You confirmed that the project space has everything this app needs from its plan and settings.",
		items: needed.map((need) => need.label),
	});

	// ── 4. Is the data this app reads already on that project space? ─
	// Blocking, and it runs BEFORE anything is sent, because the fixture
	// upload matches tables by tag: pushing without knowing what is there
	// would take over a same-named table somebody else made.
	const files = [
		...(boundary.prepared.lookupWorkbook
			? [boundary.prepared.lookupWorkbook]
			: []),
		...(boundary.prepared.streamedWorkbooks ?? []),
	];
	const workbook = files[0];
	const sentTables = files.flatMap((file) => file.tables);
	const expected = inlineWorkbookReceipts(
		boundary.prepared.lookupSnapshot,
		new Set(
			boundary.prepared.lookupWorkbook?.tables.map((table) => table.tableId) ??
				[],
		),
	);
	const streamChecks = new Map<string, () => Promise<void>>();
	for (const book of boundary.prepared.streamedWorkbooks ?? [])
		for (const [id, receipt] of book.expected) {
			expected.set(id, receipt);
			streamChecks.set(id, book.check);
		}
	let lookupPush: LookupPushPlan | null = null;
	if (workbook !== undefined) {
		/* The `managed-data` edge read the list moments ago where a table
		 * CommCare HQ manages here is among the app's, and what it wrote since
		 * is Nova's own copy, so that answer stands. */
		const hqTables =
			managedHere?.hqTables ?? (await listHqLookupTables(creds, domain));
		if ("success" in hqTables) {
			/* Nova cannot tell its own tables from anybody else's without
			 * this answer, so it does not push. Reading the failure as "the
			 * project space has none" is the one interpretation that turns a
			 * permissions problem into somebody's data being overwritten. */
			const detail = lookupTableListFailureDetail(
				classifyHqFailure(hqTables, "lookup-tables"),
				domain,
			);
			checks.push({
				id: "project-data",
				title: "Project data",
				status: "blocked",
				detail,
				items: [],
			});
			return {
				checks,
				outcome: blockedOutcome(input.now, "hq_resource_state_unknown", detail),
				ready: null,
				projectSpaceCompatibility: null,
				conflicts: [],
			};
		}
		/* The Project's standing with each table on this project space, read
		 * in the same pass as the list: the live mappings of the Project's
		 * other apps, and the tables' own records of CommCare HQ, of which a
		 * takeover from this project space is a person's decision to publish
		 * Nova's copy here. */
		const workbookTableIds = sentTables.map((table) => table.tableId);
		const [siblings, origins] = await Promise.all([
			readSiblingLookupMappings(input.access, target, workbookTableIds),
			readLookupTableOrigins(input.access, workbookTableIds),
		]);
		const originByTableId = new Map(
			origins.map((origin) => [origin.tableId, origin] as const),
		);
		const plan = planLookupResourcePush({
			tables: sentTables,
			intended: expected,
			mappings: input.mappings,
			hqTables,
			adoptTableIds: input.adoptResourceIds,
			siblings,
			takenOver: origins.flatMap((origin) =>
				origin.takenOver !== null &&
				origin.server === input.server &&
				origin.domain === input.domain
					? [
							{
								tableId: origin.tableId,
								remoteId: origin.remoteId,
								at: origin.takenOver.at,
								by: origin.takenOver.by,
							},
						]
					: [],
			),
		});
		/* Named twice over: the tag is what CommCare HQ shows, and the
		 * table's own name is what the author will recognize. The
		 * definitions are the generation the boundary validated, so the
		 * name printed here is the name the workbook was built from. */
		const nameByTableId = new Map(
			boundary.prepared.lookupSnapshot.definitions.map(
				(definition) => [definition.id, definition.name] as const,
			),
		);
		/* Content Nova's push would remove refuses before the drift
		 * comparison and before any conflict, so it never shows a discard or
		 * an adoption offer: neither keeps that content, and a new export tag
		 * settles both. */
		if (!plan.ok && "unsupported" in plan) {
			const lines = plan.unsupported.map(
				(table) =>
					`The table ${nameByTableId.get(table.tableId) ?? table.tag} holds ${describeUnsupportedLookupContent(table.holds)} in CommCare HQ.`,
			);
			checks.push({
				id: "project-data",
				title: "Project data",
				status: "blocked",
				detail: LOOKUP_CONTENT_UNSUPPORTED_MESSAGE,
				items: lines,
			});
			return {
				checks,
				outcome: blockedOutcome(
					input.now,
					"hq_table_content_unsupported",
					LOOKUP_CONTENT_UNSUPPORTED_MESSAGE,
					lines,
				),
				ready: null,
				projectSpaceCompatibility: null,
				conflicts: [],
			};
		}
		if (!plan.ok) {
			const conflicts: readonly DeploymentResourceConflict[] =
				plan.conflicts.map((conflict) => ({
					kind: "lookup-table",
					novaResourceId: conflict.tableId,
					name: nameByTableId.get(conflict.tableId) ?? conflict.tag,
					identity: conflict.tag,
					remoteId: conflict.remoteId,
				}));
			const detail = `“${domain}” already has lookup tables with these names, and Nova didn't make them. Rename the table in Project data, or choose to use the existing one.`;
			checks.push({
				id: "project-data",
				title: "Project data",
				status: "blocked",
				detail,
				items: describeConflicts(conflicts),
			});
			return {
				checks,
				outcome: blockedOutcome(
					input.now,
					"hq_resource_conflict",
					detail,
					describeConflicts(conflicts),
				),
				ready: null,
				projectSpaceCompatibility: null,
				conflicts,
			};
		}
		if (!grant || !checkPublishAccess) return dataAccessLost();
		await withAppTx(checkPublishAccess);
		if (archiveBinding === undefined) return dataAccessLost();
		const authority: WorkbookAuthority = {
			grant,
			connectionDigest: credResult.connectionDigest,
			grantBinding: archiveBinding,
			tables: plannedWorkbookTables(
				boundary.prepared.lookupSnapshot,
				expected,
				boundary.prepared.assignmentWitness,
			),
		};
		const verifiedFiles = new Map<string, string>();
		lookupPush = {
			workbook,
			expected,
			files,
			verifiedFiles,
			pushes: plan.pushes,
			names: nameByTableId,
			authority,
		};

		/* Each table a mapping accounts for under the tag it still plans, the
		 * table there now or the one HQ deleted or renamed since, compared
		 * with the baseline of that HQ table, which the Project's apps share;
		 * and each table a person took over from here, compared with the
		 * table's own record of CommCare HQ's table at its last refresh. A
		 * table this publish adopts is the person's decision to write over
		 * it, so it is not compared. */
		const comparedTables = plan.pushes.flatMap((push) =>
			push.mappedRemoteId === null || push.baseline === null
				? []
				: [{ push, remoteId: push.mappedRemoteId }],
		);
		if (comparedTables.length > 0) {
			compared = true;
			const stored = baselinesByRemoteId(
				await readResourceBaselines(
					input.access,
					target,
					comparedTables.flatMap(({ push, remoteId }) =>
						push.baseline === "mapping"
							? [{ kind: "lookup-table" as const, remoteId }]
							: [],
					),
				),
			);
			const baselineOf = (
				push: PlannedLookupPush,
				remoteId: string,
			): ResourceBaseline | undefined => {
				if (push.baseline !== "table-origin") return stored.get(remoteId);
				const origin = originByTableId.get(push.tableId);
				if (origin === undefined) {
					throw new Error(
						`The lookup table ${push.tableId} was planned as taken over with no origin read.`,
					);
				}
				return baselineFromTableOrigin({
					canonical: origin.canonical,
					remoteId,
					refreshedAt: origin.refreshedAt,
				});
			};
			/* The tables are independent, so their rows are read a few at a
			 * time; the results keep the plan's order, and the first table
			 * that could not be read is the one the refusal names. */
			const found = await mapWithConcurrency(
				comparedTables,
				LOOKUP_ROWS_READ_CONCURRENCY,
				({ push, remoteId }) =>
					lookupRemoteChange({
						creds,
						domain,
						tableId: push.tableId,
						tag: push.tag,
						name: nameByTableId.get(push.tableId) ?? push.tag,
						mappedRemoteId: remoteId,
						hqTables,
						baseline: baselineOf(push, remoteId),
						streamCheck: streamChecks.get(push.tableId),
						checkLargeTarget:
							checkPublishAccess && (() => withAppTx(checkPublishAccess)),
						/* A table Nova manages that came from this project space can be
						 * handed back on its page, which takes the version CommCare HQ
						 * holds here. One that came from another project space would
						 * take that one's, not this change. */
						takeOffer: takeOfferFor(originByTableId.get(push.tableId), input),
					}),
			);
			const unreadable = comparedTables.find(
				(_, index) => found[index] === "unreadable",
			);
			if (unreadable !== undefined) {
				const name =
					nameByTableId.get(unreadable.push.tableId) ?? unreadable.push.tag;
				const detail = `Nova couldn't read the rows of the lookup table “${name}” on “${domain}”, so it can't tell whether they changed in CommCare HQ since its last publish, and it stopped before sending anything. A row there with an empty value can cause this; filling that value in CommCare HQ, or trying again in a moment, lets the next publish read it.`;
				checks.push({
					id: "project-data",
					title: "Project data",
					status: "blocked",
					detail,
					items: [],
				});
				return {
					checks,
					outcome: blockedOutcome(
						input.now,
						"hq_resource_state_unknown",
						detail,
					),
					ready: null,
					projectSpaceCompatibility: null,
					conflicts: [],
				};
			}
			for (const [index, change] of found.entries()) {
				if (change !== null && change !== "unreadable") observed.push(change);
				if (files.length < 2 || change !== null) continue;
				const { push, remoteId } = comparedTables[index];
				const own = input.mappings.some(
					(m) =>
						m.kind === "lookup-table" &&
						m.novaResourceId === push.tableId &&
						m.remoteId === remoteId &&
						m.pushedIdentity === push.tag &&
						!m.supersededAt,
				);
				const baseline = stored.get(remoteId);
				const wanted = expected.get(push.tableId);
				// A read of the HQ row API cannot attest native indexes or owners.
				const definition = boundary.prepared.lookupSnapshot.definitions.find(
					(t) => t.id === push.tableId,
				);
				if (
					own &&
					baseline?.origin === "push" &&
					wanted?.isGlobal &&
					definition &&
					!definition.columns.some((c) => c.index !== undefined) &&
					matchesRecordedLookup(
						baseline.canonical as CanonicalLookupTable,
						wanted,
					)
				)
					verifiedFiles.set(push.tableId, remoteId);
			}
		}
		const leftOut = boundary.prepared.managedLookupTables.map(
			(table) => table.tag,
		);
		checks.push({
			id: "project-data",
			title: "Project data",
			status: "passed",
			detail:
				leftOut.length === 0
					? `Nova will put ${describeTableCount(sentTables.length)} on “${domain}” before sending the app.`
					: `Nova will put ${describeTableCount(sentTables.length)} on “${domain}” before sending the app. ${managedTablesLeftOut(leftOut, domain)}`,
			items: sentTables.map(
				(table) => `${table.tag} (${describeRowCount(table.rowCount)})`,
			),
		});
	}

	// ── 5. Can that project space hold this organization? ───────────
	// Blocking, and everything knowable is decided here. A place push is
	// a batch per level and each batch is atomic, so a tree refused
	// partway has already left places behind; and the site code is a
	// domain-unique identity, so pushing blind would take over a place
	// somebody else made.
	let locationPush: LocationPushPlan | null = null;
	/* The target's own tree can make a reverse owner hop ambiguous in a way
	 * Nova's cannot see. `assertReverseHopTargetsUnambiguous` proves the
	 * invariant over `app_locations`; CommCare HQ builds the fixture from ITS
	 * rows, which may hold places Nova never created. The emitted XPath
	 * selects `@id` from every match, so two of them make owner choice depend
	 * on fixture order — and quietly, since a predicate returning two nodes is
	 * not an error. This is the one moment Nova can see that tree, and the
	 * export boundary lets the rule through precisely because it carries no
	 * Nova identity, so the check belongs here. */
	const ambiguousOwners = (
		ambiguous: ReturnType<typeof ambiguousReverseHopsOnTarget>,
	): PreflightResult => {
		const detail = `A case owner rule needs exactly one place at its chosen level beneath each owner on “${domain}”. Change the rule or the places below these owners, then publish again.`;
		checks.push({
			id: "organization",
			title: "Organization",
			status: "blocked",
			detail,
			items: ambiguous.map((hop) =>
				hop.destinationNames.length
					? `${hop.ownerName} holds both ${hop.destinationNames.join(" and ")} at “${hop.destinationCode}”.`
					: `${hop.ownerName} has no place at “${hop.destinationCode}”.`,
			),
		});
		return {
			checks,
			outcome: blockedOutcome(input.now, "hq_organization_mismatch", detail),
			ready: null,
			projectSpaceCompatibility: null,
			conflicts: [],
		};
	};
	/* Nova cannot tell its own places from anybody else's without both
	 * answers, so a refusal is never read as "there is nothing over there".
	 * Four separate things produce these statuses and two of them are the
	 * same bodyless 403, so the sentence names all of them rather than
	 * picking one and being confidently wrong. */
	const organizationUnreadable = (error: CommCareApiError): PreflightResult => {
		const detail =
			error.status === 401 || error.status === 403
				? `Nova can't read the organization on “${domain}”, so it won't push places over what's there. That project space needs the Organizations and API access features, and your CommCare HQ account needs the Edit Locations and Access APIs permissions. Ask a CommCare HQ administrator for whichever is missing.`
				: error.cause === "too-large"
					? `“${domain}” holds more places than Nova reads from one project space, which is up to ${HQ_LOCATION_INVENTORY_MAX_ROWS.toLocaleString("en-US")} places, so Nova stopped rather than push places into a list it can't read whole. You can publish this app to another project space.`
					: `Nova couldn't ask “${domain}” about its organization, so it stopped rather than push places into it. Try publishing again in a moment.`;
		checks.push({
			id: "organization",
			title: "Organization",
			status: "blocked",
			detail,
			items: [],
		});
		return {
			checks,
			outcome: blockedOutcome(input.now, "hq_resource_state_unknown", detail),
			ready: null,
			projectSpaceCompatibility: null,
			conflicts: [],
		};
	};
	/* Places CommCare HQ manages from this project space are never pushed
	 * there. The edge still reads its places: an owner rule that picks a
	 * place beneath the case owner is judged on that project space's tree,
	 * and the read refreshes Nova's copy, which Preview shows. A copy that
	 * cannot be refreshed stops nothing, and the check's item is why. */
	const organizationMismatch = (
		detail: string,
		items: readonly string[] = [],
	): PreflightResult => {
		checks.push({
			id: "organization",
			title: "Organization",
			status: "blocked",
			detail,
			items,
		});
		return {
			checks,
			outcome: blockedOutcome(
				input.now,
				"hq_organization_mismatch",
				detail,
				items,
			),
			ready: null,
			projectSpaceCompatibility: null,
			conflicts: [],
		};
	};
	const expectedLevels = levelsAsPublished(boundary.prepared.doc);
	const readAt = new Date();
	const inventory =
		expectedLevels.length > 0
			? await readHqPlaceInventory(creds, domain)
			: null;
	if (inventory?.kind === "failed")
		return organizationUnreadable(inventory.error);
	if (inventory?.kind === "inconsistent")
		return organizationMismatch(
			`The two place lists on “${domain}” disagreed when Nova checked again. Check the levels and parent places there, then publish again.`,
		);
	if (inventory?.kind === "read") {
		const remoteLevels = new Map(
			inventory.levels.map((level) => [level.code, level]),
		);
		const items = expectedLevels.flatMap((level) => {
			const remote = remoteLevels.get(level.code);
			if (!remote) return [`Add “${level.name}” with code “${level.code}”.`];
			const differences = [
				remote.name !== level.name ? `display name “${level.name}”` : null,
				remote.parentCode !== level.parentCode
					? level.parentCode === null
						? "top level"
						: `parent level “${level.parentCode}”`
					: null,
				remote.sharesCases !== level.sharesCases
					? `case sharing ${level.sharesCases ? "on" : "off"}`
					: null,
				remote.viewDescendants !== level.viewDescendants
					? `view descendants ${level.viewDescendants ? "on" : "off"}`
					: null,
				Object.values(boundary.prepared.doc.organizationLevels ?? {}).some(
					(item) => item.code === level.code && item.tracksStock !== undefined,
				) && remote.administrative !== level.administrative
					? `stock tracking ${level.administrative ? "off" : "on"}`
					: null,
			].filter(Boolean);
			return differences.length
				? [`Set “${level.code}” to use ${differences.join(", ")}.`]
				: [];
		});
		if (items.length)
			return organizationMismatch(
				`Check the organization levels on “${domain}”. These settings affect the places and cases workers receive.`,
				items,
			);
	}
	if (placesManagedHere && inventory?.kind === "read") {
		const ambiguous = ambiguousReverseHopsOnTarget(
			authoredReverseHops(boundary.prepared.doc),
			inventory.places,
		);
		if (ambiguous.length) return ambiguousOwners(ambiguous);
		const refreshed = await refreshManagedPlacesFromRead(
			input.access,
			{ server: target.server, domain },
			inventory.places,
			readAt,
		);
		if (!refreshed.ok) return organizationMismatch(refreshed.message);
		checks.push({
			id: "organization",
			title: "Organization",
			status: "passed",
			detail: managedPlacesPassed(domain, true),
			items: [],
		});
	}
	if (places.length > 0 && inventory?.kind === "read") {
		const { levels: hqLevels, places: hqPlaces } = inventory;
		if (
			organization.hq &&
			organization.locations.some(
				(place) => place.archivedAt === null && !place.source,
			)
		)
			return organizationMismatch(
				`These places came from “${organization.hq.domain}” before Nova could read their external IDs. Refresh places from that space in Organization, then publish again.`,
			);
		const plan = planLocationResourcePush({
			places,
			mappings: input.mappings,
			hqLevels,
			hqPlaces,
			appModelsPlaceInformation:
				Object.keys(locationPropertiesOf(boundary.prepared.doc)).length > 0,
			adoptLocationUuids: input.adoptResourceIds,
		});
		if (!plan.ok && plan.reason === "unpushable") {
			const items = plan.problems.map(describePlaceProblem);
			const detail = `CommCare HQ won't take some of these places as they stand. Change them in Organization, or set up the matching levels on “${domain}”, then publish again.`;
			checks.push({
				id: "organization",
				title: "Organization",
				status: "blocked",
				detail,
				items,
			});
			return {
				checks,
				outcome: blockedOutcome(
					input.now,
					"hq_organization_mismatch",
					detail,
					items,
				),
				ready: null,
				projectSpaceCompatibility: null,
				conflicts: [],
			};
		}
		if (!plan.ok) {
			const conflicts: readonly DeploymentResourceConflict[] =
				plan.conflicts.map((conflict) => ({
					kind: "location",
					novaResourceId: conflict.locationUuid,
					name: conflict.name,
					identity: conflict.siteCode,
					remoteId: conflict.remoteId,
				}));
			const items = plan.conflicts.map(
				(conflict) =>
					`${conflict.name} (${conflict.siteCode}), which “${domain}” calls ${conflict.remoteName}`,
			);
			const detail = `“${domain}” already has places with these site codes, and Nova didn't make them. Choose to use the existing places, or remove these from Organization and add them again with codes that are free.`;
			checks.push({
				id: "organization",
				title: "Organization",
				status: "blocked",
				detail,
				items,
			});
			return {
				checks,
				outcome: blockedOutcome(
					input.now,
					"hq_resource_conflict",
					detail,
					items,
				),
				ready: null,
				projectSpaceCompatibility: null,
				conflicts,
			};
		}
		const byLocalId = new Map(
			places.map((place) => [place.locationUuid, place]),
		);
		const pending = new Map<string, PlaceIdUpdate>();
		for (const batch of plan.batches)
			for (const push of batch) {
				if (push.externalId === undefined) continue;
				const existing = push.current?.observation;
				if (
					push.remoteId &&
					(existing?.externalId != null || push.externalId !== null)
				) {
					const detail = await readHqPlaceExternalId(
						creds,
						domain,
						push.remoteId,
					);
					if ("success" in detail) return organizationUnreadable(detail);
					if (
						detail.siteCode !== push.current?.siteCode ||
						detail.externalId !== existing?.externalId
					)
						return organizationMismatch(
							"The destination changed while Nova checked its place IDs. Publish again to read the current places.",
						);
				}
				if (push.externalId === (existing?.externalId ?? null)) continue;
				const parent =
					push.parentLocationUuid && byLocalId.get(push.parentLocationUuid);
				// In the first phase the v2 writer puts the hierarchy in place but
				// leaves destination metadata intact. Stage rich source metadata
				// only after the native workbook has set the ID.
				pending.set(push.locationUuid, {
					externalId: push.externalId,
					parentCode: parent ? parent.siteCode : null,
					place: {
						locationId: push.remoteId ?? "",
						name: push.name,
						siteCode: push.siteCode,
						locationTypeCode: push.levelCode,
						parentLocationId: null,
						latitude: push.latitude,
						longitude: push.longitude,
						values: push.current?.values ?? {},
						observation: {
							nameIsNull: push.source?.nameIsNull ?? false,
							externalId: existing?.externalId ?? null,
							wire: existing?.wire ?? {},
							worker: existing?.worker ?? {},
						},
					},
				});
			}
		if (pending.size) {
			// Validate every planned member before the first resource write.
			// The eventual download re-reads the assigned destination IDs and
			// current data under its own actor, target and export grant.
			try {
				placeIdWorkbookMembers(domain, hqLevels, [...pending.values()]);
			} catch (error) {
				if (error instanceof PlaceWorkbookMismatch)
					return organizationMismatch(error.message);
				throw error;
			}
		}
		const after = projectedTargetTree(hqPlaces, plan.batches);
		const ambiguous = ambiguousReverseHopsOnTarget(
			authoredReverseHops(boundary.prepared.doc),
			after,
		);
		if (ambiguous.length) return ambiguousOwners(ambiguous);
		locationPush = {
			batches: plan.batches.map((batch) =>
				batch.map((push) => {
					if (!pending.has(push.locationUuid)) return push;
					const stagedWire = push.current?.observation?.wire ?? {};
					return {
						...push,
						rawData: undefined,
						locationData: null,
						desiredWire: stagedWire,
						stagedWire,
						ownedKeys: Object.keys(stagedWire),
					};
				}),
			),
			placeCount: places.length,
			organizationRevision: organization.revision,
		};

		/* Each planned place with a live mapping, by the mapping's id. A
		 * mapped place the read no longer lists is `missing` whatever the
		 * push plans in its stead. */
		const mappingByPlace = new Map(
			input.mappings
				.filter((resource) => resource.kind === "location")
				.map((resource) => [resource.novaResourceId, resource] as const),
		);
		const comparedPlaces = plan.batches.flat().flatMap((push) => {
			const mapping = mappingByPlace.get(push.locationUuid);
			return mapping === undefined
				? []
				: [{ push, remoteId: mapping.remoteId }];
		});
		if (comparedPlaces.length > 0) {
			compared = true;
			const baselines = baselinesByRemoteId(
				await readResourceBaselines(
					input.access,
					target,
					comparedPlaces.map(({ remoteId }) => ({
						kind: "location",
						remoteId,
					})),
				),
			);
			const placeById = new Map(
				hqPlaces.map((place) => [place.locationId, place] as const),
			);
			for (const { push, remoteId } of comparedPlaces) {
				const change = placeRemoteChange({
					push,
					current: placeById.get(remoteId) ?? null,
					baseline: baselines.get(remoteId),
				});
				if (change !== null) observed.push(change);
			}
		}
		checks.push({
			id: "organization",
			title: "Organization",
			status: "passed",
			detail: pending.size
				? `Nova will prepare the places on “${domain}”. Apply the place ID workbook there before sending the app.`
				: `Nova will put ${describePlaceCount(places.length)} on “${domain}” before sending the app, parents first.`,
			items: pending.size
				? [...pending.values()].map(
						({ place }) =>
							`${place.name || place.siteCode} (${place.siteCode})`,
					)
				: describePlacesByLevel(places),
		});
	}

	// ── 6. Can this project space run what the app uses? ────────────
	// This is the authoritative publish-time check. A prior dialog or MCP read
	// is disclosure, not reusable authority: the target can change between that
	// read and this publish. Required support that is missing or unverified
	// stops here, before the first lookup table, place, or app write. Advisory
	// support never stops the publish; it only decides whether Nova includes its
	// derived large-Search optimization in the target app profile.
	const compatibilityPlan = projectSpaceCompatibilityProbePlan(
		boundary.prepared.doc,
	);
	/* The empty-list text flag rides the same project-space read. Its answer
	 * changes no verdict here; the publish only stores it. */
	const compatibilityProbes = await probeHqProjectSpaceCompatibility(
		creds,
		domain,
		compatibilityPlan,
		{ readEmptyCaseListText: true },
	);
	const projectSpaceCompatibility = compatibilityProbes.report;
	const unavailableAdvisories = projectSpaceCompatibility.advisories.filter(
		(advisory) => advisory.state !== "available",
	);
	checks.push({
		id: "project-space-compatibility",
		title: "Project-space compatibility",
		status:
			projectSpaceCompatibility.status === "blocked"
				? "blocked"
				: unavailableAdvisories.length > 0
					? "attention"
					: "passed",
		detail: projectSpaceCompatibility.message,
		items:
			projectSpaceCompatibility.status === "blocked"
				? projectSpaceCompatibility.blockers.map(
						(blocker) => `${blocker.label}: ${blocker.description}`,
					)
				: unavailableAdvisories.map(
						(advisory) => `${advisory.title}: ${advisory.message}`,
					),
	});
	if (projectSpaceCompatibility.status === "blocked") {
		return {
			checks,
			outcome: blockedOutcome(
				input.now,
				"project_space_incompatible",
				projectSpaceCompatibility.message,
				projectSpaceCompatibility.blockers.map(
					(blocker) => `${blocker.label}: ${blocker.description}`,
				),
			),
			ready: null,
			projectSpaceCompatibility,
			conflicts: [],
		};
	}

	// ── 7. Is the app this publish updates still Nova's, and there? ──
	// Blocking, and read before any table, place or content is written. A
	// gone app is created afresh by the next publish; an app Nova did not
	// make is never written over. Absent on a first publish, which creates
	// the app and reads it then.
	let targetApp: {
		readonly appId: string;
		readonly source: HqAppSource;
		readonly normalized: unknown;
		readonly sourceDigest: string;
		readonly saveCounter: number;
	} | null = null;
	let appBaseline: AppBaseline | null = null;
	let media: {
		readonly paths: readonly HqMediaPath[];
		readonly learned: HqMediaRecord;
	} | null = null;
	if (input.inPlaceUpdate !== null) {
		const appId = input.inPlaceUpdate.remoteId;
		/* A baseline of another HQ app than the one mapped now says nothing
		 * about this one, so it reads as no baseline at all. */
		const stored = await readAppBaseline(input.access, target);
		appBaseline = stored?.remoteAppId === appId ? stored : null;

		/* The save counter just before the source, so the import's
		 * acknowledgement says whether a save fell between this read and the
		 * import. A media job of an earlier publish that HQ has finished is
		 * settled first, so its save is not taken for one. */
		await settleFinishedMediaJobs(creds, {
			server: input.server,
			domain,
			remoteAppId: appId,
		});
		const saveCounter = await readHqAppSaveCounter(creds, domain, appId);
		const read = await readHqAppSource(creds, domain, appId);
		if ("success" in read || read.kind !== "source") {
			const gone = !("success" in read) && read.kind === "gone";
			const failure = gone
				? remoteAppMissingFailure(domain)
				: hqAppSourceReadFailure(read, domain, false);
			checks.push({
				id: "target-app",
				title: "App on CommCare HQ",
				status: "blocked",
				detail: failure.message,
				items: [],
			});
			return {
				checks,
				outcome: blockedOutcome(input.now, failure.code, failure.message),
				ready: null,
				projectSpaceCompatibility,
				conflicts: [],
				...(gone && { remoteAppGone: input.inPlaceUpdate }),
			};
		}
		const normalized = normalizeHqAppSource(read.source.raw);
		if ("malformed" in normalized) {
			const failure = hqAppSourceReadFailure(
				{ success: false, status: 502, cause: "malformed" },
				domain,
				false,
			);
			checks.push({
				id: "target-app",
				title: "App on CommCare HQ",
				status: "blocked",
				detail: failure.message,
				items: [],
			});
			return {
				checks,
				outcome: blockedOutcome(input.now, failure.code, failure.message),
				ready: null,
				projectSpaceCompatibility,
				conflicts: [],
			};
		}
		/* The floor reads this read, the publish's first of an app that is
		 * there, and no later one: a stop after the tables and places are
		 * pushed could not come before the first write of Project data. */
		const floor = compareToVersionFloor(read.source.buildSpecVersion);
		if (floor !== "at-or-above") {
			const failure =
				floor === "below"
					? versionBelowFloorFailure(
							domain,
							read.source.buildSpecVersion,
							false,
						)
					: hqAppSourceReadFailure(
							{ success: false, status: 502, cause: "malformed" },
							domain,
							false,
						);
			checks.push({
				id: "target-app",
				title: "App on CommCare HQ",
				status: "blocked",
				detail: failure.message,
				items: [],
			});
			return {
				checks,
				outcome: blockedOutcome(input.now, failure.code, failure.message),
				ready: null,
				projectSpaceCompatibility,
				conflicts: [],
			};
		}
		if (typeof saveCounter !== "number") {
			const failure = hqAppSourceReadFailure(saveCounter, domain, false);
			checks.push({
				id: "target-app",
				title: "App on CommCare HQ",
				status: "blocked",
				detail: failure.message,
				items: [],
			});
			return {
				checks,
				outcome: blockedOutcome(input.now, failure.code, failure.message),
				ready: null,
				projectSpaceCompatibility,
				conflicts: [],
			};
		}
		targetApp = {
			appId,
			source: read.source,
			normalized: normalized.normalized,
			sourceDigest: normalized.digest,
			saveCounter,
		};

		/* The file at each path this publish sends, against the one Nova
		 * recorded there, by id; a path the id alone cannot vouch for is
		 * settled by the file's content. An earlier attempt may have left a shell on which a person
		 * has since saved a file. The upload can replace it, so every file a person
		 * replaced stops the publish here, before anything is sent. */
		const published = publishedMediaFiles(
			bulkUploadAssets(boundary.prepared.doc, boundary.prepared.assets),
		);
		{
			const map = read.source.multimediaMap;
			/* CommCare HQ serializes the map on every app, so a read without
			 * one is an answer Nova cannot read, and no file is sent over it. */
			if (map === null) {
				const failure = hqAppSourceReadFailure(
					{ success: false, status: 502, cause: "malformed" },
					domain,
					false,
				);
				checks.push({
					id: "target-app",
					title: "App on CommCare HQ",
					status: "blocked",
					detail: failure.message,
					items: [],
				});
				return {
					checks,
					outcome: blockedOutcome(input.now, failure.code, failure.message),
					ready: null,
					projectSpaceCompatibility,
					conflicts: [],
				};
			}
			const standings = hqMediaStandings({
				published,
				record: appBaseline?.mediaFiles ?? null,
				now: map ?? [],
			});
			if (
				standings.some(
					(path) => path.standing === "moved" || path.standing === "unrecorded",
				)
			) {
				const settled = await settleHqMedia(creds, standings, {});
				if (settled.kind === "failed") {
					const failure = hqMediaReadFailure(domain);
					checks.push({
						id: "target-app",
						title: "App on CommCare HQ",
						status: "blocked",
						detail: failure.message,
						items: [],
					});
					return {
						checks,
						outcome: blockedOutcome(input.now, failure.code, failure.message),
						ready: null,
						projectSpaceCompatibility,
						conflicts: [],
					};
				}
				media = { paths: settled.paths, learned: settled.learned };
			} else {
				media = { paths: standings, learned: {} };
			}
		}

		compared = true;
		// The historical cutover saved the live HQ source beside the Nova revision.
		// It could accept an existing language that the Nova revision did not hold,
		// so comparing HQ to that same saved source alone cannot disclose its loss.
		const emittedLanguages = publishedLanguageCodes(boundary.prepared.doc);
		const legacyLanguagesRemoved =
			appBaseline?.origin === "cutover"
				? read.source.langs.filter((code) => !emittedLanguages.includes(code))
				: [];
		const change = appRemoteChange({
			legacyLanguageRemoval:
				legacyLanguagesRemoved.length > 0
					? `Publishing would remove ${legacyLanguagesRemoved.map(buildProfileLanguageLabel).join(", ")} from this app in CommCare HQ.`
					: undefined,
			authority: appConfirmationScope(
				input.access,
				target,
				input.inPlaceUpdate,
				input.compiledAtSeq,
				saveCounter,
				appBaseline,
			),
			discards: input.discardRemoteChanges,
			replacesUnownedAndroidRequirements: changesUnownedAndroidApps(
				read.source.profile.features,
				input.doc.appSettings.requiredAndroidApps,
			),
			locationChange:
				input.doc.connectType === null &&
				!(
					appBaseline &&
					appBaseline.origin !== "unread" &&
					appBaseline.ownership.autoGpsCapture
				) &&
				sourceCapturesLocation(read.source.raw) !==
					(input.doc.appSettings.captureLocation === true)
					? input.doc.appSettings.captureLocation
						? "Automatic location for every form will change from off to on"
						: "Automatic location for every form will change from on to off"
					: undefined,
			appName: input.doc.appName,
			novaAppId: input.access.appId,
			remoteAppId: appId,
			current: normalized,
			published,
			baseline: appBaseline,
			since: driftReferenceOf(appBaseline, input.inPlaceUpdate),
			languageNames: input.languageNames,
			mediaChanged:
				media?.paths.filter((path) => path.standing === "replaced").length ?? 0,
			canBringIn: usablePair(
				appBaseline,
				input.inPlaceUpdate,
				await greatestFoldBaselineSeq(await getAppDb(), input.access.appId),
			),
		});
		if (change !== null) observed.push(change);
		checks.push({
			id: "target-app",
			title: "App on CommCare HQ",
			status: "passed",
			detail: `Nova read the app on “${domain}” and will update it in place.`,
			items: [],
		});
	}

	// ── 8. Has anything this app publishes changed in CommCare HQ? ──
	// The one verdict over every change the edges above collected. All or
	// nothing, like a name clash: one change nobody chose to publish over
	// stops the whole publish, before anything is written.
	const verdict = decideRemoteChanges({
		observed,
		discards: input.discardRemoteChanges,
	});
	if (!verdict.proceed) {
		const items = verdict.remoteChanges.map((change) => change.name);
		const message = hqChangedMessage(verdict.remoteChanges, input.driftDate);
		checks.push({
			id: "hq-changes",
			title: "Changes in CommCare HQ",
			status: "blocked",
			detail: message,
			items,
		});
		return {
			checks,
			outcome: blockedOutcome(input.now, "hq_changed", message, items),
			ready: null,
			projectSpaceCompatibility,
			conflicts: [],
			remoteChanges: verdict.remoteChanges,
		};
	}
	/* The two details name what the app was compared against where it was
	 * compared; a table's and a place's are always a publish's. */
	const since =
		targetApp === null
			? ({ kind: "published" } as const)
			: driftReferenceOf(appBaseline, input.inPlaceUpdate);
	checks.push({
		id: "hq-changes",
		title: "Changes in CommCare HQ",
		status: "passed",
		detail:
			verdict.confirmed.length > 0
				? hqChangesConfirmedDetail(since, input.driftDate)
				: compared
					? hqChangesNoneDetail(since, input.driftDate)
					: HQ_CHANGES_NOTHING_TO_COMPARE_DETAIL,
		items: verdict.confirmed.map((change) => change.name),
	});

	// ── 8a. Does a build profile name a language the app lacks? ────────
	// Blocking, and only where step 7 read an app. No API key can change a
	// build profile, so a profile this publish would leave naming a language
	// the app does not have stops it here, before any write. After
	// `hq-changes`, because a language a profile names may have been added
	// in CommCare HQ since Nova's last push: the person decides on that
	// change first, and a publish over it takes the language out of `langs`.
	// It stops whatever the plan: no API key reads whether the plan still
	// includes application profiles, and HQ keeps a profile on a plan
	// without them and builds it again the day the plan includes them. So
	// the refusal names the way out that works on any plan, where there is
	// one.
	if (targetApp !== null) {
		const gaps = buildProfileLanguageGaps(
			publishedLanguageCodes(input.doc),
			targetApp.source.buildProfiles,
		);
		if (gaps.length > 0) {
			const failure = buildProfileLanguageFailure(domain, gaps, {
				duringPush: false,
				hqLangs: targetApp.source.langs,
			});
			checks.push({
				id: "build-profiles",
				title: "Application profiles",
				status: "blocked",
				detail: failure.message,
				items: failure.details,
			});
			return {
				checks,
				outcome: blockedOutcome(
					input.now,
					failure.code,
					failure.message,
					failure.details,
				),
				ready: null,
				projectSpaceCompatibility,
				conflicts: [],
			};
		}
		checks.push({
			id: "build-profiles",
			title: "Application profiles",
			status: "passed",
			detail: `No application profile of the app on “${domain}” includes a language this app doesn't have.`,
			items: [],
		});
	}

	// ── 8b. Does the app's Web App setting on HQ match where it runs? ──
	// Blocking, after `hq-changes` because a person decides a drift discard
	// over the app first, and before every write. It asks CommCare HQ
	// nothing more: the read it judges is step 7's. A first publish, or the
	// recreate after HQ reported the app gone, has no target app yet, and
	// its fill writes the declaration.
	if (targetApp === null) {
		checks.push({
			id: "web-apps",
			title: "Web Apps",
			status: "passed",
			detail: webAppsCheckNoContentDetail(domain),
			items: [],
		});
	} else {
		const declares = declaresWebApps(boundary.prepared.doc);
		const held = targetApp.source.cloudcareEnabled;
		const change = webAppsChange({
			declaresWebApps: declares,
			held,
			baseline: appBaseline,
			confirmWebApps: input.confirmWebApps,
			since: driftReferenceOf(appBaseline, input.inPlaceUpdate),
		});
		if (change !== null) {
			const detail = webAppsChangeMessage(domain, change, input.driftDate);
			checks.push({
				id: "web-apps",
				title: "Web Apps",
				status: "blocked",
				detail,
				items: [],
			});
			return {
				checks,
				outcome: blockedOutcome(input.now, "hq_web_apps_change", detail),
				ready: null,
				projectSpaceCompatibility,
				conflicts: [],
				webAppsChange: change,
			};
		}
		checks.push({
			id: "web-apps",
			title: "Web Apps",
			status: "passed",
			detail:
				appBaseline?.origin === "create"
					? webAppsCheckNoContentDetail(domain)
					: held === declares
						? webAppsCheckMatchesDetail(domain)
						: webAppsCheckAnsweredDetail(domain, declares),
			items: [],
		});
	}

	// ── 9. Will the workers you create there have what they need? ───
	// Attention rather than blocking: a publish creates no workers, so
	// refusing it over a gap would refuse a publish that would have
	// worked. The same gap IS blocking on the call that provisions
	// workers, and both readings come from one function
	// (`workerProvisionPlan.ts::requiredWorkerDataGaps`) so the warning
	// here and the refusal there can never name different personas.
	const workerGaps = describeRequiredWorkerDataGaps(boundary.prepared.doc);
	checks.push({
		id: "required-worker-data",
		title: "Required worker information",
		status: workerGaps.length === 0 ? "passed" : "attention",
		detail:
			workerGaps.length === 0
				? "Every persona has a value for the worker information marked required."
				: "CommCare HQ won't let you save a worker without these, so publishing works but provisioning these personas won't. Fill them in on the persona, or give the role a default.",
		items: workerGaps,
	});

	// A restored worker record is not observable through the API key. The
	// plan half (user cases) is a confirmation of `plan-features`; this edge
	// keeps the device half.
	const workerRecordForms = formsUsingWorkerRecord(boundary.prepared.doc);
	checks.push({
		id: "worker-record-access",
		title: workerRecordSetup.title,
		status: workerRecordForms.length === 0 ? "passed" : "attention",
		detail:
			workerRecordForms.length === 0
				? "No form in this app reads or saves to the worker's own record."
				: `${workerRecordSetup.detail} ${workerRecordSetup.consequences}`,
		items: workerRecordForms.map((form) => form.name),
	});

	return {
		checks,
		outcome: { status: "succeeded", at: input.now },
		ready: {
			creds,
			domain,
			prepared: boundary.prepared,
			lookupPush,
			locationPush,
			organization,
			targetApp,
			appBaseline,
			confirmedChanges: verdict.confirmed,
			media,
			targetEmptyCaseListText: compatibilityProbes.emptyCaseListText,
			confirmations: settled.accepted,
		},
		projectSpaceCompatibility,
	};
}

/**
 * Whether Let CommCare HQ manage it again, on the table's page, would take
 * the table this publish compares: the table is managed in Nova, and it came
 * from the project space this publish writes to. The hand-back reads the
 * project space the table came from, so for a table taken over from another
 * one it would take that space's version, not this one's.
 */
function takeOfferFor(
	origin: LookupTableOriginRead | undefined,
	target: { readonly server: string; readonly domain: string },
): string | null {
	/* A Nova table a publish put here is mapped to the table here, so Use
	 * the table from CommCare HQ on its page takes this version. */
	if (origin === undefined) return USE_HQ_TABLE_OFFERED;
	return origin.managedBy === "nova" &&
		origin.server === target.server &&
		origin.domain === target.domain
		? HAND_BACK_OFFERED
		: null;
}

/**
 * The `managed-data` edge, or null where no table the app reads is managed
 * in CommCare HQ. It reads those tables again and refreshes Nova's copy
 * (`managedData.ts::reReadManagedTablesForPublish`), and stops where one
 * managed in the target changed in a way the app depends on, or could not be
 * read: Nova cannot tell then whether the app's content would read what is
 * gone.
 */
async function managedDataEdge(
	input: PreflightInput,
	creds: CommCareCredentials,
	domain: string,
	checkAccess: (() => Promise<void>) | undefined,
): Promise<{
	readonly check: PreflightCheck;
	readonly failure: DeploymentFailure | null;
	/** The target's table list where this edge read it, for `project-data` to reuse. */
	readonly hqTables: readonly HqLookupTable[] | null;
} | null> {
	const { tableIds } = extractLookupReferenceTargets(input.doc);
	if (tableIds.length === 0) return null;
	const { definitions } = await getLookupDefinitions(
		{
			projectId: input.access.projectId,
			actorId: input.access.actorUserId,
			role: input.access.role,
		},
		tableIds,
	);
	const managed = definitions.filter(
		(definition) => definition.hq?.managedBy === "commcare-hq",
	);
	if (managed.length === 0) return null;
	const title = "Data managed in CommCare HQ";
	const reRead = await reReadManagedTablesForPublish({
		requireHqImport: input.requireHqImport,
		access: input.access,
		doc: input.doc,
		target: { server: input.server, domain: input.domain },
		creds,
		...(checkAccess && { checkAccess }),
	});
	const blocked = (
		failure: DeploymentFailure,
	): {
		check: PreflightCheck;
		failure: DeploymentFailure;
		hqTables: null;
	} => ({
		check: {
			id: "managed-data",
			title,
			status: "blocked",
			detail: failure.message,
			items: failure.details,
		},
		failure,
		hqTables: null,
	});
	if ("unreadable" in reRead) {
		const message = isAccountRefusal(reRead.unreadable)
			? managedDataUnreadablePermission(domain)
			: reRead.rows !== null && reRead.unreadable.kind === "hq-unavailable"
				? managedTableRowsUnreadable(reRead.rows, domain)
				: managedDataUnreadable(domain);
		return blocked({
			code: "hq_resource_state_unknown",
			message,
			details: [],
		});
	}
	if (reRead.blocking.length > 0) {
		return blocked({
			code: "hq_managed_data_changed",
			message: MANAGED_DATA_CHANGED,
			details: reRead.blocking.flatMap((table) =>
				table.changes.map((change) =>
					managedTableChangeItem(table.tag, change),
				),
			),
		});
	}
	/* A table the target manages is left out of the workbook; one another
	 * project space manages goes in from Nova's copy, so its item says so:
	 * as it was last refreshed where that space could not be read, and as it
	 * is now where it could. */
	const staleByTag = new Map(reRead.stale.map((table) => [table.tag, table]));
	const here = managed.filter(
		(definition) =>
			definition.hq?.server === input.server &&
			definition.hq.domain === input.domain,
	);
	return {
		check: {
			id: "managed-data",
			title,
			status: "passed",
			detail: managedDataPassed({
				domain,
				here: here.length,
				elsewhere: managed.length - here.length,
			}),
			items: managed.map((definition) => {
				const origin = definition.hq;
				if (origin === undefined || here.includes(definition)) {
					return definition.tag;
				}
				const stale = staleByTag.get(definition.tag);
				return stale === undefined
					? managedTableFromElsewhereCurrentItem(
							definition.tag,
							origin.domain,
							domain,
						)
					: managedTableFromElsewhereItem(
							stale.tag,
							stale.domain,
							driftDate(stale.refreshedAt, input.driftDate),
							domain,
						);
			}),
		},
		failure: null,
		hqTables: reRead.hqTables,
	};
}

function baselinesByRemoteId(
	baselines: readonly ResourceBaseline[],
): ReadonlyMap<string, ResourceBaseline> {
	return new Map(
		baselines.map((baseline) => [baseline.remoteId, baseline] as const),
	);
}

/**
 * One mapped table's change since its baseline, in the comparison's order:
 * where the table is (needs no baseline), then its definition, then its
 * rows, which are read only when the definition is unchanged, since HQ's
 * rows read fails after its table editor adds a column. `"unreadable"`
 * when the rows read failed.
 */
async function lookupRemoteChange(input: {
	readonly creds: CommCareCredentials;
	readonly domain: string;
	readonly streamCheck?: () => Promise<void>;
	readonly checkLargeTarget?: () => Promise<void>;
	readonly tableId: string;
	readonly tag: string;
	readonly name: string;
	readonly mappedRemoteId: string;
	readonly hqTables: readonly HqLookupTable[];
	readonly baseline: ResourceBaseline | undefined;
	/**
	 * The sentence naming the action on the table's page that takes the
	 * table CommCare HQ holds here under the tag, said last on a change to
	 * that table: Let CommCare HQ manage it again, for a table managed in
	 * Nova that came from this project space, and Use the table from
	 * CommCare HQ, for a table made in Nova. Null where neither takes this
	 * version. A deleted or renamed table leaves nothing under the tag to
	 * take, so neither says it.
	 */
	readonly takeOffer: string | null;
}): Promise<DeploymentRemoteChange | null | "unreadable"> {
	/* A discard of a change to the table HQ still holds under this tag and
	 * id replaces that table, so it carries the note; a deleted table is gone
	 * and a renamed one is left alone, so theirs carry none. */
	const withHandBack = (parts: readonly string[]): readonly string[] =>
		input.takeOffer === null ? parts : [...parts, input.takeOffer];
	const change = (
		parts: readonly string[],
		observedDigest: string,
		baselineKnown: boolean,
		note: string | null = LOOKUP_DISCARD_NOTE,
	): DeploymentRemoteChange => ({
		kind: "lookup-table",
		novaResourceId: input.tableId,
		name: input.name,
		identity: input.tag,
		parts,
		note,
		observedDigest,
		baselineKnown,
		since: { kind: "published" },
		canBringIn: false,
	});
	const describe = (part: Parameters<typeof describeLookupChange>[0]) =>
		describeLookupChange(part, input.tag);
	const moved = lookupIdentityChange({
		mappedRemoteId: input.mappedRemoteId,
		tag: input.tag,
		tables: input.hqTables,
	});
	if (moved?.kind === "deleted") {
		return change([describe(moved)], ABSENT_RESOURCE_DIGEST, true, null);
	}
	if (moved?.kind === "renamed") {
		const renamed = input.hqTables.find(
			(table) => table.id === input.mappedRemoteId,
		);
		if (renamed === undefined) {
			throw new Error(
				`The lookup table ${input.mappedRemoteId} read as renamed is not in the list it was read from.`,
			);
		}
		return change(
			[describe(moved)],
			lookupDefinitionDigest(renamed),
			true,
			null,
		);
	}
	/* The planner pushes over a table under this tag only when it is the
	 * mapped one, so the table here has the mapped id. */
	const current = input.hqTables.find((table) => table.tag === input.tag);
	if (current === undefined || current.id !== input.mappedRemoteId) {
		throw new Error(
			`The lookup table under “${input.tag}” is not the mapped table ${input.mappedRemoteId} the plan compared.`,
		);
	}
	const { baseline } = input;
	if (baseline === undefined || baseline.origin === "unread") {
		return change(withHandBack([]), lookupDefinitionDigest(current), false);
	}
	const canonical = baseline.canonical as CanonicalLookupTable;
	const definition = lookupDefinitionChange(canonical, current);
	if (definition.length > 0) {
		return change(
			withHandBack(definition.map(describe)),
			lookupDefinitionDigest(current),
			true,
		);
	}
	if (input.streamCheck) {
		const seen = await observeLargeLookup(
			input.creds,
			input.domain,
			current,
			input.streamCheck,
		);
		if (!("canonical" in seen)) return "unreadable";
		return seen.canonical.digest === canonical.digest
			? null
			: change(
					withHandBack([describe({ kind: "rows" })]),
					seen.canonical.digest,
					true,
				);
	}
	const rows = await readSelectedHqLookupRows(
		input.creds,
		input.domain,
		current,
		{
			maxRows: HQ_LOOKUP_INLINE_READ_MAX_ROWS,
			maxBytes: HQ_LOOKUP_TABLE_ROWS_MAX_BYTES,
		},
	);
	if ("success" in rows) return "unreadable";
	// A small local replacement can target a large or recently grown native
	// table. Its size alone cannot authorize erasing a changing row set.
	if ("kind" in rows) {
		if (!input.checkLargeTarget) return "unreadable";
		const seen = await observeLargeLookup(
			input.creds,
			input.domain,
			current,
			input.checkLargeTarget,
		);
		if (!("canonical" in seen)) return "unreadable";
		return seen.canonical.digest === canonical.digest
			? null
			: change(
					withHandBack([describe({ kind: "rows" })]),
					seen.canonical.digest,
					true,
				);
	}
	const changed = lookupRowsChange(canonical, rows);
	return changed.length === 0
		? null
		: change(
				withHandBack(changed.map(describe)),
				canonicalLookupTable(current, rows.rows).digest,
				true,
			);
}

/**
 * One mapped place's change since its baseline. A place the inventory does
 * not list is archived or deleted, which no API-key read tells apart, and is
 * named whatever its baseline.
 */
function placeRemoteChange(input: {
	readonly push: PlannedPlacePush;
	readonly current: HqLocation | null;
	readonly baseline: ResourceBaseline | undefined;
}): DeploymentRemoteChange | null {
	const change = (
		parts: readonly string[],
		observedDigest: string,
		baselineKnown: boolean,
	): DeploymentRemoteChange => ({
		kind: "location",
		novaResourceId: input.push.locationUuid,
		name: input.push.name,
		identity: input.push.siteCode,
		parts,
		note: null,
		observedDigest,
		baselineKnown,
		since: { kind: "published" },
		canBringIn: false,
	});
	const { current, baseline } = input;
	if (current === null) {
		return change(
			[describePlaceChange({ kind: "missing" })],
			ABSENT_RESOURCE_DIGEST,
			true,
		);
	}
	if (baseline === undefined || baseline.origin === "unread") {
		return change(
			[],
			canonicalPlace(current, input.push.ownedKeys).digest,
			false,
		);
	}
	const canonical = baseline.canonical as CanonicalPlace;
	if (
		!canonical.observed &&
		current.observation &&
		(current.observation.nameIsNull ||
			(input.push.rawData &&
				canonical.ownedKeys.some(
					(key) =>
						typeof current.values[key] !== "string" &&
						Object.hasOwn(current.values, key),
				)))
	) {
		return change(
			[],
			canonicalPlace(current, input.push.ownedKeys).digest,
			false,
		);
	}
	const parts = placeChange(canonical, current).filter(
		(part) =>
			part.kind !== "external-id" ||
			!current.observation ||
			current.observation.externalId !== input.push.externalId,
	);
	return parts.length === 0
		? null
		: change(
				boundedParts(parts.map(describePlaceChange)),
				canonicalPlace(current, baselinePlaceKeys(canonical)).digest,
				true,
			);
}

/**
 * The refusal a publish gives when CommCare HQ reports the mapped app gone,
 * in either form: the document does not exist, or HQ's own delete marked it
 * deleted. The next publish creates a new app there.
 */
export function remoteAppMissingFailure(domain: string): {
	readonly code: "remote_app_missing";
	readonly message: string;
	readonly details: readonly string[];
} {
	return {
		code: "remote_app_missing",
		message: `The app this one publishes to on “${domain}” isn't there any more: CommCare HQ reported it gone when Nova tried to update it. It may have been deleted there. Publishing again creates a new one.`,
		details: [],
	};
}

/** The kinds of a refused read that are the account's, or its key's, to fix: every 401 and 403 CommCare HQ itself gave. */
const ACCOUNT_REFUSAL_KINDS: ReadonlySet<HqFailureKind> = new Set([
	"key-not-accepted",
	"plan-lacks-api-access",
	"api-cut-off",
	"not-a-member",
	"permission",
]);

/**
 * Why the lookup table list could not be read, for the `project-data` edge.
 *
 * Reading the table list needs the paid API access privilege on the project
 * space AND the account's own Access APIs permission, while the upload
 * itself needs neither, so this refusal is genuinely reachable on a project
 * space that would have accepted the push. Only a refusal CommCare HQ itself
 * gave names them; an edge's refusal, an outage and a list HQ served
 * malformed are a question Nova couldn't ask.
 */
export function lookupTableListFailureDetail(
	failure: HqFailure,
	domain: string,
): string {
	return ACCOUNT_REFUSAL_KINDS.has(failure.kind)
		? `Nova can't see which lookup tables “${domain}” already has, so it won't push over them. Reading them needs API access on that project space and the Access APIs permission on your CommCare HQ account; ask a CommCare HQ administrator for both.`
		: `Nova couldn't ask “${domain}” which lookup tables it already has, so it stopped rather than push over them. Try publishing again in a moment.`;
}

/**
 * The refusal for a read of the app's source that did not give a source
 * Nova can update.
 *
 * `createdApp` is true when this publish made the app moments before, so
 * the sentence names the empty app it left rather than a "current" app the
 * person has never seen. A read in preflight is always of an app that was
 * there before this publish.
 */
export function hqAppSourceReadFailure(
	read: Exclude<HqAppSourceRead, { readonly kind: "source" }>,
	domain: string,
	createdApp: boolean,
): {
	readonly code: "hq_app_state_unknown";
	readonly message: string;
	readonly details: readonly string[];
} {
	if (!("success" in read) && read.kind === "unsupported") {
		return {
			code: "hq_app_state_unknown",
			message: `The app on “${domain}” is a linked app in CommCare HQ, and Nova can't update a linked app. Nova left it unchanged. You can publish to another project space, or remove the link in CommCare HQ and publish again.`,
			details: [],
		};
	}
	/* Every 401 and 403 CommCare HQ itself gave; an edge's is
	 * `gateway-refused` and takes the "couldn't safely read" sentence. */
	const permissions =
		"success" in read &&
		ACCOUNT_REFUSAL_KINDS.has(classifyHqFailure(read, "app-source").kind);
	if (createdApp) {
		return {
			code: "hq_app_state_unknown",
			message: permissions
				? `Nova couldn't read the app on “${domain}”, so Nova stopped before sending the app's content. ${CREATED_APP_IS_EMPTY} Reading it needs permission to edit apps in CommCare HQ. Check the connected account, then publish again.`
				: `Nova couldn't safely read the app on “${domain}”, so Nova stopped before sending the app's content. ${CREATED_APP_IS_EMPTY} Check that the app opens in CommCare HQ, then publish again.`,
			details: [],
		};
	}
	return {
		code: "hq_app_state_unknown",
		message: permissions
			? `Nova couldn't read the current app on “${domain}”, so it left that app unchanged. Reading it needs permission to edit apps in CommCare HQ. Check the connected account, then publish again.`
			: `Nova couldn't safely read the current app on “${domain}”, so it left that app unchanged. Check that the app still opens in CommCare HQ, then publish again.`,
		details: [],
	};
}

/**
 * The refusal for an app CommCare HQ saved again between Nova's two reads of
 * it, the save counter and the source, so the source Nova holds is no proof
 * of the app it would build over. Nothing of the app's content was sent.
 */
export function hqAppMovedWhileReadFailure(
	domain: string,
	createdApp: boolean,
): {
	readonly code: "hq_app_state_unknown";
	readonly message: string;
	readonly details: readonly string[];
} {
	return {
		code: "hq_app_state_unknown",
		message: createdApp
			? `The new app on “${domain}” changed in CommCare HQ while Nova was reading it, so Nova stopped before sending the app's content. ${CREATED_APP_IS_EMPTY} You can publish again, and Nova asks before it writes over that change.`
			: `The app on “${domain}” changed in CommCare HQ while Nova was reading it, so Nova left it unchanged. You can publish again in a moment.`,
		details: [],
	};
}

/**
 * The refusal for a file this app publishes that Nova could not read from
 * CommCare HQ while it checked whether the file there is still this app's.
 * Nothing of the app was sent. One sentence for every failure: the address
 * names no project space, and CommCare HQ's view behind it
 * (`hqmedia/views.py::ViewMultimediaFile`) asks for no login and no
 * permission, so no refusal of it is the connected account's to fix.
 */
export function hqMediaReadFailure(domain: string): {
	readonly code: "hq_app_state_unknown";
	readonly message: string;
	readonly details: readonly string[];
} {
	return {
		code: "hq_app_state_unknown",
		message: `Nova couldn't read a picture or sound this app publishes on “${domain}”, so it left that app unchanged. Nova checks each one before it sends this app's own over it. You can publish again in a moment.`,
		details: [],
	};
}

/**
 * The refusal for an app on CommCare HQ set to a CommCare version below the
 * one Nova's apps need. `createdApp` is true when this publish made the app
 * moments before, which the next publish fills once the version is raised.
 */
export function versionBelowFloorFailure(
	domain: string,
	version: string,
	createdApp: boolean,
): {
	readonly code: "hq_app_version_below_floor";
	readonly message: string;
	readonly details: readonly string[];
} {
	const floor = `${COMMCARE_VERSION_FLOOR.major}.${COMMCARE_VERSION_FLOOR.minor}`;
	const opening = `The app on “${domain}” is set to CommCare ${version}, and Nova's apps need ${floor} or later. You can raise the CommCare version in that app's settings in CommCare HQ, then publish again. Phones on an older CommCare can no longer install or update the app after that.`;
	return {
		code: "hq_app_version_below_floor",
		message: createdApp
			? `${opening} Nova created the app there and will fill it in on the next publish.`
			: `${opening} Saving that page can also set the app's other settings there, so Nova may show you what changed before it publishes.`,
		details: [],
	};
}

/**
 * The refusal for a publish that would leave a build profile of the app on
 * CommCare HQ naming a language this app no longer has: one `details` line
 * per profile, in HQ's order. `duringPush` is true where the second read,
 * after the lookup tables and places went, found it, so the sentence says
 * what was sent. No API key can change a build profile, so the person
 * changes it in CommCare HQ: on the Application Profiles tab, which HQ
 * shows and saves only under the `build_profiles` plan privilege
 * (`views/releases.py::LanguageProfilesView`), or, where `hqLangs` (the
 * `langs` of the read the gaps came from) still lists every missing
 * language, on the app's Languages tab, which takes a removed language out
 * of every profile on any plan (`views/apps.py::edit_app_langs`).
 */
export function buildProfileLanguageFailure(
	domain: string,
	gaps: readonly BuildProfileLanguageGap[],
	read: { readonly duringPush: boolean; readonly hqLangs: readonly string[] },
): {
	readonly code: "hq_build_profile_language_missing";
	readonly message: string;
	readonly details: readonly string[];
} {
	if (gaps.length === 0) {
		throw new Error(
			"A build profile refusal was built with no profile that names a missing language.",
		);
	}
	const stopped = read.duringPush
		? "which Nova found after it published this app's lookup tables and places, so it stopped before sending the app's content"
		: "so Nova stopped before sending anything";
	const one = gaps.length === 1 && gaps[0].missing.length === 1;
	const held = new Set(read.hqLangs);
	const onLanguagesTab = gaps.every((gap) =>
		gap.missing.every((code) => held.has(code)),
	);
	const message = one
		? `An application profile of the app on “${domain}” includes a language this app no longer has, ${stopped}. Nova can't change application profiles in CommCare HQ. You can take that language out of the profile, or remove the profile, on the Application Profiles tab of the app's Releases page there, then publish again. That tab shows only where the project space's plan includes application profiles.${onLanguagesTab ? " On any plan, you can instead remove the language on the Languages tab of the app's settings there, which takes it out of every profile. Nova may then show you that change before it publishes." : ""} Left as it is, CommCare HQ would build the profile with a language that has no text of its own, or couldn't build it at all.`
		: `Application profiles of the app on “${domain}” include languages this app no longer has, ${stopped}. Nova can't change application profiles in CommCare HQ. You can take those languages out of each profile listed below, or remove the profile, on the Application Profiles tab of the app's Releases page there, then publish again. That tab shows only where the project space's plan includes application profiles.${onLanguagesTab ? " On any plan, you can instead remove those languages on the Languages tab of the app's settings there, which takes them out of every profile. Nova may then show you that change before it publishes." : ""} Left as they are, CommCare HQ would build those profiles with languages that have no text of their own, or couldn't build them at all.`;
	return {
		code: "hq_build_profile_language_missing",
		message,
		details: gaps.map((gap) => {
			const profile =
				gap.name === "" ? "A profile with no name" : `“${gap.name}”`;
			const languages = gap.missing.map(buildProfileLanguageLabel).join(", ");
			const only = gap.emptied
				? gap.missing.length === 1
					? ", the only language it has"
					: ", the only languages it has"
				: "";
			return `${profile}: ${languages}${only}`;
		}),
	};
}

/**
 * The refusal for a first publish whose new app CommCare HQ made with Web
 * Apps off, for an app that runs in Web Apps: HQ's create answered the plan
 * question from the plan itself. `narrowing` is the app's narrowing to
 * Android, so the message offers it only where the content allows it.
 */
export function planLacksWebAppsFailure(
	domain: string,
	narrowing: PlatformNarrowing,
): {
	readonly code: "hq_plan_lacks_web_apps";
	readonly message: string;
	readonly details: readonly string[];
} {
	return {
		code: "hq_plan_lacks_web_apps",
		message: planLacksWebAppsMessage(domain, narrowing),
		details: [],
	};
}

/**
 * What a stop after a first publish's shell create adds: the empty app it
 * made is on the project space, and the next publish fills that same app.
 */
export const CREATED_APP_IS_EMPTY =
	"Nova created the app there, and it is empty for now.";
