import "server-only";

/**
 * A bring-in of the changes made in CommCare HQ to an app Nova publishes
 * there. It runs the review's whole computation again, with the reading's
 * id it was sent and the bytes of each file CommCare HQ added or replaced
 * kept, and acts only where its digest is the one the person reviewed:
 *
 * - changes, with no case property renamed in Nova since: the files it took
 *   are published to the Project's library, the ownership the next
 *   publish's body gives is computed, and the batch commits at the reviewed
 *   head through `applyBlueprintChange`, with the tables the changed app
 *   newly reads (`projectDataWrite`, before the gate) and the deployment's
 *   record (`inTransaction`) in the commit's own transaction, so a change
 *   that is turned back writes no table;
 * - nothing, because the app already holds the change: the record alone,
 *   in a short transaction of its own;
 * - nothing, because CommCare HQ's save reads as the same app: the source
 *   is recorded as a read that compared equal.
 *
 * Every other answer, or another digest, takes nothing and answers the
 * review as it now stands. No log line holds a word of the app.
 */

import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { bulkUploadAssets } from "@/lib/commcare/multimedia/hqJsonExportArchive";
import { readAppChangeStreamRowsSince } from "@/lib/db/appChangeStream";
import { applyBlueprintChange } from "@/lib/db/applyBlueprintChange";
import {
	AppHeadMovedError,
	BlueprintCommitRejectedError,
	CommitReauthError,
} from "@/lib/db/commitGuard";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import type { BlueprintDoc } from "@/lib/domain";
import { collectAssetRefs } from "@/lib/domain/mediaRefs";
import { NO_ENTRIES } from "@/lib/domain/records";
import { prepareExportBoundary } from "@/lib/export/boundaryValidation";
import { log } from "@/lib/logger";
import { LookupError } from "@/lib/lookup/errors";
import { MediaPublishPermissionError } from "@/lib/media/publishReadyMedia";
import { readOrganizationAuthoringSnapshot } from "@/lib/organization/service";
import {
	HQ_CHANGES_FILES_NOT_PERMITTED,
	HQ_CHANGES_OWNER_RULE_MISSING,
	HQ_CHANGES_OWNER_RULE_NOT_OFFERED,
	HQ_CHANGES_TABLE_CHOICE_MISSING,
	HQ_CHANGES_TABLE_CHOICE_NOT_OFFERED,
	hqChangesPublishingStoppedLine,
	renamedInNovaLine,
} from "@/lib/publish/hqChangesCopy";
import type { DeploymentView } from "../actions";
import { type AdoptedMediaFile, assignMediaPaths } from "../adoption";
import { attachmentUrlTarget } from "../attachmentTarget";
import {
	DeploymentAppDeletedError,
	DeploymentEndedError,
	deploymentNotFound,
} from "../errors";
import {
	hqMediaRecordFromSource,
	nextHqMediaRecord,
	publishedMediaFiles,
} from "../hqMedia";
import { removalLedgerPaths } from "../hqSourceBaseline";
import { hqImportApplicationSteps } from "../importApplication";
import { movedBindingCount } from "../reading/create";
import { firstPublishListToStore } from "../reading/firstPublishChanges";
import { Pieces } from "../reading/gather";
import { resolveTableChoices, underTableChoices } from "../reading/projectData";
import {
	BroughtInTableChangedError,
	writeBroughtInLookupTablesInTransaction,
} from "../reading/projectData/lookupTableStore";
import type { BroughtInTableWrite } from "../reading/projectData/lookupTables";
import { adoptedMediaFiles } from "../reading/projectData/media";
import {
	type MediaStaging,
	projectMediaStaging,
	publishStagedReadingMedia,
} from "../reading/projectData/mediaStore";
import { workerOwnerMutations } from "../reading/projectData/ownerRules";
import {
	type ReviewTable,
	resolveOwnerRuleChoices,
} from "../reading/projectData/reviewTypes";
import {
	type BringInRoom,
	holdChangesReadings,
	noRoomFinding,
	withBringInRoom,
} from "../reading/room";
import { firstPublishOf, leftBehindResources } from "../resources";
import {
	currentResourceIdentities,
	deploymentKept,
	setupArtifactFor,
} from "../service";
import {
	type DeploymentScope,
	type DeploymentTargetKey,
	HqChangesBaselineMovedError,
	type HqChangesTaken,
	HqReviewWriteInFlightError,
	readDeployment,
	readFirstPublishStates,
	readMemberNames,
	recordHqChangesTaken,
	recordRefreshedAppBaseline,
	withDeploymentReadSnapshot,
} from "../store";
import { exportIdentityOf } from "../targetIdentity";
import { hqChangesBatchId } from "./batchId";
import { hqChangesGateRefusal } from "./gate";
import {
	type CheckedHqChanges,
	checkHqChanges,
	computeHqChanges,
	type HqChangesBasis,
	type HqChangesFacts,
	type HqChangesProgress,
	logAnswered,
	phaseOf,
	scopeContext,
	withJudged,
} from "./review";
import {
	changedOutcome,
	type HqChangesOutcome,
	type HqChangesReview,
} from "./types";

