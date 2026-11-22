/**
 * What Nova's publish sends CommCare HQ for one corpus document, captured
 * from Nova's own client.
 *
 * The harness makes HQ's state A (and every later state) by applying the
 * request bodies Nova's publish sends, so those bodies come from production
 * code, not a copy of it:
 *
 * - the application JSON from `lib/deployment/importApplication.ts::hqImportApplication`,
 *   the assembly `publishAppToHq` calls: the empty shell a first publish
 *   creates, and every update;
 * - the project-space check from `lib/commcare/client.ts::probeHqProjectSpaceCompatibility`
 *   over `projectSpaceCompatibilityProbePlan`, whose report decides both
 *   whether Nova publishes at all and the derived Search profile key;
 * - the source reads from `readHqAppSource`, the lookup workbook from
 *   `uploadLookupTableWorkbook`, the imports from `importApp`, and the media
 *   upload after the content from `uploadAppMediaBundle` over
 *   `buildMediaBulkUploadZip` of `bulkUploadAssets`
 *   (`lib/deployment/service.ts::uploadMediaBytes`, sent whenever some
 *   carrier the bulk upload maps references media), each sent to a loopback
 *   peer (`./targetPeer.ts`) that answers as the configured project space
 *   does.
 *
 * What stands in for Nova's database is the Project state preflight reads
 * (`lib/deployment/preflight.ts::runDeploymentPreflight`):
 *
 * - the lookup data the export boundary
 *   (`lib/export/boundaryValidation.ts::prepareExportBoundary`) reads: the
 *   document's referenced tables, ordered by table id as
 *   `lib/lookup/definitionSnapshot.ts` reads them, each with its rows in the
 *   snapshot's stored order;
 * - the media rows it reads: one ready row per uploaded asset the corpus
 *   supplies, holding what Nova's upload stores for it (the accepted media
 *   type, its canonical extension, the SHA-256 and size of the bytes), and
 *   the built-in icons' rows from the shipped catalog;
 * - an organization with no places. Preflight pushes the live places Nova
 *   holds for the app (`lib/deployment/locationResourcePlan.ts::plannedPlacesFor`),
 *   so with none a capture sends no location request, and a document whose
 *   logic reads places is published to a project space that holds none;
 * - a ledger that records no identity override for a Nova-born document, so
 *   every id is the derived one (`lib/commcare/wireIdentity.ts::DERIVED_WIRE_IDENTITY`);
 *   for an HQ-authored A, the ledger a bring-in leaves, with one identity
 *   row a menu and form (`PublishInput.hqAuthoredA`), so every body and
 *   every local archive names A's menus and forms by A's ids
 *   (`targetWireIdentity`), each held file goes out at the path HQ keeps it
 *   under, each keyed create the document keeps is printed under the prefix
 *   its cases stand under in A (`app_deployment_keyed_case_ids`), and the
 *   publish carries the project space's language names and seeds, as Nova's
 *   publish over an app it brought in does.
 *
 * A document Nova's export boundary refuses is not a corpus document: the
 * capture refuses it with the boundary's findings (`exportFindings`) before
 * anything is sent, since no project space would receive it.
 *
 * A publish is a first publish of D (state A) followed by one or more
 * updates over A: D again, or D′ after an edit batch. The first publish is
 * two imports, in the order `publishAppToHq` sends them: the empty shell
 * (`create`, no `app_id`), its source read, the lookup workbook, and the
 * update that fills it (`content`, naming a placeholder app id). Each later
 * update names the placeholder too. HQ mints A's id, so the harness writes
 * it into each update's `app_id` field (`proof/hq/operations.py::with_app_id`).
 * The peer answers every source read from what it holds of the app, and the
 * fields of that source an update's body depends on (`AssumedSource`) are an
 * assumption about HQ, so they are recorded beside the body for the HQ side
 * to hold against HQ's own `app_source` for A before it applies the update:
 * a difference means the captured update is not the one Nova would send
 * there.
 *
 * Each publish makes the reads Nova's drift check makes
 * (`lib/deployment/preflight.ts`, `service.ts`), and decides over them with
 * the same production functions: the table list and, for a table the last
 * publish pushed, its rows (`hqResourceBaseline.ts`), the source read
 * compared with the read back after the last import (`hqSourceBaseline.ts`),
 * the verdict over both (`remoteChanges.ts::decideRemoteChanges`), the name
 * clash the push plan refuses (`lookupResourcePlan.ts`), and each build
 * profile of the source read held to the languages the publish writes
 * (`lib/commcare/targetBuildProfiles.ts::buildProfileLanguageGaps`). After each
 * push it reads back what the ledger would record as the next baseline: each
 * pushed table's rows, and the app's source after its import. What the peer
 * answered for each table before the publish wrote anything is recorded
 * beside its body (`AssumedResources`) for the HQ side to hold to HQ's own
 * resources. A publish over a person's saves in HQ (`PublishInput.hqSide`)
 * does what the document states it does (`HqSideSaves.republish`): it goes
 * through untouched, or it stops as Nova's would and is sent again with what
 * that person confirms (`StopConfirmation`, recorded beside the body), or
 * Nova stops it with the code the document names. An outcome other than the
 * statement, and a stop anywhere else, ends the capture.
 *
 * No export draws an id: a publish derives its menu ids, form ids and
 * `xmlns` from the document, and a `.ccz` profile's `uniqueid` is derived
 * from the app's id and its project space. Given a corpus seed, each publish
 * step and each local export runs in its own seeded stream
 * (`./entropy.mts`), so a change that draws inside an export again writes
 * bytes that are a function of the emission's inputs: the
 * first publish at `OPERATION_ORDINALS.create`, the republish at
 * `OPERATION_ORDINALS.republish`, and each later update at its own
 * (`capturePublish`). undici draws a random multipart boundary per request,
 * so each captured body is re-framed with a fixed one (after checking the
 * re-framed body parses to the same fields), and a `.ccz` and a media
 * upload's ZIP are built with the clock fixed, because each archive stamps
 * its entries with the time (HQ reads a ZIP's names and bytes, never its
 * times: `hqmedia/tasks.py::process_bulk_upload_zip`).
 */

import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { gunzipSync } from "node:zlib";
import type { HqApplication, HqApplicationProfile } from "@/lib/commcare";
import {
	type CommCareCredentials,
	importApp,
	type MediaBundleUploadResult,
	probeHqProjectSpaceCompatibility,
	readHqSaveOnlyEditedAnswers,
	uploadAppMediaBundle,
} from "@/lib/commcare/client";
import { expandDoc, type HqAppShell } from "@/lib/commcare/expander";
import type { HqApplicationModule } from "@/lib/commcare/hq/application";
import { alignHqForms } from "@/lib/commcare/hq/appReading";
import { type HqAppSource, readHqAppSource } from "@/lib/commcare/hq/appSource";
import {
	importReplacedReadApp,
	readHqAppSourceAtVersion,
} from "@/lib/commcare/hq/appSourceAtVersion";
import { HQ_LOOKUP_TABLE_ROWS_MAX_BYTES } from "@/lib/commcare/hq/bounds";
import {
	type HqFixtureRow,
	type HqLookupTable,
	LOOKUP_ROWS_READ_CONCURRENCY,
	listHqLookupTables,
	readHqLookupTableRows,
	uploadLookupTableWorkbook,
} from "@/lib/commcare/hq/lookupTables";
import {
	publishedCaseBlocks,
	sourceHoldsEditMode,
} from "@/lib/commcare/hq/publishedCaseBlocks";
import {
	type LookupWireNaming,
	lookupWireNaming,
} from "@/lib/commcare/lookup/naming";
import {
	type AssetManifest,
	type ResolvedMediaAsset,
	wirePathFor,
} from "@/lib/commcare/multimedia/assetWirePath";
import { buildMediaBulkUploadZip } from "@/lib/commcare/multimedia/bulkUploadZip";
import {
	buildHqJsonExportArchive,
	bulkUploadAssets,
	hqImportFileGuide,
} from "@/lib/commcare/multimedia/hqJsonExportArchive";
import { requiredPlanPrivileges } from "@/lib/commcare/planPrivileges";
import {
	HQ_PRIVATE_FEATURE_FLAG_SYMBOLS,
	type HqPrivateFeatureFlagRequirement,
	type ProjectSpaceCompatibilityReport,
	projectSpaceCompatibilityProbePlan,
} from "@/lib/commcare/projectSpaceCompatibility";
import { COMMCARE_SERVERS, type CommCareServer } from "@/lib/commcare/servers";
import gateEntries from "@/lib/commcare/surface/entries/gates.json";
import { domainFeatureFlag } from "@/lib/commcare/surface/gates";
import { gateEntriesFileSchema } from "@/lib/commcare/surface/schema";
import {
	buildProfileLanguageGaps,
	publishedLanguageCodes,
} from "@/lib/commcare/targetBuildProfiles";
import {
	type TargetFacts,
	targetFactsFromSource,
} from "@/lib/commcare/targetFacts";
import type { ValidationError } from "@/lib/commcare/validator/errors";
import {
	type ColumnFieldWordRow,
	DERIVED_WIRE_IDENTITY,
	targetWireIdentity,
	type WireIdentity,
	type WireIdentityOverride,
} from "@/lib/commcare/wireIdentity";
import type { AttachmentUrlTarget } from "@/lib/commcare/xform/captureUrlNode";
import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import {
	type AdoptedKeyedCaseId,
	type AdoptedMediaFile,
	adoptedAppBaselineWrite,
	adoptedIdentityRows,
	assignMediaPaths,
	keyedCaseIdPrefixesFor,
} from "@/lib/deployment/adoption";
import { attachmentUrlTarget } from "@/lib/deployment/attachmentTarget";
import { requiredConfirmations } from "@/lib/deployment/confirmations";
import { sourceFromBaseline } from "@/lib/deployment/hqChanges/baselineSource";
import { hqChangesReviewDigest } from "@/lib/deployment/hqChanges/digest";
import {
	makeHqChangeReadings,
	ownPathsBase,
	planChangeReadingMedia,
} from "@/lib/deployment/hqChanges/readings";
import type { ReferenceDocument } from "@/lib/deployment/hqChanges/reference";
import {
	accountReview,
	type CheckedHqChanges,
	checkHqChanges,
	type FetchedHqChanges,
	type HqChangesBasis,
	type PairedBaseline,
	projectDataFindingsNow,
	publishChangeSentences,
	unionPlan,
	withJudged,
} from "@/lib/deployment/hqChanges/review";
import type { HqChangesReview } from "@/lib/deployment/hqChanges/types";
import {
	type HqMediaPath,
	type HqMediaRecord,
	hqMediaStandings,
	isHoldableWirePath,
	mediaMovedBetween,
	nextHqMediaRecord,
	publishedMediaFiles,
} from "@/lib/deployment/hqMedia";
import {
	type SettledHqMediaRead,
	settleHqMedia,
} from "@/lib/deployment/hqMediaSettle";
import {
	ABSENT_RESOURCE_DIGEST,
	canonicalLookupTable,
	type LookupChangePart,
	lookupDefinitionChange,
	lookupDefinitionDigest,
	lookupIdentityChange,
	lookupRowsChange,
} from "@/lib/deployment/hqResourceBaseline";
import {
	diffHqAppSource,
	normalizeHqAppSource,
} from "@/lib/deployment/hqSourceBaseline";
import { hqImportApplication } from "@/lib/deployment/importApplication";
import {
	type LookupTableConflict,
	type LookupTableUnsupported,
	planLookupResourcePush,
} from "@/lib/deployment/lookupResourcePlan";
import { adoptionExportBoundary } from "@/lib/deployment/reading/adoptionBoundary";
import { firstPublishChangePlaces } from "@/lib/deployment/reading/firstPublishChanges";
import { Pieces } from "@/lib/deployment/reading/gather";
import { projectDataReadsOf } from "@/lib/deployment/reading/projectData";
import {
	adoptedMediaFiles,
	mediaReadLimit,
	type ReadingMediaPlan,
} from "@/lib/deployment/reading/projectData/media";
import { judgeReadingMedia } from "@/lib/deployment/reading/projectData/mediaStore";
import {
	type ReadingProjectSide,
	readReadingProjectData,
} from "@/lib/deployment/reading/projectData/read";
import {
	boundedParts,
	decideRemoteChanges,
	describeAppChange,
	describeLookupChange,
	driftReferenceOf,
} from "@/lib/deployment/remoteChanges";
import {
	type CczUnavailable,
	chooseDownloadTarget,
	workersSentElsewhere,
} from "@/lib/deployment/runtimeTarget";
import {
	canonicalTargetIdentity,
	EMPTY_TARGET_IDENTITY,
	exportIdentityOf,
	type TargetIdentity,
} from "@/lib/deployment/targetIdentity";
import type {
	AppOwnership,
	CanonicalLookupTable,
	DeploymentIdentityOverride,
	DeploymentRemoteChange,
	DeploymentResource,
	RemoteChangeDiscard,
} from "@/lib/deployment/types";
import {
	createdWithoutWebApps,
	type WebAppsChange,
	webAppsChange,
	webAppsMovedDuringPush,
} from "@/lib/deployment/webApps";
import { extractLookupReferenceTargets } from "@/lib/doc/lookupReferences";
import type { Mutation } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	declaresAndroid,
	declaresWebApps,
	type PersistableDoc,
	PLATFORMS,
	type Platform,
} from "@/lib/domain";
import { collectAssetRefs } from "@/lib/domain/mediaRefs";
import {
	ASSET_SIZE_CAPS_BYTES,
	asMediaAssetId,
	assetKindForMimeType,
	EXTENSION_FOR_MIME_TYPE,
	gcsObjectKeyFor,
	type MediaAssetId,
	type MediaKind,
	normalizeMimeType,
} from "@/lib/domain/multimedia";
import {
	type ExportMode,
	type LookupTarget,
	type PreparedExportBoundary,
	prepareExportBoundaryWithReads,
} from "@/lib/export/boundaryValidation";
import { compileLocalArchive } from "@/lib/export/localArchive";
import { LOOKUP_MAX_ROWS } from "@/lib/lookup/constants";
import { parseLookupRevision } from "@/lib/lookup/schema";
import type {
	LookupFixtureDataSnapshot,
	LookupFixtureRow,
	LookupTableDefinition,
	LookupTableId,
} from "@/lib/lookup/types";
import {
	builtinAssetRows,
	partitionAssetRefs,
	resolveBuiltinManifestEntries,
} from "@/lib/media/builtinIconAssets";
import { classifyStoredMediaBytes } from "@/lib/media/validate";
import type { DriftReference } from "@/lib/publish/driftReference";
import type { FirstPublishChangeId } from "@/lib/publish/firstPublishChangeIds";
import { renderManualImportGuide } from "@/lib/publish/manualImportGuide";
import { mapWithConcurrency } from "@/lib/utils/concurrency";
import { CORPUS_COMMCARE_VERSION } from "./configurations";
import {
	type HqSideRecorded,
	type HqSideSaves,
	storedDocument,
} from "./documents";
import {
	firstPublishRecord,
	hydrateAdmittedDocument,
	recordedDocument,
} from "./editBatches";
import {
	type EntropyOperation,
	OPERATION_ORDINALS,
	seeded,
} from "./entropy.mts";
import { hqApplicationModules } from "./hqSummary";
import {
	type PeerHolding,
	type PeerMediaFile,
	type PeerRequest,
	type PeerTable,
	type TargetPeer,
	withTargetPeer,
} from "./targetPeer";

/** The CommCare server every capture targets; only its catalog origin reaches the bytes. */
export const PROOF_SERVER: CommCareServer = "production";

/** `proof/hq/configuration.py::DEFAULT_DOMAIN`. */
export const PROOF_DOMAIN = "nova-proof";

/** The Project a corpus document without lookup data belongs to. */
const PROOF_PROJECT = "proof-corpus";
/** The name a review gives the capture's Project where a table asks its choice. */
const PROOF_PROJECT_NAME = "Proof corpus";

/**
 * The app id the content import and every update name at capture, and the
 * app id a local archive's runtime URLs name. HQ mints the real one when it
 * applies the create; the harness writes that into each update's `app_id`
 * (`proof/hq/operations.py::with_app_id`) and into the archive's runtime
 * URLs (`proof/hq/operations.py::with_runtime_app_id`).
 */
export const PLACEHOLDER_APP_ID = "nova-proof-placeholder-app";

const CREDENTIALS: CommCareCredentials = {
	username: "nova-proof",
	apiKey: "nova-proof-key",
	server: PROOF_SERVER,
};

/**
 * The layout marker a capture writes in each import's sidecar: a first
 * publish captured as two imports, the shell's `create` and the `content`
 * update that fills it. A sidecar without the key is the legacy layout, a
 * first publish that is one create, which controls retained before the two
 * imports keep (`proof/checks/corpus.py::_captured`).
 */
export const TWO_IMPORT_LAYOUT = 2;

/**
 * The instant a `.ccz` is built at. AdmZip stamps each archive entry with
 * `new Date()`, written as a DOS date and time in the process's local zone;
 * with the clock fixed and the zone UTC (`atInstant`), two builds of one
 * document differ only in what Nova mints, wherever they run.
 */
export const CCZ_CLOCK = Date.UTC(2026, 0, 1);

// ── Inputs ───────────────────────────────────────────────────────────

/**
 * Whose a language's display name and a seeded setting the project space
 * holds no value for are on a publish (`hqImportApplication`'s
 * `languageNames` and `seeds`): Nova's on an app its own publish created,
 * the project space's on an app Nova brought in from CommCare HQ.
 */
type LanguageNames = "nova" | "target";

/** One uploaded media asset, as the Project's media store holds it. */
export interface UploadedMedia {
	readonly kind: MediaKind;
	/** The accepted MIME type Nova's upload stores (`image/png`). */
	readonly mimeType: string;
	/** The canonical extension Nova's upload stores for that type (`.png`). */
	readonly extension: string;
	readonly bytes: Buffer;
}

/** One admitted document, with what Nova's publish reads beside it. */
export interface PublishDocument {
	/** Stable identity: the corpus source plus its sample index or name. */
	readonly id: string;
	/** The stored document; it must parse under the strict schema. */
	readonly doc: PersistableDoc;
	/** The Project's lookup data: every table the document may reference, with complete ordered rows. */
	readonly lookup?: LookupFixtureDataSnapshot;
	/** Every uploaded asset the document references, by asset id. Built-in icons need no entry. */
	readonly media?: ReadonlyMap<string, UploadedMedia>;
	/** The app's `mutation_seq`, which a `.ccz` stamps into its profile. */
	readonly compiledAtSeq: number;
}

/** The project space a capture publishes to. */
export interface PublishConfiguration {
	/** Names the configuration's output directory. */
	readonly id: string;
	/** Feature flags on for the project space, by symbol in `corehq/toggles/__init__.py`. */
	readonly flags: readonly string[];
	/** Whether case search is on for the project space (`CaseSearchConfig.enabled`). */
	readonly caseSearchEnabled: boolean;
	readonly domain: string;
}

// ── Nova's verdict for a document ───────────────────────────────────

export interface VerdictFlag {
	/** The flag's symbol in `corehq/toggles/__init__.py`. */
	readonly symbol: string;
	readonly slug: string;
}

/**
 * What Nova's publish requires of a project space for one document: the
 * capabilities `projectSpaceCompatibilityProbePlan` names, each with the
 * flags and runtime checks the probe makes, and the advisories, which never
 * block a publish. A configuration missing a required flag, holding one a
 * capability needs off, or without case search where a capability's runtime
 * check needs it, is one Nova refuses. Beside
 * them, the plan privileges Nova's publish asks the person to confirm
 * (`requiredPlanPrivileges`), which no API key can read and so no
 * configuration Nova refuses.
 */
export interface NovaPublishVerdict {
	readonly capabilities: readonly {
		readonly id: string;
		readonly flags: readonly VerdictFlag[];
		/** The flags the capability needs off, by symbol, sorted; absent where none is. */
		readonly flagsOff?: readonly string[];
		readonly runtimeProbes: readonly string[];
	}[];
	readonly advisories: readonly {
		readonly id: string;
		readonly flags: readonly VerdictFlag[];
	}[];
	/** The least a project space needs for Nova to publish the document. */
	readonly minimumConfiguration: {
		readonly flags: readonly string[];
		readonly caseSearchEnabled: boolean;
		/**
		 * Present, and `false`, where Nova's publish asks the person to
		 * confirm sync on form entry is off; absent where it asks nothing,
		 * which every retained verdict written before step 4 reads as.
		 */
		readonly syncCasesOnFormEntry?: false;
		/**
		 * Present, and `false`, where Nova's publish asks the person to
		 * confirm the project space has CommCare Supply off (`commtrack-off`);
		 * absent where it asks nothing, which every retained verdict reads as.
		 */
		readonly commtrackEnabled?: false;
		/**
		 * The HQ toggles Nova's publish requires off for this document, sorted
		 * (a capability's `featureFlagsOff`); absent where none is.
		 */
		readonly flagsOff?: readonly string[];
	};
	/**
	 * The `corehq/privileges.py` constants of the plan privileges Nova's
	 * publish asks the person to confirm for this document, sorted: each use
	 * of `requiredPlanPrivileges` read through its gate entry's `surfaceKeys`.
	 * A capture pushes the lookup workbook exactly when the document reads a
	 * lookup table CommCare HQ does not manage, and no places (the
	 * organization it is published from holds none).
	 */
	readonly planPrivileges: readonly string[];
}

