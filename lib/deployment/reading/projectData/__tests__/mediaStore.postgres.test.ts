/**
 * Publishing a create's staged media files to the Project's library: real
 * Postgres, the real content lock and metadata transactions, and the bucket
 * replaced at its module by objects held in the test.
 *
 * A file in Files twice, a duplicate row on a retry, a staged object left
 * behind once its file is published, a publication from anything but the
 * staged generation and a file added for a person who may no longer add one
 * are what these cases catch.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import type { MediaKind } from "@/lib/domain/multimedia";
import { MediaPublishPermissionError } from "@/lib/media/publishReadyMedia";
import { validateSniffedMediaBytes } from "@/lib/media/validate";
import {
	copyAssetObjectIfAbsent,
	deleteAsset,
	deleteAssetGeneration,
	type StagedObject,
	uploadAssetBytes,
} from "@/lib/storage/media";
import { provisionalReadingMediaId } from "../../mediaIds";
import {
	type HqMediaVerdict,
	judgedMediaFile,
	type ReadingMediaPlan,
} from "../media";
import {
	BRING_IN_MEDIA_PUBLISH_CONCURRENCY,
	publishStagedReadingMedia,
} from "../mediaStore";

vi.mock("@/lib/storage/media", () => ({
	uploadAssetBytes: vi.fn(),
	deleteAsset: vi.fn(),
	copyAssetObjectIfAbsent: vi.fn(),
	deleteAssetGeneration: vi.fn(),
}));

const h = setupAppStateTestDb("bring_in_media_", { authSchema: "migrated" });
const ACTOR = "bringer";
const PROJECT = "program";
const APP = "7c0f1a52-5d3e-4a8b-9a51-2c3c2d4e5f60";

function fixture(name: string): Buffer {
	return readFileSync(
		join(import.meta.dirname, "../../../../media/__tests__/fixtures", name),
	);
}
const PNG = fixture("pattern.png");
const JPG = fixture("pattern.jpg");
const GIF = fixture("pattern.gif");
const MP3 = fixture("tone.mp3");

/** The bucket: each object's bytes and generation, by key. */
const objects = new Map<string, { bytes: Buffer; generation: string }>();
let copying = 0;
let mostCopying = 0;
beforeEach(() => {
	objects.clear();
	copying = 0;
	mostCopying = 0;
	vi.mocked(uploadAssetBytes).mockReset();
	vi.mocked(copyAssetObjectIfAbsent)
		.mockReset()
		.mockImplementation(async (input) => {
			copying += 1;
			mostCopying = Math.max(mostCopying, copying);
			try {
				// Yield, so publications that overlap are seen overlapping.
				await new Promise<void>((resolve) => setImmediate(resolve));
				const source = objects.get(input.sourceGcsObjectKey);
				if (source?.generation !== input.sourceGeneration)
					throw new Error("No object stands at that staged generation.");
				expect(source.bytes.byteLength).toBe(input.expectedSize);
				objects.set(input.destinationGcsObjectKey, {
					bytes: Buffer.from(source.bytes),
					generation: "1",
				});
				return { destinationGeneration: "1", replay: false };
			} finally {
				copying -= 1;
			}
		});
	vi.mocked(deleteAssetGeneration)
		.mockReset()
		.mockImplementation(async (key, generation) => {
			if (objects.get(key)?.generation === generation) objects.delete(key);
		});
	vi.mocked(deleteAsset)
		.mockReset()
		.mockImplementation(async (key) => {
			objects.delete(key);
		});
});

/** The keys of the bucket's staged objects still there. */
function stagedLeft(): string[] {
	return [...objects.keys()].filter((key) => key.startsWith("pending/"));
}

/** A create's plan after judging: each file held with its bytes staged once by their content,
 *  or given the verdict named. */