/** What a bring-in is sent beside the key: the review it answers and each table's answer. */
export interface HqChangesBringInInput {
	readonly readingId: string;
	readonly reviewDigest: string;
	readonly tableChoices: Readonly<Record<string, string>>;
	/** The answer for each owner rule the review asks about, by level code. Absent is none. */
	readonly ownerRuleChoices?: Readonly<Record<string, string>>;
	/**
	 * Whether the person agreed to lose the changes made in Nova that the
	 * review listed. A person presses a button under the list they read and
	 * sends none; an MCP client relays the list and sends what the person
	 * said. Where it is sent and is not what the review holds, nothing is
	 * taken and `HqChangesDiscardMismatchError` is thrown.
	 */
	readonly discardNovaChanges?: boolean;
}

/**
 * A bring-in sent a statement about Nova's own changes that the review it
 * answers does not bear out: a discard where the review lists no change made
 * in Nova, or none where it lists some. Nothing was taken.
 */
export class HqChangesDiscardMismatchError extends Error {
	/** Whether the review lists changes made in Nova that taking it removes. */
	readonly reviewRemoves: boolean;

	constructor(reviewRemoves: boolean) {
		super(
			reviewRemoves
				? "A bring-in of changes made in CommCare HQ was sent without agreeing to lose the changes made in Nova, and the review it answers lists some, so nothing was taken. A caller that sends `discardNovaChanges` sends true exactly where the review's `novaChanges` is not empty."
				: "A bring-in of changes made in CommCare HQ was sent agreeing to lose changes made in Nova, and the review it answers lists none, so nothing was taken. A caller that sends `discardNovaChanges` sends true exactly where the review's `novaChanges` is not empty.",
		);
		this.name = "HqChangesDiscardMismatchError";
		this.reviewRemoves = reviewRemoves;
	}
}

/** The kinds of the changes a member makes, whose actor a moved head names. */
const MEMBER_KINDS: ReadonlySet<string> = new Set([
	"autosave",
	"mcp",
	"chat",
	"hq-changes",
]);

/**
 * One bring-in. It takes no `cancel`: once a person has chosen to bring the
 * changes in, the work runs to its end whether or not the tab is there.
 * Where the process has no room for what it reads (`reading/room.ts`), it
 * stops reading, takes nothing, and answers `nova-busy`. Every write comes
 * after `beginWrites`, after which nothing stops it, but the staging of each
 * held media file as it is judged: temporary objects no surface lists, which
 * the publish promotes and the bring-in deletes however it ends.
 */
export function bringInHqChanges(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	input: HqChangesBringInInput,
	options: { readonly onEvent: (event: HqChangesProgress) => void },
): Promise<HqChangesOutcome> {
	return withBringInRoom(
		"changes-bring-in",
		async (room) => {
			const staging = projectMediaStaging(scope.projectId);
			try {
				return await bringInInRoom(
					scope,
					target,
					input,
					options,
					room,
					staging,
				);
			} finally {
				await staging.discard();
			}
		},
		() => ({
			kind: "changed",
			now: { kind: "stop", finding: noRoomFinding() },
		}),
	);
}

