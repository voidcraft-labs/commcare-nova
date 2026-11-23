import {
	androidRequirementsComparisonSource,
	androidRequirementsPrivilegeLost,
	changesUnownedAndroidApps,
} from "@/lib/commcare/androidAppDependencies";
import "server-only";

/**
 * A review of the changes made in CommCare HQ to an app Nova publishes
 * there: what changed, read as two readings of two of CommCare HQ's own
 * answers, and what taking it would do to the app. A review writes nothing;
 * a bring-in (`bringIn.ts`) runs the same computation again and acts only
 * where its digest is the one the person reviewed.
 *
 * In order: the deployment, its baseline and the pair test, the baseline's
 * size, the head, the bracketed read of the app, the reference document,
 * the files it publishes settled by content, the publish's own comparison,
 * the Project's data and the files the two sources name, both readings,
 * acceptance of the reading now under the app's own declaration, and the
 * plan. The reference comes before the files because the files a review
 * settles are the ones the reference publishes.
 *
 * No log line holds a word of an app: a finding's name, a difference's
 * detail and CommCare HQ's own text reach no line.
 */

import { v7 as uuidv7 } from "uuid";
import { greatestFoldBaselineSeq } from "@/lib/agent/change-set/baseLoader";
import { roleAllowsApp } from "@/lib/auth/projectRoles";
import { readHqSaveOnlyEditedAnswers } from "@/lib/commcare/client";
import {
	HQ_BRING_IN_APP_MAX_BYTES,
	type HqAlignedModule,
	readHqAppForReading,
} from "@/lib/commcare/hq/appReading";
import {
	type HqAppSource,
	publishReadingFactsMoved,
} from "@/lib/commcare/hq/appSource";
import {
	classifyHqFailure,
	type HqFailure,
	hqReadCircumstance,
} from "@/lib/commcare/hq/failure";
import { wirePathFor } from "@/lib/commcare/multimedia/assetWirePath";
import { bulkUploadAssets } from "@/lib/commcare/multimedia/hqJsonExportArchive";
import type { ReadDraft } from "@/lib/commcare/reader";
import { matchingResolver } from "@/lib/commcare/reader/identity";
import { externalIdentityMap } from "@/lib/commcare/reader/identityMap";
import { placeOrder } from "@/lib/commcare/reader/place";
import { readWorkLimit, sourceCharacters } from "@/lib/commcare/reader/work";
import { COMMCARE_SERVERS } from "@/lib/commcare/servers";
import { targetWireIdentity } from "@/lib/commcare/wireIdentity";
import { WorkCancelled, WorkLimitReached } from "@/lib/commcare/workMeter";
import {
	findReadyAssetIdsByProjectAndHashes,
	loadAssetsByIds,
	type MediaAssetRecord,
} from "@/lib/db/mediaAssets";
import { getAppDb } from "@/lib/db/pg";
import { getHqCredentials } from "@/lib/db/settings";
import type {
	DeclarationChoice,
	DeclarationChoices,
} from "@/lib/doc/platformDeclaration";
import { type BlueprintDoc, PLATFORMS, type Platform } from "@/lib/domain";
import { isBuiltinIconRef } from "@/lib/domain/builtinIcons";
import { bulkUploadAssetIds, collectAssetRefs } from "@/lib/domain/mediaRefs";
import type { MediaAssetId } from "@/lib/domain/multimedia";
import {
	NO_ENTRIES,
	ownRecordValue,
	recordFromEntries,
} from "@/lib/domain/records";
import { log } from "@/lib/logger";
import {
	builtinAssetRows,
	partitionAssetRefs,
} from "@/lib/media/builtinIconAssets";
import { resolveMediaManifest } from "@/lib/media/manifest";
import { readOrganizationAuthoringSnapshot } from "@/lib/organization/service";
import { documentChangeLines } from "@/lib/publish/documentChangeCopy";
import type { DriftReference } from "@/lib/publish/driftReference";
import type { FirstPublishChangeId } from "@/lib/publish/firstPublishChangeIds";
import { firstPublishLines } from "@/lib/publish/firstPublishCopy";
import {
	ANDROID_APPS_PRIVILEGE_LOST_LINE,
	caseDataLine,
	caseTypesLine,
	whereHqKeepsLines,
} from "@/lib/publish/hqChangesCopy";
import {
	type CircumstanceDetail,
	type CircumstanceFinding,
	circumstanceFinding,
	type Finding,
	type HqPlace,
	type ReadCircumstance,
} from "@/lib/publish/hqFindings";
import type { AdoptedMediaFile } from "../adoption";
import { DeploymentAppDeletedError, deploymentNotFound } from "../errors";
import {
	type HqMediaPath,
	type HqMediaRecord,
	hqMediaRecordMoves,
	hqMediaStandings,
	movedRecordedPaths,
	nextHqMediaRecord,
	publishedMediaFiles,
	recordedHqFilePaths,
} from "../hqMedia";
import { type SettledHqMediaRead, settleHqMedia } from "../hqMediaSettle";
import {
	appConfirmationScope,
	diffHqAppSource,
	fileReviewMoved,
	hqDiscardDigest,
	normalizeHqAppSource,
	removalLedgerPaths,
	removedHqFileLine,
	removedHqFileReplaced,
	removedHqFiles,
	unapprovedHqFiles,
} from "../hqSourceBaseline";
import {
	type AcceptedDeclaration,
	acceptReadingSteps,
} from "../reading/acceptance";

import { editModeTest, formsWithinReading, Pieces } from "../reading/gather";
import { reviewMediaId } from "../reading/mediaIds";
import {
	projectDataReadsOf,
	type ReaderProjectDataReads,
	type ReadingProjectData,
	readingLookupSnapshot,
	readingProjectDataFindingsFor,
} from "../reading/projectData";
import {
	adoptedMediaFiles,
	type HqMediaVerdict,
	mediaReadLimit,
	narrowDeclarationsByMedia,
	type ReadingMediaPlan,
	readingMediaFindings,
	readingMediaRows,
} from "../reading/projectData/media";
import { judgeReadingMedia } from "../reading/projectData/mediaStore";
import {
	postgresProjectSide,
	readReadingProjectData,
} from "../reading/projectData/read";
import { projectDataReview } from "../reading/projectData/review";
import { handOffSettlements } from "../reading/projectData/settlements";
import {
	holdChangesReadings,
	noRoomFinding,
	withBringInRoom,
} from "../reading/room";
import { READING_MAX_LISTED_FINDINGS } from "../reading/types";
import { driftReferenceOf, fileDisclosureTruncated } from "../remoteChanges";
import { activeRemoteApp, deploymentEnding } from "../resources";
import {
	type DeploymentScope,
	type DeploymentTargetKey,
	readAppBaseline,
	readDeployment,
	readMemberNames,
	readProjectName,
	readTargetIdentity,
	withDeploymentReadSnapshot,
} from "../store";
import {
	exportIdentityOf,
	formIdsAgree,
	observedTargetIdentity,
	resolveTargetIdentity,
	sameTargetIdentity,
	type TargetIdentity,
	targetIdentityChanges,
} from "../targetIdentity";
import type { AppBaseline, DeploymentResource } from "../types";
import { sourceFromBaseline } from "./baselineSource";
import {
	contentNamedDocument,
	hqChangesReviewDigest,
	reviewAssetNames,
} from "./digest";
import { type HqChangePlan, planHqChangesSteps } from "./plan";
import {
	type HqChangeReadings,
	type HqChangeReadingsResult,
	makeHqChangeReadingsSteps,
	ownPathsBase,
	planChangeReadingMedia,
} from "./readings";
import {
	DeploymentFoldBindingChangedError,
	loadReferenceDocument,
	type ReferenceDocument,
	usablePair,
} from "./reference";
import type {
	HqChangesReview,
	HqChangesStage,
	HqChangesUnavailable,
} from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Matching owned content may still change a real form ID, a file, or a
 * first-publish consequence. The live reader and capture use the same decision. */
export function reviewMatchingSource(
	basis: HqChangesBasis,
): Extract<HqChangesReview, { kind: "nothing" }> | null {
	const {
		reference,
		targetIdentity,
		modules,
		published,
		baseline,
		learned,
		since,
	} = basis;
	const removed = removedHqFiles(basis.normalized.normalized, {
		published,
		recorded: baseline.mediaFiles,
	});
	// The historic projection settles files at its own revision. If local
	// edits changed the carriers a publish sends, compare the actual head.
	const carriersChanged = () => {
		const then = bulkUploadAssetIds(reference.doc);
		const now = bulkUploadAssetIds(basis.head.doc);
		return then.size !== now.size || [...then].some((id) => !now.has(id));
	};
	if (
		baseline.firstPublishReview === "required" ||
		fileReviewMoved(removed, baseline) ||
		(basis.source.multimediaMap?.length &&
			basis.head.seq !== baseline.novaRevision &&
			carriersChanged()) ||
		!formIdsAgree(reference.doc, targetIdentity, modules) ||
		publishReadingFactsMoved(
			baseline.source,
			basis.source,
			new Set([
				...published.map((file) => `${JR_FILE}${file.wirePath}`),
				...recordedHqFilePaths(
					baseline.mediaFiles,
					basis.source.multimediaMap ?? [],
				),
			]),
		)
	)
		return null;
	const next = nextHqMediaRecord({
		published,
		previous: baseline.mediaFiles,
		learned,
		reported: NO_ENTRIES,
		settled: published,
	});
	if (!hqMediaRecordMoves(baseline.mediaFiles, next)) return unchanged(since);
	return {
		kind: "nothing",
		reason: "reads-the-same",
		since,
		hqChanges: [],
		publishChanges: [],
		readingId: basis.readingId,
		reviewDigest: hqChangesReviewDigest({
			identity: { read: targetIdentity, next: targetIdentity },
			authority: reviewAuthority(basis),
			baselineDigest: baseline.sourceDigest,
			sourceDigest: basis.normalized.digest,
			headSeq: basis.head.seq,
			media: published,
			recordedFiles: baseline.mediaFiles,
			incomingPaths: removalLedgerPaths(basis.normalized.normalized, published),
			target: null,
			tables: [],
		}),
	};
}

