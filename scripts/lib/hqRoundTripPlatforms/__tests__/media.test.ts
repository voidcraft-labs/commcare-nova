/**
 * The backfill's classification (part 09 §7), with a fake reader at the
 * storage boundary over the media fixtures step 4 commits.
 *
 * Contract: a ready row whose stored MIME has one variant takes it with no
 * byte read, and that variant is what the production classifier gives every
 * accepted fixture of the MIME; every other row is classified from its
 * object's bytes, one read per object, with a missing object and one past
 * its kind's cap decided from the size alone, and any read that fails stops
 * the run with no format kept.
 */

import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
	ACCEPTED_FORMATS,
	ASSET_SIZE_CAPS_BYTES,
	type AssetMimeType,
	MEDIA_FORMATS,
} from "@/lib/domain/multimedia";
import { amrNb, amrWb, midi } from "@/lib/media/__tests__/builtFixtures";
import {
	classifyStoredMediaBytes,
	validateMediaBytes,
} from "@/lib/media/validate";
import {
	classifyFleetMedia,
	FORMAT_OF_STORED_MIME,
	type MediaObjectReader,
	MediaReadError,
	type MediaRow,
	needsBytes,
	proveMediaRead,
} from "../media";

const FIXTURES = join(process.cwd(), "lib/media/__tests__/fixtures");

/** The accepted format a fixture's extension names. */
function formatOfExtension(extension: string) {
	return ACCEPTED_FORMATS.find((format) =>
		(format.declaredExtensions as readonly string[]).includes(extension),
	);
}

/** Every committed fixture and every built one, as bytes with the MIME its extension names. */
async function committedFixtures(): Promise<
	{ name: string; bytes: Buffer; mime: string; extension: string }[]
> {
	const files = readdirSync(FIXTURES).map((name) => ({
		name,
		bytes: readFileSync(join(FIXTURES, name)),
	}));
	const built = [
		{ name: "amr-nb.amr", bytes: amrNb() },
		{ name: "amr-wb.amr", bytes: amrWb() },
		{ name: "midi.mid", bytes: midi() },
		{
			name: "pattern.png",
			bytes: await sharp({
				create: { width: 8, height: 8, channels: 3, background: "#3366cc" },
			})
				.png()
				.toBuffer(),
		},
	];
	return [...files, ...built].flatMap((file) => {
		const extension = extname(file.name).toLowerCase();
		const format = formatOfExtension(extension);
		return format === undefined
			? []
			: [{ ...file, mime: format.mime, extension: format.extension }];
	});
}

let next = 0;
function row(mime: string, kind: string, key?: string): MediaRow {
	next += 1;
	const id = `00000000-0000-4000-8000-${String(next).padStart(12, "0")}`;
	return {
		id,
		project_id: "project",
		status: "ready",
		kind,
		mime_type: mime,
		extension:
			ACCEPTED_FORMATS.find((format) => format.mime === mime)?.extension ??
			".bin",
		content_hash: String(next).padStart(64, "0"),
		gcs_object_key: key ?? `projects/project/${id}`,
	};
}

/** A reader over an object map, counting each call. */
function fakeReader(objects: ReadonlyMap<string, Buffer | number | null>) {
	const calls = { size: [] as string[], bytes: [] as string[] };
	const reader: MediaObjectReader = {
		size: async (key) => {
			calls.size.push(key);
			const object = objects.get(key);
			if (object === undefined || object === null) return null;
			return typeof object === "number" ? object : object.length;
		},
		bytes: async (key) => {
			calls.bytes.push(key);
			const object = objects.get(key);
			if (!Buffer.isBuffer(object)) throw new Error("no bytes");
			return object;
		},
	};
	return { reader, calls };
}

function fixture(name: string): Buffer {
	return readFileSync(join(FIXTURES, name));
}