async function bringInInRoom(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	input: HqChangesBringInInput,
	options: { readonly onEvent: (event: HqChangesProgress) => void },
	room: BringInRoom,
	staging: MediaStaging,
): Promise<HqChangesOutcome> {
	const started = performance.now();
	/* One count of synchronous pieces for the whole bring-in: the computation's,
	 * the check over published files and the record's. */
	const pieces = new Pieces(room.signal);
	const computed = await computeHqChanges(
		scope,
		target,
		{
			readingId: input.readingId,
			stageMedia: staging,
			onEvent: options.onEvent,
			pieces,
			cancel: room.signal,
		},
		"bring-in",
	);
	const { review, basis, checked } = computed;
	const facts = (): HqChangesFacts => ({
		sourceBytes: computed.facts.sourceBytes,
		checkMs: pieces.total,
		longestPieceMs: pieces.longest,
		longestPieceAt: pieces.longestAt,
		workUnits: pieces.units,
		longestPieceUnits: pieces.longestUnits,
		longestPieceUnitsAt: pieces.longestUnitsAt,
	});
	const answered = (outcome: HqChangesOutcome): HqChangesOutcome => {
		logAnswered(
			scope,
			"bring-in",
			outcome.kind === "changed"
				? `changed:${phaseOf(outcome.now)}`
				: outcome.kind,
			started,
			facts(),
		);
		return outcome;
	};

	/** The review computed once more, as the person reads it next. */
	const changedNow = async (
		editedBy: string | null = null,
	): Promise<HqChangesOutcome> => {
		const again = await computeHqChanges(
			scope,
			target,
			{
				readingId: input.readingId,
				stageMedia: null,
				onEvent: () => {},
			},
			"bring-in",
		);
		if (again.ended)
			return answered({
				kind: "refused",
				message: hqChangesPublishingStoppedLine(target.domain),
			});
		return answered(changedOutcome(again.review, editedBy));
	};

	/* Publishing there stopped since the review: there is nothing to take. */
	if (computed.ended)
		return answered({
			kind: "refused",
			message: hqChangesPublishingStoppedLine(target.domain),
		});

	/* The digest: the review the person read, or nothing is taken. */
	if (
		basis === null ||
		(review.kind !== "nothing" && review.kind !== "changes") ||
		review.reviewDigest !== input.reviewDigest
	)
		return answered(changedOutcome(review));

	scope = basis.scope;
	/* The caller's statement about Nova's own changes, where it sent one. */
	const removes = review.kind === "changes" && review.novaChanges.length > 0;
	if (
		input.discardNovaChanges !== undefined &&
		input.discardNovaChanges !== removes
	) {
		logAnswered(scope, "bring-in", "discard-mismatch", started, facts());
		throw new HqChangesDiscardMismatchError(removes);
	}

	/* Each arm writes; the room stops nothing from here on. */
	room.beginWrites();
	try {
		if (
			(review.kind === "nothing" && review.reason === "reads-the-same") ||
			checked?.plan.kind === "nothing"
		)
			return answered(await recordReadsTheSame(scope, target, basis, checked));
		if (checked === null)
			throw new Error(
				"A review that lists changes or finds them already here came back with no check. computeHqChanges answers both only after the readings.",
			);
		if (
			review.kind === "nothing" ||
			(checked.plan.kind === "changes" &&
				checked.plan.batch.length === 0 &&
				checked.plan.renamedInNova.length === 0)
		)
			return answered(
				await recordAlreadyHere(
					scope,
					target,
					basis,
					checked,
					pieces,
					changedNow,
				),
			);
		return answered(
			await bringChangesIn(
				scope,
				target,
				input,
				review,
				checked,
				pieces,
				options.onEvent,
				changedNow,
			),
		);
	} catch (error) {
		if (error instanceof HqReviewWriteInFlightError)
			return answered({ kind: "refused", message: error.message });
		if (error instanceof DeploymentEndedError)
			return answered({
				kind: "refused",
				message: hqChangesPublishingStoppedLine(target.domain),
			});
		/* The app went to recently deleted since the review, for a member who
		 * may still edit it: the review as it now stands says so. */
		if (error instanceof DeploymentAppDeletedError) return changedNow();
		throw error;
	}
}

// ---------------------------------------------------------------------------
// The three arms
// ---------------------------------------------------------------------------

const gzipAsync = promisify(gzip);

/**
 * CommCare HQ's source as read, normalized, compressed and digested, as a
 * baseline stores it. Compressed off the event loop: a source at the cap
 * takes a second or more.
 */
