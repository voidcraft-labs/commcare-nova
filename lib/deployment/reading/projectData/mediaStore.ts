/**
 * The two media steps of a bring-in that reach outside the process: judging
 * every file of a reading from its bytes, read from CommCare HQ, and, in a
 * create, staging each held content under the receiving Project as it is
 * judged, then publishing the staged ones to the Project's library once the
 * create knows it will create. `media.ts` beside it is the pure rest.
 */

import "server-only";
import { randomUUID } from "node:crypto";
import { classifyHqFailure, type HqFailure } from "@/lib/commcare/hq/failure";
import type { CommCareCredentials } from "@/lib/commcare/hq/http";
import {
	HQ_MEDIA_IN_FLIGHT_MAX_BYTES,
	HQ_MEDIA_READ_CONCURRENCY,
	type HqMediaFileRead,
	readHqMediaFile,
} from "@/lib/commcare/hq/media";
import { giveBackHeld } from "@/lib/commcare/hq/memoryMeter";
import {
	asMediaAssetId,
	pendingGcsObjectKeyFor,
} from "@/lib/domain/multimedia";
import { ownRecordValue, recordFromEntries } from "@/lib/domain/records";
import { log } from "@/lib/logger";
import { publishReadyMedia } from "@/lib/media/publishReadyMedia";
import { validateSniffedMediaBytes } from "@/lib/media/validate";
import {
	deleteAssetGeneration,
	type StagedObject,
	stageAssetBytes,
} from "@/lib/storage/media";
import type { SettledHqMediaRead } from "../../hqMediaSettle";
import {
	type HqMediaVerdict,
	type JudgedMediaFile,
	judgedMediaFile,
	mediaCapBytes,
	type ReadingMediaPlan,
} from "./media";

/**
 * Where a create puts the bytes of each held content between judging it and
 * publishing it: one temporary object of the receiving Project per content,
 * so what a create holds in memory is the files in flight, however many files
 * the app has.
 */
export interface MediaStaging {
	/** Write one held content's bytes and answer the object they are in. */
	readonly stage: (
		file: JudgedMediaFile,
		bytes: Buffer,
	) => Promise<StagedObject>;
	/** Delete every object this staging wrote. One already promoted and deleted is gone, and
	 *  deleting it again does nothing. */
	readonly discard: () => Promise<void>;
}

/**
 * A staging under `pending/<projectId>/`, the prefix the bucket's lifecycle
 * rule reaps (`lib/storage/media.ts::applyMediaBucketStoragePolicy`), so an
 * object a crashed request never deleted is gone within the rule's days. The
 * library never lists such an object: a file appears in Files only when its
 * `ready` row commits.
 */
export function projectMediaStaging(projectId: string): MediaStaging {
	const written: StagedObject[] = [];
	return {
		async stage(file, bytes) {
			const staged = await stageAssetBytes({
				gcsObjectKey: pendingGcsObjectKeyFor(
					projectId,
					asMediaAssetId(randomUUID()),
					file.extension,
				),
				bytes,
				contentType: file.mimeType,
			});
			written.push(staged);
			return staged;
		},
		async discard() {
			const all = written.splice(0);
			const settled = await Promise.allSettled(
				all.map((one) =>
					deleteAssetGeneration(one.gcsObjectKey, one.generation),
				),
			);
			const failed = settled.filter((one) => one.status === "rejected").length;
			if (failed > 0)
				log.warn(
					"[bring-in:media] staged media files could not be deleted; the bucket's pending/ rule deletes them",
					{ count: failed, of: all.length },
				);
		},
	};
}

type PlanFile = ReadingMediaPlan["files"][number];

/**
 * Fetches and judges every file of the plan, however many there are. Stores
 * nothing but what `stage` stages.
 *
 * A file `fetched` already answers (read by an earlier step of the same
 * request, by its CommCare HQ id) is judged from that answer and not asked
 * for again.
 *
 * A file starts only where fewer than `HQ_MEDIA_READ_CONCURRENCY` are in
 * flight and the size limits of those in flight plus its own stay within
 * `HQ_MEDIA_IN_FLIGHT_MAX_BYTES`, a file being in flight from its start until
 * its verdict is in and, in a create, its bytes are staged. With `stage`, the
 * first file of each held content is staged once, in the same entry its
 * verdict names it by, and its bytes are let go; a held file whose bytes
 * another already holds stages none. So what the call holds in memory at once
 * is what is in flight, and the app's whole media never is.
 * A file CommCare HQ could not send ends the call: the requests in flight are
 * aborted and the answer is `failed`, so no verdict stands for it.
 */