async function judgedPlan(
	files: readonly (readonly [string, MediaKind, Buffer | HqMediaVerdict])[],
): Promise<ReadingMediaPlan> {
	const verdicts: Record<string, HqMediaVerdict> = {};
	const staged = new Map<string, StagedObject>();
	const planned = [];
	for (const [id, kind, held] of files) {
		const mediaType =
			kind === "image"
				? "CommCareImage"
				: kind === "audio"
					? "CommCareAudio"
					: "CommCareVideo";
		const key = `${mediaType}/${id}`;
		const paths = [`jr://file/commcare/${kind}/${id}`];
		planned.push({
			key,
			mediaType,
			multimediaId: id,
			kind,
			paths,
			provisionalId: provisionalReadingMediaId(APP, mediaType, id),
		} as const);
		if (!Buffer.isBuffer(held)) {
			verdicts[key] = held;
			continue;
		}
		const judged = await validateSniffedMediaBytes(held);
		if (!judged.ok)
			throw new Error(`The fixture for ${id} is not a file the gate takes.`);
		const file = judgedMediaFile(paths, kind, judged.validated);
		verdicts[key] = { kind: "held", file };
		if (staged.has(file.contentHash)) continue;
		const gcsObjectKey = `pending/${PROJECT}/${id}${file.extension}`;
		const generation = String(objects.size + 1);
		objects.set(gcsObjectKey, { bytes: held, generation });
		staged.set(file.contentHash, { gcsObjectKey, generation, checksum: "c" });
	}
	return { files: planned, verdicts, staged, published: {} };
}

async function rows() {
	return h
		.db()
		.selectFrom("media_assets")
		.selectAll()
		.orderBy("content_hash")
		.execute();
}
function publish(plan: ReadingMediaPlan, actorUserId = ACTOR) {
	const progress: (readonly [number, number])[] = [];
	const answer = publishStagedReadingMedia({
		projectId: PROJECT,
		actorUserId,
		plan,
		onProgress: (done, total) => progress.push([done, total]),
	});
	return { answer, progress };
}

it("publishes each held file once, as a ready row with the judged facts and its name, two at a time", async () => {
	await h.seedProjectMember(ACTOR, PROJECT, "editor");
	const plan = await judgedPlan([
		["a", "image", PNG],
		["b", "image", JPG],
		["c", "image", GIF],
		["d", "audio", MP3],
		["gone", "image", { kind: "missing" }],
		["big", "video", { kind: "over-limit", mediaKind: "video", capBytes: 1 }],
	]);
	const { answer, progress } = publish(plan);
	const done = await answer;
	expect(mostCopying).toBeLessThanOrEqual(BRING_IN_MEDIA_PUBLISH_CONCURRENCY);
	expect(copyAssetObjectIfAbsent).toHaveBeenCalledTimes(4);
	expect(uploadAssetBytes).not.toHaveBeenCalled();
	expect(Object.keys(done.published).sort()).toEqual([
		"CommCareAudio/d",
		"CommCareImage/a",
		"CommCareImage/b",
		"CommCareImage/c",
	]);
	expect(done.staged.size).toBe(0);
	expect(plan.staged.size).toBe(4);
	/* Each staged object leaves once its content is published, and the content key holds it. */
	expect(stagedLeft()).toEqual([]);
	expect(progress.map(([count]) => count)).toEqual([1, 2, 3, 4]);
	expect(progress.every(([, total]) => total === 4)).toBe(true);
	const stored = await rows();
	expect(stored).toHaveLength(4);
	for (const key of Object.keys(done.published)) {
		const verdict = plan.verdicts[key];
		if (verdict?.kind !== "held")
			throw new Error("published a file that was not held");
		const row = stored.find((each) => each.id === done.published[key]);
		expect(row).toMatchObject({
			project_id: PROJECT,
			owner: ACTOR,
			status: "ready",
			content_hash: verdict.file.contentHash,
			mime_type: verdict.file.mimeType,
			kind: verdict.file.kind,
			extension: verdict.file.extension,
			size_bytes: String(verdict.file.sizeBytes),
			media_format: verdict.file.mediaFormat,
			original_filename: verdict.file.originalFilename,
			gcs_object_key: `projects/${PROJECT}/${verdict.file.contentHash}${verdict.file.extension}`,
		});
	}
	expect(stored.map((row) => row.original_filename).sort()).toEqual([
		"a.png",
		"b.jpg",
		"c.gif",
		"d.mp3",
	]);
});