async function storedSource(
	basis: HqChangesBasis,
): Promise<HqChangesTaken["source"]> {
	return {
		sourceGzip: await gzipAsync(Buffer.from(basis.normalized.text, "utf8")),
		sourceBytes: basis.normalized.bytes,
		sourceDigest: basis.normalized.digest,
		observedAt: basis.observedAt,
	};
}

/**
 * A save in CommCare HQ that reads as the same app: the source recorded, the
 * media record where it moves, an id learned by content or one whose file
 * CommCare HQ no longer serves forgotten, and where CommCare HQ now keeps what
 * the document doesn't hold, where that moved (a form's id, a keyed create's
 * prefix, a file's path), which the review named.
 */
async function recordReadsTheSame(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	basis: HqChangesBasis,
	checked: CheckedHqChanges | null,
): Promise<HqChangesOutcome> {
	const mediaFiles = nextHqMediaRecord({
		published: basis.published,
		previous: basis.baseline.mediaFiles,
		learned: basis.learned,
		reported: NO_ENTRIES,
		settled: basis.published,
	});
	const written = await recordRefreshedAppBaseline(scope, target, {
		expectedEndings: basis.deployment.endings,
		remoteAppId: basis.live.remoteId,
		comparedDigest: basis.baseline.sourceDigest,
		comparedPushToken: basis.live.pushToken,
		comparedRevision: basis.baseline.novaRevision,
		comparedFold: basis.baseline.foldBinding?.foldSeq,
		comparedHead: basis.head.seq,
		reviewedVersion: basis.remoteRevision,
		read: await storedSource(basis),
		/* A review that answered before the readings read nothing that moves
		 * the list, which then stays. */
		...(checked !== null && {
			nextPublish: {
				accepted: firstPublishListToStore(
					checked.declaration.firstPublish,
					checked.draft.facts,
				),
				publishChanges: checked.plan.publishChanges,
				removedFiles: {
					compared: basis.baseline.approvedFileRemovals ?? [],
					accepted: checked.removedFiles,
				},
				webAppsOnInHq: basis.source.cloudcareEnabled,
			},
		}),
		// Even when no id moved, the recorded standings decided that these
		// were the same files. The transaction verifies that prior evidence.
		mediaFiles: {
			read: basis.baseline.mediaFiles,
			next: mediaFiles,
			judgedPaths: [
				...basis.published.map((file) => file.wirePath),
				...removalLedgerPaths(basis.normalized.normalized, basis.published),
			],
		},
		targetIdentity: checked?.targetIdentity ?? {
			read: basis.targetIdentity,
			next: basis.targetIdentity,
		},
	});
	if (written.outcome === "superseded") {
		const again = await computeHqChanges(
			scope,
			target,
			{ readingId: basis.readingId, stageMedia: null, onEvent: () => {} },
			"bring-in",
		);
		return changedOutcome(again.review);
	}
	return {
		kind: "recorded",
		deployment: await deploymentViewOf(scope, target),
	};
}

/** CommCare HQ changed, and the app already holds the change: the pair moves to the reviewed head. */
async function recordAlreadyHere(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	basis: HqChangesBasis,
	checked: CheckedHqChanges,
	pieces: Pieces,
	changedNow: () => Promise<HqChangesOutcome>,
): Promise<HqChangesOutcome> {
	const taking = await takenFor(scope, target, basis, checked, [], pieces);
	if (taking.kind === "refusal") return taking.outcome;
	try {
		await recordHqChangesTaken(
			{ kind: "own", headSeq: basis.head.seq },
			taking.taken,
		);
	} catch (error) {
		if (error instanceof HqChangesBaselineMovedError) return changedNow();
		throw error;
	}
	return {
		kind: "recorded",
		deployment: await deploymentViewOf(scope, target),
	};
}