/** The privilege constants of each gate entry, by entry id (`privilege:USERCASE` read as `USERCASE`). */
const PRIVILEGE_CONSTANTS: ReadonlyMap<string, readonly string[]> = new Map(
	gateEntriesFileSchema
		.parse(gateEntries)
		.map((gate) => [
			gate.id,
			gate.surfaceKeys.flatMap((key) =>
				key.startsWith("privilege:") ? [key.slice("privilege:".length)] : [],
			),
		]),
);

/**
 * What a capture's publish sends besides the app, as preflight reads it
 * (`preflight.ts::publishConfirmationNeeds`): the lookup workbook exactly when
 * the document reads a lookup table CommCare HQ does not manage from the
 * project space the capture publishes to, which the workbook leaves out, and
 * no places (the organization it is published from holds none). A table
 * CommCare HQ manages is the capture's own project space's
 * (`managedDataEdge` refuses one managed from another).
 */
function capturePushes(
	doc: BlueprintDoc,
	source: Pick<PublishDocument, "id" | "lookup">,
) {
	const { tableIds } = extractLookupReferenceTargets(doc);
	const managed = new Set(
		lookupFixtureData(source, tableIds).definitions.flatMap((definition) =>
			definition.hq?.managedBy === "commcare-hq" ? [definition.id] : [],
		),
	);
	return {
		lookupTables: tableIds.some((tableId) => !managed.has(tableId)),
		places: false,
	};
}

/**
 * The target a capture's publish hands the emitter. A capture publishes to a
 * project space, so its capture links are written (`capturePublish` hands the
 * emitter that space's target); which space it is decides no privilege and no
 * confirmation.
 */
const CAPTURE_ATTACHMENT_TARGET = attachmentUrlTarget({
	server: PROOF_SERVER,
	domain: PROOF_DOMAIN,
});

/** The privilege constants Nova's publish asks to be confirmed for `doc`. */
function planPrivileges(
	doc: BlueprintDoc,
	source: Pick<PublishDocument, "id" | "lookup">,
): string[] {
	const uses = requiredPlanPrivileges(
		doc,
		capturePushes(doc, source),
		CAPTURE_ATTACHMENT_TARGET,
	);
	return [
		...new Set(
			uses.flatMap((use) => {
				const constants = PRIVILEGE_CONSTANTS.get(use.gate) ?? [];
				if (constants.length === 0) {
					throw new Error(
						`Nova's publish asks for the plan privilege ${use.id}, and the gate entry ${use.gate} in lib/commcare/surface/entries/gates.json names no privilege constant. Give the entry its surface key, privilege:<constant>.`,
					);
				}
				return constants;
			}),
		),
	].sort();
}

/**
 * Each probed flag's HQ symbol and slug, from the gate entry of the toggle
 * behind the flag's id: the entry the probe read the slug from
 * (`projectSpaceCompatibility.ts::HQ_PRIVATE_FEATURE_FLAG_SYMBOLS`).
 */
function verdictFlags(
	flags: readonly HqPrivateFeatureFlagRequirement[],
): VerdictFlag[] {
	return flags.map((flag) => {
		const { symbol, slug } = domainFeatureFlag(
			HQ_PRIVATE_FEATURE_FLAG_SYMBOLS[flag.id],
		);
		return { symbol, slug };
	});
}

/**
 * What a capture's publish calls the tables `doc` reads on the wire: the
 * naming the export boundary derives from the definitions of the Project
 * data `source` carries (`lookupFixtureData` read through `lookupWireNaming`),
 * or `undefined` for a document that reads no table.
 */
function captureLookupNaming(
	doc: BlueprintDoc,
	source: Pick<PublishDocument, "id" | "lookup">,
): LookupWireNaming | undefined {
	const { tableIds } = extractLookupReferenceTargets(doc);
	return tableIds.length === 0
		? undefined
		: lookupWireNaming(lookupFixtureData(source, tableIds).definitions);
}

/**
 * The kinds of project space setting Nova's publish asks the person to
 * confirm for `doc` (`form-entry-sync-off`, `commtrack-off` and the rest),
 * from the same needs the publish reads, under the lookup naming of the
 * Project data `source` carries.
 */
function confirmationKinds(
	doc: BlueprintDoc,
	source: Pick<PublishDocument, "id" | "lookup">,
): ReadonlySet<string> {
	return new Set(
		requiredConfirmations(
			doc,
			capturePushes(doc, source),
			CAPTURE_ATTACHMENT_TARGET,
			captureLookupNaming(doc, source),
		).map((need) => need.kind),
	);
}

/** The symbols of the flags a probe plan needs off, sorted. */
function flagsOffSymbols(
	flags: readonly HqPrivateFeatureFlagRequirement[],
): string[] {
	return [...new Set(verdictFlags(flags).map((flag) => flag.symbol))].sort();
}

/**
 * Nova's verdict for `doc`, published with the Project data `source` carries:
 * the document itself, or the one whose lookup data an edit of it publishes
 * beside.
 */
export function novaPublishVerdict(
	doc: BlueprintDoc,
	source: Pick<PublishDocument, "id" | "lookup">,
): NovaPublishVerdict {
	const plan = projectSpaceCompatibilityProbePlan(doc);
	const confirmations = confirmationKinds(doc, source);
	const capabilities = plan.capabilities.map((item) => {
		const off = flagsOffSymbols(item.featureFlagsOff);
		return {
			id: item.capability.id,
			flags: verdictFlags(item.featureFlags),
			...(off.length > 0 && { flagsOff: off }),
			runtimeProbes: [...item.runtimeProbes],
		};
	});
	const flagsOff = [
		...new Set(capabilities.flatMap((item) => item.flagsOff ?? [])),
	].sort();
	return {
		capabilities,
		advisories: plan.advisories.map((item) => ({
			id: item.advisory.id,
			flags: verdictFlags(item.featureFlags),
		})),
		minimumConfiguration: {
			flags: [
				...new Set(
					capabilities.flatMap((item) => item.flags.map((flag) => flag.symbol)),
				),
			].sort(),
			caseSearchEnabled: capabilities.some((item) =>
				item.runtimeProbes.includes("case-search"),
			),
			...(confirmations.has("form-entry-sync-off") && {
				syncCasesOnFormEntry: false as const,
			}),
			...(confirmations.has("commtrack-off") && {
				commtrackEnabled: false as const,
			}),
			...(flagsOff.length > 0 && { flagsOff }),
		},
		planPrivileges: planPrivileges(doc, source),
	};
}

/**
 * The least configuration under which Nova publishes every one of `verdicts`:
 * each flag one requires on, and none it requires off. Throws where one
 * verdict requires on a flag another requires off, since no project space
 * takes both.
 */
export function minimumConfiguration(
	verdicts: readonly NovaPublishVerdict[],
	domain = PROOF_DOMAIN,
): PublishConfiguration {
	const flags = [
		...new Set(verdicts.flatMap((v) => v.minimumConfiguration.flags)),
	].sort();
	const off = new Set(
		verdicts.flatMap((v) => v.minimumConfiguration.flagsOff ?? []),
	);
	const both = flags.filter((flag) => off.has(flag));
	if (both.length > 0) {
		throw new Error(
			`Nova's publish requires ${both.join(", ")} on for one of these documents and off for another, so no project space takes them all; publish them to separate project spaces.`,
		);
	}
	return {
		id: "minimum",
		flags,
		caseSearchEnabled: verdicts.some(
			(v) => v.minimumConfiguration.caseSearchEnabled,
		),
		domain,
	};
}

// ── The Project state preflight reads ───────────────────────────────

/** The three exports a capture makes: the direct HQ upload, the `.ccz` download and the HQ import file. */
export type CaptureExportMode = Extract<
	ExportMode,
	"hq-upload" | "ccz" | "hq-json"
>;