it("publishes two files with the same bytes once, and records the one asset under both keys", async () => {
	await h.seedProjectMember(ACTOR, PROJECT, "editor");
	const plan = await judgedPlan([
		["one", "image", PNG],
		["two", "image", PNG],
	]);
	expect(plan.staged.size).toBe(1);
	const { answer, progress } = publish(plan);
	const done = await answer;
	expect(done.published["CommCareImage/one"]).toBe(
		done.published["CommCareImage/two"],
	);
	/* One publication, which recorded both keys at once. */
	expect(progress).toEqual([[2, 2]]);
	expect(done.staged.size).toBe(0);
	expect(await rows()).toHaveLength(1);
	expect(copyAssetObjectIfAbsent).toHaveBeenCalledTimes(1);
	expect(stagedLeft()).toEqual([]);
});

it("answers the Project's own file for bytes it already holds, and a second run uploads and inserts nothing", async () => {
	await h.seedProjectMember(ACTOR, PROJECT, "editor");
	await h.seedProjectMember("co-member", PROJECT, "editor");
	const first = await publish(
		await judgedPlan([["a", "image", PNG]]),
		"co-member",
	).answer;
	const existing = first.published["CommCareImage/a"];
	vi.mocked(copyAssetObjectIfAbsent).mockClear();
	const again = await publish(
		await judgedPlan([
			["a", "image", PNG],
			["copy", "image", PNG],
		]),
	).answer;
	expect(again.published).toEqual({
		"CommCareImage/a": existing,
		"CommCareImage/copy": existing,
	});
	expect(copyAssetObjectIfAbsent).not.toHaveBeenCalled();
	/* The second run's staged object is deleted though nothing was copied from it. */
	expect(stagedLeft()).toEqual([]);
	const stored = await rows();
	expect(stored).toHaveLength(1);
	expect(stored[0]?.owner).toBe("co-member");
});

it("refuses a person who may not add media, and adds nothing", async () => {
	await h.seedProjectMember(ACTOR, PROJECT, "viewer");
	const failed = publish(await judgedPlan([["a", "image", PNG]])).answer;
	await expect(failed).rejects.toBeInstanceOf(MediaPublishPermissionError);
	await expect(failed).rejects.toMatchObject({ reason: "cannot-edit" });
	expect(await rows()).toEqual([]);
	expect(copyAssetObjectIfAbsent).not.toHaveBeenCalled();
});

it("rejects on a storage failure, and the next run finds what was published by its bytes", async () => {
	await h.seedProjectMember(ACTOR, PROJECT, "editor");
	const plan = await judgedPlan([
		["a", "image", PNG],
		["b", "image", JPG],
		["c", "image", GIF],
	]);
	const failing = plan.verdicts["CommCareImage/b"];
	if (failing?.kind !== "held") throw new Error("b is held");
	const failingKey = `projects/${PROJECT}/${failing.file.contentHash}${failing.file.extension}`;
	const working = vi.mocked(copyAssetObjectIfAbsent).getMockImplementation();
	if (working === undefined) throw new Error("no bucket");
	vi.mocked(copyAssetObjectIfAbsent).mockImplementation(async (input) => {
		if (input.destinationGcsObjectKey === failingKey)
			throw new Error("the bucket did not answer");
		return working(input);
	});
	await expect(publish(plan).answer).rejects.toThrow(
		"the bucket did not answer",
	);
	const after = await rows();
	expect(after.map((row) => row.original_filename)).not.toContain("b.jpg");
	const publishedBefore = after.map((row) => row.content_hash);

	vi.mocked(copyAssetObjectIfAbsent).mockImplementation(working);
	vi.mocked(copyAssetObjectIfAbsent).mockClear();
	const retried = await publish(plan).answer;
	expect(Object.keys(retried.published).sort()).toEqual([
		"CommCareImage/a",
		"CommCareImage/b",
		"CommCareImage/c",
	]);
	const uploadedAgain = vi
		.mocked(copyAssetObjectIfAbsent)
		.mock.calls.map(([input]) => input.destinationGcsObjectKey);
	for (const hash of publishedBefore)
		expect(uploadedAgain.some((key) => key.includes(hash))).toBe(false);
	expect(await rows()).toHaveLength(3);
});
