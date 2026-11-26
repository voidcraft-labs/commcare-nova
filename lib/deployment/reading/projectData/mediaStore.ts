/**
 * The two media steps of a bring-in that reach outside the process: judging
 * every file of a reading from its bytes, read from CommCare HQ, and
 * publishing the held ones to the Project's library once a create knows it
 * will create. `media.ts` beside it is the pure rest.
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
	MAX_MEDIA_EXPORT_ASSETS,
	type MediaKind,
} from "@/lib/domain/multimedia";
import { ownRecordValue, recordFromEntries } from "@/lib/domain/records";
import { exportBudgetExcess } from "@/lib/media/exportBudget";
import { publishReadyMedia } from "@/lib/media/publishReadyMedia";
import { validateSniffedMediaBytes } from "@/lib/media/validate";
import type { SettledHqMediaRead } from "../../hqMediaSettle";
import {
	type HqMediaVerdict,
	judgedMediaFile,
	mediaCapBytes,
	type ReadingMediaPlan,
} from "./media";

type PlanFile = ReadingMediaPlan["files"][number];

/**
 * Fetches and judges every file of the plan. Stores nothing.
 *
 * A file `fetched` already answers (read by an earlier step of the same
 * request, by its CommCare HQ id) is judged from that answer and not asked
 * for again.
 *
 * A file starts only where fewer than `HQ_MEDIA_READ_CONCURRENCY` are in
 * flight and the size limits of those in flight plus its own stay within
 * `HQ_MEDIA_IN_FLIGHT_MAX_BYTES`, a file being in flight from its start until
 * its verdict is in. Over `MAX_MEDIA_EXPORT_ASSETS` files no file starts, and
 * once the held files pass Nova's media budget no further file starts: those
 * in flight finish and the answer is `done` with the plan as it then stands.
 * With `keep`, the plan keeps one buffer per distinct content, in the same
 * entry the budget counts it by, so what a create holds is exactly what the
 * budget counted; a held file whose bytes another already holds keeps none.
 * The bytes are the read's own, never a copy.
 * A file CommCare HQ could not send ends the call: the requests in flight are
 * aborted and the answer is `failed`, so no verdict stands for it.
 */
export async function judgeReadingMedia(input: {
	readonly creds: CommCareCredentials;
	readonly plan: ReadingMediaPlan;
	/** True in a create: the answered plan keeps the bytes of each held file. */
	readonly keep: boolean;
	readonly onProgress: (done: number, total: number) => void;
	readonly cancel?: AbortSignal;
	/** What an earlier step of the request read of a file, by its CommCare HQ id. */
	readonly fetched?: ReadonlyMap<string, SettledHqMediaRead>;
}): Promise<
	| { readonly kind: "done"; readonly plan: ReadingMediaPlan }
	| { readonly kind: "failed"; readonly failure: HqFailure }
> {
	const { creds, plan, keep, onProgress } = input;
	const total = plan.files.length;
	if (total > MAX_MEDIA_EXPORT_ASSETS) return { kind: "done", plan };

	const stop = new AbortController();
	const signal =
		input.cancel === undefined
			? stop.signal
			: AbortSignal.any([input.cancel, stop.signal]);
	const verdicts = recordFromEntries<HqMediaVerdict>([]);
	/** The held files, one per content: the row the budget counts and, in a
	 *  create, the one buffer kept for it. */
	const held = new Map<
		string,
		{
			readonly row: {
				readonly status: "ready";
				readonly kind: MediaKind;
				readonly sizeBytes: number;
			};
			readonly bytes: Buffer | null;
		}
	>();
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
		if (read.kind === "missing") verdict = { kind: "missing" };
		else if (file.availabilityOnly) {
			verdict = { kind: "available" };
			if (answered === undefined && read.kind === "read")
				giveBackHeld("bytes", read.bytes.byteLength);
		} else if (read.kind === "too-large")
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
				if (!held.has(heldFile.contentHash))
					held.set(heldFile.contentHash, {
						row: {
							status: "ready",
							kind: heldFile.kind,
							sizeBytes: heldFile.sizeBytes,
						},
						bytes: keep ? bytes : null,
					});
			}
			/* Bytes this call read and keeps no buffer of are let go here, and
			 * given back to the request's lease; bytes an earlier step handed
			 * in stay with the step that holds them. */
			const kept =
				verdict.kind === "held" &&
				held.get(verdict.file.contentHash)?.bytes === bytes;
			if (answered === undefined && !kept)
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
	const mayStart = () =>
		failure === null &&
		thrown === null &&
		!signal.aborted &&
		exportBudgetExcess([...held.values()].map((entry) => entry.row)) === null;
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
	const kept = new Map<string, Buffer>();
	for (const [contentHash, entry] of held)
		if (entry.bytes !== null) kept.set(contentHash, entry.bytes);
	return {
		kind: "done",
		plan: { ...plan, verdicts, kept, published: { ...plan.published } },
	};
}

/** How many files a create publishes at once. */
export const BRING_IN_MEDIA_PUBLISH_CONCURRENCY = 2;

/**
 * Publishes the kept bytes of each held content to the Project's library,
 * once per content: each content hash the plan has not published yet is
 * published under a fresh id, or found by its bytes where the Project already
 * holds them, and its asset is recorded under every file key whose held
 * verdict has that hash; its bytes then leave the plan. A create alone calls
 * it. Throws what the publication throws, after the publications in flight
 * settle.
 */
export async function publishKeptReadingMedia(input: {
	readonly projectId: string;
	readonly actorUserId: string;
	readonly plan: ReadingMediaPlan;
	readonly onProgress: (done: number, total: number) => void;
 readonly authorizePublication?:Parameters<typeof publishReadyMedia>[0]["authorizePublication"];
}): Promise<ReadingMediaPlan> {
	const { plan, onProgress } = input;
	const heldFiles = plan.files.flatMap((file) => {
		const verdict = ownRecordValue(plan.verdicts, file.key);
		return verdict?.kind === "held" ? [{ file, judged: verdict.file }] : [];
	});
	const published = recordFromEntries(Object.entries(plan.published));
	const kept = new Map(plan.kept);
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
		if (!kept.has(contentHash)) {
			throw new Error(
				`The held media file ${keys[0]} has no bytes to publish. A create judges its files with keep: true, which holds each held content's bytes until it is published.`,
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
			try {
				const answer = await publishReadyMedia({
					actorUserId: input.actorUserId,
					projectId: input.projectId,
					bytes: kept.get(contentHash) as Buffer,
					validated: judged,
					authorizePublication:input.authorizePublication,
					originalFilename: judged.originalFilename,
					assetId: asMediaAssetId(randomUUID()),
				});
				for (const key of keys) published[key] = answer.assetId;
				kept.delete(contentHash);
				onProgress(publishedCount(), heldFiles.length);
			} catch (error) {
				failed ??= { error };
			}
		}
	};
	await Promise.all(
		Array.from(
			{ length: Math.min(BRING_IN_MEDIA_PUBLISH_CONCURRENCY, waiting.length) },
			worker,
		),
	);
	if (failed !== null) throw (failed as { readonly error: unknown }).error;
	return { ...plan, kept, published };
}