export async function judgeReadingMedia(input: {
	readonly creds: CommCareCredentials;
	readonly plan: ReadingMediaPlan;
	/** In a create: where each held content's bytes go until it is published. */
	readonly stage?: MediaStaging["stage"];
	readonly onProgress: (done: number, total: number) => void;
	readonly cancel?: AbortSignal;
	/** What an earlier step of the request read of a file, by its CommCare HQ id. */
	readonly fetched?: ReadonlyMap<string, SettledHqMediaRead>;
}): Promise<
	| { readonly kind: "done"; readonly plan: ReadingMediaPlan }
	| { readonly kind: "failed"; readonly failure: HqFailure }
> {
	const { creds, plan, onProgress } = input;
	const total = plan.files.length;

	const stop = new AbortController();
	const signal =
		input.cancel === undefined
			? stop.signal
			: AbortSignal.any([input.cancel, stop.signal]);
	const verdicts = recordFromEntries<HqMediaVerdict>([]);
	/** Each held content, by its hash: the object it is staged in, in a create, once written. */
	const held = new Map<string, StagedObject | null>();
	let failure: HqFailure | null = null;
	let thrown: { readonly error: unknown } | null = null;
	let done = 0;

	const judge = async (file: PlanFile): Promise<void> => {
		// HQ's bounded read distinguishes a successful file response from HQ's own 404
		// even when its body exceeds the limit. No bytes of a source-only file are needed.
		const capBytes = file.availabilityOnly ? 1 : mediaCapBytes(file.kind);
		const answered = input.fetched?.get(file.multimediaId);
		const read: HqMediaFileRead =
			answered === undefined
				? await readHqMediaFile(creds, file.mediaType, file.multimediaId, {
						maxBytes: capBytes,
						cancel: signal,
					})
				: answered.kind === "missing"
					? answered
					: answered.bytes.byteLength > capBytes
						? { kind: "too-large", maxBytes: capBytes }
						: {
								kind: "read",
								bytes: answered.bytes,
								declaredContentType: null,
							};
		if ("success" in read) {
			if (failure === null) failure = classifyHqFailure(read, "media-file");
			stop.abort();
			return;
		}
		let verdict: HqMediaVerdict;
		try {
			if (read.kind === "missing") verdict = { kind: "missing" };
			else if (file.availabilityOnly) verdict = { kind: "available" };
			else if (read.kind === "too-large")
				verdict = { kind: "over-limit", mediaKind: file.kind, capBytes };
			else {
				/* A view of the read's own bytes: a file fetched once is held once. */
				const bytes = Buffer.from(
					read.bytes.buffer,
					read.bytes.byteOffset,
					read.bytes.byteLength,
				);
				const judged = await validateSniffedMediaBytes(bytes);
				if (!judged.ok)
					verdict = {
						kind: "refused",
						reason: judged.reason,
						sniffedMime: judged.sniffedMime,
					};
				else if (judged.validated.kind !== file.kind)
					verdict = { kind: "wrong-kind", sniffedKind: judged.validated.kind };
				else {
					const heldFile = judgedMediaFile(
						file.paths,
						file.kind,
						judged.validated,
					);
					verdict = { kind: "held", file: heldFile };
					if (!held.has(heldFile.contentHash)) {
						held.set(heldFile.contentHash, null);
						if (input.stage !== undefined)
							held.set(
								heldFile.contentHash,
								await input.stage(heldFile, bytes),
							);
					}
				}
			}
		} finally {
			/* Bytes this call read are let go once judged and staged, and given back to the
			 * request's lease; bytes an earlier step handed in stay with the step that holds
			 * them. */
			if (answered === undefined && read.kind === "read")
				giveBackHeld("bytes", read.bytes.byteLength);
		}
		verdicts[file.key] = verdict;
		done += 1;
		onProgress(done, total);
	};

	const inFlight = new Set<Promise<void>>();
	let inFlightBytes = 0;
	let next = 0;
	const fits = (file: PlanFile) =>
		inFlight.size < HQ_MEDIA_READ_CONCURRENCY &&
		inFlightBytes + mediaCapBytes(file.kind) <= HQ_MEDIA_IN_FLIGHT_MAX_BYTES;
	const mayStart = () => failure === null && thrown === null && !signal.aborted;
	for (;;) {
		while (next < total && mayStart() && fits(plan.files[next] as PlanFile)) {
			const file = plan.files[next] as PlanFile;
			next += 1;
			const capBytes = mediaCapBytes(file.kind);
			inFlightBytes += capBytes;
			const task: Promise<void> = judge(file)
				.catch((error: unknown) => {
					thrown ??= { error };
					stop.abort();
				})
				.finally(() => {
					inFlight.delete(task);
					inFlightBytes -= capBytes;
				});
			inFlight.add(task);
		}
		if (inFlight.size === 0) break;
		await Promise.race(inFlight);
	}

	if (thrown !== null) throw (thrown as { readonly error: unknown }).error;
	if (failure !== null) return { kind: "failed", failure };
	if (input.cancel?.aborted === true)
		return {
			kind: "failed",
			failure: classifyHqFailure(
				{ success: false, status: 503, cause: "network" },
				"media-file",
			),
		};
	const staged = new Map<string, StagedObject>();
	for (const [contentHash, object] of held)
		if (object !== null) staged.set(contentHash, object);
	return {
		kind: "done",
		plan: { ...plan, verdicts, staged, published: { ...plan.published } },
	};
}