describe("FORMAT_OF_STORED_MIME", () => {
	it("holds exactly the MIMEs with one variant, less audio/wav", () => {
		const byMime = new Map<string, number>();
		for (const format of MEDIA_FORMATS)
			byMime.set(format.mime, (byMime.get(format.mime) ?? 0) + 1);
		const single = [...byMime]
			.filter(([mime, count]) => count === 1 && mime !== "audio/wav")
			.map(([mime]) => mime)
			.sort();
		expect([...FORMAT_OF_STORED_MIME.keys()].sort()).toEqual(single);
		expect(FORMAT_OF_STORED_MIME.has("audio/wav")).toBe(false);
		expect([...FORMAT_OF_STORED_MIME.keys()].sort()).toEqual(
			[
				"audio/aac",
				"audio/amr",
				"audio/flac",
				"audio/midi",
				"audio/mp4",
				"audio/mpeg",
				"image/avif",
				"image/bmp",
				"image/gif",
				"image/jpeg",
				"image/png",
				"image/vnd.microsoft.icon",
				"image/webp",
				"video/x-matroska",
			].sort(),
		);
	});

	it("is what the classifier gives every accepted fixture of each of its MIMEs", async () => {
		const covered = new Set<string>();
		for (const file of await committedFixtures()) {
			const variant = FORMAT_OF_STORED_MIME.get(file.mime);
			if (variant === undefined) continue;
			const upload = await validateMediaBytes({
				bytes: file.bytes,
				claimedMimeType: file.mime,
				claimedSizeBytes: file.bytes.length,
				originalFilename: file.name,
			});
			/* A row is ready only once its upload accepted it. */
			if (!upload.ok || upload.validated.mimeType !== file.mime) continue;
			expect(
				await classifyStoredMediaBytes(file.bytes, {
					mimeType: file.mime as AssetMimeType,
					extension: file.extension,
				}),
				file.name,
			).toBe(variant);
			covered.add(file.mime);
		}
		expect([...covered].sort()).toEqual(
			[...FORMAT_OF_STORED_MIME.keys()].sort(),
		);
	});
});