/** The changes taken: tables, files, the ownership, then the commit with its record. */
async function bringChangesIn(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	input: HqChangesBringInInput,
	review: Extract<HqChangesReview, { readonly kind: "changes" }>,
	first: CheckedHqChanges,
	pieces: Pieces,
	onEvent: (event: HqChangesProgress) => void,
	changedNow: (editedBy?: string | null) => Promise<HqChangesOutcome>,
): Promise<HqChangesOutcome> {
	const { fetched } = first;

	/* A rename in Nova since the reference holds the change back: it moved saved data. */
	if (review.renamedInNova.length > 0)
		return {
			kind: "refused",
			message: renamedInNovaLine(review.renamedInNova),
		};

	/* The person's answers, against the review as it stands. */
	const resolved = resolveTableChoices(review.tables, input.tableChoices);
	if (!resolved.ok)
		return {
			kind: "refused",
			message:
				resolved.unknown.length > 0 || resolved.notOffered.length > 0
					? HQ_CHANGES_TABLE_CHOICE_NOT_OFFERED
					: HQ_CHANGES_TABLE_CHOICE_MISSING,
		};
	const ownerRules = resolveOwnerRuleChoices(
		review.ownerRules,
		input.ownerRuleChoices ?? NO_ENTRIES,
	);
	if (!ownerRules.ok)
		return {
			kind: "refused",
			message:
				ownerRules.notOffered.length > 0
					? HQ_CHANGES_OWNER_RULE_NOT_OFFERED
					: HQ_CHANGES_OWNER_RULE_MISSING,
		};
	const answeredData = underTableChoices(first.data, resolved.choices);
	const moved = movedBindingCount(
		first.data.gathered.tables,
		answeredData.gathered.tables,
		first.readsNow.lookupFields,
	);
	if (moved > 0) return defect(scope, "bindings", review);

	/* The files the app takes from CommCare HQ, published to the Project. */
	const firstPlan = first.plan;
	if (firstPlan.kind !== "changes")
		throw new Error(
			"A review that lists changes came back with a plan that holds none. Look at checkHqChanges.",
		);
	const taken = collectAssetRefs(firstPlan.target);
	const nowPlan = first.media.now;
	const toPublish = {
		...nowPlan,
		files: nowPlan.files.filter((file) => taken.has(file.provisionalId)),
	};
	const held = toPublish.files.filter(
		(file) =>
			Object.hasOwn(toPublish.verdicts, file.key) &&
			toPublish.verdicts[file.key]?.kind === "held",
	).length;
	let checked = first;
	if (held > 0 || Object.keys(resolved.choices).length > 0) {
		let published = nowPlan.published;
		if (held > 0) {
			onEvent({ type: "stage", stage: "adding-media" });
			onEvent({ type: "files", done: 0, total: held });
			try {
				published = (
					await publishStagedReadingMedia({
						projectId: scope.projectId,
						actorUserId: scope.actorUserId,
						plan: toPublish,
						onProgress: (done, total) =>
							onEvent({ type: "files", done, total }),
					})
				).published;
			} catch (error) {
				if (error instanceof MediaPublishPermissionError)
					return { kind: "refused", message: HQ_CHANGES_FILES_NOT_PERMITTED };
				throw error;
			}
		}
		/* The check once more, over exactly what the app takes: its two
		 * readings are the review's, which this request already holds a charge
		 * for, and never refused, since the request has begun to write. */
		holdChangesReadings(fetched.baseline.sourceBytes, fetched.normalized.bytes);
		const again = await checkHqChanges(
			fetched,
			{
				base: withJudged(first.media.base, {
					...first.media.base,
					published,
				}),
				now: withJudged(nowPlan, { ...nowPlan, published }),
			},
			answeredData,
			pieces,
		);
		if (
			again.kind !== "checked" ||
			again.review.reviewDigest !== input.reviewDigest
		) {
			log.error(
				"[hq-changes] could not bring in: integrity",
				undefined,
				scopeContext(scope, "bring-in"),
			);
			return changedOutcome(again.review);
		}
		checked = again.checked;
	}
	const plan = checked.plan;
	if (plan.kind !== "changes")
		throw new Error(
			"The check over the published files came back with a plan that holds no changes under the same digest. Look at checkHqChanges.",
		);

	/* The tables the changed app newly reads, written in the commit below. */
	const tables = newTableWrites(answeredData, checked.newTags, review.tables);

	/* The ownership the next publish's body gives, and the record. */
	onEvent({ type: "stage", stage: "bringing-in" });
	const taking = await takenFor(
		scope,
		target,
		fetched,
		checked,
		newMediaFiles(checked, plan.target, fetched.head.doc),
		pieces,
	);
	if (taking.kind === "refusal") return taking.outcome;

	/* The commit, at the head the person reviewed. */
	let seq: number;
	try {
		const committed = await applyBlueprintChange({
			appId: scope.appId,
			userId: scope.actorUserId,
			expectedProjectId: scope.projectId,
			batchId: hqChangesBatchId({
				deploymentId: fetched.deployment.id,
				reviewDigest: input.reviewDigest,
				memberId: scope.actorUserId,
			}),
			kind: "hq-changes",
			expectedHeadSeq: fetched.head.seq,
			/* The explicit owner rule the person chose for each level the places cannot satisfy,
			 * given in the same batch, so the commit's gate meets only rules that hold. */
			guard: {
				mutations: admitMutationBatch([
					...plan.batch,
					...workerOwnerMutations(plan.target, ownerRules.levels),
				]),
			},
			/* The tables the change newly reads are written in the commit's own
			 * transaction, before its gate reads them: a change that is turned
			 * back (a moved head, a refused gate, a moved baseline) creates,
			 * refreshes and adopts no table. */
			...(tables.length > 0 && {
				projectDataWrite: ({ tx, projectId }) =>
					writeBroughtInLookupTablesInTransaction(
						tx,
						{
							projectId,
							actorUserId: scope.actorUserId,
							appId: scope.appId,
						},
						{
							origin: answeredData.gathered.origin,
							tables,
							readAt: answeredData.gathered.tablesReadAt,
						},
					),
			}),
			inTransaction: async ({ tx, seq: at }) => {
				await recordHqChangesTaken(
					{ kind: "commit", tx, seq: at },
					taking.taken,
				);
			},
		});
		seq = committed.seq;
	} catch (error) {
		if (error instanceof AppHeadMovedError)
			return changedNow(await headMovedBy(scope, fetched.head.seq));
		if (error instanceof HqChangesBaselineMovedError) return changedNow();
		/* A table the change newly reads is no longer what the review showed
		 * (its revisions, the apps that read it, a tag taken since): the review
		 * as it now stands. */
		if (
			error instanceof BroughtInTableChangedError ||
			(error instanceof LookupError &&
				(error.code === "tag_taken" || error.code === "conflict"))
		)
			return changedNow();
		if (error instanceof BlueprintCommitRejectedError) {
			/* The gate's refusal at the commit, said as the export boundary's is: each finding in
			 * the builder's voice for the panel and in its own sentence for MCP. */
			if (error.findings.length > 0)
				return hqChangesGateRefusal(error.findings);
			return error.findingCodes.length > 0
				? { kind: "gate", findings: [error.message], details: [error.message] }
				: { kind: "refused", message: error.message };
		}
		if (error instanceof CommitReauthError)
			return { kind: "refused", message: error.message };
		throw error;
	}
	log.info("[hq-changes] brought in", {
		...scopeContext(scope, "bring-in"),
		seq,
		mutations: plan.batch.length,
		tables: tables.length,
		mediaPaths: taking.taken.targetIdentity.next.mediaPaths.length,
		identityRows: taking.taken.targetIdentity.next.entities.length,
		keyedCaseIds: taking.taken.targetIdentity.next.keyedCaseIds.length,
	});
	return {
		kind: "brought-in",
		seq,
		discarded: review.novaChanges.length > 0,
		deployment: await deploymentViewOf(scope, target),
	};
}