function compareIds(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/** The Project the document's stored state belongs to. */
function projectOf(source: Pick<PublishDocument, "lookup">): string {
	return source.lookup?.projectId ?? PROOF_PROJECT;
}

/**
 * The requested tables, as the lookup reader returns them: definitions by
 * table id, each table's rows in the snapshot's (stored) order. A Project
 * that holds no lookup data reads as an empty snapshot at revision 0, as
 * the reader's Project clock does.
 */
function lookupFixtureData(
	source: Pick<PublishDocument, "id" | "lookup">,
	tableIds: readonly LookupTableId[],
): LookupFixtureDataSnapshot {
	if (tableIds.length > 0 && source.lookup === undefined) {
		throw new Error(
			`Corpus document ${source.id} references lookup tables, and it carries no Project lookup data. Give it the lookup snapshot it was admitted with.`,
		);
	}
	const wanted = new Set<string>(tableIds);
	const definitions = (source.lookup?.definitions ?? [])
		.filter((definition) => wanted.has(definition.id))
		.sort((left, right) => compareIds(left.id, right.id));
	const rowsByTable = new Map<LookupTableId, readonly LookupFixtureRow[]>();
	for (const definition of definitions) {
		rowsByTable.set(
			definition.id,
			source.lookup?.rowsByTable.get(definition.id) ?? [],
		);
	}
	return {
		projectId: projectOf(source),
		projectRevision: source.lookup?.projectRevision ?? parseLookupRevision("0"),
		definitions,
		rowsByTable,
	};
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Why Nova's media store never holds `asset` as given, or `undefined` when
 * it can. Nova's upload (`lib/media/validate.ts::validateMediaBytes`) stores
 * an accepted MIME type as written, the kind and canonical extension
 * `lib/domain/multimedia.ts` gives that type, and the bytes' SHA-256 and
 * size, within the kind's size cap.
 */
export function uploadedMediaProblem(asset: UploadedMedia): string | undefined {
	const mimeType = normalizeMimeType(asset.mimeType);
	if (mimeType === undefined || mimeType !== asset.mimeType) {
		return `its type ${JSON.stringify(asset.mimeType)} is not an accepted type as Nova writes it`;
	}
	const kind = assetKindForMimeType(mimeType);
	if (kind !== asset.kind) {
		return `its kind is ${JSON.stringify(asset.kind)}, where Nova stores ${mimeType} as ${kind}`;
	}
	const extension = EXTENSION_FOR_MIME_TYPE[mimeType];
	if (extension !== asset.extension) {
		return `its extension is ${JSON.stringify(asset.extension)}, where Nova stores ${mimeType} as ${JSON.stringify(extension)}`;
	}
	const cap = ASSET_SIZE_CAPS_BYTES[asset.kind];
	if (asset.bytes.length === 0 || asset.bytes.length > cap) {
		return `it holds ${asset.bytes.length} bytes, where a ${asset.kind} upload holds 1 to ${cap}`;
	}
	return undefined;
}

/**
 * The ready row Nova's media store holds for one uploaded asset, with the
 * variant the production classifier gives its bytes, as the upload gate
 * records it.
 */
async function mediaRow(
	source: PublishDocument,
	assetId: string,
	asset: UploadedMedia,
): Promise<MediaAssetRecord> {
	const problem = uploadedMediaProblem(asset);
	const mimeType = normalizeMimeType(asset.mimeType);
	if (problem !== undefined || mimeType === undefined) {
		throw new Error(
			`Corpus document ${source.id}'s media asset ${assetId} is not one Nova's upload stores: ${problem}. Give it the kind, type and extension Nova's upload records for its bytes.`,
		);
	}
	const projectId = projectOf(source);
	const contentHash = sha256(asset.bytes);
	return {
		id: asMediaAssetId(assetId),
		project_id: projectId,
		owner: PROOF_PROJECT,
		contentHash,
		mimeType,
		extension: asset.extension,
		sizeBytes: asset.bytes.length,
		kind: asset.kind,
		gcsObjectKey: gcsObjectKeyFor(projectId, contentHash, asset.extension),
		originalFilename: `${assetId}${asset.extension}`,
		status: "ready",
		mediaFormat: await classifyStoredMediaBytes(asset.bytes, {
			mimeType,
			extension: asset.extension,
		}),
		created_at: new Date(0),
	};
}

/**
 * The rows the media store holds for the requested uploaded assets: every
 * asset the document references must be supplied, since a publish reads
 * the Project's own uploads.
 */
function mediaRows(
	source: PublishDocument,
	ids: readonly string[],
): Promise<MediaAssetRecord[]> {
	return Promise.all(
		ids.map((id) => {
			const asset = source.media?.get(id);
			if (asset === undefined) {
				throw new Error(
					`Corpus document ${source.id} references the uploaded media asset ${id}, and its media holds no bytes for it. Give the document every uploaded asset it references.`,
				);
			}
			return mediaRow(source, id, asset);
		}),
	);
}

/**
 * The media manifest with bytes, as `lib/media/manifest.ts::resolveMediaManifest`
 * resolves it from the ready rows: each uploaded asset by its content hash
 * and extension, then the built-in icons from the shipped catalog.
 */
async function mediaManifest(
	source: PublishDocument,
	doc: BlueprintDoc,
	heldPaths?: ReadonlyMap<MediaAssetId, string>,
): Promise<AssetManifest> {
	const { realIds, builtinSlugs } = partitionAssetRefs([
		...collectAssetRefs(doc),
	]);
	const manifest = new Map<ResolvedMediaAsset["assetId"], ResolvedMediaAsset>();
	for (const row of await mediaRows(source, realIds)) {
		const asset = source.media?.get(row.id);
		if (asset === undefined) continue;
		manifest.set(row.id, {
			assetId: row.id,
			wirePath:
				heldPaths?.get(row.id) ?? wirePathFor(row.contentHash, row.extension),
			kind: asset.kind,
			mimeType: row.mimeType,
			contentHash: row.contentHash,
			extension: row.extension,
			bytes: asset.bytes,
		});
	}
	for (const [id, asset] of await resolveBuiltinManifestEntries(
		builtinSlugs,
		true,
	)) {
		manifest.set(id, asset);
	}
	return manifest;
}

// ── The export boundary ─────────────────────────────────────────────

/** A document Nova's export boundary refuses, whatever the project space. */
export class UnexportableDocumentError extends Error {
	constructor(
		readonly documentId: string,
		readonly mode: CaptureExportMode,
		readonly findings: readonly ValidationError[],
	) {
		const reasons = findings
			.map((finding) => `${finding.code}: ${finding.message}`)
			.join(" ");
		super(
			mode === "hq-upload"
				? `Nova's publish refuses corpus document ${documentId} before it sends anything (${reasons}), so no project space would receive it. Fix the document or the Project data it carries.`
				: mode === "ccz"
					? `Nova's compile route refuses to build corpus document ${documentId} (${reasons}), so no device would receive it. Fix the document or the Project data it carries.`
					: `Nova's compile route refuses to build the HQ import file of corpus document ${documentId} (${reasons}), so no one could import it. Fix the document or the Project data it carries.`,
		);
		this.name = "UnexportableDocumentError";
	}
}

/** A document the boundary prepared for one export. */
interface PreparedDocument {
	readonly source: PublishDocument;
	readonly export: PreparedExportBoundary;
}

/**
 * The export boundary's own verdict and prepared export
 * (`lib/export/boundaryValidation.ts::prepareExportBoundaryWithReads`) for
 * the document, over its stored state, as preflight's `hq-upload` or the
 * compile route's `ccz` asks for it. A publish names the project space it
 * writes to (`lookupTarget`), so a table CommCare HQ manages there is left
 * out of its workbook. A document that is not admitted at all throws.
 */
function exportBoundary(
	source: PublishDocument,
	mode: CaptureExportMode,
	attachmentTarget: AttachmentUrlTarget | null,
	lookupTarget?: LookupTarget,
	heldMediaPaths?: ReadonlyMap<MediaAssetId, string>,
) {
	const doc = hydrateAdmittedDocument({
		id: source.id,
		doc: source.doc,
		...(source.lookup !== undefined && { lookup: source.lookup }),
	});
	return prepareExportBoundaryWithReads(
		{
			mode,
			access: {
				projectId: projectOf(source),
				role: "editor",
				actorUserId: PROOF_PROJECT,
			},
			doc,
			compiledAtSeq: source.compiledAtSeq,
			attachmentTarget,
			...(lookupTarget !== undefined && { lookupTarget }),
			...(heldMediaPaths !== undefined && { heldMediaPaths }),
		},
		{
			lookupFixtureData: async (_scope, tableIds) =>
				lookupFixtureData(source, tableIds),
			mediaRows: async (ids) => mediaRows(source, ids),
			mediaManifest: (manifestDoc, _projectId, held) =>
				mediaManifest(source, manifestDoc, held),
		},
	);
}

/**
 * The findings Nova's export boundary returns for the document over its
 * stored state, for a direct HQ upload or a `.ccz` download: empty when Nova
 * exports it.
 */
export async function exportFindings(
	source: PublishDocument,
	mode: CaptureExportMode,
): Promise<readonly ValidationError[]> {
	const result = await exportBoundary(source, mode, null);
	return result.ok ? [] : result.violations;
}

async function prepareDocument(
	source: PublishDocument,
	mode: CaptureExportMode,
	attachmentTarget: AttachmentUrlTarget | null,
	lookupTarget?: LookupTarget,
	heldMediaPaths?: ReadonlyMap<MediaAssetId, string>,
): Promise<PreparedDocument> {
	const result = await exportBoundary(
		source,
		mode,
		attachmentTarget,
		lookupTarget,
		heldMediaPaths,
	);
	if (!result.ok) {
		throw new UnexportableDocumentError(source.id, mode, result.violations);
	}
	return { source, export: result.prepared };
}

// ── Captured requests ────────────────────────────────────────────────

/** The multipart boundary every captured body is framed with. */
export const CAPTURE_BOUNDARY = "----nova-proof-capture";

/** One request Nova's client sent, re-framed with a fixed multipart boundary. */
export interface CapturedRequest {
	readonly method: string;
	readonly path: string;
	readonly contentType: string;
	readonly body: Buffer;
	/** The multipart field names, in order. */
	readonly fields: readonly string[];
}

function multipartBoundary(contentType: string): string {
	const [mediaType, ...parameters] = contentType.split(";");
	const boundary = parameters
		.map((parameter) => parameter.trim())
		.find((parameter) => parameter.startsWith("boundary="))
		?.slice("boundary=".length);
	if (mediaType?.trim() !== "multipart/form-data" || !boundary) {
		throw new Error(
			`Nova's client sent a body of type ${contentType}, and the capture reads only multipart/form-data with a boundary.`,
		);
	}
	return boundary;
}

async function formEntries(body: Buffer, contentType: string) {
	const form = await new Response(new Uint8Array(body), {
		headers: { "content-type": contentType },
	}).formData();
	return Promise.all(
		[...form.entries()].map(async ([name, value]) =>
			typeof value === "string"
				? { name, value }
				: {
						name,
						filename: value.name,
						type: value.type,
						bytes: Buffer.from(await value.arrayBuffer()),
					},
		),
	);
}

/**
 * Re-frame a multipart body with the fixed boundary. Every occurrence of the
 * sent boundary must be a delimiter (at the start of the body or after a
 * line break), and the fixed boundary must not occur in the body; the result
 * is parsed back and must hold the same fields, names, file names, types and
 * bytes as the body as sent.
 */
async function reframed(request: PeerRequest): Promise<CapturedRequest> {
	const sentType = request.contentType ?? "";
	const sent = multipartBoundary(sentType);
	let fixed = CAPTURE_BOUNDARY;
	for (let n = 1; request.body.includes(fixed); n += 1) {
		fixed = `${CAPTURE_BOUNDARY}-${n}`;
	}
	const delimiter = Buffer.from(`--${sent}`);
	const replacement = Buffer.from(`--${fixed}`);
	const pieces: Buffer[] = [];
	let from = 0;
	for (
		let at = request.body.indexOf(delimiter);
		at !== -1;
		at = request.body.indexOf(delimiter, at + delimiter.length)
	) {
		if (at !== 0 && request.body.subarray(at - 2, at).toString() !== "\r\n") {
			throw new Error(
				`The body Nova's client sent to ${request.path} holds its multipart boundary inside a part, so the capture cannot re-frame it.`,
			);
		}
		pieces.push(request.body.subarray(from, at), replacement);
		from = at + delimiter.length;
	}
	pieces.push(request.body.subarray(from));
	const body = Buffer.concat(pieces);
	const contentType = `multipart/form-data; boundary=${fixed}`;
	const before = await formEntries(request.body, sentType);
	const after = await formEntries(body, contentType);
	if (JSON.stringify(before) !== JSON.stringify(after)) {
		throw new Error(
			`Re-framing the body Nova's client sent to ${request.path} changed what it parses to, so the capture would not be the request Nova sent.`,
		);
	}
	return {
		method: request.method,
		path: request.path,
		contentType,
		body,
		fields: after.map((entry) => entry.name),
	};
}

// ── The publish steps ────────────────────────────────────────────────

/** The compatibility report's outcome, without the report's prose. */
export interface CompatibilityOutcome {
	readonly status: ProjectSpaceCompatibilityReport["status"];
	readonly capabilities: readonly {
		readonly id: string;
		readonly state: string;
	}[];
	readonly advisories: readonly {
		readonly id: string;
		readonly state: string;
	}[];
}

function compatibilityOutcome(
	report: ProjectSpaceCompatibilityReport,
): CompatibilityOutcome {
	return {
		status: report.status,
		capabilities: report.required_capabilities.map(({ id, state }) => ({
			id,
			state,
		})),
		advisories: report.advisories.map(({ id, state }) => ({ id, state })),
	};
}

/**
 * The fields of HQ's app source a captured import depends on, each by its
 * path in the source HQ serves (`app_manager/views/apps.py::app_source`).
 * Nova's import accepts a read only of an `Application` with a CommCare
 * version (`readHqAppSource`), and projects an update's `profile`,
 * `translations` and `add_ons` over the read's (`lib/commcare/targetOverlay.ts`,
 * which reads `langs` for the language names), so these are what the peer
 * answered the read the import was built on with. `auto_gps_capture` is read
 * by no body: it is held because the peer applies a person's saves to it
 * (`./targetPeer.ts::applyHqSide`), and holding it proves that model. The HQ
 * side holds each to HQ's own read before it applies the import
 * (`proof/observe/publish.py::update`, `proof/hq/operations.py::publish_capture`).
 */
export interface AssumedSource {
	readonly doc_type: "Application";
	readonly "build_spec.version": string;
	readonly profile: HqApplicationProfile;
	readonly translations: HqAppSource["translations"];
	readonly add_ons: HqAppSource["addOns"];
	readonly langs: HqAppSource["langs"];
	readonly auto_gps_capture: boolean;
	/**
	 * The app's Web App setting as the peer answered the read: a create's is
	 * the configuration's `CLOUDCARE` grant (`_create_app_from_doc`), and the
	 * HQ side holds it to HQ's own create.
	 */
	readonly cloudcare_enabled: boolean;
}

/** The fields of `source` a captured import depends on. */
function assumedSourceOf(source: HqAppSource): AssumedSource {
	const autoGpsCapture = source.raw.auto_gps_capture;
	if (typeof autoGpsCapture !== "boolean") {
		throw new Error(
			`The capture peer served an app source whose auto_gps_capture is ${JSON.stringify(autoGpsCapture)}; HQ serves the setting as a boolean for every app (Application.auto_gps_capture).`,
		);
	}
	return {
		doc_type: source.docType,
		"build_spec.version": source.buildSpecVersion,
		profile: source.profile,
		translations: source.translations,
		add_ons: source.addOns,
		langs: source.langs,
		auto_gps_capture: autoGpsCapture,
		cloudcare_enabled: source.cloudcareEnabled,
	};
}

/** One field of a lookup table's definition, as `LookupTableResource` serves it. */
interface ServedTableField {
	readonly field_name: string;
	readonly properties: readonly string[];
}

/**
 * What the peer answered for one lookup table a publish pushes, before the
 * publish wrote anything: the definition HQ held under its tag
 * (`fixtures/resources/v0_1.py::LookupTableResource`, without the id HQ
 * mints), or null where it held none, and, where the publish read them to
 * compare, the table's rows in order (`FixtureResource`, each row's
 * `fields` alone). These decide whether Nova pushes and what it compares,
 * so the HQ side holds each to HQ's own answer before it applies the
 * capture (`proof/hq/operations.py::hold_assumed_resources`).
 */
export interface AssumedLookupTable {
	readonly tag: string;
	readonly table: {
		readonly is_global: boolean;
		readonly fields: readonly ServedTableField[];
		readonly item_attributes: readonly string[];
	} | null;
	readonly rows?: readonly {
		readonly fields: Readonly<
			Record<
				string,
				| string
				| {
						readonly field_list: readonly {
							readonly field_value: string;
							readonly properties: Readonly<Record<string, string>>;
						}[];
				  }
			>
		>;
	}[];
}

/** What the peer answered for the project space's resources before a publish wrote anything. */
export interface AssumedResources {
	readonly lookupTables: readonly AssumedLookupTable[];
}

function servedDefinition(table: HqLookupTable): AssumedLookupTable["table"] {
	return {
		is_global: table.isGlobal,
		fields: table.fields.map((name) => ({
			field_name: name,
			properties: table.fieldProperties[name] ?? [],
		})),
		item_attributes: table.itemAttributes,
	};
}

/** A row's fields in the shape `FixtureResource.dehydrate_fields` served them. */
function servedRow(
	row: HqFixtureRow,
): NonNullable<AssumedLookupTable["rows"]>[number] {
	return {
		fields: Object.fromEntries(
			Object.entries(row.fields).map(([name, value]) => [
				name,
				typeof value === "string"
					? value
					: {
							field_list: value.map((item) => ({
								field_value: item.value,
								properties: item.properties,
							})),
						},
			]),
		),
	};
}

/**
 * What the capture holds of what Nova's ledger would after a publish: the
 * app's baseline (HQ's read after Nova's last write, normalized, with the
 * ownership of the body that write sent) and each pushed table's mapping
 * and baseline (`lib/deployment/store.ts`). A later publish compares HQ's
 * reads with these, as preflight compares them with the stored rows.
 */
interface CaptureLedger {
	readonly app: HeldRead;
	readonly tables: ReadonlyMap<LookupTableId, LedgerTable>;
}

/** A read of the app the publish holds, normalized, and how a later read is compared with it. */
interface HeldRead {
	readonly normalized: unknown;
	/** The ownership of the body the write before the read sent. */
	readonly ownership: AppOwnership;
	/**
	 * `create` while the app is the shell the first publish made, `read`
	 * while it is the app CommCare HQ's own pages made, as a bring-in of it
	 * left the read (`adoptedA`), `changes` once a review of changes made in
	 * CommCare HQ recorded the read.
	 */
	readonly origin: "create" | "read" | "push" | "changes";
	/** The read's digest and size, as the baseline stores them. */
	readonly digest: string;
	readonly bytes: number;
	/**
	 * The file Nova knows to stand at each path the app publishes
	 * (`app_deployment_baselines.media_files`), as the record after the
	 * write that left the read gives it, or null where Nova holds none.
	 */
	readonly mediaFiles: HqMediaRecord | null;
}

/**
 * The standings preflight settled for the files a publish sends, and the
 * ids it learned by content (`preflight.ts`, the `target-app` edge), which
 * the record after the upload takes.
 */
interface SettledMedia {
	readonly paths: readonly HqMediaPath[];
	readonly learned: HqMediaRecord;
	/**
	 * What settling read of each file, by id, where the caller asked to
	 * `retain` it (a review of changes made in CommCare HQ, whose judge of the
	 * files the sources name reads none of them again); empty otherwise.
	 */
	readonly reads: ReadonlyMap<string, SettledHqMediaRead>;
}

/**
 * The id CommCare HQ's upload report names for each path it matched, by wire
 * path, and none where the report holds an error or names no ids
 * (`lib/deployment/service.ts::reportedMediaFiles`).
 */
function reportedMediaFiles(result: MediaBundleUploadResult): HqMediaRecord {
	if (result.errors.length > 0 || result.matchedFiles === null) return {};
	const reported: Record<string, string> = {};
	for (const file of result.matchedFiles) {
		if (!file.path.startsWith(JR_FILE)) continue;
		const wirePath = file.path.slice(JR_FILE.length);
		if (isHoldableWirePath(wirePath)) reported[wirePath] = file.multimediaId;
	}
	return reported;
}

const JR_FILE = "jr://file/";

/**
 * The files `prepared` publishes, against the record and the map of one
 * source read, each a path whose id the record cannot vouch for settled by
 * its content through the peer (`preflight.ts`, the `target-app` edge:
 * `hqMediaStandings`, then `settleHqMedia`). The peer serves the map on
 * every app and every file it maps, so a read without a map, or a file it
 * cannot serve, stops the capture. A review passes `retain`, as
 * `hqChanges/review.ts` does, so each file is read once.
 */
async function settledMediaOf(
	prepared: PreparedDocument,
	read: HqAppSource,
	record: HqMediaRecord | null,
	options: { readonly retain?: boolean } = {},
): Promise<SettledMedia> {
	const published = publishedMediaFiles(
		bulkUploadAssets(prepared.export.doc, prepared.export.assets),
	);
	const map = read.multimediaMap;
	if (map === null && published.length > 0) {
		throw new Error(
			`The capture peer served the app of ${prepared.source.id} with no multimedia_map, which HQ serializes on every app, and Nova blocks a publish that sends a file over such a read.`,
		);
	}
	const standings = hqMediaStandings({ published, record, now: map ?? [] });
	if (
		!standings.some(
			(path) => path.standing === "moved" || path.standing === "unrecorded",
		)
	) {
		return { paths: standings, learned: {}, reads: new Map() };
	}
	const settled = await settleHqMedia(CREDENTIALS, standings, {
		...(options.retain === true && { retain: true }),
	});
	if (settled.kind === "failed") {
		throw new Error(
			`Nova could not read a file the capture peer maps for ${prepared.source.id} (${JSON.stringify(settled.failure)}), and the peer serves every file it maps.`,
		);
	}
	return {
		paths: settled.paths,
		learned: settled.learned,
		reads: settled.reads,
	};
}

/** One pushed table's mapping and the baseline read after the push. */
interface LedgerTable {
	readonly tag: string;
	readonly remoteId: string;
	readonly canonical: CanonicalLookupTable;
}

/** A source read normalized as a baseline is (`normalizeHqAppSource`); a read that does not normalize stops the capture. */
function normalizedRead(
	prepared: PreparedDocument,
	source: HqAppSource,
): {
	readonly normalized: unknown;
	readonly digest: string;
	readonly bytes: number;
} {
	const result = normalizeHqAppSource(source.raw);
	if ("malformed" in result) {
		throw new Error(
			`Nova's publish of ${prepared.source.id} read a source from the capture peer that is not an app's (${result.malformed}), so it would not have compared it.`,
		);
	}
	return result;
}

/**
 * The capture peer's save counter around one write it answered
 * (`TargetPeer.saveCounter`): right before it, null before a create, when
 * the peer holds no app, and right after it. A sidecar carries it, and the
 * HQ side holds HQ's own counter's move over the same write to it
 * (`proof/observe/publish.py`).
 */
export interface SaveCounterMove {
	readonly before: number | null;
	readonly after: number;
}

/** The peer's save counter around `write`, which must leave the peer holding an app. */
async function counted<T>(
	peer: TargetPeer,
	what: string,
	write: () => Promise<T>,
): Promise<{ readonly result: T; readonly counter: SaveCounterMove }> {
	const before = peer.saveCounter();
	const result = await write();
	const after = peer.saveCounter();
	if (after === null) {
		throw new Error(
			`The capture peer holds no app after ${what}, so it has no save counter to record; a write it answered leaves the app it was sent to.`,
		);
	}
	return { result, counter: { before, after } };
}

/** The requests one import sends: the workbook before it, the import, and the media after it. */
export interface SentImport {
	/** The lookup workbook upload, when the document references a table. */
	readonly lookup?: CapturedRequest;
	readonly importApp: CapturedRequest;
	/** The media upload after the import, when the export carries media. */
	readonly media?: CapturedRequest;
	/** The peer's save counter around the import. */
	readonly saveCounter: SaveCounterMove;
	/** The peer's save counter around the media upload, where one was sent. */
	readonly mediaSaveCounter?: SaveCounterMove;
	/** The application JSON the import carried. */
	readonly application: HqApplication;
	/** The overlay keys the application writes (`hqImportApplication`'s `ownership`). */
	readonly ownership: AppOwnership;
	/** The fields of the source read the import was built on. */
	readonly assumedSource: AssumedSource;
	/** What the peer answered for the tables the publish pushes, when it pushes any. */
	readonly assumedResources?: AssumedResources;
	/**
	 * What the project space keeps of the values Nova leaves to CommCare HQ
	 * after the import, from the source at the version HQ acknowledged. A
	 * download can use these even when another save left the next publish's
	 * comparison unconfirmed.
	 */
	readonly targetFacts: TargetFacts | null;
}

/**
 * Why Nova's preflight stopped a publish over what CommCare HQ holds: the
 * changes made there since Nova's last publish (`hq_changed`), tables
 * under Nova's tags that Nova cannot account for (`hq_resource_conflict`),
 * or tables under Nova's tags that hold what Nova's push would remove
 * (`hq_table_content_unsupported`), which no confirmation resolves; a build
 * profile on HQ's app naming a language the publish does not write
 * (`hq_build_profile_language_missing`), which no confirmation resolves
 * either; or the app's Web App setting differing from the declaration
 * (`hq_web_apps_change`).
 */
export interface PublishStop {
	readonly code:
		| "hq_changed"
		| "hq_resource_conflict"
		| "hq_table_content_unsupported"
		| "hq_build_profile_language_missing"
		| "hq_web_apps_change";
	readonly remoteChanges: readonly DeploymentRemoteChange[];
	/** The tables in conflict, by Nova's table id, with their tag and HQ's id. */
	readonly conflicts: readonly LookupTableConflict[];
	/** The Web Apps question, non-null exactly for `hq_web_apps_change`. */
	readonly webAppsChange: WebAppsChange | null;
}

/**
 * What a person confirmed to send a stopped publish again, as the publish
 * dialog sends it: each change to write over with the digest a stop showed
 * (`discardRemoteChanges`), and each table to take over
 * (`adoptResourceIds`). Preflight stops at the first edge that refuses, so a
 * table in conflict is listed before any change, and `stops` holds each
 * stop the publish met, in order, before the send that went through.
 */
export interface StopConfirmation {
	readonly stops: readonly PublishStop[];
	readonly discards: readonly RemoteChangeDiscard[];
	readonly adopted: readonly string[];
	/** The Web App setting the person agreed to write (`confirmWebApps`). */
	readonly webApps?: boolean;
}

/** One update of a document: refused by Nova's check, stopped by its preflight, or what it sent. */
export type StepOutcome =
	| {
			readonly status: "refused";
			readonly compatibility: CompatibilityOutcome;
	  }
	| ({ readonly status: "stopped" } & PublishStop)
	| ({
			readonly status: "sent";
			readonly compatibility: CompatibilityOutcome;
			/** Every request the step sent, `<method> <path>`, in the order it sent them. */
			readonly sequence: readonly string[];
			/** The stop this publish was sent through, and what the resend confirmed. */
			readonly confirmed?: StopConfirmation;
			/**
			 * The review of the changes made in CommCare HQ this publish was sent
			 * after, and what the bring-in or the record took of them.
			 */
			readonly broughtIn?: BringInRecord;
			/**
			 * The document this publish sent where a review of the changes made in
			 * CommCare HQ moved it from the update's own (`bringInOverPeer`): the
			 * document the bring-in gave, with the placements its emission records.
			 */
			readonly sent?: PublishDocument;
			/**
			 * The target-identity record `sent` was sent under, the one the
			 * bring-in left (`review.ts::takenTargetIdentity`): its menu and form
			 * ids and each keyed create's prefix (`exportIdentityOf`).
			 */
			readonly sentUnder?: TargetIdentity;
			/**
			 * The person's other choice over the same saves, publishing over the
			 * change, where the document states the capture runs it
			 * (`HqSideSaves.alsoPublishesOver`).
			 */
			readonly publishedOver?: PublishedOverRecord;
	  } & SentImport);

/** A first publish: refused by Nova's check, or the shell's create and the content's update it sent. */
export type FirstPublishOutcome =
	| {
			readonly status: "refused";
			readonly compatibility: CompatibilityOutcome;
	  }
	| {
			readonly status: "sent";
			readonly compatibility: CompatibilityOutcome;
			/** The shell's create, which names no app and pushes nothing before it. */
			readonly create: {
				readonly importApp: CapturedRequest;
				/** The peer's save counter around the create, from no app to the one it made. */
				readonly saveCounter: SaveCounterMove;
				readonly application: HqAppShell;
				/** The overlay keys the shell writes (`hqImportApplication`'s `ownership`). */
				readonly ownership: AppOwnership;
			};
			/** The update that fills the shell: state A's app. */
			readonly content: SentImport;
			/** Every request the first publish sent, `<method> <path>`, in the order it sent them. */
			readonly sequence: readonly string[];
	  };

function takeRequest(
	requests: readonly PeerRequest[],
	method: string,
	path: string,
): PeerRequest {
	const matching = requests.filter(
		(request) => request.method === method && request.path === path,
	);
	if (matching.length !== 1 || matching[0] === undefined) {
		throw new Error(
			`The capture expected Nova's client to send one ${method} ${path} in this step of the publish, and it sent ${matching.length}.`,
		);
	}
	return matching[0];
}

/** Each request, `<method> <path>`, in order. */
function sequenceOf(requests: readonly PeerRequest[]): string[] {
	return requests.map((request) => `${request.method} ${request.path}`);
}

/**
 * The compatibility check `publishAppToHq`'s preflight makes before any
 * write, with its read of the target's empty-list text flag, which never
 * changes the report.
 */
async function compatibilityCheck(
	peer: TargetPeer,
	prepared: PreparedDocument,
) {
	const probe = await probeHqProjectSpaceCompatibility(
		CREDENTIALS,
		peer.state.domain,
		projectSpaceCompatibilityProbePlan(prepared.export.doc),
		{ readEmptyCaseListText: true },
	);
	return { report: probe.report, outcome: compatibilityOutcome(probe.report) };
}

/** A source read of the app, as Nova's publish makes it; any answer but a source stops the capture. */
async function readSource(
	peer: TargetPeer,
	prepared: PreparedDocument,
	appId: string,
): Promise<HqAppSource> {
	const read = await readHqAppSource(CREDENTIALS, peer.state.domain, appId);
	if ("success" in read || read.kind !== "source") {
		throw new Error(
			`Nova's publish of ${prepared.source.id} could not read the app's source from the capture peer (${JSON.stringify(read)}), so it would not have sent the app's content.`,
		);
	}
	return read.source;
}

/** The table list read; any refusal stops the capture, since Nova would not push. */
async function readTables(
	peer: TargetPeer,
	prepared: PreparedDocument,
): Promise<readonly HqLookupTable[]> {
	const tables = await listHqLookupTables(CREDENTIALS, peer.state.domain);
	if ("success" in tables) {
		throw new Error(
			`Nova's publish of ${prepared.source.id} could not read the lookup tables from the capture peer (status ${tables.status}), so it would not have pushed them.`,
		);
	}
	return tables;
}

/** One table's rows read; any refusal stops the capture, since Nova's preflight would stop. */
async function readRows(
	peer: TargetPeer,
	prepared: PreparedDocument,
	table: HqLookupTable,
) {
	const rows = await readHqLookupTableRows(
		CREDENTIALS,
		peer.state.domain,
		table,
		{ maxRows: LOOKUP_MAX_ROWS, maxBytes: HQ_LOOKUP_TABLE_ROWS_MAX_BYTES },
	);
	if ("success" in rows) {
		throw new Error(
			`Nova's publish of ${prepared.source.id} could not read the rows of the lookup table ${table.id} from the capture peer (status ${rows.status}).`,
		);
	}
	if ("kind" in rows) {
		throw new Error(
			`Nova's publish of ${prepared.source.id} met the lookup table ${table.id} on the capture peer holding more than Nova reads of one table, which no capture's table does.`,
		);
	}
	return rows;
}

/** The author's name for each table the export carries, as preflight names a table in a change. */
function tableName(prepared: PreparedDocument, tableId: LookupTableId): string {
	return (
		prepared.export.lookupSnapshot.definitions.find(
			(definition) => definition.id === tableId,
		)?.name ?? tableId
	);
}

/**
 * Why CommCare HQ's table differs from Nova's copy of it, or null where it
 * holds the copy exactly: the same remote id, a table every worker reads
 * with no field property and no row attribute, the copy's columns as its
 * fields in order, and the copy's rows, value for value, in order. Where it
 * differs, Nova's `managed-data` edge would refresh its copy before the
 * export, or stop the publish (`managedData.ts::reReadManagedTablesForPublish`).
 */
function managedCopyDifference(
	definition: LookupTableDefinition,
	copyRows: readonly LookupFixtureRow[],
	table: HqLookupTable,
	rows: readonly HqFixtureRow[],
): string | null {
	if (table.id !== definition.hq?.remoteId) {
		return `CommCare HQ holds it under the id ${table.id}, and the copy names ${definition.hq?.remoteId}`;
	}
	if (
		!table.isGlobal ||
		table.itemAttributes.length > 0 ||
		Object.values(table.fieldProperties).some(
			(properties) => properties.length > 0,
		)
	) {
		return "CommCare HQ's table holds what Nova's copy cannot";
	}
	const wireNames = definition.columns.map((column) => column.wireName);
	if (JSON.stringify(table.fields) !== JSON.stringify(wireNames)) {
		return `CommCare HQ's fields are ${JSON.stringify(table.fields)}, and the copy's columns ${JSON.stringify(wireNames)}`;
	}
	if (rows.length !== copyRows.length) {
		return `CommCare HQ holds ${rows.length} rows, and the copy ${copyRows.length}`;
	}
	for (const [index, row] of rows.entries()) {
		const copy = copyRows[index];
		for (const column of definition.columns) {
			const held = row.fields[column.wireName];
			const value = copy?.values[column.id];
			if (typeof held !== "string" || held !== String(value ?? "")) {
				return `row ${index + 1}'s ${column.wireName} is ${JSON.stringify(held)} in CommCare HQ and ${JSON.stringify(value)} in the copy`;
			}
		}
	}
	return null;
}

/**
 * Preflight's `managed-data` edge over the peer, as
 * `lib/deployment/preflight.ts` runs it before every other edge that talks
 * to CommCare HQ (`managedData.ts::reReadManagedTablesForPublish`): where a
 * table the document reads is managed in CommCare HQ from the project space
 * the capture publishes to, the table list, then each such table's rows, in
 * table id order and as many at once as a publish reads
 * (`LOOKUP_ROWS_READ_CONCURRENCY`). Null where none is, which reads nothing.
 * Returns the list, which the `project-data` edge then reads again from
 * nothing, and what the peer answered for each table, which the HQ side
 * holds to HQ's own as it does a pushed table's.
 *
 * The capture models one project space holding each such table as Nova's
 * copy holds it, the state a publish passes over unchanged: a table managed
 * from another project space, which the capture's peer cannot answer for,
 * and one the peer lacks or holds otherwise than the copy, over which Nova's
 * publish would refresh its copy or stop, end the capture by name.
 */
async function managedDataEdge(
	peer: TargetPeer,
	prepared: PreparedDocument,
): Promise<{
	readonly hqTables: readonly HqLookupTable[];
	readonly assumed: readonly AssumedLookupTable[];
} | null> {
	const { tableIds } = extractLookupReferenceTargets(prepared.export.doc);
	const data = lookupFixtureData(prepared.source, tableIds);
	const managed = data.definitions.filter(
		(definition) => definition.hq?.managedBy === "commcare-hq",
	);
	if (managed.length === 0) return null;
	const elsewhere = managed.filter(
		(definition) =>
			definition.hq?.server !== PROOF_SERVER ||
			definition.hq.domain !== peer.state.domain,
	);
	if (elsewhere.length > 0) {
		throw new Error(
			`Corpus document ${prepared.source.id} reads ${elsewhere.map((definition) => definition.tag).join(", ")}, which CommCare HQ manages from another project space than ${peer.state.domain}. The capture's peer is one project space, so give the tables the origin of the project space the capture publishes to.`,
		);
	}
	const hqTables = await readTables(peer, prepared);
	const reads = await mapWithConcurrency(
		managed,
		LOOKUP_ROWS_READ_CONCURRENCY,
		async (definition) => {
			const table = hqTables.find(
				(candidate) => candidate.tag === definition.tag,
			);
			if (table === undefined) {
				throw new Error(
					`Nova's publish of ${prepared.source.id} would stop with hq_managed_data_changed: the capture peer holds no table under ${definition.tag}, which CommCare HQ manages there. Give the capture that table (\`PublishInput.hqTables\`).`,
				);
			}
			const rows = await readRows(peer, prepared, table);
			return { definition, table, rows: rows.rows };
		},
	);
	for (const { definition, table, rows } of reads) {
		const difference = managedCopyDifference(
			definition,
			data.rowsByTable.get(definition.id) ?? [],
			table,
			rows,
		);
		if (difference !== null) {
			throw new Error(
				`Nova's publish of ${prepared.source.id} would refresh its copy of ${definition.tag} or stop before anything else, since ${difference}. The capture holds the peer's table as the copy holds it; give the peer the copy's table.`,
			);
		}
	}
	return {
		hqTables,
		assumed: reads.map(({ table, rows }) => ({
			tag: table.tag,
			table: servedDefinition(table),
			rows: rows.map(servedRow),
		})),
	};
}

/** What the peer answered for the managed tables and for the tables a publish pushes, together. */
function assumedOf(
	managed: readonly AssumedLookupTable[] | undefined,
	pushed: AssumedResources | undefined,
): AssumedResources | undefined {
	if (managed === undefined && pushed === undefined) return undefined;
	return {
		lookupTables: [...(managed ?? []), ...(pushed?.lookupTables ?? [])],
	};
}

/**
 * Preflight's `project-data` edge over the peer, as
 * `lib/deployment/preflight.ts` runs it: the table list, the push plan
 * (`planLookupResourcePush`) over the tables the ledger maps, and for each
 * table the plan compares, where it is, then its definition, then its rows
 * (`hqResourceBaseline.ts`), the rows read only while the definition is
 * unchanged. The list is the one the `managed-data` edge read where it read
 * one (`listed`), as preflight reuses it. Returns the plan's conflicts, or
 * the changes it collected and what the peer answered for each table the
 * publish pushes.
 */
async function tableEdge(
	peer: TargetPeer,
	prepared: PreparedDocument,
	ledger: CaptureLedger | null,
	adopt: readonly string[],
	listed: readonly HqLookupTable[] | null,
): Promise<
	| { readonly unsupported: readonly LookupTableUnsupported[] }
	| { readonly conflicts: readonly LookupTableConflict[] }
	| {
			readonly observed: readonly DeploymentRemoteChange[];
			readonly assumed: AssumedResources;
	  }
	| null
> {
	const workbook = prepared.export.lookupWorkbook;
	if (workbook === undefined) return null;
	const hqTables = listed ?? (await readTables(peer, prepared));
	const mappings = [...(ledger?.tables ?? new Map()).entries()].map(
		([tableId, mapped]): DeploymentResource => ({
			deploymentId: "capture",
			kind: "lookup-table",
			novaResourceId: tableId,
			remoteId: mapped.remoteId,
			ownership: "nova-created",
			pushedIdentity: mapped.tag,
			adoptedAt: null,
			adoptedBy: null,
			pushedRevision: prepared.source.compiledAtSeq,
			pushedAt: null,
			pushToken: "capture",
			remoteRevision: null,
			remoteObservedAt: null,
			supersededAt: null,
			remoteMissingAt: null,
			adoptedByName: null,
			releasedAt: null,
			endedReason: null,
			endedByName: null,
			heldByAnotherApp: false,
		}),
	);
	const plan = planLookupResourcePush({
		tables: workbook.tables,
		mappings,
		hqTables,
		adoptTableIds: adopt,
		/* The capture publishes one app of its own Project, and no table of it
		 * was taken over from CommCare HQ: the ledger is the whole standing. */
		siblings: [],
		takenOver: [],
	});
	if (!plan.ok) {
		return "unsupported" in plan
			? { unsupported: plan.unsupported }
			: { conflicts: plan.conflicts };
	}
	const observed: DeploymentRemoteChange[] = [];
	const rowsRead = new Map<string, readonly HqFixtureRow[]>();
	for (const push of plan.pushes) {
		const mapped = ledger?.tables.get(push.tableId);
		if (push.mappedRemoteId === null || mapped === undefined) continue;
		const change = (
			parts: readonly string[],
			observedDigest: string,
		): DeploymentRemoteChange => ({
			kind: "lookup-table",
			novaResourceId: push.tableId,
			name: tableName(prepared, push.tableId),
			identity: push.tag,
			parts,
			note: null,
			observedDigest,
			baselineKnown: true,
			since: { kind: "published" },
			canBringIn: false,
		});
		const describe = (part: LookupChangePart) =>
			describeLookupChange(part, push.tag);
		const moved = lookupIdentityChange({
			mappedRemoteId: push.mappedRemoteId,
			tag: push.tag,
			tables: hqTables,
		});
		if (moved?.kind === "deleted") {
			observed.push(change([describe(moved)], ABSENT_RESOURCE_DIGEST));
			continue;
		}
		const current = hqTables.find((table) =>
			moved?.kind === "renamed"
				? table.id === push.mappedRemoteId
				: table.tag === push.tag,
		);
		if (current === undefined) {
			throw new Error(
				`The lookup table ${push.mappedRemoteId} the capture compared is not in the list it read.`,
			);
		}
		if (moved?.kind === "renamed") {
			observed.push(change([describe(moved)], lookupDefinitionDigest(current)));
			continue;
		}
		const definition = lookupDefinitionChange(mapped.canonical, current);
		if (definition.length > 0) {
			observed.push(
				change(definition.map(describe), lookupDefinitionDigest(current)),
			);
			continue;
		}
		const rows = await readRows(peer, prepared, current);
		rowsRead.set(push.tag, rows.rows);
		const changed = lookupRowsChange(mapped.canonical, rows);
		if (changed.length > 0) {
			observed.push(
				change(
					changed.map(describe),
					canonicalLookupTable(current, rows.rows).digest,
				),
			);
		}
	}
	return {
		observed,
		assumed: {
			lookupTables: workbook.tables.map((table) => {
				const held = hqTables.find((remote) => remote.tag === table.tag);
				const rows = rowsRead.get(table.tag);
				return {
					tag: table.tag,
					table: held === undefined ? null : servedDefinition(held),
					...(rows !== undefined && { rows: rows.map(servedRow) }),
				};
			}),
		},
	};
}

/** The instant a capture's ledger records an app brought in at, as its baseline's read date. */
const CAPTURE_OBSERVED_AT = new Date(CCZ_CLOCK).toISOString();

/**
 * What a change of the app is measured against, as
 * `lib/deployment/remoteChanges.ts::driftReferenceOf` gives it for the
 * baseline's origin: the bring-in of an app CommCare HQ made, a bring-in of
 * changes made there, or Nova's own publish.
 */
function sinceOf(origin: HeldRead["origin"]): DriftReference {
	return origin === "read"
		? { kind: "brought-in", at: CAPTURE_OBSERVED_AT }
		: origin === "changes"
			? { kind: "changes-brought-in" }
			: { kind: "published" };
}

/**
 * Preflight's app comparison over the peer (`preflight.ts`, the `target-app`
 * edge): HQ's read against the ledger's baseline under the baseline's
 * ownership, read as a shell while the baseline is the shell's, with each
 * file the publish sends that CommCare HQ holds another file in place of
 * (`media`, settled by content) as one `media` part. The change names the
 * whole normalized read's digest.
 */
function appEdge(
	prepared: PreparedDocument,
	appName: string,
	ledger: CaptureLedger,
	current: { readonly normalized: unknown; readonly digest: string },
	media: SettledMedia | null,
	languageNames: LanguageNames,
): DeploymentRemoteChange | null {
	const parts = diffHqAppSource({
		baseline: ledger.app.normalized,
		current: current.normalized,
		ownership: ledger.app.ownership,
		shell: ledger.app.origin === "create",
		languageNames,
		mediaChanged:
			media?.paths.filter((path) => path.standing === "replaced").length ?? 0,
	});
	if (parts.length === 0) return null;
	return {
		kind: "app",
		novaResourceId: prepared.source.id,
		name: appName,
		identity: PLACEHOLDER_APP_ID,
		parts: boundedParts(parts.map(describeAppChange)),
		note: null,
		observedDigest: current.digest,
		baselineKnown: true,
		/* The capture's app is one Nova's own publish made, its baseline that
		 * publish's read or the read a review of changes recorded, or one
		 * CommCare HQ's own pages made, its baseline the bring-in's read. */
		since: sinceOf(ledger.app.origin),
		/* Its baseline names the revision it describes and no fold baseline
		 * follows it, so the pair is usable (`hqChanges/reference.ts::usablePair`). */
		canBringIn: true,
	};
}

/**
 * The resource push and the import of the app's content, as `publishAppToHq`
 * makes them once the app exists and `read` is its last read: the lookup
 * workbook, then the re-list and each pushed table's rows read the ledger
 * records as its baseline (`service.ts::pushLookupTables`); then a second
 * source read (the push took time, and HQ may have changed the app), held
 * to the read this publish holds (`held`) by the drift comparison, which
 * must find nothing; then the import of the assembled application as an
 * update of `appId`. A read at the version the import acknowledged gives
 * the download its kept settings. It also gives the next publish its
 * baseline where the import raised the counter once. An export with media
 * then sends the ZIP of its assets to that app and reads the upload's status
 * (`service.ts::uploadMediaBytes`).
 */
async function sendContent(
	peer: TargetPeer,
	prepared: PreparedDocument,
	appName: string,
	report: ProjectSpaceCompatibilityReport,
	appId: string,
	read: HqAppSource,
	held: Pick<HeldRead, "normalized" | "ownership" | "origin" | "mediaFiles">,
	media: SettledMedia | null,
	assumedResources: AssumedResources | undefined,
	identity: WireIdentity = DERIVED_WIRE_IDENTITY,
	languageNames: LanguageNames = "nova",
	keyedCaseIds: readonly AdoptedKeyedCaseId[] = [],
): Promise<{
	readonly sent: SentImport;
	readonly ledger: CaptureLedger | null;
}> {
	const domain = peer.state.domain;
	const target = { server: PROOF_SERVER, domain };
	const mark = peer.requests.length;
	let source = read;
	const tables = new Map<LookupTableId, LedgerTable>();
	const workbook = prepared.export.lookupWorkbook;
	if (workbook !== undefined) {
		const pushed = await uploadLookupTableWorkbook(
			CREDENTIALS,
			domain,
			workbook.bytes,
			{ replace: true },
		);
		if (!pushed.success) {
			throw new Error(
				`The capture peer refused the lookup workbook of ${prepared.source.id} (status ${pushed.status}), which it accepts from every publish.`,
			);
		}
		const relisted = await readTables(peer, prepared);
		for (const table of workbook.tables) {
			const landed = relisted.find((remote) => remote.tag === table.tag);
			if (landed === undefined) {
				throw new Error(
					`The capture peer holds no table under ${table.tag} after the push that sent it.`,
				);
			}
			const rows = await readRows(peer, prepared, landed);
			tables.set(table.tableId, {
				tag: table.tag,
				remoteId: landed.id,
				canonical: canonicalLookupTable(landed, rows.rows),
			});
		}
		source = await readSource(peer, prepared, appId);
		const moved = diffHqAppSource({
			baseline: held.normalized,
			current: normalizedRead(prepared, source).normalized,
			ownership: held.ownership,
			shell: held.origin === "create",
			languageNames,
		});
		if (moved.length > 0) {
			throw new Error(
				`Nova's publish of ${prepared.source.id} would stop at its second source read: the app moved in the capture peer while its tables were pushed (${JSON.stringify(moved)}), and nothing moves it there.`,
			);
		}
		if (held.origin !== "create" && webAppsMovedDuringPush(read, source)) {
			throw new Error(
				`Nova's publish of ${prepared.source.id} would stop at its second source read: the app's Web App setting moved in the capture peer while its tables were pushed, and nothing moves it there.`,
			);
		}
		/* A file at a path this publish sends whose entry moved between the
		 * two reads (`mediaMovedBetween`), which nothing in the peer moves. */
		const between = mediaMovedBetween(
			read.multimediaMap ?? [],
			source.multimediaMap ?? [],
			publishedMediaFiles(
				bulkUploadAssets(prepared.export.doc, prepared.export.assets),
			),
		);
		if (
			buildProfileLanguageGaps(
				publishedLanguageCodes(prepared.export.doc),
				source.buildProfiles,
			).length > 0
		) {
			throw new Error(
				`Nova's publish of ${prepared.source.id} would stop at its second source read: a build profile on the app in the capture peer names a language the publish does not write (hq_build_profile_language_missing), and nothing saves a profile there while its tables are pushed.`,
			);
		}
		if (between.length > 0) {
			throw new Error(
				`Nova's publish of ${prepared.source.id} would settle a file at its second source read: a file it sends moved in the capture peer while its tables were pushed (${JSON.stringify(between.map((path) => path.wirePath))}), and nothing moves one there.`,
			);
		}
	}
	const { application, ownership } = hqImportApplication({
		prepared: prepared.export,
		target,
		compatibility: report,
		update: { appId, source },
		identity,
		/* On an app Nova brought in from CommCare HQ the language names and
		 * the seeds are the project space's (`service.ts::publishAppToHq`, an
		 * `adopted` mapping); on one Nova's own publish created they are
		 * Nova's. Each keyed create a bring-in recorded is printed under the
		 * prefix its cases stand under there, computed over the document the
		 * body is built from; a Nova-born deployment records none
		 * (`app_deployment_keyed_case_ids`). */
		languageNames,
		seeds: languageNames,
		keyedCaseIdPrefixes: keyedCaseIdPrefixesFor(
			prepared.export.doc,
			keyedCaseIds,
		),
	});
	const { result: imported, counter: saveCounter } = await counted(
		peer,
		`the import of ${prepared.source.id}`,
		() => importApp(CREDENTIALS, domain, appName, application, appId),
	);
	if (!imported.success) {
		throw new Error(
			`The capture peer refused the import of ${prepared.source.id} (status ${imported.status}), which it accepts from every publish.`,
		);
	}
	const afterImport =
		imported.version === null
			? null
			: await readHqAppSourceAtVersion(
					CREDENTIALS,
					domain,
					imported.appId,
					imported.version,
				);
	const readBack =
		afterImport !== null &&
		!("success" in afterImport) &&
		afterImport.kind === "source-at" &&
		saveCounter.before !== null &&
		afterImport.version > saveCounter.before
			? normalizedRead(prepared, afterImport.source)
			: null;
	const bulkAssets = bulkUploadAssets(
		prepared.export.doc,
		prepared.export.assets,
	);
	let reported: HqMediaRecord = {};
	let mediaSaveCounter: SaveCounterMove | undefined;
	if (bulkAssets.size > 0) {
		const { result: uploaded, counter } = await counted(
			peer,
			`the media upload of ${prepared.source.id}`,
			() =>
				uploadAppMediaBundle(
					CREDENTIALS,
					domain,
					imported.appId,
					atInstant(CCZ_CLOCK, () => buildMediaBulkUploadZip(bulkAssets)),
				),
		);
		mediaSaveCounter = counter;
		if ("success" in uploaded || uploaded.timedOut) {
			throw new Error(
				`The capture peer did not confirm the media upload of ${prepared.source.id} (${JSON.stringify(uploaded)}), which it accepts from every publish.`,
			);
		}
		reported = reportedMediaFiles(uploaded);
	}
	/* The record of which file stands at each path this publish sent
	 * (`service.ts`, `recordDeploymentMediaFiles` after the upload): the id
	 * CommCare HQ reported, else one preflight learned by content, else the
	 * previous record's. */
	const mediaFiles = nextHqMediaRecord({
		published: publishedMediaFiles(bulkAssets),
		previous: held.mediaFiles,
		learned: media?.learned ?? {},
		reported,
		settled: media?.paths ?? [],
	});
	const sent = peer.since(mark);
	return {
		sent: {
			...(workbook !== undefined && {
				lookup: await reframed(
					takeRequest(sent, "POST", `/a/${domain}/fixtures/fixapi/`),
				),
			}),
			importApp: await reframed(
				takeRequest(sent, "POST", `/a/${domain}/apps/api/import_app/`),
			),
			...(bulkAssets.size > 0 && {
				media: await reframed(
					takeRequest(
						sent,
						"POST",
						`/a/${domain}/apps/api/${imported.appId}/multimedia/`,
					),
				),
			}),
			saveCounter,
			...(mediaSaveCounter !== undefined && { mediaSaveCounter }),
			application,
			ownership,
			assumedSource: assumedSourceOf(source),
			...(assumedResources !== undefined && { assumedResources }),
			/* The deployment's mapping is `adopted` exactly where the
			 * language names are the project space's. */
			targetFacts:
				readBack === null
					? null
					: targetFactsFromSource(readBack.normalized, {
							observedAt: new Date(CCZ_CLOCK).toISOString(),
							novaOwnsAutoGpsCapture: ownership.autoGpsCapture,
							adopted: languageNames === "target",
						}),
		},
		ledger:
			readBack === null ||
			saveCounter.before === null ||
			!importReplacedReadApp(saveCounter.before, imported.version)
				? null
				: {
						app: {
							normalized: readBack.normalized,
							ownership,
							origin: "push",
							digest: readBack.digest,
							bytes: readBack.bytes,
							mediaFiles,
						},
						tables,
					},
	};
}

/**
 * A first publish as `publishAppToHq` makes it once its target is
 * reachable: the `managed-data` edge's reads where the app reads a table
 * CommCare HQ manages there (`managedDataEdge`), preflight's table list where
 * the app pushes tables (no table is mapped yet, so nothing is compared), the compatibility check (a blocked
 * report stops the publish before any write), the empty shell's create, the
 * source read of the app it made, which the ledger records as the shell's
 * baseline, then the app's content (`sendContent`). The shell is created
 * before any Project data is pushed, and holds nothing that reads it.
 */
async function firstPublish(
	peer: TargetPeer,
	prepared: PreparedDocument,
	appName: string,
): Promise<
	| { readonly outcome: Extract<FirstPublishOutcome, { status: "refused" }> }
	| {
			readonly outcome: Extract<FirstPublishOutcome, { status: "sent" }>;
			readonly ledger: CaptureLedger;
	  }
> {
	const domain = peer.state.domain;
	const start = peer.requests.length;
	const managed = await managedDataEdge(peer, prepared);
	const edge = await tableEdge(
		peer,
		prepared,
		null,
		[],
		managed?.hqTables ?? null,
	);
	if (edge !== null && ("conflicts" in edge || "unsupported" in edge)) {
		throw new Error(
			`Nova's first publish of ${prepared.source.id} found lookup tables it cannot account for in the capture peer (${JSON.stringify(edge)}), which holds none before it.`,
		);
	}
	const { report, outcome } = await compatibilityCheck(peer, prepared);
	if (report.status === "blocked") {
		return { outcome: { status: "refused", compatibility: outcome } };
	}
	const mark = peer.requests.length;
	const shell = hqImportApplication({
		prepared: prepared.export,
		target: { server: PROOF_SERVER, domain },
		compatibility: report,
		update: null,
		identity: DERIVED_WIRE_IDENTITY,
		languageNames: "nova",
		seeds: "nova",
		keyedCaseIdPrefixes: new Map(),
	});
	const { result: created, counter: createCounter } = await counted(
		peer,
		`the shell create of ${prepared.source.id}`,
		() => importApp(CREDENTIALS, domain, appName, shell.application),
	);
	if (!created.success) {
		throw new Error(
			`The capture peer refused the shell create of ${prepared.source.id} (status ${created.status}), which it accepts from every publish.`,
		);
	}
	const createRequest = takeRequest(
		peer.since(mark),
		"POST",
		`/a/${domain}/apps/api/import_app/`,
	);
	const read = await readSource(peer, prepared, created.appId);
	if (
		createdWithoutWebApps({
			declaresWebApps: declaresWebApps(prepared.export.doc),
			shell: read,
		})
	) {
		throw new Error(
			`Nova's first publish of ${prepared.source.id} would stop with hq_plan_lacks_web_apps: the capture peer made the app with Web Apps off for an app that declares Web Apps, and the lane's configuration grants CLOUDCARE to every document that does.`,
		);
	}
	const { sent: content, ledger } = await sendContent(
		peer,
		prepared,
		appName,
		report,
		created.appId,
		read,
		{
			normalized: normalizedRead(prepared, read).normalized,
			ownership: shell.ownership,
			origin: "create",
			/* A new HQ app holds no file. */
			mediaFiles: null,
		},
		/* A shell holds no file, so preflight settles none. */
		null,
		assumedOf(managed?.assumed, edge?.assumed),
	);
	if (ledger === null) {
		throw new Error(
			`The content import into the new shell for ${prepared.source.id} left no confirmed baseline. A new shell has no media map to prune.`,
		);
	}
	return {
		outcome: {
			status: "sent",
			compatibility: outcome,
			create: {
				importApp: await reframed(createRequest),
				saveCounter: createCounter,
				application: shell.application,
				ownership: shell.ownership,
			},
			content,
			sequence: sequenceOf(peer.since(start)),
		},
		ledger,
	};
}

/**
 * A later publish as `publishAppToHq` makes it over an app it reached:
 * the `managed-data` edge (`managedDataEdge`), preflight's table edge
 * (`tableEdge`), the compatibility check, the
 * `target-app` source read and its comparison with the ledger's baseline
 * (`appEdge`), the verdict over every change collected
 * (`remoteChanges.ts::decideRemoteChanges`, under what `confirm` names),
 * then the Web Apps question (`webApps.ts::webAppsChange`, under what
 * `confirm` answers), then the app's content (`sendContent`). A conflict, a
 * change nobody confirmed or an unanswered Web Apps question stops it before
 * any write, as preflight's `hq_resource_conflict`, `hq_changed` and
 * `hq_web_apps_change` do.
 */
async function updateStep(
	peer: TargetPeer,
	prepared: PreparedDocument,
	appName: string,
	ledger: CaptureLedger,
	confirm: StopConfirmation | undefined,
	identity: WireIdentity = DERIVED_WIRE_IDENTITY,
	languageNames: LanguageNames = "nova",
	keyedCaseIds: readonly AdoptedKeyedCaseId[] = [],
): Promise<StepOutcome> {
	const start = peer.requests.length;
	const managed = await managedDataEdge(peer, prepared);
	const edge = await tableEdge(
		peer,
		prepared,
		ledger,
		confirm?.adopted ?? [],
		managed?.hqTables ?? null,
	);
	if (edge !== null && "unsupported" in edge) {
		return {
			status: "stopped",
			code: "hq_table_content_unsupported",
			remoteChanges: [],
			conflicts: [],
			webAppsChange: null,
		};
	}
	if (edge !== null && "conflicts" in edge) {
		return {
			status: "stopped",
			code: "hq_resource_conflict",
			remoteChanges: [],
			conflicts: edge.conflicts,
			webAppsChange: null,
		};
	}
	const { report, outcome } = await compatibilityCheck(peer, prepared);
	if (report.status === "blocked") {
		return { status: "refused", compatibility: outcome };
	}
	const read = await readSource(peer, prepared, PLACEHOLDER_APP_ID);
	const current = normalizedRead(prepared, read);
	const media =
		ledger.app.origin === "create"
			? null
			: await settledMediaOf(prepared, read, ledger.app.mediaFiles);
	const app = appEdge(prepared, appName, ledger, current, media, languageNames);
	const verdict = decideRemoteChanges({
		observed: [...(app === null ? [] : [app]), ...(edge?.observed ?? [])],
		discards: confirm?.discards ?? [],
	});
	if (!verdict.proceed) {
		return {
			status: "stopped",
			code: "hq_changed",
			remoteChanges: verdict.remoteChanges,
			conflicts: [],
			webAppsChange: null,
		};
	}
	/* The `build-profiles` edge, after `hq-changes`, as preflight asks it:
	 * a profile on HQ's app that names a language this publish does not
	 * write stops it before any write. */
	if (
		buildProfileLanguageGaps(
			publishedLanguageCodes(prepared.export.doc),
			read.buildProfiles,
		).length > 0
	) {
		return {
			status: "stopped",
			code: "hq_build_profile_language_missing",
			remoteChanges: [],
			conflicts: [],
			webAppsChange: null,
		};
	}
	/* The `web-apps` edge, after `hq-changes`, as preflight asks it. */
	const change = webAppsChange({
		declaresWebApps: declaresWebApps(prepared.export.doc),
		held: read.cloudcareEnabled,
		baseline: { origin: ledger.app.origin, source: ledger.app.normalized },
		confirmWebApps: confirm?.webApps,
		since: sinceOf(ledger.app.origin),
	});
	if (change !== null) {
		return {
			status: "stopped",
			code: "hq_web_apps_change",
			remoteChanges: [],
			conflicts: [],
			webAppsChange: change,
		};
	}
	const { sent } = await sendContent(
		peer,
		prepared,
		appName,
		report,
		PLACEHOLDER_APP_ID,
		read,
		{ ...ledger.app, normalized: current.normalized },
		media,
		assumedOf(managed?.assumed, edge?.assumed),
		identity,
		languageNames,
		keyedCaseIds,
	);
	return {
		status: "sent",
		compatibility: outcome,
		...sent,
		...(confirm !== undefined && { confirmed: confirm }),
		sequence: sequenceOf(peer.since(start)),
	};
}

// ── Changes made in CommCare HQ ─────────────────────────────────────

/** The reading id of every review the capture makes: a UUIDv7 written out, which orders nothing. */
export const CAPTURE_READING_ID = "01900000-0000-7000-8000-000000000000";

/** The deployment the capture's app stands for, as a review's basis names it. */
const CAPTURE_DEPLOYMENT = { id: "proof-capture", endings: 0 } as const;

/**
 * What a publish over a person's saves in HQ read and took of them, where
 * its first send stopped over a change Nova can bring in: the review Nova
 * made (`lib/deployment/hqChanges/review.ts::checkHqChanges`), what the
 * bring-in or the record took, the second review over the record, which
 * finds nothing, and the summary of the app the review read, which the peer
 * models (`./hqSummary.ts`) and the HQ side holds to HQ's own answer after
 * the same saves.
 */
export interface BringInRecord {
	readonly review: HqChangesReview;
	/** Exact places in the current reading when the review newly lists the removal of unshown form media. */
	readonly unshownMediaPlaces?: readonly string[];
	/** `brought-in`: the change was committed; `recorded`: nothing in the app changed. */
	readonly taken: "brought-in" | "recorded";
	/** Whether the bring-in removed changes made in Nova (the plan applied to the published document). */
	readonly discarded: boolean;
	/** How many mutations the batch held. */
	readonly mutations: number;
	/** The menus and forms the app holds with the ids CommCare HQ holds them by, as the record keeps them. */
	readonly identities: readonly DeploymentIdentityOverride[];
	/** The review over the record, before the publish that follows. */
	readonly again: HqChangesReview;
	readonly assumedSummary: readonly HqApplicationModule[];
	/** The document the app holds after the bring-in, as stored. */
	readonly document: PersistableDoc;
	/**
	 * The review's reading of the app as the peer held it after the saves:
	 * the reading's document and one identity row a menu and a form, under
	 * the ids the peer's summary names. The HQ side holds HQ's own answer
	 * after the same saves to it, naming each file by the bytes HQ serves at
	 * its path (`proof/checks/proof6.py::saved_requests`). Absent where the
	 * review read no document (it found the app unchanged, or the files alone
	 * said it reads the same).
	 */
	readonly reading?: {
		readonly doc: PersistableDoc;
		readonly identity: readonly WireIdentityOverride[];
	};
}

/**
 * A publish over a person's saves in HQ that the person chose to send over
 * the change rather than bring it in (`publishOver`): the change its first
 * send stopped over, and the document CommCare HQ's map names at each path
 * the publish sent once the discard went through, which is the document of
 * Nova's own bytes there (`hqmedia/tasks.py::process_bulk_upload_zip`
 * finds a file's document by its content and maps the path to it).
 */
export interface PublishedOverRecord {
	readonly stoppedOver: readonly DeploymentRemoteChange[];
	/** Wire path to the id of the document CommCare HQ's map names there after the publish. */
	readonly mapped: Readonly<Record<string, string>>;
}

/**
 * The person's other choice over the saves a document states it brings in:
 * a separate next publish over A, which stops over the change, is sent
 * again with the discard a person who read the stop confirms, and leaves
 * CommCare HQ's map naming, at every path the publish sent, the document of
 * the bytes Nova sent there.
 */
async function publishOver(input: {
	readonly peer: TargetPeer;
	readonly stateA: PeerHolding;
	readonly prepared: PreparedDocument;
	readonly appName: string;
	readonly ledger: CaptureLedger;
}): Promise<PublishedOverRecord> {
	const { peer, prepared, appName, ledger } = input;
	const id = prepared.source.id;
	peer.restore(input.stateA);
	const stopped = await updateStep(peer, prepared, appName, ledger, undefined);
	if (stopped.status !== "stopped" || stopped.code !== "hq_changed") {
		throw new Error(
			`hq-side.json states that the capture also publishes ${id} over a person's saves in HQ, and the publish ${stopped.status === "stopped" ? `stopped with ${stopped.code}` : "went through"} where it stops over the change first.`,
		);
	}
	peer.restore(input.stateA);
	const sent = await updateStep(
		peer,
		prepared,
		appName,
		ledger,
		confirming(undefined, stopped),
	);
	if (sent.status !== "sent") {
		throw new Error(
			`Nova's publish of ${id} over a person's saves in HQ, sent again with the discard of ${JSON.stringify(stopped.remoteChanges)}, answered ${JSON.stringify(sent)}.`,
		);
	}
	const mapped: Record<string, string> = {};
	for (const asset of bulkUploadAssets(
		prepared.export.doc,
		prepared.export.assets,
	).values()) {
		const file = peer.mappedAt(`${JR_FILE}${asset.wirePath}`);
		if (
			file === undefined ||
			asset.bytes === undefined ||
			file.md5 !== createHash("md5").update(asset.bytes).digest("hex")
		) {
			throw new Error(
				`Nova's publish of ${id} over a person's saves in HQ sent its own file at ${asset.wirePath}, and CommCare HQ's map names ${file === undefined ? "no document" : `the document ${file.id}, of other bytes,`} there after it.`,
			);
		}
		mapped[asset.wirePath] = file.id;
	}
	return { stoppedOver: stopped.remoteChanges, mapped };
}

/** The deployment's live mapping of the app the capture publishes. */
function captureMapping(appId: string, pushedRevision: number) {
	return {
		deploymentId: CAPTURE_DEPLOYMENT.id,
		kind: "app",
		novaResourceId: appId,
		remoteId: PLACEHOLDER_APP_ID,
		ownership: "nova-created",
		pushedIdentity: null,
		adoptedAt: null,
		adoptedBy: null,
		pushedRevision,
		pushedAt: new Date(CCZ_CLOCK).toISOString(),
		pushToken: CAPTURE_DEPLOYMENT.id,
		remoteRevision: null,
		remoteObservedAt: null,
		supersededAt: null,
		remoteMissingAt: null,
		adoptedByName: null,
		releasedAt: null,
		endedReason: null,
		endedByName: null,
		heldByAnotherApp: false,
	} satisfies DeploymentResource;
}

/**
 * The Project's side of a review's read of its data, for a document whose
 * Project data the capture holds (`PublishDocument.lookup`): the Project's
 * tables of the tags read, no other app reading them, no column kept where
 * CommCare HQ's fields lack it (the capture holds no reference edge and no
 * design protection, `readKeptLookupColumnIds`'s two sources), no sibling
 * mapping, and a member who may administer it. The capture measures no
 * candidate's rows: a document whose changed app reads a table CommCare HQ
 * holds and Nova does not is no document of the capture's.
 */
function captureProjectSide(source: PublishDocument): ReadingProjectSide {
	return {
		async tables(tags) {
			const wanted = new Set(tags);
			const lookup = source.lookup;
			const definitions = (lookup?.definitions ?? []).filter((definition) =>
				wanted.has(definition.tag),
			);
			return {
				projectId: projectOf(source),
				projectRevision: lookup?.projectRevision ?? parseLookupRevision("0"),
				definitions,
				rowsByTable: Object.fromEntries(
					definitions.map((definition) => [
						definition.id,
						lookup?.rowsByTable.get(definition.id) ?? [],
					]),
				),
				keptColumns: {},
			};
		},
		async referencingApps() {
			return {};
		},
		async siblings() {
			return [];
		},
		async mayAdminister() {
			return true;
		},
		async measureRows() {
			throw new Error(
				`A review of ${source.id} met a lookup table CommCare HQ holds that Nova does not, whose rows Postgres would measure; the capture has no Postgres to measure them in.`,
			);
		},
	};
}

/**
 * One review of the changes made in CommCare HQ to the app the peer holds,
 * as `computeHqChanges` makes it, in its order: the deployment's baseline
 * (the ledger's app read) and its pair, the head (`prepared`, which is the
 * reference too: nothing in Nova is unpublished), the bracketed read (the
 * source, and the application resource whose summary the peer models,
 * aligned by `alignHqForms`), the files the reference publishes, the
 * publish's own comparison, the flag a write saved only if changed needs,
 * the Project's data, both readings and the files they name, each fetched
 * from the peer and judged (`judgeReadingMedia`), then `checkHqChanges`
 * itself. `keepMedia` is the review's own option: a bring-in keeps the bytes
 * of each file it may take, to publish it to the Project.
 */
async function reviewOverPeer(input: {
	readonly peer: TargetPeer;
	readonly prepared: PreparedDocument;
	readonly ledger: CaptureLedger;
	readonly pushedRevision: number;
	/** The target-identity record the deployment holds (`store.ts::readTargetIdentity`). */
	readonly targetIdentity: TargetIdentity;
	readonly keepMedia: boolean;
}): Promise<{
	readonly review: HqChangesReview;
	/** What the review read, from the publish's own comparison on; null where it found the app unchanged. */
	readonly basis: HqChangesBasis | null;
	readonly fetched: FetchedHqChanges | null;
	readonly checked: CheckedHqChanges | null;
	readonly summary: readonly HqApplicationModule[];
}> {
	const { peer, prepared, ledger } = input;
	const domain = peer.state.domain;
	const target = { server: PROOF_SERVER, domain };
	const head = {
		doc: prepared.export.doc,
		seq: prepared.source.compiledAtSeq,
	};
	const appId = head.doc.appId;
	const observedAt = new Date(CCZ_CLOCK).toISOString();
	const live = captureMapping(appId, input.pushedRevision);
	const baseline = {
		origin: ledger.app.origin === "changes" ? "changes" : "push",
		remoteAppId: PLACEHOLDER_APP_ID,
		source: ledger.app.normalized,
		sourceDigest: ledger.app.digest,
		ownership: ledger.app.ownership,
		observedAt,
		observedBy: "proof-capture",
		novaRevision: head.seq,
		mediaFiles: ledger.app.mediaFiles,
		sourceBytes: ledger.app.bytes,
	} satisfies PairedBaseline;
	const since = driftReferenceOf(baseline, live);

	/* The bracketed read: the source, and the summary the resource gives. */
	const read = await readHqAppSource(CREDENTIALS, domain, PLACEHOLDER_APP_ID, {
		admit: "any",
	});
	if ("success" in read || read.kind !== "source") {
		throw new Error(
			`A review of ${prepared.source.id} could not read the app's source from the capture peer (${JSON.stringify(read)}).`,
		);
	}
	const source = read.source;
	const summary = hqApplicationModules(source);
	const alignment = alignHqForms(source, summary);
	if (alignment.kind === "misaligned") {
		throw new Error(
			`A review of ${prepared.source.id} could not align the peer's summary with its source (${alignment.at}); the two are read from one app.`,
		);
	}
	const normalized = normalizeHqAppSource(source.raw);
	if ("malformed" in normalized) {
		throw new Error(
			`A review of ${prepared.source.id} read a source from the capture peer that is not an app's (${normalized.malformed}).`,
		);
	}
	const reference = {
		kind: "ok",
		doc: head.doc,
		identityDoc: head.doc,
		renamesSince: [],
		actors: [],
	} satisfies Extract<ReferenceDocument, { readonly kind: "ok" }>;

	/* The files the reference publishes, settled by content. */
	const {
		paths: published,
		learned,
		reads: settledReads,
	} = await settledMediaOf(prepared, source, baseline.mediaFiles, {
		retain: true,
	});

	/* The publish's own comparison. */
	const parts = diffHqAppSource({
		baseline: baseline.source,
		current: normalized.normalized,
		ownership: baseline.ownership,
		shell: false,
		languageNames: "nova",
		mediaChanged: published.filter((path) => path.standing === "replaced")
			.length,
	});
	const ownRows = new Map<string, MediaAssetRecord>();
	{
		const { realIds, builtinSlugs } = partitionAssetRefs(
			published.map((path) => path.assetId),
		);
		for (const row of [
			...(await mediaRows(prepared.source, realIds)),
			...builtinAssetRows(builtinSlugs),
		])
			ownRows.set(row.id, row);
	}
	const basis = {
		scope: {
			appId,
			projectId: projectOf(prepared.source),
			role: "editor",
			actorUserId: PROOF_PROJECT,
		},
		target,
		readingId: CAPTURE_READING_ID,
		deployment: CAPTURE_DEPLOYMENT,
		live,
		baseline,
		since,
		projectName: PROOF_PROJECT_NAME,
		head,
		reference,
		targetIdentity: input.targetIdentity,
		observedAt,
		source,
		modules: alignment.modules,
		normalized,
		published,
		learned,
		ownRows,
	} satisfies HqChangesBasis;
	if (parts.length === 0) {
		if (Object.keys(learned).length === 0) {
			return {
				review: {
					kind: "nothing",
					reason: "unchanged",
					since,
					hqChanges: [],
					publishChanges: [],
					readingId: null,
					reviewDigest: null,
				},
				basis: null,
				fetched: null,
				checked: null,
				summary,
			};
		}
		/* Two documents of one content at a path: the id is recorded, and
		 * nothing Nova publishes moved. */
		return {
			review: {
				kind: "nothing",
				reason: "reads-the-same",
				since,
				hqChanges: [],
				publishChanges: [],
				readingId: CAPTURE_READING_ID,
				reviewDigest: hqChangesReviewDigest({
					v: 1,
					baselineDigest: baseline.sourceDigest,
					sourceDigest: normalized.digest,
					headSeq: head.seq,
					media: published,
					target: null,
					tables: [],
				}),
			},
			basis,
			fetched: null,
			checked: null,
			summary,
		};
	}

	/* The flag a write saved only if changed needs. */
	const baseSource = sourceFromBaseline(baseline.source);
	let saveOnlyEditedApplied: boolean | undefined;
	if (
		sourceHoldsEditMode(publishedCaseBlocks(source.raw)) ||
		sourceHoldsEditMode(publishedCaseBlocks(baseSource.raw))
	) {
		const flag = await readHqSaveOnlyEditedAnswers(CREDENTIALS, domain);
		if (flag.kind !== "applied" && flag.kind !== "not-applied") {
			throw new Error(
				`A review of ${prepared.source.id} could not read whether the capture peer's project space saves only answers that changed (${flag.kind}).`,
			);
		}
		saveOnlyEditedApplied = flag.kind === "applied";
	}

	/* The Project's data both sources may read. */
	const projectData = await readReadingProjectData({
		creds: CREDENTIALS,
		server: PROOF_SERVER,
		domain,
		appId,
		readingId: CAPTURE_READING_ID,
		source,
		alsoSource: baseSource,
		project: captureProjectSide(prepared.source),
		places: "when-source-reads",
	});
	if (projectData.kind !== "read") {
		throw new Error(
			`A review of ${prepared.source.id} could not read the Project's data from the capture peer (${JSON.stringify(projectData)}).`,
		);
	}
	const fetched: FetchedHqChanges = {
		...basis,
		...(saveOnlyEditedApplied !== undefined && { saveOnlyEditedApplied }),
		data: projectData.data,
	};

	/* Both readings before the files, to know which files they name. */
	const first = makeHqChangeReadings({
		appId,
		target: { origin: COMMCARE_SERVERS[PROOF_SERVER].baseUrl, domain },
		baselineSource: baseline.source,
		now: { source, modules: alignment.modules },
		data: projectData.data,
		...(saveOnlyEditedApplied !== undefined && { saveOnlyEditedApplied }),
		reference,
		overrides: input.targetIdentity.entities,
		media: { published, base: null, now: null },
	});
	if (first.kind === "no-base") {
		return {
			review: { kind: "unavailable", reason: first.reason, since },
			basis,
			fetched: null,
			checked: null,
			summary,
		};
	}
	const nowFirst = first.readings.now;
	const baseFirst = first.readings.base;
	/* Production reads places again where a reading reads them and the source
	 * test missed the spelling, and logs it as Nova's defect: here it fails. */
	if (
		!projectData.data.placesRead &&
		(projectDataReadsOf(projectData.data, nowFirst).readsPlaces ||
			projectDataReadsOf(projectData.data, baseFirst).readsPlaces)
	) {
		throw new Error(
			`A review of ${prepared.source.id} reads places its sources' text did not show it reads (readReadingProjectData's source test missed a spelling); production reads them again and logs that as Nova's defect.`,
		);
	}
	/* What the Project's data the reading now reads holds that Nova can't
	 * hold, which production adds to the reading's own findings. */
	const projectFindings = projectDataFindingsNow(
		basis,
		projectData.data,
		nowFirst,
	);
	if (nowFirst.kind === "account") {
		return {
			review: accountReview([...nowFirst.findings, ...projectFindings]),
			basis,
			fetched,
			checked: null,
			summary,
		};
	}
	/* Each side's files less the paths it names Nova's own file by
	 * (`review.ts::plannedMedia`): every path the reference publishes on the
	 * base's side, and on the side now each one `recorded` or `absent`. */
	const runsOn: readonly Platform[] =
		head.doc.appSettings.runsOnlyOn === undefined
			? PLATFORMS
			: [head.doc.appSettings.runsOnlyOn];
	const base = planChangeReadingMedia(
		baseSource,
		appId,
		baseFirst.draft,
		ownPathsBase(published),
		runsOn,
	);
	const now = planChangeReadingMedia(
		source,
		appId,
		nowFirst.draft,
		new Set(
			published
				.filter(
					(path) => path.standing === "recorded" || path.standing === "absent",
				)
				.map((path) => `${JR_FILE}${path.wirePath}`),
		),
		runsOn,
	);
	if (projectFindings.length > 0 || now.media.findings.length > 0) {
		return {
			review: accountReview([...projectFindings, ...now.media.findings]),
			basis,
			fetched,
			checked: null,
			summary,
		};
	}

	/* The files both sources name, each fetched once from the peer and judged:
	 * a file settling a published path read is not asked for again. */
	const union = unionPlan(base.plan, now.plan);
	const readLimit = mediaReadLimit(union.files);
	if (readLimit)
		return {
			review: accountReview([readLimit]),
			basis,
			fetched,
			checked: null,
			summary,
		};
	let judged: Pick<ReadingMediaPlan, "verdicts" | "kept" | "published"> = union;
	if (union.files.length > 0) {
		const read = await judgeReadingMedia({
			creds: CREDENTIALS,
			plan: union,
			keep: input.keepMedia,
			fetched: settledReads,
			onProgress: () => {},
		});
		if (read.kind === "failed") {
			throw new Error(
				`A review of ${prepared.source.id} could not read a file the capture peer maps (${JSON.stringify(read.failure)}), and the peer serves every file it maps.`,
			);
		}
		judged = read.plan;
	}

	/* The check: both readings with the files' verdicts, acceptance and the plan. */
	const result = await checkHqChanges(
		fetched,
		{ base: withJudged(base.plan, judged), now: withJudged(now.plan, judged) },
		projectData.data,
		new Pieces(),
	);
	return {
		review: result.review,
		basis,
		fetched,
		checked: result.kind === "checked" ? result.checked : null,
		summary,
	};
}

/** Two stored documents' first difference, as a JSON path. */
function firstStoredDifference(a: unknown, b: unknown, path = ""): string {
	if (isDeepStrictEqual(a, b)) return "";
	if (
		typeof a === "object" &&
		a !== null &&
		typeof b === "object" &&
		b !== null &&
		Array.isArray(a) === Array.isArray(b)
	) {
		const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
		for (const key of keys) {
			const found = firstStoredDifference(
				(a as Record<string, unknown>)[key],
				(b as Record<string, unknown>)[key],
				`${path}/${key}`,
			);
			if (found !== "") return found;
		}
	}
	return path === "" ? "/" : path;
}

/** The value at a JSON path `firstStoredDifference` gives. */
function valueAt(value: unknown, path: string): unknown {
	let at = value;
	for (const key of path.split("/").slice(1)) {
		if (at === null || typeof at !== "object") return undefined;
		at = (at as Record<string, unknown>)[key];
	}
	return at;
}

/**
 * The asset of the Project's library that holds the bytes of SHA-256
 * `contentHash`, which a bring-in's publication of a file of those bytes
 * answers with (`lib/media/publishReadyMedia.ts`: a file whose bytes the
 * Project already holds is that asset). The capture holds no library to
 * publish a new file to, so a document whose bring-in takes a file is given
 * that file among its Project's media, and one that is not is refused by
 * name.
 */
function projectAssetOf(
	source: PublishDocument,
	contentHash: string,
): MediaAssetId {
	for (const [assetId, asset] of source.media ?? []) {
		if (sha256(asset.bytes) === contentHash) return asMediaAssetId(assetId);
	}
	throw new Error(
		`Nova's bring-in of ${source.id} takes a file CommCare HQ holds whose bytes the document's Project does not hold, and the capture has no library to publish it to. Give the document that file among its media.`,
	);
}

/**
 * What a publish over a person's saves does where it stopped over a change
 * of the app Nova can bring in, as the publish dialog's panel does it: the
 * review (`reviewOverPeer`), then, as the statement says, the bring-in of
 * a review that lists changes (`brings-in`: the batch committed at the next
 * revision, the record of `bringIn.ts::takenFor`, the ids CommCare HQ holds
 * for every menu and form of the reading, the ownership the next publish's
 * body gives over the read, and the document the app takes, which must be
 * the stated one) or the record of a review that finds nothing to bring in
 * (`records`: the review's reason and the changes it lists for the next
 * publish, which must be the stated ones), then the review over the record,
 * which must find nothing. Returns the ledger, the document and the ids the
 * publish that follows sends, with the record.
 */
async function bringInOverPeer(input: {
	readonly peer: TargetPeer;
	readonly prepared: PreparedDocument;
	readonly ledger: CaptureLedger;
	/** The target-identity record the deployment holds before the bring-in. */
	readonly targetIdentity: TargetIdentity;
	readonly pushedRevision: number;
	readonly statement: "brings-in" | "records";
	readonly bringsIn: PersistableDoc | undefined;
	readonly recorded: HqSideRecorded | undefined;
	/** The changes of the next publish a `brings-in` statement says its review lists. */
	readonly publishChanges: readonly FirstPublishChangeId[] | undefined;
	readonly attachmentTarget: AttachmentUrlTarget;
	readonly lookupTarget: LookupTarget;
}): Promise<{
	readonly ledger: CaptureLedger;
	readonly prepared: PreparedDocument;
	/** The record the bring-in leaves, which the publish that follows prints under. */
	readonly targetIdentity: TargetIdentity;
	readonly record: BringInRecord;
}> {
	const { peer, prepared, ledger, statement } = input;
	const id = prepared.source.id;
	const reviewed = await reviewOverPeer({
		peer,
		prepared,
		ledger,
		pushedRevision: input.pushedRevision,
		targetIdentity: input.targetIdentity,
		/* A bring-in keeps the bytes of each file it may take, to publish it. */
		keepMedia: statement === "brings-in",
	});
	const { review, basis, fetched } = reviewed;
	let { checked } = reviewed;
	const expected = statement === "brings-in" ? "changes" : "nothing";
	if (
		review.kind !== expected ||
		basis === null ||
		(review.kind === "changes" && (fetched === null || checked === null))
	) {
		throw new Error(
			`hq-side.json states that Nova's republish of ${id} ${statement === "brings-in" ? "brings in the changes a person made in HQ" : "finds nothing in a person's saves in HQ to bring in"}, and Nova's review of them answered ${JSON.stringify(review)}. Look at what the review reads of the saves, or at the statement.`,
		);
	}
	if (review.kind === "nothing") {
		const stated = input.recorded;
		const listed =
			stated === undefined
				? undefined
				: publishChangeSentences(stated.publishChanges);
		if (
			stated === undefined ||
			review.reason !== stated.reason ||
			!isDeepStrictEqual(review.publishChanges, listed)
		) {
			throw new Error(
				`hq-side.json states that Nova's review of ${id} finds nothing to bring in for the reason ${JSON.stringify(stated?.reason)} and lists ${JSON.stringify(listed)} for the next publish, and it answered the reason ${JSON.stringify(review.reason)} and listed ${JSON.stringify(review.publishChanges)}. Look at what the review reads of the saves, or at the statement.`,
			);
		}
	}
	if (review.kind === "changes") {
		const listed =
			input.publishChanges === undefined
				? undefined
				: publishChangeSentences(input.publishChanges);
		if (!isDeepStrictEqual(review.publishChanges, listed)) {
			throw new Error(
				`hq-side.json states that Nova's review of ${id} lists ${JSON.stringify(listed)} for the next publish, and it listed ${JSON.stringify(review.publishChanges)}. Look at what the review reads of the saves, or at the statement.`,
			);
		}
	}

	/* The files the app takes from CommCare HQ, published to the Project
	 * (`bringIn.ts::bringChangesIn`), then the check once more over exactly
	 * what the app takes. */
	if (checked !== null && fetched !== null && checked.plan.kind === "changes") {
		const shown = collectAssetRefs(checked.plan.target);
		const nowPlan = checked.media.now;
		const published: Record<string, MediaAssetId> = { ...nowPlan.published };
		for (const file of nowPlan.files) {
			const verdict = Object.hasOwn(nowPlan.verdicts, file.key)
				? nowPlan.verdicts[file.key]
				: undefined;
			if (!shown.has(file.provisionalId) || verdict?.kind !== "held") continue;
			published[file.key] = projectAssetOf(
				prepared.source,
				verdict.file.contentHash,
			);
		}
		if (Object.keys(published).length > Object.keys(nowPlan.published).length) {
			const again = await checkHqChanges(
				fetched,
				{
					base: withJudged(checked.media.base, {
						...checked.media.base,
						published,
					}),
					now: withJudged(nowPlan, { ...nowPlan, published }),
				},
				checked.data,
				new Pieces(),
			);
			if (
				again.kind !== "checked" ||
				again.review.kind !== "changes" ||
				review.kind !== "changes" ||
				again.review.reviewDigest !== review.reviewDigest
			) {
				throw new Error(
					`Nova's check of ${id} over the files it publishes to the Project answered ${JSON.stringify(again.review)}, and a bring-in commits only what the review the person read lists.`,
				);
			}
			checked = again.checked;
		}
	}
	const plan = checked?.plan ?? null;
	const target =
		plan !== null && plan.kind === "changes" ? plan.target : basis.head.doc;
	const committed =
		plan !== null && plan.kind === "changes" && plan.batch.length > 0;
	if (statement === "brings-in" && !committed) {
		throw new Error(
			`hq-side.json states that Nova's republish of ${id} brings in the changes a person made in HQ, and the review found the app already holds them.`,
		);
	}
	if (statement === "brings-in") {
		const stated = input.bringsIn;
		const took = storedDocument(target);
		if (stated === undefined || !isDeepStrictEqual(took, stated)) {
			const at = firstStoredDifference(took, stated);
			throw new Error(
				`hq-side.json states the document Nova's bring-in of ${id} gives, and the bring-in gave another (first at ${at}, where it holds ${JSON.stringify(valueAt(took, at))} and the statement ${JSON.stringify(valueAt(stated, at))}). Look at the review's plan, or at the stated document.`,
			);
		}
	}

	/* Where CommCare HQ keeps what the document doesn't hold once the take or
	 * the record lands: the record the review resolved
	 * (`review.ts::takenTargetIdentity`), which a save that reads as the same
	 * app records too where it moved (`bringIn.ts::recordReadsTheSame`), and
	 * the record as it stood where the review read nothing. */
	const readsTheSame =
		review.kind === "nothing" && review.reason === "reads-the-same";
	if (!readsTheSame && checked === null) {
		throw new Error(
			`Nova's review of ${id} answered ${JSON.stringify(review)} with no readings to take ids from.`,
		);
	}
	const targetIdentity =
		checked === null ? input.targetIdentity : checked.targetIdentity.next;
	const exported = exportIdentityOf(target, targetIdentity);

	/* The document the app takes, at the revision its commit gives. */
	const seq = basis.head.seq + (committed ? 1 : 0);
	const taken = await prepareDocument(
		{
			...prepared.source,
			doc: storedDocument(target),
			compiledAtSeq: seq,
		},
		"hq-upload",
		input.attachmentTarget,
		input.lookupTarget,
	);
	/* The ownership the next publish's body gives over the read, which a save
	 * that reads as the same app leaves as the baseline held it. */
	const ownership = readsTheSame
		? ledger.app.ownership
		: hqImportApplication({
				prepared: taken.export,
				target: { server: PROOF_SERVER, domain: peer.state.domain },
				compatibility: { advisories: [] },
				update: { appId: PLACEHOLDER_APP_ID, source: basis.source },
				identity: exported.identity,
				languageNames: "nova",
				seeds: "nova",
				keyedCaseIdPrefixes: exported.keyedCaseIdPrefixes,
			}).ownership;
	/* The file at each path the app publishes once the record lands: for a
	 * take (`bringIn.ts::takenFor`), each file taken at the path CommCare HQ
	 * holds it under where that path is kept (`assignMediaPaths`), else the
	 * review's learned ids or the previous record's; for a save that reads as
	 * the same app (`recordReadsTheSame`), the previous record, written again
	 * only where the review learned an id. */
	const takenFiles =
		checked === null || plan === null || plan.kind !== "changes"
			? []
			: adoptedMediaFiles(checked.media.now).filter(
					(file) =>
						collectAssetRefs(target).has(file.assetId) &&
						!collectAssetRefs(basis.head.doc).has(file.assetId),
				);
	const keptPaths = assignMediaPaths(takenFiles).rows.map(
		(row) => row.wirePath,
	);
	if (keptPaths.length > 0) {
		throw new Error(
			`Nova's bring-in of ${id} keeps CommCare HQ's path for a file it takes (${keptPaths.join(", ")}), and the capture writes each file at the path its content derives, and holds no deployment's media path rows.`,
		);
	}
	const learned = Object.keys(basis.learned).length > 0;
	const mediaFiles = readsTheSame
		? learned
			? nextHqMediaRecord({
					published: basis.published,
					previous: basis.baseline.mediaFiles,
					learned: basis.learned,
					reported: {},
				})
			: ledger.app.mediaFiles
		: nextHqMediaRecord({
				published: publishedMediaFiles(
					bulkUploadAssets(taken.export.doc, taken.export.assets),
				),
				previous: basis.baseline.mediaFiles,
				learned: basis.learned,
				reported: {},
			});
	const recorded: CaptureLedger = {
		app: {
			normalized: basis.normalized.normalized,
			ownership,
			origin: readsTheSame ? ledger.app.origin : "changes",
			digest: basis.normalized.digest,
			bytes: basis.normalized.bytes,
			mediaFiles,
		},
		tables: ledger.tables,
	};

	/* The review over the record finds nothing: the ledger the publish that
	 * follows compares against names CommCare HQ's app as it stands, its
	 * files' record among it. The production record's own writes are held by
	 * `lib/deployment/__tests__/hqChanges.postgres.test.ts`. */
	const again = await reviewOverPeer({
		peer,
		prepared: taken,
		ledger: recorded,
		pushedRevision: input.pushedRevision,
		targetIdentity,
		keepMedia: false,
	});
	if (again.review.kind !== "nothing" || again.review.reason !== "unchanged") {
		throw new Error(
			`Nova's review of ${id} after ${committed ? "the bring-in" : "the record"} answered ${JSON.stringify(again.review)}, and the pair it moved names CommCare HQ's app as it stands, so a second review finds it unchanged.`,
		);
	}

	/* The publish that follows records the placements its emission derives first. */
	const placements = firstPublishRecord(taken.export.doc);
	const publishing =
		placements.length === 0
			? taken
			: await prepareDocument(
					{
						...taken.source,
						doc: storedDocument(
							recordedDocument(
								id,
								taken.export.doc,
								placements,
								taken.source.lookup,
							),
						),
						compiledAtSeq: seq + 1,
					},
					"hq-upload",
					input.attachmentTarget,
					input.lookupTarget,
				);
	/* The review's reading of the app now, as the record keeps it. */
	let reading: BringInRecord["reading"];
	if (checked !== null) {
		const read = adoptedIdentityRows(checked.draft.identities, basis.modules);
		if (!read.ok) {
			throw new Error(
				`Nova's review of ${id} read a menu or form the peer's summary does not hold (${read.at}), which acceptance refuses before a review answers.`,
			);
		}
		reading = {
			doc: storedDocument(checked.draft.doc),
			identity: read.rows.map(
				({ entityKind, novaEntityUuid, uniqueId, xmlns }) => ({
					entityKind,
					novaEntityUuid,
					uniqueId,
					xmlns,
				}),
			),
		};
	}
	return {
		ledger: recorded,
		prepared: publishing,
		targetIdentity,
		record: {
			review,
			...(checked?.plan.publishChanges.includes(
				"unshown-form-media-removed",
			) && {
				unshownMediaPlaces: firstPublishChangePlaces(
					checked.declaration.firstPublishFacts,
					["unshown-form-media-removed"],
				)[0].places,
			}),
			taken: committed ? "brought-in" : "recorded",
			discarded:
				plan !== null &&
				plan.kind === "changes" &&
				plan.appliedTo === "published",
			mutations:
				plan !== null && plan.kind === "changes" ? plan.batch.length : 0,
			identities: targetIdentity.entities,
			again: again.review,
			assumedSummary: reviewed.summary,
			document: storedDocument(target),
			...(reading !== undefined && { reading }),
		},
	};
}

/** One update over A: the document it publishes, and the name it sends. */
export interface PublishUpdate {
	/** Names the update's outputs (`update`, `update-edited`). */
	readonly name: string;
	readonly document: PublishDocument;
	/** The app name the publish sends; the document's own by default. */
	readonly appName?: string;
}

/**
 * One import of a first publish as the capture writes it: the request
 * (`<name>.body` with its sidecar `<name>.json`) and the overlay keys its
 * body writes (`<name>.ownership.json`).
 */
export interface CapturedImport {
	readonly request: CapturedRequest;
	readonly ownership: AppOwnership;
}

/**
 * A request a first publish sends beside its content import, as the capture
 * writes it: the lookup workbook before the import, the media upload after
 * it.
 */
export type CapturedUpload = CapturedRequest;

/**
 * A migration witness's state A: the first publish of the app from before
 * the migration, retained under `proof/migrations/<id>/`
 * (`./inputs.ts::retainedMigrationA`), the shell's create, the content
 * import that fills it, and the workbook and media upload the content's
 * sidecar names.
 */
export interface RetainedPublish {
	readonly create: CapturedImport;
	readonly content: CapturedImport;
	readonly workbook?: CapturedUpload;
	readonly media?: CapturedUpload;
}

/**
 * An app CommCare HQ's own pages made, as a capture publishes over it: HQ's
 * source of it, which the peer starts from (the body of the base's retained
 * source answer); the identity rows a bring-in of it records, one a menu and
 * a form; the path HQ keeps each of the document's files under, by asset id,
 * each `jr://file/...`; the prefix each keyed create the document keeps
 * stands under in it, as a bring-in records them
 * (`app_deployment_keyed_case_ids`); and the word each case list column's
 * field keeps there where it is not Nova's (`app_deployment_column_field_words`).
 */
export interface HqAuthoredA {
	readonly source: Readonly<Record<string, unknown>>;
	readonly identity: readonly WireIdentityOverride[];
	readonly mediaPaths: ReadonlyMap<string, string>;
	readonly keyedCaseIds: readonly AdoptedKeyedCaseId[];
	readonly columnWords: readonly ColumnFieldWordRow[];
}

/** The held paths an export boundary takes for `mediaPaths`: each without `jr://file/`. */
export function heldMediaPathsOf(
	mediaPaths: ReadonlyMap<string, string>,
): ReadonlyMap<MediaAssetId, string> {
	return new Map(
		[...mediaPaths].map(([assetId, path]) => [
			asMediaAssetId(assetId),
			path.startsWith(JR_FILE) ? path.slice(JR_FILE.length) : path,
		]),
	);
}

export interface PublishInput {
	/**
	 * The document as stored before the first publish, which records its
	 * placements (`PublishCapture.placements`) and sends the document they
	 * leave; with `retainedA`, the migrated document, which the capture
	 * publishes only as the updates name it, each update naming the document
	 * with its placements recorded.
	 */
	readonly create: PublishDocument;
	/**
	 * A migration witness's A, retained from before the migration. With it the
	 * capture writes no first publish: the peer applies A's retained bodies,
	 * in the order the first publish sent them, and starts holding what HQ
	 * holds after them; the ledger is the one Nova's first publish leaves
	 * (the content's ownership, the drift baseline the source read back after
	 * A, each pushed table's rows read back); and the updates are sent over
	 * it, the first of them B. A stop of any update ends the capture, naming
	 * the witness and the stop's code: Nova's own push must never read as a
	 * change.
	 */
	readonly retainedA?: RetainedPublish;
	/**
	 * An HQ-authored A. With it the capture writes no first publish: the peer
	 * starts holding HQ's own source answer, the ledger is the one a bring-in
	 * leaves, every id is the target's, and the updates are sent over it, the
	 * first of them B. Never beside `retainedA` or `hqSide`.
	 */
	readonly hqAuthoredA?: HqAuthoredA;
	/** The first publish's app name; the document's own by default. */
	readonly appName?: string;
	/**
	 * Each a separate next publish over A. The first is the republish of D,
	 * which the capture sends twice (`capturePublish`).
	 */
	readonly updates: readonly PublishUpdate[];
	readonly configuration: PublishConfiguration;
	/**
	 * The corpus seed every step's stream is drawn from (`./entropy.mts`),
	 * with the configuration's id, at the ordinals `capturePublish` gives
	 * each step. Without one every draw is real.
	 */
	readonly seed?: number;
	/**
	 * Fields of HQ's source for the app, by path, that hold other values in
	 * this project space than an update sent: HQ serves them after every
	 * update, from the content import on. By default each is what the update
	 * left: the profile it sent (`views/apps.py::app_source` serves the
	 * stored profile through `export_json`) and HQ's own CommCare version.
	 */
	readonly source?: Partial<AssumedSource>;
	/**
	 * What a person saves in HQ over A before the updates (the document's
	 * `hq-side.json`), and what each update over them then does
	 * (`republish`): it goes through untouched (`"proceeds"`); it stops and
	 * is sent again with what a person who saw each stop confirms, every
	 * table in conflict taken over and every change listed with the digest
	 * shown (`"discards"`); Nova stops it with `stopCode` and offers no
	 * discard (`"stops"`); or it stops over a change of the app Nova can
	 * bring in, and Nova's review answers it before it is sent again: the
	 * record of a review that finds nothing (`"records"`) or the bring-in of
	 * the change (`"brings-in"`, `bringInOverPeer`). An update whose outcome is another stops the
	 * capture, naming the document and what the stop listed, and so does a
	 * stop over a document without them: Nova's own push must never read as
	 * a change.
	 */
	readonly hqSide?: HqSideSaves;
	/**
	 * The lookup tables the project space holds before Nova's first publish,
	 * as HQ's own upload made them, among them each table the document reads
	 * that CommCare HQ manages there: the capture reads those as Nova's
	 * `managed-data` edge does (`managedDataEdge`), and its peer answers from
	 * them. By default the project space holds none.
	 */
	readonly hqTables?: readonly PeerTable[];
}

export type PublishCapture =
	| {
			readonly status: "refused";
			readonly create: Extract<FirstPublishOutcome, { status: "refused" }>;
	  }
	| {
			readonly status: "sent";
			readonly create: Extract<FirstPublishOutcome, { status: "sent" }>;
			readonly updates: Readonly<Record<string, StepOutcome>>;
			/**
			 * The mutations of the `publish-placement` change the first publish
			 * committed before it sent anything: one `holdPlacements` carrying
			 * every placement the emission of `create`'s document derives and the
			 * document does not hold yet (`./editBatches.ts::firstPublishRecord`),
			 * or none where it holds them all. The publish sent the document with
			 * them applied, which is D as stored after it; the corpus applies the
			 * same record to D before it plans D′, and an update over A names that
			 * document.
			 */
			readonly placements: readonly Mutation[];
	  };

/** The updates a capture sent over a retained A (`PublishInput.retainedA`), which it applied rather than sent. */
export interface RepublishCapture {
	readonly status: "republished";
	readonly updates: Readonly<Record<string, StepOutcome>>;
	/**
	 * The mutations of the `publish-placement` change Nova's first publish of
	 * the migrated document records over the retained A, as
	 * `PublishCapture.placements` is for a first publish: the placements its
	 * emission derives that neither the migration nor an earlier recording
	 * holds.
	 */
	readonly placements: readonly Mutation[];
}

/**
 * Whether two publish steps sent the same bytes: the same import and the
 * same lookup workbook, or none. The media upload follows from the prepared
 * assets (one ZIP entry per asset `buildMediaBulkUploadZip` writes), so the
 * same document sends the same media. Two steps Nova stopped send nothing,
 * and are the same where they stopped with the same code.
 */
function sendsTheSame(left: StepOutcome, right: StepOutcome): boolean {
	if (left.status === "stopped" && right.status === "stopped") {
		return left.code === right.code;
	}
	if (left.status !== "sent" || right.status !== "sent") return false;
	const lookups =
		left.lookup === undefined || right.lookup === undefined
			? left.lookup === right.lookup
			: left.lookup.body.equals(right.lookup.body);
	return lookups && left.importApp.body.equals(right.importApp.body);
}

/**
 * What a person who saw `stop` confirms to send the publish again, beside
 * what they confirmed of the stops before it.
 */
function confirming(
	before: StopConfirmation | undefined,
	stop: PublishStop,
): StopConfirmation {
	return {
		stops: [
			...(before?.stops ?? []),
			{
				code: stop.code,
				remoteChanges: stop.remoteChanges,
				conflicts: stop.conflicts,
				webAppsChange: stop.webAppsChange,
			},
		],
		discards: [
			...(before?.discards ?? []),
			...stop.remoteChanges.map((change) => ({
				kind: change.kind,
				novaResourceId: change.novaResourceId,
				observedDigest: change.observedDigest,
			})),
		],
		adopted: [
			...(before?.adopted ?? []),
			...stop.conflicts.map((conflict) => conflict.tableId),
		],
		...(before?.webApps !== undefined && { webApps: before.webApps }),
	};
}

/**
 * What a person who saw the Web Apps question answers to send the publish
 * again: the value the declaration writes, beside what they confirmed of
 * the stops before it.
 */
function answeringWebApps(
	before: StopConfirmation | undefined,
	stop: PublishStop & { readonly webAppsChange: WebAppsChange },
): StopConfirmation {
	return {
		stops: [
			...(before?.stops ?? []),
			{
				code: stop.code,
				remoteChanges: stop.remoteChanges,
				conflicts: stop.conflicts,
				webAppsChange: stop.webAppsChange,
			},
		],
		discards: before?.discards ?? [],
		adopted: before?.adopted ?? [],
		webApps: stop.webAppsChange.to,
	};
}

/**
 * The peer made to hold a retained A, and the ledger Nova's first publish of
 * it leaves: the peer applies the shell's create, the workbook, the content
 * import and the media upload in the order the first publish sent them,
 * then the capture reads back what the ledger records after the content, as
 * `sendContent` does: the app's source, normalized as a baseline is, under
 * the content's ownership, and each table the document pushes that the peer
 * now holds, with its rows.
 */
async function applyRetainedA(
	peer: TargetPeer,
	prepared: PreparedDocument,
	retained: RetainedPublish,
): Promise<CaptureLedger> {
	await peer.applyRetained([
		retained.create.request,
		...(retained.workbook === undefined ? [] : [retained.workbook]),
		retained.content.request,
		...(retained.media === undefined ? [] : [retained.media]),
	]);
	const tables = new Map<LookupTableId, LedgerTable>();
	const workbook = prepared.export.lookupWorkbook;
	if (workbook !== undefined) {
		const listed = await readTables(peer, prepared);
		for (const table of workbook.tables) {
			const held = listed.find((remote) => remote.tag === table.tag);
			if (held === undefined) continue;
			const rows = await readRows(peer, prepared, held);
			tables.set(table.tableId, {
				tag: table.tag,
				remoteId: held.id,
				canonical: canonicalLookupTable(held, rows.rows),
			});
		}
	}
	const readBack = normalizedRead(
		prepared,
		await readSource(peer, prepared, PLACEHOLDER_APP_ID),
	);
	return {
		app: {
			normalized: readBack.normalized,
			ownership: retained.content.ownership,
			origin: "push",
			digest: readBack.digest,
			bytes: readBack.bytes,
			/* The retained A was published before Nova kept a record of its
			 * files, so the next publish settles each by its content. */
			mediaFiles: null,
		},
		tables,
	};
}

/**
 * The peer made to hold an HQ-authored A, and the ledger a bring-in of it
 * leaves (`lib/deployment/reading/birth.ts`,
 * `store.ts::recordAdoptedDeploymentInTransaction`): the peer holds HQ's
 * source of the app (`TargetPeer.holdSource`), with each file its map names
 * at a path the document holds; the capture reads that source as the
 * birth's create reads it, and the ledger records it as production records
 * it, through `adoption.ts::adoptedAppBaselineWrite`: the baseline of origin
 * `read`, under the ownership the first publish's body over that source
 * gives on an adopted mapping, with CommCare HQ's file at each held path.
 * Its first-publish list is empty: no lane check reads the stored list, and
 * a base's predicted ids reach the lane through `first-publish.json`. No
 * table is mapped: a bring-in pushes none.
 */
async function adoptedA(
	peer: TargetPeer,
	prepared: PreparedDocument,
	adopted: HqAuthoredA,
): Promise<CaptureLedger> {
	const map = (adopted.source.multimedia_map ?? {}) as Readonly<
		Record<
			string,
			{ readonly multimedia_id?: unknown; readonly media_type?: unknown }
		>
	>;
	const files: Omit<PeerMediaFile, "md5">[] = [];
	for (const [assetId, path] of adopted.mediaPaths) {
		const item = map[path];
		const asset = prepared.source.media?.get(assetId);
		if (
			item === undefined ||
			asset === undefined ||
			typeof item.multimedia_id !== "string" ||
			(item.media_type !== "CommCareImage" &&
				item.media_type !== "CommCareAudio" &&
				item.media_type !== "CommCareVideo")
		) {
			throw new Error(
				`${prepared.source.id} keeps its asset ${assetId} at ${path}, and CommCare HQ's source of the app it was read from maps no file of its own there. The reading named that path from the app's map; look at proof/hq-apps/ for the base.`,
			);
		}
		files.push({
			id: item.multimedia_id,
			mediaClass: item.media_type,
			contentType: asset.mimeType,
			bytes: new Uint8Array(asset.bytes),
		});
	}
	peer.holdSource(adopted.source, files);
	const read = await readSource(peer, prepared, PLACEHOLDER_APP_ID);
	const mediaFiles: Record<string, string> = {};
	for (const path of adopted.mediaPaths.values()) {
		const item = (read.multimediaMap ?? []).find((one) => one.path === path);
		if (item?.multimediaId != null && path.startsWith(JR_FILE))
			mediaFiles[path.slice(JR_FILE.length)] = item.multimediaId;
	}
	/* The birth's own boundary over the document it births
	 * (`reading/birth.ts::adoptedDeploymentWrite`): each held file at the
	 * path the bring-in assigns it, every other at its content's, which is
	 * the path the bring-in assigns a file none of whose paths it can hold. */
	const adoptedFiles: AdoptedMediaFile[] = [];
	for (const [assetId, asset] of prepared.source.media ?? []) {
		const contentHash = sha256(asset.bytes);
		adoptedFiles.push({
			hqPath:
				adopted.mediaPaths.get(assetId) ??
				`${JR_FILE}${wirePathFor(contentHash, asset.extension)}`,
			assetId: asMediaAssetId(assetId),
			contentHash,
			extension: asset.extension,
		});
	}
	const write = adoptedAppBaselineWrite({
		remoteAppId: PLACEHOLDER_APP_ID,
		source: read,
		prepared: adoptionExportBoundary(
			prepared.export.doc,
			prepared.source.lookup?.definitions ?? [],
			adoptedFiles,
			{
				origin: COMMCARE_SERVERS[PROOF_SERVER].baseUrl,
				domain: peer.state.domain,
			},
		),
		target: { server: PROOF_SERVER, domain: peer.state.domain },
		identity: targetWireIdentity(adopted.identity, adopted.columnWords),
		novaRevision: prepared.source.compiledAtSeq,
		mediaFiles,
		observedAt: CAPTURE_OBSERVED_AT,
		firstPublish: { ids: [], touchesWorkers: false, of: "first-publish" },
	});
	const { sourceGzip, ownership, sourceDigest, sourceBytes } = write;
	if (
		sourceGzip === null ||
		ownership === null ||
		sourceDigest === null ||
		sourceBytes === null
	) {
		throw new Error(
			`adoptedAppBaselineWrite gave ${prepared.source.id}'s bring-in a baseline with no source, which a read baseline always holds.`,
		);
	}
	return {
		app: {
			normalized: JSON.parse(gunzipSync(sourceGzip).toString("utf8")),
			ownership,
			origin: "read",
			digest: sourceDigest,
			bytes: sourceBytes,
			mediaFiles:
				write.mediaFiles.kind === "set" ? write.mediaFiles.files : null,
		},
		tables: new Map(),
	};
}

/**
 * How many times a person's confirmation can meet another stop: preflight
 * lists the tables in conflict first and the changes after them, so a
 * publish over both stops twice before it goes through.
 */
const CONFIRMED_STOPS = 2;

/**
 * Capture what Nova's publish sends for a first publish and the updates
 * over it. Throws `UnexportableDocumentError` when Nova's export boundary
 * refuses a document, since no configuration would receive it.
 *
 * Each step is drawn once, in a stream of its own: with a seed, the first
 * publish at `OPERATION_ORDINALS.create`, the republish of D at
 * `OPERATION_ORDINALS.republish`, and each update to D′ at
 * `OPERATION_ORDINALS.update`, then one more for each later update. An
 * update that changes nothing Nova sends equals the republish because Nova
 * derives what it sends, never because the two shared a draw. The republish
 * is captured a second time, in the first stream no update holds, and the
 * two must send the same bytes, as a third publish sends the second's: a
 * change that mints an id per publish again stops the capture here.
 *
 * Every update is a separate next publish over A, so the peer is put back
 * to what the first publish left (with a person's saves, `hqSide`) before
 * each, and each is compared with the ledger the first publish left.
 *
 * Over a migration witness's retained A (`PublishInput.retainedA`) the
 * capture sends no first publish: the peer applies A's bodies
 * (`applyRetainedA`), and the capture is `republished`, the updates alone.
 * Over an HQ-authored A (`PublishInput.hqAuthoredA`) it sends none either:
 * the peer holds HQ's own source and the ledger is a bring-in's
 * (`adoptedA`), every body and the export boundary take the target's ids,
 * held media paths and keyed create prefixes, the language names and seeds
 * are the project space's, and the capture is `republished`.
 */
export async function capturePublish(
	input: PublishInput & { readonly retainedA: RetainedPublish },
): Promise<RepublishCapture>;
export async function capturePublish(
	input: PublishInput & {
		readonly hqAuthoredA: HqAuthoredA;
		readonly retainedA?: undefined;
	},
): Promise<RepublishCapture>;
export async function capturePublish(
	input: PublishInput & {
		readonly retainedA?: undefined;
		readonly hqAuthoredA?: undefined;
	},
): Promise<PublishCapture>;
export async function capturePublish(
	input: PublishInput,
): Promise<PublishCapture | RepublishCapture> {
	const { configuration } = input;
	const adopted = input.hqAuthoredA;
	if (
		adopted !== undefined &&
		(input.retainedA !== undefined || input.hqSide !== undefined)
	) {
		throw new Error(
			`The capture of ${input.create.id} was given an HQ-authored A beside ${input.retainedA !== undefined ? "a migration witness's retained A" : "a person's saves in HQ"}. An app CommCare HQ's own pages made is A itself: it has no first publish to retain and nothing is saved over it before Nova's.`,
		);
	}
	/* The ids, the held media paths and whose language names and seeds a
	 * publish carries: the target's over an app brought in, else Nova's own. */
	const adoptedIdentity: WireIdentity =
		adopted === undefined
			? DERIVED_WIRE_IDENTITY
			: targetWireIdentity(adopted.identity, adopted.columnWords);
	const heldMediaPaths =
		adopted === undefined ? undefined : heldMediaPathsOf(adopted.mediaPaths);
	const keyedCaseIds = adopted?.keyedCaseIds ?? [];
	/* What the deployment holds of where CommCare HQ keeps things, as a
	 * bring-in resolves the reading over it. */
	const adoptedRecord: TargetIdentity =
		adopted === undefined
			? EMPTY_TARGET_IDENTITY
			: canonicalTargetIdentity({
					entities: adopted.identity,
					keyedCaseIds: adopted.keyedCaseIds,
					mediaPaths: [...heldMediaPathsOf(adopted.mediaPaths)].map(
						([assetId, wirePath]) => ({ assetId, wirePath }),
					),
					columnWords: adopted.columnWords,
				});
	const languageNames: LanguageNames =
		adopted === undefined ? "nova" : "target";
	const operation = (ordinal: number): EntropyOperation | undefined =>
		input.seed === undefined
			? undefined
			: { seed: input.seed, ordinal, configuration: configuration.id };
	/* A publish knows its target exactly (`preflight.ts`), for its links and
	 * for the tables CommCare HQ manages there, which its workbook leaves out. */
	const target = { server: PROOF_SERVER, domain: configuration.domain };
	const lookupTarget: LookupTarget = target;
	const attachmentTarget = attachmentUrlTarget(target);
	/* Preflight reads D as stored before this publish; the placements it
	 * records are committed before anything is sent, and the document they
	 * leave is what the publish sends (`publishAppToHq`). */
	const unrecorded = await prepareDocument(
		input.create,
		"hq-upload",
		attachmentTarget,
		lookupTarget,
		heldMediaPaths,
	);
	const placements = firstPublishRecord(unrecorded.export.doc);
	const create =
		placements.length === 0
			? unrecorded
			: await prepareDocument(
					{
						...input.create,
						doc: storedDocument(
							recordedDocument(
								input.create.id,
								unrecorded.export.doc,
								placements,
								input.create.lookup,
							),
						),
					},
					"hq-upload",
					attachmentTarget,
					lookupTarget,
					heldMediaPaths,
				);
	const updates = await Promise.all(
		input.updates.map(async (update) => ({
			update,
			prepared: await prepareDocument(
				update.document,
				"hq-upload",
				attachmentTarget,
				lookupTarget,
				heldMediaPaths,
			),
		})),
	);
	return withTargetPeer(
		{
			credentials: CREDENTIALS,
			domain: configuration.domain,
			flags: new Set(configuration.flags),
			caseSearchEnabled: configuration.caseSearchEnabled,
			appId: PLACEHOLDER_APP_ID,
			commcareVersion: CORPUS_COMMCARE_VERSION,
			/* The lane grants `CLOUDCARE` exactly where the content declares
			 * Web Apps (`proof/checks/configurations.py::_needs_cloudcare`). */
			cloudcareGranted: declaresWebApps(create.export.doc),
			...(input.source !== undefined && { sourceChanges: input.source }),
		},
		async (peer): Promise<PublishCapture | RepublishCapture> => {
			if (input.hqTables !== undefined) peer.holdTables(input.hqTables);
			const retained = input.retainedA;
			let created: Extract<FirstPublishOutcome, { status: "sent" }> | null =
				null;
			let ledger: CaptureLedger;
			if (retained !== undefined) {
				ledger = await applyRetainedA(peer, create, retained);
			} else if (adopted !== undefined) {
				ledger = await adoptedA(peer, create, adopted);
			} else {
				const first = await seeded(operation(OPERATION_ORDINALS.create), () =>
					firstPublish(
						peer,
						create,
						input.appName ?? create.export.doc.appName,
					),
				);
				if (!("ledger" in first)) {
					assertModeled(peer);
					return { status: "refused", create: first.outcome };
				}
				created = first.outcome;
				ledger = first.ledger;
			}
			if (input.hqSide !== undefined) peer.applyHqSide(input.hqSide);
			const stateA = peer.snapshot();
			const send = (
				{ update, prepared }: (typeof updates)[number],
				ordinal: number,
			) =>
				seeded(operation(ordinal), async (): Promise<StepOutcome> => {
					const statement = input.hqSide?.republish;
					let confirm: StopConfirmation | undefined;
					/* Counts only drift and conflict stops: a Web Apps question is
					 * answered before every other branch and counts against
					 * neither `republish` nor `CONFIRMED_STOPS`. */
					let stops = 0;
					/* What a review of the changes made in CommCare HQ moved: the
					 * ledger's app read, the document the publish sends and the
					 * ids it sends it under (`bringInOverPeer`). */
					let held = ledger;
					let sending = prepared;
					let identity: WireIdentity = adoptedIdentity;
					let record = adoptedRecord;
					let keyed = keyedCaseIds;
					let broughtIn: BringInRecord | undefined;
					for (;;) {
						peer.restore(stateA);
						const appName = update.appName ?? sending.export.doc.appName;
						const step = await updateStep(
							peer,
							sending,
							appName,
							held,
							confirm,
							identity,
							languageNames,
							keyed,
						);
						/* A stop over a change of the app Nova can bring in, where the
						 * statement takes the review's way on: the person reads the
						 * review, and the bring-in or the record moves the pair before
						 * the publish is sent again (`bringInOverPeer`). */
						if (
							broughtIn === undefined &&
							(statement === "brings-in" || statement === "records") &&
							step.status === "stopped" &&
							step.code === "hq_changed" &&
							step.remoteChanges.length > 0 &&
							step.remoteChanges.every(
								(change) => change.kind === "app" && change.canBringIn,
							)
						) {
							const taken = await bringInOverPeer({
								peer,
								prepared: sending,
								ledger: held,
								targetIdentity: record,
								pushedRevision: prepared.source.compiledAtSeq,
								statement,
								bringsIn: input.hqSide?.bringsIn,
								recorded: input.hqSide?.recorded,
								publishChanges: input.hqSide?.publishChanges,
								attachmentTarget,
								lookupTarget,
							});
							held = taken.ledger;
							sending = taken.prepared;
							/* The next publish prints every form, keyed create
							 * and file as the record the bring-in left holds
							 * it (`targetIdentity.ts::exportIdentityOf`). */
							record = taken.targetIdentity;
							identity = exportIdentityOf(sending.export.doc, record).identity;
							keyed = record.keyedCaseIds;
							broughtIn = taken.record;
							continue;
						}
						/* The person's answer to a question Nova asks of every
						 * declaration change and of a person's save of the setting
						 * in HQ, recorded beside the body (`confirmed`). */
						if (
							step.status === "stopped" &&
							step.code === "hq_web_apps_change"
						) {
							const asked = step.webAppsChange;
							if (asked === null || confirm?.webApps === asked.to) {
								throw new Error(
									`Nova's ${update.name} of ${prepared.source.id} asked the Web Apps question again after the capture answered it with ${JSON.stringify(confirm?.webApps)}. An answer equal to the declaration passes the question; look at what the question reads.`,
								);
							}
							confirm = answeringWebApps(confirm, {
								...step,
								webAppsChange: asked,
							});
							continue;
						}
						const driftStops = (confirm?.stops ?? []).filter(
							(stop) => stop.code !== "hq_web_apps_change",
						);
						if (step.status !== "stopped") {
							if (
								(statement === "discards" && driftStops.length === 0) ||
								statement === "stops"
							) {
								throw new Error(
									`hq-side.json states that Nova's ${update.name} of ${prepared.source.id} over a person's saves in HQ ${statement === "stops" ? `stops with ${input.hqSide?.stopCode}` : "stops until a person discards what HQ holds"}, and it went through with no stop. Look at what the comparison reads of the saves, or at the statement.`,
								);
							}
							if (
								(statement === "brings-in" || statement === "records") &&
								broughtIn === undefined
							) {
								throw new Error(
									`hq-side.json states that Nova's ${update.name} of ${prepared.source.id} ${statement === "brings-in" ? "brings in the changes a person made in HQ" : "stops over a person's saves in HQ, whose review finds nothing to bring in"}, and it went through with no stop. Look at what the comparison reads of the saves, or at the statement.`,
								);
							}
							return broughtIn === undefined || step.status !== "sent"
								? step
								: {
										...step,
										broughtIn,
										sent: sending.source,
										sentUnder: record,
									};
						}
						const listed = JSON.stringify(
							step.code === "hq_changed" ? step.remoteChanges : step.conflicts,
						);
						if (adopted !== undefined) {
							throw new Error(
								`Nova's ${update.name} of ${prepared.source.id} stopped with ${step.code} (${listed}) over the app CommCare HQ's own pages made, which the capture peer holds as HQ served it and the ledger records as the bring-in of it left it: Nova's own reading read as a change made in CommCare HQ. Look at what the comparison reads of the base's source under the ownership adoptedAppBaselineWrite gives.`,
							);
						}
						if (retained !== undefined) {
							throw new Error(
								`Nova's ${update.name} of the migration witness ${prepared.source.id} stopped with ${step.code} (${listed}) over the A retained from before the migration, which the capture peer holds exactly as that first publish left it: Nova's own push read as a change. Look at what the comparison reads of the peer's answers after the retained bodies.`,
							);
						}
						if (input.hqSide === undefined) {
							throw new Error(
								`Nova's ${update.name} of ${prepared.source.id} stopped with ${step.code} (${listed}), and nothing was saved in HQ over the app: Nova's own push read as a change. Look at what the comparison reads of the peer's answers.`,
							);
						}
						if (statement === "proceeds") {
							throw new Error(
								`hq-side.json states that Nova's ${update.name} of ${prepared.source.id} proceeds over a person's saves in HQ, and it stopped with ${step.code} over these changes: ${listed}. None of the saves is a value Nova owns, so the overlay or the drift comparison read one as Nova's; fix that rather than the statement.`,
							);
						}
						if (statement === "brings-in" || statement === "records") {
							throw new Error(
								`hq-side.json states that Nova's ${update.name} of ${prepared.source.id} ${statement === "brings-in" ? "brings in the changes a person made in HQ" : "records a review of a person's saves in HQ that finds nothing to bring in"}, and it stopped with ${step.code} (${listed})${broughtIn === undefined ? ", which no review of changes made in CommCare HQ answers" : ` after the ${statement === "brings-in" ? "bring-in" : "record"}`}.`,
							);
						}
						if (statement === "stops") {
							if (step.code !== input.hqSide.stopCode) {
								throw new Error(
									`hq-side.json states that Nova stops its ${update.name} of ${prepared.source.id} with ${input.hqSide.stopCode}, and it stopped with ${step.code} (${listed}).`,
								);
							}
							return step;
						}
						if (stops === CONFIRMED_STOPS) return step;
						confirm = confirming(confirm, step);
						stops += 1;
					}
				});
			const outcomes: Record<string, StepOutcome> = {};
			for (const [position, entry] of updates.entries()) {
				outcomes[entry.update.name] = await send(
					entry,
					position === 0
						? OPERATION_ORDINALS.republish
						: OPERATION_ORDINALS.update + position - 1,
				);
			}
			const [republish] = updates;
			if (republish !== undefined) {
				const first = outcomes[republish.update.name];
				const again = await send(
					republish,
					OPERATION_ORDINALS.update + updates.length - 1,
				);
				if (first === undefined || !sendsTheSame(first, again)) {
					throw new Error(
						`Nova's republish of ${republish.prepared.source.id} sent other bytes the second time it was captured, so a third publish would not send the second's. A publish derives everything it sends from the document; look for an id drawn per publish.`,
					);
				}
				if (input.hqSide?.alsoPublishesOver === true) {
					if (first.status !== "sent") {
						throw new Error(
							`hq-side.json states that the capture also publishes ${republish.prepared.source.id} over a person's saves in HQ, beside a republish that was not sent.`,
						);
					}
					const publishedOver = await seeded(
						operation(OPERATION_ORDINALS.update + updates.length),
						() =>
							publishOver({
								peer,
								stateA,
								prepared: republish.prepared,
								appName:
									republish.update.appName ??
									republish.prepared.export.doc.appName,
								ledger,
							}),
					);
					outcomes[republish.update.name] = { ...first, publishedOver };
				}
			}
			assertModeled(peer);
			if (created === null)
				return { status: "republished", updates: outcomes, placements };
			return {
				status: "sent",
				create: created,
				updates: outcomes,
				placements,
			};
		},
	);
}

/**
 * What the project space keeps after the publish a `.ccz` downloaded then
 * follows: the facts of the baseline the named update left where it went
 * through, else of the one the first publish's content left. Null where
 * neither was sent: no baseline was read.
 */
export function capturedTargetFacts(
	capture: PublishCapture | RepublishCapture,
	update: string,
): TargetFacts | null {
	if (capture.status === "refused") return null;
	const step = capture.updates[update];
	if (step?.status === "sent") return step.targetFacts;
	return capture.status === "sent" ? capture.create.content.targetFacts : null;
}

function assertModeled(peer: TargetPeer): void {
	if (peer.unexpected.length > 0) {
		throw new Error(
			`Nova's client asked the capture peer for requests it does not model: ${peer.unexpected
				.map((request) => `${request.method} ${request.path}`)
				.join(
					", ",
				)}. The capture would otherwise record a publish Nova does not make.`,
		);
	}
}

// ── The local archive ────────────────────────────────────────────────

/**
 * Run `build` with the clock at `instant` and the local zone UTC, for code
 * that reads the clock synchronously. Node applies a change to `TZ` at
 * once, and `build` runs to completion before the zone is put back.
 */
function atInstant<T>(instant: number, build: () => T): T {
	const RealDate = globalThis.Date;
	const zone = process.env.TZ;
	process.env.TZ = "UTC";
	globalThis.Date = new Proxy(RealDate, {
		construct(target, args, newTarget) {
			return Reflect.construct(
				target,
				args.length === 0 ? [instant] : args,
				newTarget,
			);
		},
		get(target, property, receiver) {
			return property === "now"
				? () => instant
				: Reflect.get(target, property, receiver);
		},
	});
	try {
		return build();
	} finally {
		globalThis.Date = RealDate;
		if (zone === undefined) delete process.env.TZ;
		else process.env.TZ = zone;
	}
}

/**
 * Nova's answer for a `.ccz` it does not make for a project space it is
 * published to: why, as the download's refusal says it.
 */
export interface LocalCczRefused {
	readonly refused: CczUnavailable;
}

/**
 * The document's `.ccz` as Nova's compile route builds it
 * (`app/api/compile/route.ts` over `prepareCompileRequest`, then
 * `lib/export/localArchive.ts::compileLocalArchive`) for an app published to
 * the one project space `domain`: the download's rule
 * (`lib/deployment/runtimeTarget.ts::chooseDownloadTarget`) picks that one
 * reached deployment, whose HQ app is `PLACEHOLDER_APP_ID`, for the profile's
 * server properties and runtime URLs and the attachment links, with the
 * menu and form ids and the keyed creates' prefixes `targetIdentity` gives
 * (`targetIdentity.ts::exportIdentityOf`): the record a bring-in of changes
 * made in CommCare HQ left on the deployment, under which the publish that
 * followed it sent the app, or the derivations of the empty record, the
 * default. The archive embeds the
 * referenced lookup tables as fixtures and stamps the app's sequence. The
 * deployment is the one a publish there leaves: its HQ app was never made
 * afresh (`earlierHqApps` 0), and it holds `USH_EMPTY_CASE_LIST_TEXT` where
 * `emptyCaseListText` says the configuration does, as the publish would have
 * read it, so the archive writes the empty-list text exactly where HQ's
 * build there does. `targetFacts` is what that project space keeps of the
 * values Nova leaves to CommCare HQ, as the deployment's baseline gives them
 * (`SentImport.targetFacts` of the publish the archive follows), which the
 * archive writes as HQ's build there does; null, the default, where no
 * baseline was read. With `adopted`, the deployment is one a bring-in of an
 * app CommCare HQ's own pages made left (`HqAuthoredA`): its mapping is
 * `adopted`, so the archive writes no seed, and it names each menu and form
 * by the target's ids, each held file at its held path and each keyed
 * create under the prefix its cases stand under there, as a publish there
 * does. Returns null where the rule refuses an app that does
 * not declare Android (`not-declared-for-android`): Nova offers no `.ccz` of
 * it. Returns the refusal (`LocalCczRefused`) where the project space's app
 * keeps a custom base URL that sends phones elsewhere than the server, as
 * the download does (`lib/deployment/downloadTarget.ts::cczStandingOf`,
 * `runtimeTarget.ts::workersSentElsewhere`, `workers-sent-elsewhere`): Nova
 * makes no `.ccz` for that project space. Throws
 * `UnexportableDocumentError` where the route's boundary refuses, and on any
 * other refusal of the rule. With an operation, a draw made while the archive is
 * built is answered from its seeded generator (`./entropy.mts`); the build
 * makes none.
 */
export async function localCcz(
	source: PublishDocument,
	domain: string,
	operation?: EntropyOperation,
	options: {
		readonly emptyCaseListText?: boolean;
		readonly targetFacts?: TargetFacts | null;
		/** The record a bring-in of changes left on a Nova-born deployment; never beside `adopted`, whose record wins. */
		readonly targetIdentity?: TargetIdentity;
		readonly adopted?: Pick<
			HqAuthoredA,
			"identity" | "mediaPaths" | "keyedCaseIds" | "columnWords"
		>;
	} = {},
): Promise<Buffer | LocalCczRefused | null> {
	const emptyCaseListText = options.emptyCaseListText === true;
	const { adopted } = options;
	const choice = chooseDownloadTarget(
		[
			{
				server: PROOF_SERVER,
				domain,
				hqAppId: PLACEHOLDER_APP_ID,
				emptyCaseListText,
				earlierHqApps: 0,
				/* The capture's deployment is Nova-born, or one a bring-in left. */
				adopted: adopted !== undefined,
			},
		],
		{ format: "ccz", domain, declaresAndroid: declaresAndroid(source.doc) },
	);
	/* A `.ccz` installs an app on Android and nothing else: Nova offers
	 * none for an app that does not declare it. */
	if (choice.kind === "refused" && choice.reason === "not-declared-for-android")
		return null;
	if (choice.kind !== "project-space") {
		throw new Error(
			`The download rule chose no project space for a CCZ of ${source.id} from its one reached deployment (${JSON.stringify(choice)}).`,
		);
	}
	const { target } = choice;
	const unavailable = workersSentElsewhere(
		target,
		options.targetFacts?.customBaseUrl ?? null,
	);
	if (unavailable !== null) return { refused: unavailable };
	const record = options.targetIdentity ?? EMPTY_TARGET_IDENTITY;
	if (record.mediaPaths.length > 0) {
		throw new Error(
			`The local archive of ${source.id} is to be made under a record that keeps files at CommCare HQ's own paths, and the capture writes each file at the path its content derives, as the publish the archive follows sent them. Look at the record the bring-in left (review.ts::takenTargetIdentity).`,
		);
	}
	const { export: prepared } = await prepareDocument(
		source,
		"ccz",
		attachmentUrlTarget(target),
		undefined,
		adopted === undefined ? undefined : heldMediaPathsOf(adopted.mediaPaths),
	);
	const exported = exportIdentityOf(prepared.doc, record);
	return seeded(operation, () =>
		atInstant(CCZ_CLOCK, () =>
			compileLocalArchive(
				prepared,
				{ server: target.server, domain: target.domain, appId: target.hqAppId },
				adopted === undefined
					? exported.identity
					: targetWireIdentity(adopted.identity, adopted.columnWords),
				{
					emptyCaseListText: target.emptyCaseListText,
					earlierHqApps: target.earlierHqApps,
					adopted: target.adopted,
					targetFacts: options.targetFacts ?? null,
					/* The prefix each keyed create's cases stand under where a
					 * bring-in recorded one (`downloadTarget.ts`, the `ccz`
					 * arm): of the app, or of changes made in CommCare HQ. */
					keyedCaseIdPrefixes:
						adopted === undefined
							? exported.keyedCaseIdPrefixes
							: keyedCaseIdPrefixesFor(prepared.doc, adopted.keyedCaseIds),
				},
			),
		),
	);
}

/**
 * The document's HQ import file as `/api/compile/json` builds it for an app
 * published to the one project space `domain`: the download's rule
 * (`lib/deployment/runtimeTarget.ts::chooseDownloadTarget`) scopes its
 * attachment links to that deployment, `expandDoc` writes the app JSON with
 * no runtime target and the derived ids, and `buildHqJsonExportArchive`
 * packs it with the media upload, the lookup workbook and the README that
 * renders the manual-import guide (`lib/publish/manualImportGuide.ts`). The
 * ZIP is built with the clock fixed, as a `.ccz` is.
 */
export async function importFile(
	source: PublishDocument,
	domain: string,
): Promise<Buffer> {
	const choice = chooseDownloadTarget(
		[
			{
				server: PROOF_SERVER,
				domain,
				hqAppId: PLACEHOLDER_APP_ID,
				emptyCaseListText: false,
				earlierHqApps: 0,
				adopted: false,
			},
		],
		{ format: "json", declaresAndroid: declaresAndroid(source.doc) },
	);
	const { export: prepared } = await prepareDocument(
		source,
		"hq-json",
		choice.kind === "project-space" ? attachmentUrlTarget(choice.target) : null,
	);
	const {
		doc,
		assets,
		lookupWorkbook,
		managedLookupTables,
		managedLookupWorkbooks,
	} = prepared;
	const hqJson = expandDoc(doc, {
		attachmentTarget: prepared.attachmentTarget,
		...(assets.size > 0 && { assets }),
		...(prepared.lookupNaming && { lookupNaming: prepared.lookupNaming }),
	});
	const guide = hqImportFileGuide({
		appName: doc.appName,
		doc,
		assets,
		lookupWorkbook,
		managedLookupWorkbooks,
		managedLookupTables,
		attachmentTarget: prepared.attachmentTarget,
		lookupNaming: prepared.lookupNaming,
	});
	return atInstant(CCZ_CLOCK, () =>
		buildHqJsonExportArchive(
			doc.appName,
			doc,
			hqJson,
			assets,
			lookupWorkbook,
			managedLookupWorkbooks,
			renderManualImportGuide(guide),
		),
	);
}

/**
 * The paths of the media upload a publish of the document sends: one per
 * wire path of the assets the bulk upload carries (`bulkUploadAssets`), as
 * `buildMediaBulkUploadZip` writes them, sorted. Empty for a document whose
 * bulk upload carries no media: an image only the logo uses is never in it.
 */
export async function preparedMediaPaths(
	source: PublishDocument,
	domain: string,
): Promise<string[]> {
	const { export: prepared } = await prepareDocument(
		source,
		"hq-upload",
		attachmentUrlTarget({ server: PROOF_SERVER, domain }),
	);
	return [
		...new Set(
			[...bulkUploadAssets(prepared.doc, prepared.assets).values()].map(
				(asset) => asset.wirePath,
			),
		),
	].sort();
}

/** Nova's verdict for a stored document, after the same admission a capture makes. */
export function documentVerdict(source: PublishDocument): NovaPublishVerdict {
	return novaPublishVerdict(
		hydrateAdmittedDocument({
			id: source.id,
			doc: source.doc,
			...(source.lookup !== undefined && { lookup: source.lookup }),
		}),
		source,
	);
}