function reviewAuthority(basis: HqChangesBasis) {
	return appConfirmationScope(
		basis.scope,
		basis.target,
		basis.live,
		basis.head.seq,
		basis.remoteRevision,
		basis.baseline,
	);
}

/** A stage or file line, as both requests stream them. */
export type HqChangesProgress =
	| { readonly type: "stage"; readonly stage: HqChangesStage }
	| { readonly type: "files"; readonly done: number; readonly total: number };

/** A baseline that holds a source and names the revision it describes. */
export type PairedBaseline = Exclude<
	AppBaseline,
	{ readonly origin: "unread" }
> & { readonly novaRevision: number };

/** Resolve an incoming file at the same held or content path its accepted
 * export uses, even before the reading has put its bytes in the Project. */
async function prospectiveFileLosses(
	basis: HqChangesBasis,
	doc: BlueprintDoc,
	identity: TargetIdentity,
	incoming: readonly AdoptedMediaFile[],
	assetNames?: ReadonlyMap<MediaAssetId, MediaAssetId>,
) {
	if (basis.source.multimediaMap?.length === 0) return [];
	const visible = bulkUploadAssetIds(doc);
	const paths = exportIdentityOf(doc, identity).heldMediaPaths;
	const files = new Map<string, AdoptedMediaFile>(
		incoming.map((file) => [file.assetId, file]),
	);
	const published: { wirePath: string }[] = [];
	let manifest: Awaited<ReturnType<typeof resolveMediaManifest>> | undefined;
	for (const assetId of visible) {
		const asset = files.get(assetId) ?? basis.ownRows.get(assetId);
		let path = isBuiltinIconRef(assetId)
			? undefined
			: paths.get(assetNames?.get(assetId) ?? assetId);
		if (!path && asset) path = wirePathFor(asset.contentHash, asset.extension);
		if (!path) {
			manifest ??= await resolveMediaManifest(doc, basis.scope.projectId, {
				withBytes: false,
				heldPaths: paths,
			});
			path = manifest.get(assetId)?.wirePath;
		}
		if (path) published.push({ wirePath: path });
	}
	return removedHqFiles(basis.normalized.normalized, {
		published,
		recorded: basis.baseline.mediaFiles,
	});
}

/** What one computation logs and the test at the cap reads. */
export interface HqChangesFacts {
	/** `Buffer.byteLength(JSON.stringify(source.raw))` of CommCare HQ's app now; null where it was not read. */
	readonly sourceBytes: number | null;
	readonly checkMs: number;
	readonly longestPieceMs: number;
	/** What the longest piece was part of (`Pieces.at`). */
	readonly longestPieceAt: string;
	/** The work meter's units over every piece, the most one piece did, and what that one was
	 *  part of (`Pieces`). */
	readonly workUnits: number;
	readonly longestPieceUnits: number;
	readonly longestPieceUnitsAt: string;
}

/**
 * What a request read of the deployment, the app and CommCare HQ's source,
 * which a bring-in records. Held in memory until the request answers.
 */
export interface HqChangesBasis {
	readonly scope: DeploymentScope;
	readonly target: DeploymentTargetKey;
	readonly readingId: string;
	readonly deployment: { readonly id: string; readonly endings: number };
	/** The live app mapping. */
	readonly live: DeploymentResource;
	readonly baseline: PairedBaseline;
	readonly since: DriftReference;
	/** The name of the app's Project, which a table's choice names. */
	readonly projectName: string;
	readonly head: { readonly doc: BlueprintDoc; readonly seq: number };
	readonly reference: Extract<ReferenceDocument, { readonly kind: "ok" }>;
	/**
	 * Where the deployment records CommCare HQ keeps what the document doesn't
	 * hold (`store.ts::readTargetIdentity`), which a take resolves the reading
	 * over.
	 */
	readonly targetIdentity: TargetIdentity;
	/** Taken before CommCare HQ was asked. */
	readonly observedAt: string;
	readonly remoteRevision: number;
	readonly source: HqAppSource;
	readonly modules: readonly HqAlignedModule[];
	readonly normalized: {
		readonly normalized: unknown;
		readonly text: string;
		readonly bytes: number;
		readonly digest: string;
	};
	/** Every file the reference publishes, settled: no path `moved` or `unrecorded`. */
	readonly published: readonly HqMediaPath[];
	/** Ids found by content to hold this app's own bytes. */
	readonly learned: HqMediaRecord;
	/** The rows of the assets the reference publishes, by asset id. */
	readonly ownRows: ReadonlyMap<string, MediaAssetRecord>;
}

/** Everything the synchronous check reads. */
export interface FetchedHqChanges extends HqChangesBasis {
	/** The authorized Project library that supplies this reading's actual and prospective assets. */
	readonly projectMedia: {
		byIds(ids: readonly MediaAssetId[]): Promise<readonly MediaAssetRecord[]>;
		byContent(
			hashes: readonly string[],
		): Promise<readonly Pick<MediaAssetRecord, "id" | "contentHash">[]>;
	};
	readonly comparisonSource?: unknown;
	/** CommCare HQ dropped the baseline's Android apps with the project space's
	 *  App Dependencies, so the comparison source holds none either
	 *  (`androidRequirementsPrivilegeLost`). */
	readonly androidPrivilegeLost?: true;
	readonly saveOnlyEditedApplied?: boolean;
	/** The Project's data, bound with no answer of the person's. */
	readonly data: ReadingProjectData;
}

/** What the check decided, for a bring-in to act on. */
export interface CheckedHqChanges {
	readonly removedFiles: readonly string[];
	readonly fetched: FetchedHqChanges;
	readonly plan: Extract<
		HqChangePlan,
		{ readonly kind: "nothing" | "changes" }
	>;
	/** The app's own declaration, as acceptance judged it on the reading now. */
	readonly declaration: AcceptedDeclaration;
	readonly readings: HqChangeReadings;
	/** The reading now's draft. */
	readonly draft: ReadDraft;
	readonly readsNow: ReaderProjectDataReads;
	/** The tags the reading now reads and the base does not. */
	readonly newTags: readonly string[];
	readonly media: {
		readonly base: ReadingMediaPlan;
		readonly now: ReadingMediaPlan;
	};
	/** The data the readings were bound under. */
	readonly data: ReadingProjectData;
	/**
	 * The deployment's target-identity record as read (`read`) and as this
	 * reading resolves it (`next`): what a take records and computes its
	 * export over.
	 */
	readonly targetIdentity: {
		readonly read: TargetIdentity;
		readonly next: TargetIdentity;
	};
}

/**
 * The deployment's target-identity record once the reading now is recorded:
 * what it observed of every menu and form `doc` holds, every keyed create,
 * and every file of the reading `doc` shows
 * (`targetIdentity.ts::observedTargetIdentity`), resolved over the stored
 * record by the one rule (`resolveTargetIdentity`). Null where a form of the
 * reading has no real id in CommCare HQ's application resource, which
 * acceptance refuses before a reading is clean.
 */
export function takenTargetIdentity(input: {
	readonly fetched: HqChangesBasis;
	readonly draft: ReadDraft;
	readonly files: readonly AdoptedMediaFile[];
	readonly assetNames?: ReadonlyMap<MediaAssetId, MediaAssetId>;
	readonly doc: BlueprintDoc;
}): {
	readonly read: TargetIdentity;
	readonly next: TargetIdentity;
} | null {
	const shown = collectAssetRefs(input.doc);
	const id = (assetId: MediaAssetId) =>
		input.assetNames?.get(assetId) ?? assetId;
	const original = input.fetched.targetIdentity;
	const read = input.assetNames?.size
		? {
				...original,
				mediaPaths: original.mediaPaths.map((row) => ({
					...row,
					assetId: id(row.assetId),
				})),
			}
		: original;
	const observed = observedTargetIdentity({
		read: input.draft.identities,
		aligned: input.fetched.modules,
		mediaFiles: input.files
			.filter((file) => shown.has(file.assetId))
			.map((file) => ({ ...file, assetId: id(file.assetId) })),
		mediaMap: input.fetched.source.multimediaMap ?? [],
		doc: input.doc,
	});
	if (!observed.ok) return null;
	return {
		read,
		next: resolveTargetIdentity(read, observed.observed, input.doc),
	};
}