// ---------------------------------------------------------------------------
// What the record is made of
// ---------------------------------------------------------------------------

/** A defect of Nova's own between the review and the take: logged, and answered as `nova-defect`. */
function defect(
	scope: DeploymentScope,
	check: string,
	review: HqChangesReview,
): HqChangesOutcome {
	log.error(`[hq-changes] could not bring in: ${check}`, undefined, {
		...scopeContext(scope, "bring-in"),
		phase: check,
		reviewed: review.kind,
	});
	return {
		kind: "changed",
		now: {
			kind: "unavailable",
			reason: "nova-defect",
			since:
				review.kind === "nothing" ||
				review.kind === "changes" ||
				review.kind === "unavailable"
					? review.since
					: null,
		},
	};
}

/** The table writes of the tags the changed app newly reads, under the person's answers. */
function newTableWrites(
	data: CheckedHqChanges["data"],
	newTags: readonly string[],
	offered: readonly ReviewTable[],
): readonly BroughtInTableWrite[] {
	const wanted = new Set(newTags);
	const reviewed = new Set(offered.map((table) => table.tag));
	return data.gathered.tables.flatMap((table) => {
		const tag = table.read.table.tag;
		if (!wanted.has(tag) || !reviewed.has(tag)) return [];
		if (
			table.read.kind !== "read" ||
			table.standing === null ||
			table.binding === null ||
			(table.standing.kind === "choice" && table.choice === null)
		)
			throw new Error(
				`The changed app newly reads a lookup table that reached the write with no binding or no answer (reading ${data.gathered.readingId}). The review offers only a table that can come in, and the bring-in checks every answer first.`,
			);
		return [
			{
				read: table.read,
				standing: table.standing,
				choice: table.choice,
				binding: table.binding,
				projectTable: table.projectTable,
			},
		];
	});
}

