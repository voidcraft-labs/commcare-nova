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
	readHqMediaFile,
} from "@/lib/commcare/hq/media";
import {
	asMediaAssetId,
	MAX_MEDIA_EXPORT_ASSETS,
	type MediaAssetId,
	type MediaKind,
} from "@/lib/domain/multimedia";
import { exportBudgetExcess } from "@/lib/media/exportBudget";
import { publishReadyMedia } from "@/lib/media/publishReadyMedia";
import { validateSniffedMediaBytes } from "@/lib/media/validate";
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
 * A file starts only where fewer than `HQ_MEDIA_READ_CONCURRENCY` are in
 * flight and the size limits of those in flight plus its own stay within
 * `HQ_MEDIA_IN_FLIGHT_MAX_BYTES`, a file being in flight from its start until
 * its verdict is in. Over `MAX_MEDIA_EXPORT_ASSETS` files no file starts, and
 * once the held files pass Nova's media budget no further file starts: those
 * in flight finish and the answer is `done` with the plan as it then stands.
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
	const verdicts: Record<string, HqMediaVerdict> = {};
	const kept = new Map<string, Buffer>();
	/** The held files, one per content, as the budget counts them. */
	const held = new Map<
		string,
		{
			readonly status: "ready";
			readonly kind: MediaKind;
			readonly sizeBytes: number;
		}
	>();
	let failure: HqFailure | null = null;
	let thrown: { readonly error: unknown } | null = null;
	let done = 0;

	const judge = async (file: PlanFile): Promise<void> => {
		const capBytes = mediaCapBytes(file.kind);
		const read = await readHqMediaFile(
			creds,
			file.mediaType,
			file.multimediaId,
			{
				maxBytes: capBytes,
				cancel: signal,
			},
		);
		if ("success" in read) {
			if (failure === null) failure = classifyHqFailure(read, "media-file");
			stop.abort();
			return;
		}
		let verdict: HqMediaVerdict;
		if (read.kind === "missing") verdict = { kind: "missing" };
		else if (read.kind === "too-large")
			verdict = { kind: "over-limit", mediaKind: file.kind, capBytes };
		else {
			const bytes = Buffer.from(read.bytes);
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
				held.set(heldFile.contentHash, {
					status: "ready",
					kind: heldFile.kind,
					sizeBytes: heldFile.sizeBytes,
				});
				if (keep) kept.set(file.key, bytes);
			}
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
		exportBudgetExcess([...held.values()]) === null;
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
	return {
		kind: "done",
		plan: { ...plan, verdicts, kept, published: { ...plan.published } },
	};
}

/** How many files a create publishes at once. */
export const BRING_IN_MEDIA_PUBLISH_CONCURRENCY = 2;

/**
 * Publishes the kept bytes of each held file to the Project's library. A
 * create alone calls it. Each held file the plan has not published yet is
 * published under a fresh id, or found by its bytes where the Project already
 * holds them; its asset is recorded under the file's key and its bytes leave
 * the plan. Throws what the publication throws, after the publications in
 * flight settle.
 */
export async function publishKeptReadingMedia(input: {
	readonly projectId: string;
	readonly actorUserId: string;
	readonly plan: ReadingMediaPlan;
	readonly onProgress: (done: number, total: number) => void;
}): Promise<ReadingMediaPlan> {
	const { plan, onProgress } = input;
	const heldFiles = plan.files.flatMap((file) => {
		const verdict = Object.hasOwn(plan.verdicts, file.key)
			? plan.verdicts[file.key]
			: undefined;
		return verdict?.kind === "held" ? [{ file, judged: verdict.file }] : [];
	});
	const published: Record<string, MediaAssetId> = { ...plan.published };
	const kept = new Map(plan.kept);
	const waiting = heldFiles.filter(
		({ file }) => !Object.hasOwn(published, file.key),
	);
	for (const { file } of waiting) {
		if (!kept.has(file.key)) {
			throw new Error(
				`The held media file ${file.key} has no bytes to publish. A create judges its files with keep: true, which holds each held file's bytes until it is published.`,
			);
		}
	}
	let failed: { readonly error: unknown } | null = null;
	let next = 0;
	const worker = async (): Promise<void> => {
		while (failed === null && next < waiting.length) {
			const { file, judged } = waiting[next] as (typeof waiting)[number];
			next += 1;
			try {
				const answer = await publishReadyMedia({
					actorUserId: input.actorUserId,
					projectId: input.projectId,
					bytes: kept.get(file.key) as Buffer,
					validated: judged,
					originalFilename: judged.originalFilename,
					assetId: asMediaAssetId(randomUUID()),
				});
				published[file.key] = answer.assetId;
				kept.delete(file.key);
				onProgress(Object.keys(published).length, heldFiles.length);
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