/** A clean reading that named a form with no real id: Nova's own defect. */
function identityRowsDefect(fetched: HqChangesBasis): CheckResult {
	return {
		kind: "answer",
		review: unavailable("nova-defect", fetched.since),
		defect: { check: "identity-rows", signature: "form-with-no-real-id" },
	};
}

/** One computation's answer, and what a bring-in acts on. */
export interface HqChangesComputation {
	readonly review: HqChangesReview;
	readonly facts: HqChangesFacts;
	/** Null for every review a bring-in cannot act on. */
	readonly basis: HqChangesBasis | null;
	/** Null where the review answered before the readings: the files alone said it reads the same. */
	readonly checked: CheckedHqChanges | null;
	/** Whether publishing to the project space was stopped, which a bring-in answers in its own words. */
	readonly ended: boolean;
}

export interface HqChangesComputeOptions {
	/** Minted by a review; the one a bring-in was sent, so a newly read table's ids derive alike. */
	readonly readingId: string;
	/** True in a bring-in: the plan keeps the bytes of each file CommCare HQ added or replaced. */
	readonly keepMedia: boolean;
	readonly onEvent: (event: HqChangesProgress) => void;
	readonly cancel?: AbortSignal;
	/** The pieces a bring-in counts its own synchronous work in beside the computation's. */
	readonly pieces?: Pieces;
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

const APP: HqPlace = { kind: "app" };

function atApp(code: ReadCircumstance): CircumstanceFinding {
	return circumstanceFinding(code, APP, {} as CircumstanceDetail<typeof code>);
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/** The account of `findings`: each once, by place and then code, the first ones listed. */
export function accountReview(
	findings: readonly Finding[],
): Extract<HqChangesReview, { readonly kind: "account" }> {
	const seen = new Set<string>();
	const all = findings
		.filter((finding) => {
			const key = JSON.stringify([finding.code, finding.place, finding.detail]);
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.sort(
			(a, b) => placeOrder(a.place, b.place) || compareText(a.code, b.code),
		);
	const counts = { notYet: 0, never: 0, fixInHq: 0 };
	for (const finding of all) {
		if (finding.standing === "not-yet") counts.notYet += 1;
		else if (finding.standing === "never") counts.never += 1;
		else if (finding.standing === "fix-in-hq") counts.fixInHq += 1;
	}
	return {
		kind: "account",
		findings: all.slice(0, READING_MAX_LISTED_FINDINGS),
		more: Math.max(0, all.length - READING_MAX_LISTED_FINDINGS),
		counts,
	};
}

/** A failed read of CommCare HQ: a stop where its circumstance stops, else the account of it. */
function failedRead(failure: HqFailure): HqChangesReview {
	const finding = atApp(hqReadCircumstance(failure));
	return finding.standing === "stop"
		? { kind: "stop", finding }
		: accountReview([finding]);
}

/**
 * A review Nova cannot make. `since` is what the change is measured against,
 * as the deployment's baseline says, so every surface words a reason whose
 * sentence names it (a baseline Nova could not read, a base it cannot read
 * without the Project's data, a document Nova updated since) alike without
 * reading the baseline again. Null where there is no baseline to say it.
 */
function unavailable(
	reason: HqChangesUnavailable,
	since: DriftReference | null,
	requiresReview = false,
): HqChangesReview {
	return {
		kind: "unavailable",
		reason,
		since,
		...(requiresReview && { requiresReview: true }),
	};
}

function unchanged(
	since: DriftReference,
): Extract<HqChangesReview, { kind: "nothing" }> {
	return {
		kind: "nothing",
		reason: "unchanged",
		since,
		hqChanges: [],
		publishChanges: [],
		readingId: null,
		reviewDigest: null,
	};
}

/** Each next-publish id as the sentence a surface shows it by, in registry order. */
export function publishChangeSentences(
	ids: readonly FirstPublishChangeId[],
): readonly string[] {
	if (ids.length === 0) return [];
	const lines = firstPublishLines(
		{ ids, touchesWorkers: false, of: "next-publish" },
		"review",
	);
	return [...lines.workers.lines, ...lines.hqOnly.lines].map(
		(line) => line.sentence,
	);
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

export type HqChangesOperation = "review" | "bring-in";

/** What every log line of a computation names: never the project space or a word of the app. */
export function scopeContext(
	scope: DeploymentScope,
	operation: HqChangesOperation,
): Record<string, unknown> {
	return {
		appId: scope.appId,
		projectId: scope.projectId,
		userId: scope.actorUserId,
		operation,
	};
}

/**
 * The line of a review Nova could not make: at error where the reason is
 * Nova's own (a base it cannot read, a change that did not fit, which names
 * the plan's check and signature), at warn where it is a limit or a move.
 */
function logUnavailable(
	scope: DeploymentScope,
	operation: HqChangesOperation,
	reason: HqChangesUnavailable,
	defect?: { readonly check: string; readonly signature: string },
): void {
	const context = { ...scopeContext(scope, operation), phase: reason };
	switch (reason) {
		case "base-unreadable":
			log.error("[hq-changes] base unreadable", undefined, context);
			return;
		case "nova-defect":
			log.error(
				`[hq-changes] nova defect: ${defect?.check ?? "unknown"}: ${defect?.signature ?? "unknown"}`,
				undefined,
				{
					...context,
					...(defect !== undefined && {
						check: defect.check,
						signature: defect.signature,
					}),
				},
			);
			return;
		case "base-too-large":
		case "comparison-too-intricate":
		case "app-moved":
			log.warn(`[hq-changes] unavailable: ${reason}`, context);
			return;
		default:
			return;
	}
}

// ---------------------------------------------------------------------------
// The declaration
// ---------------------------------------------------------------------------

function declaredBy(runsOnlyOn: Platform | null | undefined): Platform[] {
	return runsOnlyOn === undefined || runsOnlyOn === null
		? [...PLATFORMS]
		: [runsOnlyOn];
}

/** Every platform some choice declares, in the platforms' order. */
function offeredBy(choices: readonly DeclarationChoice[]): Platform[] {
	const offered = new Set<Platform>();
	for (const choice of choices)
		for (const platform of declaredBy(choice.runsOnlyOn)) offered.add(platform);
	return PLATFORMS.filter((platform) => offered.has(platform));
}

/** Whether the reference holds the questions a date and time split of `draft` made. */
function holdsSplit(ref: BlueprintDoc, draft: ReadDraft): boolean {
	if (draft.declaration.kind !== "choices") return false;
	return draft.declaration.choices.some(
		(choice) =>
			choice.split &&
			choice.splits.some(
				(split) => ownRecordValue(ref.fields, split.dateUuid) !== undefined,
			),
	);
}

/**
 * The app's own declaration among `choices`: the one that runs where the
 * reference runs and, where the reference holds the questions a split made,
 * splits; the other split where only it is offered. Undefined where none
 * runs where the app does.
 */
function appDeclaration(
	choices: readonly DeclarationChoice[],
	ref: BlueprintDoc,
	split: boolean,
): DeclarationChoice | undefined {
	const runs = ref.appSettings.runsOnlyOn ?? null;
	const where = choices.filter(
		(choice) => (choice.runsOnlyOn ?? null) === runs,
	);
	return (
		where.find((choice) => choice.split === split) ??
		where.find((choice) => choice.split !== split)
	);
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

const JR_FILE = "jr://file/";

/** The paths the reading now names Nova's own file by: published and `recorded` or `absent`. */
function ownPathsNow(published: readonly HqMediaPath[]): ReadonlySet<string> {
	return new Set(
		published
			.filter(
				(path) => path.standing === "recorded" || path.standing === "absent",
			)
			.map((path) => `${JR_FILE}${path.wirePath}`),
	);
}

/** The two plans' files, each once by key, as one plan to judge. */
export function unionPlan(
	base: ReadingMediaPlan,
	now: ReadingMediaPlan,
): ReadingMediaPlan {
	const files = new Map(base.files.map((file) => [file.key, file]));
	for (const file of now.files) {
		const previous = files.get(file.key);
		// A slot that holds the file needs its bytes. For the same use on both sides,
		// its current paths supply the name the Project library will show.
		if (!previous || !file.availabilityOnly || previous.availabilityOnly)
			files.set(file.key, file);
	}
	return {
		files: [...files.values()].sort((a, b) => compareText(a.key, b.key)),
		verdicts: NO_ENTRIES,
		kept: new Map(),
		published: NO_ENTRIES,
	};
}

/** `plan` with a judged plan's verdicts, kept bytes and published assets. */
export function withJudged(
	plan: ReadingMediaPlan,
	judged: Pick<ReadingMediaPlan, "verdicts" | "kept" | "published">,
): ReadingMediaPlan {
	const verdicts = recordFromEntries<HqMediaVerdict>([]);
	const kept = new Map<string, Buffer>();
	const published = recordFromEntries<MediaAssetId>([]);
	for (const file of plan.files) {
		const verdict = ownRecordValue(judged.verdicts, file.key);
		if (verdict === undefined) continue;
		verdicts[file.key] =
			file.availabilityOnly && verdict.kind !== "missing"
				? { kind: "available" }
				: verdict;
		if (file.availabilityOnly || verdict.kind !== "held") continue;
		const bytes = judged.kept.get(verdict.file.contentHash);
		if (bytes !== undefined) kept.set(verdict.file.contentHash, bytes);
		const asset = ownRecordValue(judged.published, file.key);
		if (asset !== undefined) published[file.key] = asset;
	}
	return { files: plan.files, verdicts, kept, published };
}

/** File assignments for this reading. An HQ file is identified by the native
 * type and id in its own source. Each owned path resolves to the immutable
 * reference asset only while it is owned by this reading and used by a slot. */
function filesOfReading(
	fetched: HqChangesBasis,
	plan: ReadingMediaPlan,
	own: ReadonlySet<string>,
	draft: ReadDraft,
): readonly AdoptedMediaFile[] {
	const used = new Set(draft.facts.mediaReferences.map((ref) => ref.path));
	const held = fetched.published.flatMap((path) => {
		const hqPath = `${JR_FILE}${path.wirePath}`;
		if (!own.has(hqPath) || !used.has(hqPath)) return [];
		const row = fetched.ownRows.get(path.assetId);
		if (row === undefined) return [];
		return [
			{
				hqPath,
				assetId: path.assetId as MediaAssetId,
				contentHash: path.contentHash,
				extension: row.extension,
			},
		];
	});
	return [...adoptedMediaFiles(plan), ...held];
}

/** The rows of every asset the reference publishes, built-in icons included. */
async function ownAssetRows(
	published: readonly HqMediaPath[],
	projectId: string,
): Promise<ReadonlyMap<string, MediaAssetRecord>> {
	const { realIds, builtinSlugs } = partitionAssetRefs(
		published.map((path) => path.assetId),
	);
	const rows =
		realIds.length === 0 ? [] : await loadAssetsByIds(realIds, projectId);
	return new Map(
		[...rows, ...builtinAssetRows(builtinSlugs)].map((row) => [row.id, row]),
	);
}

/** Both native readings name identical bytes alike before planning, so a
 * file already on the head, its immutable reference or a parked target path
 * cannot appear to be a document change just because HQ gave it another id. */
async function comparisonMedia(
	fetched: FetchedHqChanges,
	plans: CheckedHqChanges["media"],
) {
	const held = new Set<string>();
	for (const plan of [plans.base, plans.now])
		for (const verdict of Object.values(plan.verdicts))
			if (verdict.kind === "held") held.add(verdict.file.contentHash);
	const ownContent = new Map<MediaAssetId, string>();
	if (!held.size) return { plans, ownContent };
	const { realIds } = partitionAssetRefs([
		...new Set([
			...collectAssetRefs(fetched.reference.doc),
			...collectAssetRefs(fetched.head.doc),
			...fetched.targetIdentity.mediaPaths.map((row) => row.assetId),
		]),
	]);
	const otherRows = await fetched.projectMedia.byIds(
		realIds.filter((id) => !fetched.ownRows.has(id)),
	);
	for (const row of [...fetched.ownRows.values(), ...otherRows]) {
		if (
			row.status === "ready" &&
			!isBuiltinIconRef(row.id) &&
			held.has(row.contentHash)
		)
			ownContent.set(row.id, row.contentHash);
	}
	const ready = await fetched.projectMedia.byContent([...held]);
	const known = new Map(ready.map((row) => [row.contentHash, row.id]));
	const named = (plan: ReadingMediaPlan): ReadingMediaPlan => ({
		...plan,
		files: plan.files.map((file) => {
			const verdict = ownRecordValue(plan.verdicts, file.key);
			return verdict?.kind === "held"
				? {
						...file,
						provisionalId:
							known.get(verdict.file.contentHash) ??
							reviewMediaId(verdict.file.contentHash),
					}
				: file;
		}),
	});
	return {
		plans: { base: named(plans.base), now: named(plans.now) },
		ownContent,
	};
}

// ---------------------------------------------------------------------------
// Steps 1 to 3
// ---------------------------------------------------------------------------

type Standing =
	| { readonly kind: "answer"; readonly review: HqChangesReview }
	/** Publishing to the project space was stopped: nothing there is this app's. */
	| { readonly kind: "ended" }
	| {
			readonly kind: "deployment";
			readonly deployment: { readonly id: string; readonly endings: number };
			readonly role: string;
			readonly live: DeploymentResource;
			readonly baseline: PairedBaseline;
			readonly since: DriftReference;
	  };

/** The deployment, its baseline and the pair test: what a review stands on before it reads anything. */
async function standingOf(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
): Promise<Standing> {
	/* An app deleted since the request was authorized, for a member who may
	 * still edit it: the snapshot says so rather than not-found. */
	let existing: Awaited<ReturnType<typeof readDeployment>>;
	let role: string;
	try {
		({ existing, role } = await withDeploymentReadSnapshot(
			scope,
			"edit",
			async (snapshot) => ({
				existing: await readDeployment(snapshot, target),
				role: snapshot.role,
			}),
		));
	} catch (error) {
		if (error instanceof DeploymentAppDeletedError)
			return { kind: "answer", review: unavailable("app-deleted", null) };
		throw error;
	}
	/* No deployment, or one whose publish never made the app there: nothing
	 * in that project space is this app's. */
	if (existing === null)
		return { kind: "answer", review: unavailable("not-published", null) };
	if (deploymentEnding(existing) !== null) return { kind: "ended" };
	const live = activeRemoteApp(existing);
	if (live === null)
		return { kind: "answer", review: unavailable("not-published", null) };
	/* The app is live, so a released mapping is one its restore left released
	 * while another app's write to that HQ app was still open
	 * (`SettledClaims.waiting`): another app took the HQ app while this one was
	 * in recently deleted, and only this app's next publish there takes it
	 * back. */
	if (live.releasedAt !== null)
		return { kind: "answer", review: unavailable("hq-app-taken", null) };
	const baseline = await readAppBaseline(scope, target);
	if (baseline === null || baseline.remoteAppId !== live.remoteId)
		return { kind: "answer", review: unavailable("no-reference", null) };
	if (baseline.origin === "unread")
		return {
			kind: "answer",
			review: unavailable(
				"baseline-unread",
				driftReferenceOf(baseline, live),
				baseline.firstPublishReview === "required",
			),
		};
	const foldSeq = await greatestFoldBaselineSeq(await getAppDb(), scope.appId);
	if (!usablePair(baseline, live, foldSeq) || baseline.novaRevision === null)
		return {
			kind: "answer",
			review: unavailable(
				"no-reference",
				driftReferenceOf(baseline, live),
				baseline.firstPublishReview === "required",
			),
		};
	return {
		kind: "deployment",
		role,
		deployment: {
			id: existing.deployment.id,
			endings: existing.deployment.endings,
		},
		live,
		baseline: baseline as PairedBaseline,
		since: driftReferenceOf(baseline, live),
	};
}

// ---------------------------------------------------------------------------
// The computation
// ---------------------------------------------------------------------------

/**
 * The whole computation of one request, as a review answers it and a
 * bring-in acts on it. It writes nothing. `edit`, as Refresh is: it reads
 * CommCare HQ with the member's own key.
 */
export async function computeHqChanges(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	options: HqChangesComputeOptions,
	operation: HqChangesOperation,
): Promise<HqChangesComputation> {
	if (!roleAllowsApp(scope.role, "edit")) throw deploymentNotFound();
	const pieces = options.pieces ?? new Pieces(options.cancel);
	try {
		return await computeWith(scope, target, options, operation, pieces);
	} catch (error) {
		/* A review whose caller cancelled it stops at its next step, and answers as a read of
		 * CommCare HQ the same signal cut off answers. An app that went to recently deleted
		 * while it read, for a member who may still edit it, answers as its first read does. */
		const review: HqChangesReview | null =
			error instanceof WorkCancelled
				? { kind: "stop", finding: atApp("hq-unavailable") }
				: error instanceof DeploymentAppDeletedError
					? unavailable("app-deleted", null)
					: null;
		if (review === null) throw error;
		return {
			review,
			facts: {
				sourceBytes: null,
				checkMs: pieces.total,
				longestPieceMs: pieces.longest,
				longestPieceAt: pieces.longestAt,
				workUnits: pieces.units,
				longestPieceUnits: pieces.longestUnits,
				longestPieceUnitsAt: pieces.longestUnitsAt,
			},
			basis: null,
			checked: null,
			ended: false,
		};
	}
}

async function computeWith(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	options: HqChangesComputeOptions,
	operation: HqChangesOperation,
	pieces: Pieces,
): Promise<HqChangesComputation> {
	const { onEvent, cancel } = options;
	let sourceBytes: number | null = null;
	// Until the outgoing comparison is available, an incomplete reading cannot
	// promise that publishing over its findings will be possible.
	let mayOfferDiscard = false;
	const standing = await standingOf(scope, target);
	const answer = (
		review: HqChangesReview,
		basis: HqChangesBasis | null = null,
		checked: CheckedHqChanges | null = null,
	): HqChangesComputation => ({
		review:
			standing.kind === "deployment" &&
			(!mayOfferDiscard ||
				standing.baseline.firstPublishReview === "required") &&
			(review.kind === "account" ||
				review.kind === "held" ||
				review.kind === "unavailable")
				? { ...review, requiresReview: true }
				: review,
		facts: {
			sourceBytes,
			checkMs: pieces.total,
			longestPieceMs: pieces.longest,
			longestPieceAt: pieces.longestAt,
			workUnits: pieces.units,
			longestPieceUnits: pieces.longestUnits,
			longestPieceUnitsAt: pieces.longestUnitsAt,
		},
		basis,
		checked,
		ended: false,
	});

	/* The deployment, its baseline and the pair. */
	if (standing.kind === "ended")
		return {
			...answer(unavailable("publishing-stopped", null)),
			ended: true,
		};
	if (standing.kind === "answer") return answer(standing.review);
	const { baseline, live, since } = standing;
	scope = { ...scope, role: standing.role };

	/* 2. The baseline's size, before it is read as a source. `readAppBaseline`
	 * has verified and parsed the stored text, as it does for every publish;
	 * no reader pass, diff or source parse runs over a baseline past the cap. */
	if (baseline.sourceBytes > HQ_BRING_IN_APP_MAX_BYTES) {
		logUnavailable(scope, operation, "base-too-large");
		return answer(unavailable("base-too-large", since));
	}
	/* The base reading's room, before anything is read as it. */
	if (!holdChangesReadings(baseline.sourceBytes, 0))
		return answer({ kind: "stop", finding: noRoomFinding() });

	/* 3. The head. */
	const snapshot = await readOrganizationAuthoringSnapshot({
		appId: scope.appId,
		projectId: scope.projectId,
		role: scope.role,
		actorUserId: scope.actorUserId,
	});
	const head = { doc: snapshot.blueprint, seq: snapshot.blueprintSeq };

	/* The member's own connection. */
	const credentials = await getHqCredentials(scope.actorUserId, target.domain);
	if (!credentials.ok)
		return answer({
			kind: "stop",
			finding: atApp(
				credentials.error === "not_configured"
					? "not-connected"
					: "key-cannot-reach-space",
			),
		});
	if (credentials.creds.server !== target.server)
		return answer({ kind: "stop", finding: atApp("not-connected") });
	const creds = credentials.creds;

	/* 4. The app, as one bracketed attempt, made once more where it was saved during it. */
	onEvent({ type: "stage", stage: "reading-app" });
	const observedAt = new Date().toISOString();
	let reading = await readHqAppForReading(creds, target.domain, live.remoteId, {
		cancel,
	});
	if (reading.kind === "changed" && cancel?.aborted !== true)
		reading = await readHqAppForReading(creds, target.domain, live.remoteId, {
			cancel,
		});
	switch (reading.kind) {
		case "changed":
			return answer({ kind: "stop", finding: atApp("changed-while-reading") });
		case "linked":
			return answer({ kind: "stop", finding: atApp("linked-app") });
		case "remote":
			return answer({ kind: "stop", finding: atApp("remote-app") });
		case "deleted":
			return answer({ kind: "stop", finding: atApp("app-deleted") });
		case "gone":
			return answer({ kind: "stop", finding: atApp("app-gone") });
		case "failed":
			return answer(failedRead(reading.failure));
		case "read":
			break;
	}
	const { source, modules } = reading;
	mayOfferDiscard =
		source.multimediaMap !== null &&
		!fileDisclosureTruncated(source.multimediaMap.length, 1);
	sourceBytes = await pieces
		.at("the source's size")
		.run(() => Buffer.byteLength(JSON.stringify(source.raw)));
	/* The reading now's room, before the source is read as one. */
	if (!holdChangesReadings(baseline.sourceBytes, sourceBytes))
		return answer({ kind: "stop", finding: noRoomFinding() });
	const normalized = await pieces
		.at("the source's normalization")
		.run(() => normalizeHqAppSource(source.raw));
	if ("malformed" in normalized)
		return answer({ kind: "stop", finding: atApp("app-unreadable-in-hq") });
	const unownedAndroidSelection =
		!baseline.ownership.profileFeatures?.includes("dependencies") &&
		changesUnownedAndroidApps(
			source.profile.features,
			head.doc.appSettings.requiredAndroidApps,
		);
	/* CommCare HQ deleting the selection with the privilege is no person's
	 * edit, so the app keeps its Android apps: both readings hold none. */
	const androidPrivilegeLost = androidRequirementsPrivilegeLost(
		baseline.source,
		normalized.normalized,
	);
	const languageNames = live.ownership === "adopted" ? "target" : "nova";

	/* 5. The reference document, whose files the publish sends. */
	const referenceInput = {
		appId: scope.appId,
		novaRevision: baseline.novaRevision,
		binding: baseline.foldBinding,
		head,
	};
	const reference = await (baseline.foldBinding
		? withDeploymentReadSnapshot(scope, "edit", ({ db }) =>
				loadReferenceDocument({ ...referenceInput, db }),
			)
		: loadReferenceDocument(referenceInput)
	).catch((error: unknown) => {
		if (error instanceof DeploymentFoldBindingChangedError) return null;
		throw error;
	});
	if (reference === null)
		return answer({ kind: "stop", finding: atApp("changed-while-reading") });
	const targetIdentity = await readTargetIdentity(scope, target);
	if (reference.kind !== "ok") {
		/* With no reference there are no files to settle by content. An
		 * observed move still needs the missing reference for a full reading. */
		const parts = await pieces.at("the source's comparison").run(() =>
			diffHqAppSource({
				baseline: baseline.source,
				current: normalized.normalized,
				ownership: baseline.ownership,
				shell: false,
				languageNames,
				mediaChanged: movedRecordedPaths(
					baseline.mediaFiles,
					source.multimediaMap ?? [],
				),
			}),
		);
		if (
			!unownedAndroidSelection &&
			baseline.firstPublishReview !== "required" &&
			!fileReviewMoved(
				removedHqFiles(normalized.normalized, {
					published: [],
					recorded: baseline.mediaFiles,
				}),
				baseline,
			) &&
			parts.length === 0 &&
			formIdsAgree(head.doc, targetIdentity, modules) &&
			!publishReadingFactsMoved(
				baseline.source,
				source,
				recordedHqFilePaths(baseline.mediaFiles, source.multimediaMap ?? []),
			)
		)
			return answer(unchanged(since));
		logUnavailable(scope, operation, reference.kind);
		return answer(unavailable(reference.kind, since));
	}

	/* 6. The files the reference publishes, settled by content. */
	const manifest = await resolveMediaManifest(reference.doc, scope.projectId, {
		withBytes: false,
		heldPaths: exportIdentityOf(reference.doc, targetIdentity).heldMediaPaths,
	});
	const standings = hqMediaStandings({
		published: publishedMediaFiles(bulkUploadAssets(reference.doc, manifest)),
		record: baseline.mediaFiles,
		now: source.multimediaMap ?? [],
	});
	let published: readonly HqMediaPath[] = standings;
	let learned: HqMediaRecord = NO_ENTRIES;
	/* What settling read of each file, so step 11 asks CommCare HQ for none
	 * of them again: a file at a published path is one the reading now names. */
	let settledReads: ReadonlyMap<string, SettledHqMediaRead> = new Map();
	if (
		standings.some(
			(path) => path.standing === "moved" || path.standing === "unrecorded",
		)
	) {
		const settled = await settleHqMedia(creds, standings, {
			retain: true,
			...(cancel !== undefined && { cancel }),
		});
		if (settled.kind === "failed")
			return answer(
				failedRead(classifyHqFailure(settled.failure, "media-file")),
			);
		published = settled.paths;
		learned = settled.learned;
		settledReads = settled.reads;
	}

	/* 7. The publish's own comparison. */
	const parts = await pieces.at("the source's comparison").run(() =>
		diffHqAppSource({
			baseline: baseline.source,
			current: normalized.normalized,
			ownership: baseline.ownership,
			shell: false,
			languageNames,
			mediaChanged: published.filter((path) => path.standing === "replaced")
				.length,
		}),
	);
	const basis: HqChangesBasis = {
		scope,
		target,
		readingId: options.readingId,
		deployment: standing.deployment,
		live,
		baseline,
		since,
		projectName: await readProjectName(scope),
		head,
		reference,
		targetIdentity,
		observedAt,
		remoteRevision: reading.version,
		source,
		modules,
		normalized,
		published,
		learned,
		ownRows: await ownAssetRows(published, scope.projectId),
	};
	const hiddenFiles =
		fileDisclosureTruncated(source.multimediaMap?.length ?? 0, parts.length) &&
		fileDisclosureTruncated(
			unapprovedHqFiles(
				await prospectiveFileLosses(basis, head.doc, targetIdentity, []),
				baseline.approvedFileRemovals,
			).length,
			parts.length,
		);
	mayOfferDiscard = !hiddenFiles;
	if (!unownedAndroidSelection && parts.length === 0) {
		const same = reviewMatchingSource(basis);
		if (same) return answer(same, same.readingId === null ? null : basis);
	}

	/* 8. The flag a write saved only if changed needs, where either source holds one. */
	const comparisonSource = unownedAndroidSelection
		? androidRequirementsComparisonSource(
				baseline.source,
				reference.doc.appSettings.requiredAndroidApps,
			)
		: androidPrivilegeLost
			? androidRequirementsComparisonSource(baseline.source, undefined)
			: baseline.source;
	const baseSource = await pieces
		.at("the base source")
		.run(() => sourceFromBaseline(comparisonSource));
	/* Each source's forms, parsed once each before anything reads them, held
	 * to what one reading parses as each source's bytes are to the cap. */
	if (!(await formsWithinReading(pieces, source)))
		return answer(accountReview([atApp("too-large")]));
	if (!(await formsWithinReading(pieces, baseSource))) {
		logUnavailable(scope, operation, "base-too-large");
		return answer(unavailable("base-too-large", since));
	}
	let saveOnlyEditedApplied: boolean | undefined;
	const holdsEditMode = await editModeTest(pieces, [source, baseSource]);
	if (holdsEditMode === "fault") {
		logUnavailable(scope, operation, "nova-defect", {
			check: "reader",
			signature: "contract",
		});
		return answer(unavailable("nova-defect", since));
	}
	if (holdsEditMode) {
		const flag = await readHqSaveOnlyEditedAnswers(creds, target.domain, {
			cancel,
		});
		if (flag.kind === "not-a-member")
			return answer({ kind: "stop", finding: atApp("not-a-member") });
		if (flag.kind === "failed") return answer(failedRead(flag.failure));
		saveOnlyEditedApplied = flag.kind === "applied";
	}

	/* 9. The Project's data both sources may read, read once for both readings. */
	onEvent({ type: "stage", stage: "reading-project-data" });
	const readData = (places: "when-source-reads" | "always") =>
		readReadingProjectData({
			creds,
			server: target.server,
			domain: target.domain,
			appId: scope.appId,
			readingId: options.readingId,
			source,
			alsoSource: baseSource,
			project: postgresProjectSide({
				projectId: scope.projectId,
				actorUserId: scope.actorUserId,
				appId: scope.appId,
				origin: { server: target.server, domain: target.domain },
			}),
			places,
			...(cancel !== undefined && { cancel }),
		});
	const projectData = await readData("when-source-reads");
	if (projectData.kind === "failed")
		return answer(failedRead(projectData.failure));
	let fetched: FetchedHqChanges = {
		...basis,
		projectMedia: {
			byIds: (ids) => loadAssetsByIds(ids, scope.projectId),
			byContent: (hashes) =>
				findReadyAssetIdsByProjectAndHashes(scope.projectId, hashes),
		},
		comparisonSource,
		...(androidPrivilegeLost && { androidPrivilegeLost: true }),
		...(saveOnlyEditedApplied !== undefined && { saveOnlyEditedApplied }),
		data: projectData.data,
	};

	/* 10. Both readings before the files, to know which files they name. */
	onEvent({ type: "stage", stage: "checking" });
	let first = await pieces
		.at("the readings")
		.steps(readingsWith(fetched, pieces, null, null));
	if (first.kind === "readings") {
		const { readings } = first;
		const readsPlaces =
			projectDataReadsOf(fetched.data, readings.now).readsPlaces ||
			projectDataReadsOf(fetched.data, readings.base).readsPlaces;
		if (readsPlaces && !fetched.data.placesRead) {
			/* The source test missed a spelling: read places, then both readings
			 * again. One extra pass, never a loop, since this read always reads
			 * places. */
			log.error(
				"[hq-changes] places read missed",
				undefined,
				scopeContext(scope, operation),
			);
			onEvent({ type: "stage", stage: "reading-project-data" });
			const again = await readData("always");
			if (again.kind === "failed") return answer(failedRead(again.failure));
			fetched = { ...fetched, data: again.data };
			onEvent({ type: "stage", stage: "checking" });
			first = await pieces
				.at("the readings")
				.steps(readingsWith(fetched, pieces, null, null));
		}
	}
	if (first.kind === "no-base") {
		logUnavailable(scope, operation, first.reason);
		return answer(unavailable(first.reason, since));
	}
	const baseFirst = first.readings.base;
	const nowFirst = first.readings.now;
	const data = fetched.data;
	if (nowFirst.kind === "account")
		return answer(
			accountReview([
				...nowFirst.findings,
				...projectDataFindingsNow(fetched, data, nowFirst),
			]),
		);
	const runsOn = declaredBy(reference.doc.appSettings.runsOnlyOn);
	const planned = await pieces.at("the media plan").run(() => ({
		base: planChangeReadingMedia(
			baseSource,
			scope.appId,
			baseFirst.draft,
			ownPathsBase(published),
			runsOn,
		),
		now: planChangeReadingMedia(
			source,
			scope.appId,
			nowFirst.draft,
			ownPathsNow(published),
			runsOn,
		),
		projectFindings: projectDataFindingsNow(fetched, data, nowFirst),
	}));
	const beforeFiles = [
		...planned.projectFindings,
		...planned.now.media.findings,
	];
	if (beforeFiles.length > 0) return answer(accountReview(beforeFiles));

	/* 11. The files both sources name, each fetched once and judged. */
	const union = unionPlan(planned.base.plan, planned.now.plan);
	const readLimit = mediaReadLimit(union.files);
	if (readLimit) return answer(accountReview([readLimit]));
	let judged: Pick<ReadingMediaPlan, "verdicts" | "kept" | "published"> = union;
	if (union.files.length > 0) {
		onEvent({ type: "stage", stage: "checking-media" });
		onEvent({ type: "files", done: 0, total: union.files.length });
		const files = await judgeReadingMedia({
			creds,
			plan: union,
			keep: options.keepMedia,
			fetched: settledReads,
			onProgress: (done, total) => onEvent({ type: "files", done, total }),
			...(cancel !== undefined && { cancel }),
		});
		if (files.kind === "failed") return answer(failedRead(files.failure));
		judged = files.plan;
		onEvent({ type: "stage", stage: "checking" });
	}

	/* 12. Both readings with the files' verdicts, acceptance and the plan. The
	 * readings step 10 made are those readings where no verdict changes what
	 * the media index answers. */
	const result = await checkHqChanges(
		fetched,
		{
			base: withJudged(planned.base.plan, judged),
			now: withJudged(planned.now.plan, judged),
		},
		data,
		pieces,
		resolvesAsUnjudged(judged) ? first.readings : undefined,
	);
	if (result.kind === "answer") {
		if (result.review.kind === "unavailable")
			logUnavailable(scope, operation, result.review.reason, result.defect);
		return answer(result.review);
	}
	const review: HqChangesReview =
		result.review.kind === "changes"
			? { ...result.review, madeBy: await madeByNames(fetched) }
			: result.review;
	return answer(review, fetched, result.checked);
}

/**
 * What the Project's data the reading now reads holds that Nova can't hold:
 * the findings a review adds to the reading's own before it judges any file,
 * whether the reading is an account (beside the reader's findings) or read
 * (before the media's). The capture's review over its peer
 * (`proof/corpus/publish.ts::reviewOverPeer`) adds the same.
 */
export function projectDataFindingsNow(
	fetched: HqChangesBasis,
	data: ReadingProjectData,
	now: HqChangeReadings["now"],
): readonly Finding[] {
	return readingProjectDataFindingsFor(
		data,
		projectDataReadsOf(data, now),
		now.kind === "account" ? null : now.draft.doc,
		resolverOf(fetched),
	);
}

/** The resolver over the reference's identities under the deployment's ids. */
function resolverOf(fetched: HqChangesBasis) {
	return matchingResolver(
		fetched.scope.appId,
		externalIdentityMap(
			fetched.reference.identityDoc,
			targetWireIdentity(fetched.targetIdentity.entities),
		),
	);
}

/**
 * Whether files judged `judged` leave the media index answering as it does
 * with no file judged: none judged missing and none published, the two
 * things `readingMediaIndex` reads of a plan.
 */
function resolvesAsUnjudged(
	judged: Pick<ReadingMediaPlan, "verdicts" | "published">,
): boolean {
	return (
		Object.keys(judged.published).length === 0 &&
		Object.values(judged.verdicts).every(
			(verdict) => verdict.kind !== "missing",
		)
	);
}

/** Both readings over `fetched`, with each side's judged files where they are known, one
 *  stage at a time, sharing the request's held emissions. */
function readingsWith(
	fetched: FetchedHqChanges,
	pieces: Pieces,
	base: ReadingMediaPlan | null,
	now: ReadingMediaPlan | null,
	data: ReadingProjectData = fetched.data,
): Generator<void, HqChangeReadingsResult, void> {
	return makeHqChangeReadingsSteps({
		appId: fetched.scope.appId,
		target: {
			origin: COMMCARE_SERVERS[fetched.target.server].baseUrl,
			domain: fetched.target.domain,
		},
		baselineSource: fetched.comparisonSource ?? fetched.baseline.source,
		now: { source: fetched.source, modules: fetched.modules },
		data,
		...(fetched.saveOnlyEditedApplied !== undefined && {
			saveOnlyEditedApplied: fetched.saveOnlyEditedApplied,
		}),
		reference: fetched.reference,
		overrides: fetched.targetIdentity.entities,
		media: { published: fetched.published, base, now },
		heldExpansions: pieces.expansions,
	});
}

/** The names of the members other than the reader who changed the app since the reference, read
 *  in a snapshot that proves the reader may still see the app. */
async function madeByNames(
	fetched: HqChangesBasis,
): Promise<readonly string[]> {
	const others = fetched.reference.actors.filter(
		(actor) => actor !== fetched.scope.actorUserId,
	);
	if (others.length === 0) return [];
	const names = await withDeploymentReadSnapshot(
		fetched.scope,
		"view",
		(snapshot) => readMemberNames(snapshot, others),
	);
	return others.flatMap((actor) => {
		const name = names.get(actor);
		return name === undefined ? [] : [name];
	});
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

export type CheckResult =
	| {
			readonly kind: "answer";
			readonly review: HqChangesReview;
			/** For `nova-defect`: the plan's check and signature, which the log line names. */
			readonly defect?: { readonly check: string; readonly signature: string };
	  }
	| {
			readonly kind: "checked";
			readonly review: Extract<
				HqChangesReview,
				{ readonly kind: "nothing" | "changes" }
			>;
			readonly checked: CheckedHqChanges;
	  };

/**
 * Both readings with every file judged, acceptance of the reading now under
 * the app's own declaration, the plan, and the review with its digest. It
 * asks nothing of CommCare HQ or of the store, and runs each synchronous
 * piece on its own turn. A bring-in runs it again over the files it
 * published and the person's answers, and acts only where the digest is the
 * same. `madeBy` is left empty: naming members reads the store.
 */
export async function checkHqChanges(
	fetched: FetchedHqChanges,
	incomingMedia: {
		readonly base: ReadingMediaPlan;
		readonly now: ReadingMediaPlan;
	},
	data: ReadingProjectData,
	pieces: Pieces,
	/** The readings over exactly these files and this data, where the caller holds them. */
	known?: HqChangeReadings,
): Promise<CheckResult> {
	const { scope, reference } = fetched;
	const appId = scope.appId;
	const ref = reference.doc;
	const { plans: media, ownContent } = await comparisonMedia(
		fetched,
		incomingMedia,
	);

	/* The readings, and what the reading now says of its files and its data. */
	const made: HqChangeReadingsResult =
		known !== undefined && media === incomingMedia
			? { kind: "readings", readings: known }
			: await pieces
					.at("the readings")
					.steps(readingsWith(fetched, pieces, media.base, media.now, data));
	const stage = await pieces.at("the stage").run(() => {
		if (made.kind === "no-base")
			return {
				kind: "answer" as const,
				review: unavailable(made.reason, fetched.since),
			};
		const { readings } = made;
		const now = readings.now;
		const readsNow = projectDataReadsOf(data, now);
		if (now.kind === "account")
			return {
				kind: "answer" as const,
				review: accountReview([
					...now.findings,
					...readingProjectDataFindingsFor(
						data,
						readsNow,
						null,
						resolverOf(fetched),
					),
				]),
			};
		const draft = now.draft;
		const hqPlan = planChangeReadingMedia(
			fetched.source,
			appId,
			draft,
			ownPathsNow(fetched.published),
			declaredBy(ref.appSettings.runsOnlyOn),
		).media;
		const projectFindings = readingProjectDataFindingsFor(
			data,
			readsNow,
			draft.doc,
			resolverOf(fetched),
		);
		const files = readingMediaFindings({
			media: hqPlan,
			plan: media.now,
			runsOn:
				draft.declaration.kind === "choices"
					? offeredBy(draft.declaration.choices)
					: declaredBy(ref.appSettings.runsOnlyOn),
		});
		const findings = [...projectFindings, ...files.findings];
		if (findings.length > 0)
			return { kind: "answer" as const, review: accountReview(findings) };
		return {
			kind: "read" as const,
			readings,
			now,
			draft,
			readsNow,
			hqPlan,
			projectFindings,
			files,
		};
	});
	if (stage.kind === "answer") return stage;
	const { readings, now, draft, readsNow, hqPlan, projectFindings, files } =
		stage;

	/* The app's own declaration among the choices the files leave. */
	const narrowed: DeclarationChoices = narrowDeclarationsByMedia(
		draft.declaration,
		files.playsOn,
	);
	const offered = narrowed.kind === "choices" ? narrowed.choices : [];
	const runs = {
		app: declaredBy(ref.appSettings.runsOnlyOn),
		hq: offeredBy(offered),
	};
	const split = holdsSplit(ref, readings.base.draft) || holdsSplit(ref, draft);
	const own = appDeclaration(offered, ref, split);
	if (narrowed.kind !== "choices" || own === undefined)
		return {
			kind: "answer",
			review: { kind: "held", reason: "runs-elsewhere", runs },
		};

	/* Acceptance of the reading now, with the app's declaration as its one choice. */
	const judgedPlan = {
		...hqPlan,
		inert: [...hqPlan.inert, ...files.inert],
		claims: [...hqPlan.claims, ...files.claims],
	};
	const readerNow = readings.inputs.now;
	const rows = new Map(readingMediaRows(media.now));
	for (const [id, row] of fetched.ownRows) rows.set(id, row);
	const accepted = await pieces.at("acceptance").steps(
		acceptReadingSteps({
			appId,
			target: fetched.target,
			/* The source the reading now read, in the stored key order, so acceptance judges
			 * the one source that reading came from. */
			source: readerNow.source,
			modules: readerNow.modules,
			outcome: now,
			reader: {
				target: readerNow.target,
				lookup: readerNow.lookup,
				organization: readerNow.organization,
				media: readerNow.media,
				appStrings: readerNow.appStrings,
				recordDialect: readerNow.recordDialect,
				...(readerNow.saveOnlyEditedApplied !== undefined && {
					saveOnlyEditedApplied: readerNow.saveOnlyEditedApplied,
				}),
			},
			choices: {
				kind: "choices",
				choices: [own],
				proposed: 0,
				narrowedByHq: narrowed.narrowedByHq,
				keepsWebApps: narrowed.keepsWebApps,
			},
			settlements: handOffSettlements(now.claims.handOffs, judgedPlan, [
				...projectFindings,
				...files.findings,
			]),
			lookup: readingLookupSnapshot(data, readsNow),
			mediaClaims: judgedPlan.claims,
			media: {
				files: filesOfReading(
					fetched,
					media.now,
					ownPathsNow(fetched.published),
					draft,
				),
				rows,
			},
			heldExpansions: pieces.expansions,
		}),
	);

	/* The plan, under the work a reading of both sources is given (`reader/work.ts`): its
	 * canonical rows and diffs run over four documents of the app, and one that would take
	 * more is a comparison Nova does not make. */
	let plan: HqChangePlan;
	try {
		plan = await pieces.at("the plan").steps(
			planHqChangesSteps({
				reference,
				baseMediaFiles: filesOfReading(
					fetched,
					media.base,
					ownPathsBase(fetched.published),
					readings.base.draft,
				),
				now: fetched.head.doc,
				readings,
				accepted,
			}),
			readWorkLimit(
				sourceCharacters(readerNow.source.raw) +
					sourceCharacters(readings.inputs.base.source.raw),
			),
		);
	} catch (error) {
		if (!(error instanceof WorkLimitReached)) throw error;
		return {
			kind: "answer",
			review: unavailable("comparison-too-intricate", fetched.since),
		};
	}
	switch (plan.kind) {
		case "account":
			return { kind: "answer", review: accountReview(plan.findings) };
		case "held":
			return {
				kind: "answer",
				review: {
					kind: "held",
					reason: plan.reason,
					...(plan.translation && { translation: plan.translation }),
					runs: plan.reason === "runs-elsewhere" ? runs : null,
				},
			};
		case "differs":
			return {
				kind: "answer",
				review: unavailable("nova-defect", fetched.since),
				defect: { check: plan.check, signature: plan.signature },
			};
		case "nothing":
		case "changes":
			break;
	}
	const declaration = accepted.ok ? accepted.declarations[0] : undefined;
	if (declaration === undefined)
		throw new Error(
			"A plan took the reading now from an acceptance that judged no declaration. planHqChanges answers `differs` for an acceptance that failed, so look at lib/deployment/hqChanges/plan.ts.",
		);

	/* The review and its digest. */
	const targetDoc = plan.kind === "changes" ? plan.target : fetched.head.doc;
	const targetFiles = adoptedMediaFiles(media.now);
	const assetNames = reviewAssetNames(targetFiles, ownContent);
	// Resolve the same incoming paths twice when HQ supplied a file: first
	// for storage and then in the content namespace used by the receipt.
	// Deduplicating identical files before assigning their paths gives both
	// requests the same proposed record, including a previously parked file.
	const input = { fetched, draft, files: targetFiles, doc: targetDoc };
	const recorded = await pieces
		.at("the target identity")
		.run(() => takenTargetIdentity(input));
	if (!recorded) return identityRowsDefect(fetched);
	const receipt = assetNames.size
		? await pieces
				.at("the target identity")
				.run(() => takenTargetIdentity({ ...input, assetNames }))
		: recorded;
	if (!receipt) return identityRowsDefect(fetched);
	// Older passive refreshes could advance the source while retaining a card
	// from another reading. Otherwise compare the concrete file references:
	// the same register entry can describe a different path or a different file.
	const legacy = fetched.baseline.firstPublishReview === "required";
	const priorNext = fetched.baseline.unverifiedNextChanges;
	const unused = await prospectiveFileLosses(
		fetched,
		targetDoc,
		receipt.next,
		targetFiles,
		assetNames,
	);
	const approved = fetched.baseline.approvedFileRemovals;
	const changedFiles = unapprovedHqFiles(unused, legacy ? [] : approved);
	const discardedFiles =
		targetDoc === fetched.head.doc &&
		sameTargetIdentity(receipt.next, receipt.read)
			? unapprovedHqFiles(unused, approved)
			: unapprovedHqFiles(
					await prospectiveFileLosses(
						fetched,
						fetched.head.doc,
						recorded.read,
						[],
					),
					approved,
				);
	// A new register consequence, just like a different input to an existing
	// consequence, needs a decision even when both sources read to the same doc.
	const changedPublishSubjects = plan.publishChanges.some(
		(id) => id !== "unused-media-entries-removed",
	);
	const requiresReview =
		legacy || changedFiles.length > 0 || changedPublishSubjects;
	const built = await pieces.at("the next publish's body").run(() => {
		const baseTags = new Set(
			Object.keys(projectDataReadsOf(data, readings.base).lookupFields),
		);
		const newTags = Object.keys(readsNow.lookupFields)
			.filter((tag) => !baseTags.has(tag))
			.sort(compareText);
		const newTagSet = new Set(newTags);
		const tables =
			newTags.length === 0
				? []
				: projectDataReview(
						data,
						readsNow,
						draft.doc,
						resolverOf(fetched),
					).tables.filter((table) => newTagSet.has(table.tag));
		const reviewDigest = hqChangesReviewDigest({
			identity: receipt,
			approvedRemovals: approved,
			removedFiles: unused.map((file) => file.digest),
			...(requiresReview && {
				requiredReview: legacy
					? "historical-first-publish"
					: changedFiles.length
						? "new-unused-files"
						: "changed-publish-subjects",
			}),
			authority: reviewAuthority(fetched),
			baselineDigest: fetched.baseline.sourceDigest,
			sourceDigest: fetched.normalized.digest,
			headSeq: fetched.head.seq,
			media: fetched.published,
			recordedFiles: fetched.baseline.mediaFiles,
			incomingPaths: [
				...removalLedgerPaths(fetched.normalized.normalized, []),
				...targetFiles.flatMap((file) =>
					file.hqPath.startsWith(JR_FILE)
						? [file.hqPath.slice(JR_FILE.length)]
						: [],
				),
			],
			target:
				plan.kind === "changes"
					? contentNamedDocument(plan.target, targetFiles, ownContent)
					: null,
			tables,
		});
		return { newTags, tables, reviewDigest };
	});
	const checked: CheckedHqChanges = {
		removedFiles: unused.map((file) => file.digest),
		fetched,
		plan,
		declaration,
		readings,
		draft,
		readsNow,
		newTags: built.newTags,
		media,
		data,
		targetIdentity: recorded,
	};
	const reviewLines = [
		...(legacy
			? [
					priorNext
						? "You can review what the next publish would change in this project space."
						: "You can review what the first publish would change in this project space.",
				]
			: []),
		...changedFiles.map((file) =>
			removedHqFileLine(
				file,
				removedHqFileReplaced(file, fetched.baseline.source),
			),
		),
		...(plan.changedPublishForms ?? []).map(
			(name) =>
				`The next publish would rewrite another saved value in the form “${name}”.`,
		),
	];
	const publishChanges = [
		...publishChangeSentences(
			priorNext
				? declaration.firstPublish.ids.filter(
						(id) => priorNext.includes(id) || plan.publishChanges.includes(id),
					)
				: legacy
					? declaration.firstPublish.ids
					: plan.publishChanges,
		),
	];
	if (requiresReview && unused.length > 0)
		publishChanges.push(
			`This publish removes ${unused.length} unused file ${unused.length === 1 ? "reference" : "references"}.`,
		);
	const whereHqKeeps = await pieces
		.at("where HQ keeps")
		.run(() => [
			...(fetched.androidPrivilegeLost
				? [ANDROID_APPS_PRIVILEGE_LOST_LINE]
				: []),
			...whereHqKeepsLines(
				targetIdentityChanges(
					receipt.read,
					receipt.next,
					plan.kind === "changes" ? plan.target : fetched.head.doc,
					fetched.head.doc,
					assetNames,
				),
			),
		]);
	if (
		!requiresReview &&
		(plan.kind === "nothing" ||
			(plan.batch.length === 0 && plan.renamedInNova.length === 0))
	)
		return {
			kind: "checked",
			review: {
				kind: "nothing",
				reason: plan.kind === "nothing" ? "reads-the-same" : "already-here",
				since: fetched.since,
				hqChanges: whereHqKeeps,
				publishChanges,
				readingId: fetched.readingId,
				reviewDigest: built.reviewDigest,
			},
			checked,
		};
	const cannotDiscard =
		legacy ||
		unapprovedHqFiles(
			discardedFiles,
			changedFiles.map((file) => file.digest),
		).length > 0;
	return {
		kind: "checked",
		review: {
			kind: "changes",
			...(cannotDiscard && { requiresReview: true }),
			...(changedFiles.length > 0 && {
				fileReviewLines: changedFiles.length + Number(legacy),
			}),
			since: fetched.since,
			hqChanges: [
				...reviewLines,
				...(plan.kind === "changes"
					? documentChangeLines(plan.hqChanges, "hq")
					: []),
				...whereHqKeeps,
			],
			novaChanges:
				plan.kind === "changes"
					? documentChangeLines(plan.novaChanges, "nova")
					: [],
			madeBy: [],
			caseData:
				plan.kind === "nothing"
					? []
					: [
							...(plan.removedCaseProperties.length > 0
								? [caseDataLine(plan.removedCaseProperties)]
								: []),
							...(plan.removedCaseTypes.length > 0
								? [caseTypesLine(plan.removedCaseTypes)]
								: []),
						],
			publishChanges,
			observedDigest: hqDiscardDigest(
				reviewAuthority(fetched),
				fetched.normalized.digest,
				discardedFiles,
				cannotDiscard ? "unavailable" : "complete",
			),
			renamedInNova: plan.kind === "changes" ? plan.renamedInNova : [],
			tables: built.tables,
			projectName: fetched.projectName,
			readingId: fetched.readingId,
			reviewDigest: built.reviewDigest,
		},
		checked,
	};
}

// ---------------------------------------------------------------------------
// The review
// ---------------------------------------------------------------------------

/**
 * One review: mints a reading's id, computes, logs the answer with the time
 * its synchronous pieces took and the source's size, and answers. Writes
 * nothing. Where the process has no room for what it reads
 * (`reading/room.ts`), it stops reading and answers `nova-busy`.
 */
export function reviewHqChanges(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	options: {
		readonly onEvent: (event: HqChangesProgress) => void;
		readonly cancel?: AbortSignal;
	},
): Promise<HqChangesReview> {
	return withBringInRoom(
		"changes-review",
		(room) =>
			reviewInRoom(scope, target, {
				onEvent: options.onEvent,
				cancel:
					options.cancel === undefined
						? room.signal
						: AbortSignal.any([options.cancel, room.signal]),
			}),
		() => ({ kind: "stop", finding: noRoomFinding() }),
	);
}

async function reviewInRoom(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	options: {
		readonly onEvent: (event: HqChangesProgress) => void;
		readonly cancel?: AbortSignal;
	},
): Promise<HqChangesReview> {
	const started = performance.now();
	const { review, facts } = await computeHqChanges(
		scope,
		target,
		{
			readingId: uuidv7(),
			keepMedia: false,
			onEvent: options.onEvent,
			...(options.cancel !== undefined && { cancel: options.cancel }),
		},
		"review",
	);
	logAnswered(scope, "review", phaseOf(review), started, facts);
	return review;
}

/** An answer's kind with its own word: a reason, a stop's code, or nothing. */
export function phaseOf(review: HqChangesReview): string {
	switch (review.kind) {
		case "nothing":
		case "unavailable":
		case "held":
			return `${review.kind}:${review.reason}`;
		case "stop":
			return `stop:${review.finding.code}`;
		case "account":
		case "changes":
			return review.kind;
	}
}

/** The one line every answered request writes: its phase, its times and the source's size. */
export function logAnswered(
	scope: DeploymentScope,
	operation: HqChangesOperation,
	phase: string,
	started: number,
	facts: HqChangesFacts,
): void {
	log.info("[hq-changes] answered", {
		...scopeContext(scope, operation),
		phase,
		elapsedMs: Math.round(performance.now() - started),
		checkMs: Math.round(facts.checkMs),
		longestPieceMs: Math.round(facts.longestPieceMs),
		longestPieceAt: facts.longestPieceAt,
		workUnits: facts.workUnits,
		longestPieceUnits: facts.longestPieceUnits,
		longestPieceUnitsAt: facts.longestPieceUnitsAt,
		sourceBytes: facts.sourceBytes,
	});
}