/**
 * Each file the app takes from CommCare HQ: a file of the reading now that
 * the target shows and the head does not, at every path CommCare HQ holds it
 * under.
 */
function newMediaFiles(
	checked: CheckedHqChanges,
	target: BlueprintDoc,
	head: BlueprintDoc,
): readonly AdoptedMediaFile[] {
	const shown = collectAssetRefs(target);
	const held = collectAssetRefs(head);
	return adoptedMediaFiles(checked.media.now).filter(
		(file) => shown.has(file.assetId) && !held.has(file.assetId),
	);
}

type Taking =
	| { readonly kind: "taken"; readonly taken: HqChangesTaken }
	| { readonly kind: "refusal"; readonly outcome: HqChangesOutcome };

/**
 * The record of a take: CommCare HQ's source as read, the ownership the next
 * publish's body gives over it and the document the app takes, the file at
 * each path, the target-identity record the reading resolves
 * (`review.ts::takenTargetIdentity`, which the export is computed over), and
 * the next publish's list. `mediaPaths` are the files the app takes from
 * CommCare HQ, whose file at each kept path the record learns.
 */
async function takenFor(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	basis: HqChangesBasis,
	checked: CheckedHqChanges,
	mediaPaths: readonly AdoptedMediaFile[],
	pieces: Pieces,
): Promise<Taking> {
	const plan = checked.plan;
	const doc = plan.kind === "changes" ? plan.target : basis.head.doc;

	/* Where CommCare HQ keeps everything once the record lands: what the next
	 * publish prints under, and so what its body's ownership is computed over. */
	const exported = exportIdentityOf(doc, checked.targetIdentity.next);

	/* The next publish's body over that source and the document taken. */
	const boundary = await prepareExportBoundary({
		mode: "hq-upload",
		access: scope,
		doc,
		/* The body names each file by its path; no byte of one is read here. */
		streamMedia: true,
		compiledAtSeq: basis.head.seq,
		heldMediaPaths: exported.heldMediaPaths,
		attachmentTarget: attachmentUrlTarget(target),
		lookupTarget: target,
	});
	if (!boundary.ok)
		return {
			kind: "refusal",
			outcome: hqChangesGateRefusal(boundary.violations),
		};
	const seeds = basis.live.ownership === "adopted" ? "target" : "nova";
	const { ownership } = await pieces.at("the next publish's ownership").steps(
		hqImportApplicationSteps({
			prepared: boundary.prepared,
			target,
			compatibility: { advisories: [] },
			update: { appId: basis.live.remoteId, source: basis.source },
			identity: exported.identity,
			languageNames: seeds,
			seeds,
			keyedCaseIdPrefixes: exported.keyedCaseIdPrefixes,
		}),
	);

	/* The file at each path the app publishes: reported by no upload, learned by
	 * content, the one each file taken was fetched by, else the previous record's. */
	const keptPaths = assignMediaPaths(mediaPaths).rows.map(
		(row) => row.wirePath,
	);
	const fetchedBy = hqMediaRecordFromSource(
		keptPaths,
		basis.source.multimediaMap ?? [],
	);
	const published = publishedMediaFiles(
		bulkUploadAssets(doc, boundary.prepared.assets),
	);
	const mediaFiles = nextHqMediaRecord({
		published,
		previous: basis.baseline.mediaFiles,
		learned: { ...basis.learned, ...fetchedBy },
		reported: NO_ENTRIES,
		settled: basis.published,
	});

	return {
		kind: "taken",
		taken: {
			scope,
			target,
			expectedEndings: basis.deployment.endings,
			remoteAppId: basis.live.remoteId,
			comparedPushToken: basis.live.pushToken,
			reviewedVersion: basis.remoteRevision,
			read: {
				sourceDigest: basis.baseline.sourceDigest,
				novaRevision: basis.baseline.novaRevision,
			},
			source: await storedSource(basis),
			ownership,
			mediaFiles: {
				read: basis.baseline.mediaFiles,
				next: mediaFiles,
				judgedPaths: [...basis.published, ...published]
					.map((file) => file.wirePath)
					.concat(
						keptPaths,
						removalLedgerPaths(basis.normalized.normalized, published),
					),
			},
			targetIdentity: checked.targetIdentity,
			firstPublish: {
				accepted: firstPublishListToStore(
					checked.declaration.firstPublish,
					checked.draft.facts,
				),
				publishChanges: plan.publishChanges,
				removedFiles: {
					compared: basis.baseline.approvedFileRemovals ?? [],
					accepted: checked.removedFiles,
				},
				webAppsOnInHq: basis.source.cloudcareEnabled,
			},
		},
	};
}

