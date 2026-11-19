/**
 * Publishing a create's held media files to the Project's library: real
 * Postgres, the real content lock and metadata transactions, and the bucket
 * replaced at its module, as the MCP upload's suite replaces it.
 *
 * A file in Files twice, a duplicate row on a retry, bytes held past their
 * use and a file added for a person who may no longer add one are what these
 * cases catch.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import type { MediaKind } from "@/lib/domain/multimedia";
import { MediaPublishPermissionError } from "@/lib/media/publishReadyMedia";
import { validateSniffedMediaBytes } from "@/lib/media/validate";
import { deleteAsset, uploadAssetBytes } from "@/lib/storage/media";
import { provisionalReadingMediaId } from "../../mediaIds";
import {
	type HqMediaVerdict,
	judgedMediaFile,
	type ReadingMediaPlan,
} from "../media";
import {
	BRING_IN_MEDIA_PUBLISH_CONCURRENCY,
	publishKeptReadingMedia,
} from "../mediaStore";

vi.mock("@/lib/storage/media", () => ({
	uploadAssetBytes: vi.fn(),
	deleteAsset: vi.fn(),
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

const objects = new Map<string, Buffer>();
let uploading = 0;
let mostUploading = 0;
beforeEach(() => {
	objects.clear();
	uploading = 0;
	mostUploading = 0;
	vi.mocked(uploadAssetBytes)
		.mockReset()
		.mockImplementation(async ({ gcsObjectKey, bytes }) => {
			uploading += 1;
			mostUploading = Math.max(mostUploading, uploading);
			try {
				// Yield, so publications that overlap are seen overlapping.
				await new Promise<void>((resolve) => setImmediate(resolve));
				objects.set(gcsObjectKey, Buffer.from(bytes));
			} finally {
				uploading -= 1;
			}
		});
	vi.mocked(deleteAsset)
		.mockReset()
		.mockImplementation(async (key) => {
			objects.delete(key);
		});
});

/** A create's plan after judging: each file held with its bytes kept by their content, or given the verdict named. */
async function judgedPlan(
	files: readonly (readonly [string, MediaKind, Buffer | HqMediaVerdict])[],
): Promise<ReadingMediaPlan> {
	const verdicts: Record<string, HqMediaVerdict> = {};
	const kept = new Map<string, Buffer>();
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
		kept.set(file.contentHash, held);
	}
	return { files: planned, verdicts, kept, published: {} };
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
	const answer = publishKeptReadingMedia({
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
	expect(mostUploading).toBeLessThanOrEqual(BRING_IN_MEDIA_PUBLISH_CONCURRENCY);
	expect(uploadAssetBytes).toHaveBeenCalledTimes(4);
	expect(Object.keys(done.published).sort()).toEqual([
		"CommCareAudio/d",
		"CommCareImage/a",
		"CommCareImage/b",
		"CommCareImage/c",
	]);
	expect(done.kept.size).toBe(0);
	expect(plan.kept.size).toBe(4);
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
	expect(plan.kept.size).toBe(1);
	const { answer, progress } = publish(plan);
	const done = await answer;
	expect(done.published["CommCareImage/one"]).toBe(
		done.published["CommCareImage/two"],
	);
	/* One publication, which recorded both keys at once. */
	expect(progress).toEqual([[2, 2]]);
	expect(done.kept.size).toBe(0);
	expect(await rows()).toHaveLength(1);
	expect(uploadAssetBytes).toHaveBeenCalledTimes(1);
});

it("answers the Project's own file for bytes it already holds, and a second run uploads and inserts nothing", async () => {
	await h.seedProjectMember(ACTOR, PROJECT, "editor");
	await h.seedProjectMember("co-member", PROJECT, "editor");
	const first = await publish(
		await judgedPlan([["a", "image", PNG]]),
		"co-member",
	).answer;
	const existing = first.published["CommCareImage/a"];
	vi.mocked(uploadAssetBytes).mockClear();
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
	expect(uploadAssetBytes).not.toHaveBeenCalled();
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
	expect(uploadAssetBytes).not.toHaveBeenCalled();
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
	const working = vi.mocked(uploadAssetBytes).getMockImplementation();
	vi.mocked(uploadAssetBytes).mockImplementation(async (input) => {
		if (input.gcsObjectKey === failingKey)
			throw new Error("the bucket did not answer");
		await working?.(input);
	});
	await expect(publish(plan).answer).rejects.toThrow(
		"the bucket did not answer",
	);
	const after = await rows();
	expect(after.map((row) => row.original_filename)).not.toContain("b.jpg");
	const publishedBefore = after.map((row) => row.content_hash);

	vi.mocked(uploadAssetBytes).mockImplementation(async (input) =>
		working?.(input),
	);
	vi.mocked(uploadAssetBytes).mockClear();
	const retried = await publish(plan).answer;
	expect(Object.keys(retried.published).sort()).toEqual([
		"CommCareImage/a",
		"CommCareImage/b",
		"CommCareImage/c",
	]);
	const uploadedAgain = vi
		.mocked(uploadAssetBytes)
		.mock.calls.map(([input]) => input.gcsObjectKey);
	for (const hash of publishedBefore)
		expect(uploadedAgain.some((key) => key.includes(hash))).toBe(false);
	expect(await rows()).toHaveLength(3);
});