describe("classifyFleetMedia", () => {
	it("gives a row of each one-variant MIME its variant with no read, and never calls the reader for such a fleet", async () => {
		const rows = [...FORMAT_OF_STORED_MIME.keys()].map((mime) =>
			row(
				mime,
				mime.split("/")[0] === "video"
					? "video"
					: (mime.split("/")[0] as string),
			),
		);
		const { reader, calls } = fakeReader(new Map());
		const { plans, stats } = await classifyFleetMedia(rows, reader);
		expect(
			plans.map((plan) => [plan.mimeType, plan.format, plan.cause]),
		).toEqual(
			rows.map((candidate) => [
				candidate.mime_type,
				FORMAT_OF_STORED_MIME.get(candidate.mime_type),
				"mime",
			]),
		);
		expect(calls).toEqual({ size: [], bytes: [] });
		expect(stats.objectsRead).toBe(0);
		expect(rows.some(needsBytes)).toBe(false);
	});

	it("classifies every other row from its bytes, one read per object key", async () => {
		const wav = row("audio/wav", "audio");
		const wav24 = row("audio/wav", "audio");
		const vorbis = row("audio/ogg", "audio");
		const opus = row("audio/ogg", "audio");
		const high = row("video/mp4", "video");
		const hevc = row("video/mp4", "video");
		const baseline = row("video/mp4", "video");
		const vp9 = row("video/webm", "video");
		const shared = row("video/webm", "video", "projects/project/shared");
		const sharedTwin = row("video/webm", "video", "projects/project/shared");
		const objects = new Map<string, Buffer>([
			[wav.gcs_object_key, fixture("tone.wav")],
			[wav24.gcs_object_key, fixture("tone-24.wav")],
			[vorbis.gcs_object_key, fixture("tone-vorbis.ogg")],
			[opus.gcs_object_key, fixture("tone-opus.ogg")],
			[high.gcs_object_key, fixture("tiny-video.mp4")],
			[hevc.gcs_object_key, fixture("pattern-hevc.mp4")],
			[baseline.gcs_object_key, fixture("pattern-h264-baseline.mp4")],
			[vp9.gcs_object_key, fixture("pattern-vp9.webm")],
			["projects/project/shared", fixture("pattern-vp8.webm")],
		]);
		const { reader, calls } = fakeReader(objects);
		const rows = [
			wav,
			wav24,
			vorbis,
			opus,
			high,
			hevc,
			baseline,
			vp9,
			shared,
			sharedTwin,
		];
		const { plans, stats } = await classifyFleetMedia(rows, reader);
		const byId = new Map(plans.map((plan) => [plan.assetId, plan]));
		expect(
			rows.map((candidate) => [
				byId.get(candidate.id)?.format,
				byId.get(candidate.id)?.cause,
			]),
		).toEqual([
			["wav-pcm", "classified"],
			["unplayable", "no-variant"],
			["ogg-vorbis", "classified"],
			["ogg-opus", "classified"],
			["mp4-h264-high", "classified"],
			["mp4-hevc", "classified"],
			["mp4-h264-baseline", "classified"],
			["webm-vp9", "classified"],
			["webm-vp8", "classified"],
			["webm-vp8", "classified"],
		]);
		expect(
			calls.bytes.filter((key) => key === "projects/project/shared"),
		).toHaveLength(1);
		expect(stats.objectsRead).toBe(9);
	});

	it("decides a missing object and one past its kind's cap from the size alone", async () => {
		const missing = row("audio/wav", "audio");
		const large = row("video/mp4", "video");
		const { reader, calls } = fakeReader(
			new Map<string, number | null>([
				[missing.gcs_object_key, null],
				[large.gcs_object_key, ASSET_SIZE_CAPS_BYTES.video + 1],
			]),
		);
		const { plans } = await classifyFleetMedia([missing, large], reader);
		expect(plans.map((plan) => [plan.format, plan.cause])).toEqual([
			["unplayable", "missing"],
			["unplayable", "too-large"],
		]);
		expect(calls.bytes).toEqual([]);
	});

	it("stops the run on an error from either read, keeping no format", async () => {
		const failing = row("audio/ogg", "audio");
		const sizeFails: MediaObjectReader = {
			size: async () => {
				throw new TypeError("refused");
			},
			bytes: async () => Buffer.alloc(0),
		};
		const sizeError = await classifyFleetMedia([failing], sizeFails).catch(
			(error: unknown) => error,
		);
		expect(sizeError).toBeInstanceOf(MediaReadError);
		expect((sizeError as MediaReadError).message).toBe(
			`Reading the stored file of media asset ${failing.id} failed with an error of class TypeError, so this run stopped before writing anything. Run --prove-media-read to check the Job can read the media bucket, then run again.`,
		);
		const bytesFails: MediaObjectReader = {
			size: async () => 10,
			bytes: async () => {
				throw new Error("grew past its cap");
			},
		};
		await expect(
			classifyFleetMedia([failing], bytesFails),
		).rejects.toBeInstanceOf(MediaReadError);
	});
});

describe("proveMediaRead", () => {
	const instant = {
		retryMilliseconds: 15_000,
		limitMilliseconds: 600_000,
		sleep: async () => {},
	};

	it("says no-media and reads nothing where every ready row takes its format from its MIME", async () => {
		const { reader, calls } = fakeReader(new Map());
		expect(
			await proveMediaRead(
				[row("image/png", "image"), row("image/jpeg", "image")],
				reader,
				instant,
			),
		).toBe("no-media");
		expect(calls.size).toEqual([]);
	});

	it("says ok once the lowest row that needs its bytes read answers its size", async () => {
		const first = row("video/mp4", "video");
		const second = row("audio/wav", "audio");
		const { reader, calls } = fakeReader(
			new Map([[first.gcs_object_key, 1234]]),
		);
		expect(
			await proveMediaRead(
				[second, first, row("image/png", "image")],
				reader,
				instant,
			),
		).toBe("ok");
		expect(calls.size).toEqual([first.gcs_object_key]);
	});

	it("retries a refusal, and says failed once the time allowed has passed", async () => {
		let attempts = 0;
		const refusing = {
			size: async () => {
				attempts += 1;
				throw new Error("403");
			},
		};
		expect(
			await proveMediaRead([row("audio/ogg", "audio")], refusing, instant),
		).toBe("failed");
		expect(attempts).toBe(41);
		let refusals = 2;
		const granted = {
			size: async () => {
				if (refusals-- > 0) throw new Error("403");
				return 10;
			},
		};
		expect(
			await proveMediaRead([row("audio/ogg", "audio")], granted, instant),
		).toBe("ok");
	});
});