/** How many files a create publishes at once. */
export const BRING_IN_MEDIA_PUBLISH_CONCURRENCY = 2;

/**
 * Publishes the staged bytes of each held content to the Project's library,
 * once per content: each content hash the plan has not published yet is
 * published under a fresh id, copied from exactly the generation staged, or
 * found by its bytes where the Project already holds them, and its asset is
 * recorded under every file key whose held verdict has that hash; its staged
 * object is then deleted and leaves the plan. A create alone calls it. Throws
 * what the publication throws, after the publications in flight settle.
 */
export async function publishStagedReadingMedia(input: {
	readonly projectId: string;
	readonly actorUserId: string;
	readonly plan: ReadingMediaPlan;
	readonly onProgress: (done: number, total: number) => void;
}): Promise<ReadingMediaPlan> {
	const { plan, onProgress } = input;
	const heldFiles = plan.files.flatMap((file) => {
		const verdict = ownRecordValue(plan.verdicts, file.key);
		return verdict?.kind === "held" ? [{ file, judged: verdict.file }] : [];
	});
	const published = recordFromEntries(Object.entries(plan.published));
	const staged = new Map(plan.staged);
	/* Each content not yet published, with the file keys that hold it. */
	const byContent = new Map<
		string,
		{
			readonly judged: (typeof heldFiles)[number]["judged"];
			readonly keys: string[];
		}
	>();
	for (const { file, judged } of heldFiles) {
		if (Object.hasOwn(published, file.key)) continue;
		const content = byContent.get(judged.contentHash);
		if (content === undefined)
			byContent.set(judged.contentHash, { judged, keys: [file.key] });
		else content.keys.push(file.key);
	}
	const waiting = [...byContent.entries()];
	for (const [contentHash, { keys }] of waiting) {
		if (!staged.has(contentHash)) {
			throw new Error(
				`The held media file ${keys[0]} has no staged bytes to publish. A create judges its files with a staging, which writes each held content once until it is published.`,
			);
		}
	}
	const publishedCount = () =>
		heldFiles.filter(({ file }) => Object.hasOwn(published, file.key)).length;
	let failed: { readonly error: unknown } | null = null;
	let next = 0;
	const worker = async (): Promise<void> => {
		while (failed === null && next < waiting.length) {
			const [contentHash, { judged, keys }] = waiting[
				next
			] as (typeof waiting)[number];
			next += 1;
			const object = staged.get(contentHash) as StagedObject;
			try {
				const answer = await publishReadyMedia({
					actorUserId: input.actorUserId,
					projectId: input.projectId,
					staged: object,
					validated: judged,
					originalFilename: judged.originalFilename,
					assetId: asMediaAssetId(randomUUID()),
				});
				for (const key of keys) published[key] = answer.assetId;
				staged.delete(contentHash);
				onProgress(publishedCount(), heldFiles.length);
			} catch (error) {
				failed ??= { error };
				continue;
			}
			/* The staged object has done its work; the bucket's rule deletes one this misses. */
			await deleteAssetGeneration(object.gcsObjectKey, object.generation).catch(
				(error: unknown) =>
					log.warn("[bring-in:media] a published file's staged object stayed", {
						error: error instanceof Error ? error.message : String(error),
					}),
			);
		}
	};
	await Promise.all(
		Array.from(
			{ length: Math.min(BRING_IN_MEDIA_PUBLISH_CONCURRENCY, waiting.length) },
			worker,
		),
	);
	if (failed !== null) throw (failed as { readonly error: unknown }).error;
	return { ...plan, staged, published };
}