/**
 * The member other than the requester whose change moved the head past `seq`,
 * by name, read in a snapshot that first proves the requester may still edit
 * the app where it is now. A head that a Project move passed names no one:
 * whoever edited it since is another Project's member. A requester the app has
 * left, or who lost edit, is answered as the kernel answers them, with the
 * refusal the snapshot throws.
 */
async function headMovedBy(
	scope: DeploymentScope,
	seq: number,
): Promise<string | null> {
	return withDeploymentReadSnapshot(scope, "edit", async (snapshot) => {
		const rows = await readAppChangeStreamRowsSince(
			snapshot.db,
			scope.appId,
			seq,
		);
		if (rows.some((row) => row.kind === "project-move")) return null;
		const last = [...rows]
			.reverse()
			.find(
				(row) =>
					MEMBER_KINDS.has(row.kind) && row.actor_id !== scope.actorUserId,
			);
		if (last === undefined) return null;
		return (
			(await readMemberNames(snapshot, [last.actor_id])).get(last.actor_id) ??
			null
		);
	});
}

// ---------------------------------------------------------------------------
// The record as a card reads it
// ---------------------------------------------------------------------------

/**
 * The deployment as the panel's card shows it after a write that landed. A
 * fault reading any of it is logged and answers less, never an error, so a
 * write that landed is never answered as one that failed: the record or the
 * setup artifact unread answers no record (the surface reads its records
 * again), the resource names unread a left-behind list of superseded apps
 * alone, and the kept list or the next publish's list unread none.
 */
async function deploymentViewOf(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
): Promise<DeploymentView | null> {
	const landed = async <T>(read: () => Promise<T>, what: string) => {
		try {
			return await read();
		} catch (error) {
			log.error(
				`[hq-changes] ${what} unavailable after a bring-in`,
				undefined,
				{
					...scopeContext(scope, "bring-in"),
					errorName: error instanceof Error ? error.name : typeof error,
				},
			);
			return null;
		}
	};
	const read = await landed(async () => {
		const deployment = await readDeployment(scope, target);
		if (deployment === null) throw deploymentNotFound();
		const snapshot = await readOrganizationAuthoringSnapshot({
			appId: scope.appId,
			projectId: scope.projectId,
			role: scope.role,
			actorUserId: scope.actorUserId,
		});
		return { deployment, snapshot };
	}, "record");
	if (read === null) return null;
	const { deployment, snapshot } = read;
	const doc = snapshot.blueprint;
	const artifact = await landed(
		() => setupArtifactFor(scope, deployment, doc, snapshot.organization),
		"setup artifact",
	);
	if (artifact === null) return null;
	return {
		deployment,
		artifact,
		leftBehind: leftBehindResources(
			deployment,
			await landed(
				() => currentResourceIdentities(scope, doc),
				"resource names",
			),
		),
		kept: await landed(() => deploymentKept(scope, deployment), "kept list"),
		firstPublish: await landed(async () => {
			const states = await readFirstPublishStates(scope);
			return firstPublishOf(
				deployment,
				states.get(deployment.deployment.id),
				doc,
			);
		}, "first-publish list"),
	};
}
