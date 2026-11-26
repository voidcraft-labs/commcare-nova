/**
 * Judging a reading's media files against a CommCare HQ peer the test holds
 * open: the real media reader, the real gate, a loopback socket.
 *
 * A window that lets memory follow the app, a read that stores, bytes staged
 * for a file that will not come in, bytes held after they are staged, an
 * unbounded fetch, a count of files that stops the read, a wrong retry rule and
 * work that outlives its request are what these cases catch.
 */

import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withSocketHttpPeer } from "@/__tests__/helpers/httpPeer";
import type { HqMediaType } from "@/lib/commcare/hq/appSource";
import { classifyHqFailure } from "@/lib/commcare/hq/failure";
import { MemoryMeter, runInLease } from "@/lib/commcare/hq/memoryMeter";
import {
	ASSET_SIZE_CAPS_BYTES,
	MAX_MEDIA_EXPORT_ASSETS,
	type MediaKind,
} from "@/lib/domain/multimedia";
import { validateSniffedMediaBytes } from "@/lib/media/validate";
import {
	deleteAsset,
	type StagedObject,
	stageAssetBytes,
	uploadAssetBytes,
} from "@/lib/storage/media";
import { unionPlan, withJudged } from "../../../hqChanges/review";
import { provisionalReadingMediaId } from "../../mediaIds";
import {
	adoptedMediaFiles,
	type HqMediaReference,
	type JudgedMediaFile,
	planReadingMedia,
	type ReadingMediaPlan,
	readingMediaFindings,
	readingMediaRows,
} from "../media";
import { judgeReadingMedia, type MediaStaging } from "../mediaStore";

vi.mock("@/lib/storage/media", () => ({
	uploadAssetBytes: vi.fn(),
	deleteAsset: vi.fn(),
	stageAssetBytes: vi.fn(),
	deleteAssetGeneration: vi.fn(),
}));
vi.mock("@/lib/media/validate", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/media/validate")>();
	return {
		...actual,
		validateSniffedMediaBytes: vi.fn(actual.validateSniffedMediaBytes),
	};
});

const HOST = "india.commcarehq.org";
const CREDS = { username: "account", apiKey: "key", server: "india" } as const;
const APP = "7c0f1a52-5d3e-4a8b-9a51-2c3c2d4e5f60";
const MIB = 1024 * 1024;

function fixture(name: string): Buffer {
	return readFileSync(
		join(import.meta.dirname, "../../../../media/__tests__/fixtures", name),
	);
}
const BYTES: Readonly<Record<MediaKind, Buffer>> = {
	image: fixture("pattern.png"),
	audio: fixture("tone.mp3"),
	video: fixture("tiny-video.mp4"),
};
const TYPE: Readonly<
	Record<MediaKind, Exclude<HqMediaType, "CommCareMultimedia">>
> = {
	image: "CommCareImage",
	audio: "CommCareAudio",
	video: "CommCareVideo",
};
const KIND_OF: Readonly<Record<string, MediaKind>> = {
	CommCareImage: "image",
	CommCareAudio: "audio",
	CommCareVideo: "video",
};

/** A plan of files in the order given, each named by its kind and id. */
function planOf(
	files: readonly (readonly [MediaKind, string])[],
): ReadingMediaPlan {
	return {
		files: files.map(([kind, id]) => ({
			key: `${TYPE[kind]}/${id}`,
			mediaType: TYPE[kind],
			multimediaId: id,
			kind,
			paths: [`jr://file/commcare/${id}`],
			provisionalId: provisionalReadingMediaId(APP, TYPE[kind], id),
		})),
		verdicts: {},
		staged: new Map(),
		published: {},
	};
}

interface Held {
	readonly kind: MediaKind;
	readonly id: string;
	readonly response: ServerResponse;
	released: boolean;
	closed: boolean;
}

/**
 * The peer: every request is held until the test answers it, and every
 * arrival is held to the window the client must keep.
 */
class Peer {
	readonly all: Held[] = [];
	readonly breaches: string[] = [];
	private readonly listeners = new Set<() => void>();

	readonly onRequest = (request: IncomingMessage, response: ServerResponse) => {
		const parts = (request.url ?? "").split("/").filter(Boolean);
		const held: Held = {
			kind: KIND_OF[parts[3] as string] as MediaKind,
			id: parts[4] as string,
			response,
			released: false,
			closed: false,
		};
		response.once("close", () => {
			held.closed = true;
			this.notify();
		});
		this.all.push(held);
		const open = this.open();
		const caps = open.reduce(
			(sum, each) => sum + ASSET_SIZE_CAPS_BYTES[each.kind],
			0,
		);
		if (open.length > 4)
			this.breaches.push(`${open.length} requests in flight`);
		if (caps > 64 * MIB) this.breaches.push(`${caps / MIB} MiB in flight`);
		this.notify();
	};

	/** Requests the client is waiting on: not answered and not closed. */
	open(): Held[] {
		return this.all.filter((each) => !each.released && !each.closed);
	}

	notify(): void {
		for (const listener of this.listeners) listener();
	}

	until(test: () => boolean): Promise<void> {
		return new Promise((resolve) => {
			const check = () => {
				if (!test()) return;
				this.listeners.delete(check);
				resolve();
			};
			this.listeners.add(check);
			check();
		});
	}

	answer(held: Held, status: number, body: Buffer = BYTES[held.kind]): void {
		held.released = true;
		held.response.writeHead(status, {
			"content-type": "application/octet-stream",
		});
		held.response.end(body);
	}
}

async function withPeer<T>(run: (peer: Peer) => Promise<T>): Promise<T> {
	const peer = new Peer();
	return withSocketHttpPeer(HOST, peer.onRequest, () => run(peer));
}

/** A create's staging held in the test: what it was handed, each staged under a key of its
 *  own, never written. */
function recordingStaging(): {
	readonly stage: MediaStaging["stage"];
	readonly calls: { readonly file: JudgedMediaFile; readonly bytes: Buffer }[];
} {
	const calls: { readonly file: JudgedMediaFile; readonly bytes: Buffer }[] =
		[];
	return {
		calls,
		stage: async (file, bytes): Promise<StagedObject> => {
			calls.push({ file, bytes });
			return {
				gcsObjectKey: `pending/project/${calls.length}${file.extension}`,
				generation: String(calls.length),
				checksum: "staged",
			};
		},
	};
}

/** Calls `judgeReadingMedia`, counting verdicts as they come in for the peer to wait on. */
function judge(
	peer: Peer,
	plan: ReadingMediaPlan,
	options: {
		readonly stage?: MediaStaging["stage"];
		readonly cancel?: AbortSignal;
	} = {},
) {
	const progress: number[] = [];
	const answer = judgeReadingMedia({
		creds: CREDS,
		plan,
		...(options.stage !== undefined && { stage: options.stage }),
		onProgress: (done, total) => {
			expect(total).toBe(plan.files.length);
			progress.push(done);
			peer.notify();
		},
		cancel: options.cancel,
	});
	return { answer, progress };
}

afterEach(() => {
	/* Judging writes nothing to the bucket itself: a create's staging is its caller's. */
	expect(uploadAssetBytes).not.toHaveBeenCalled();
	expect(stageAssetBytes).not.toHaveBeenCalled();
	expect(deleteAsset).not.toHaveBeenCalled();
	vi.mocked(validateSniffedMediaBytes).mockClear();
});

describe("judgeReadingMedia", () => {
	it("checks an unshown itext file at HQ without adopting it, and reads a shared file once at the held slot's limits", async () => {
		const hint = "jr://file/commcare/image/hint.png";
		const shared = "jr://file/commcare/image/shared.png";
		const gone = "jr://file/commcare/image/gone.png";
		const place = {
			kind: "question",
			menu: 0,
			form: 0,
			path: "q",
			menuName: "Menu",
			formName: "Form",
		} as const;
		const ref = (
			path: string,
			slot: HqMediaReference["slot"],
		): HqMediaReference => ({ path, slot, kind: "image", place });
		const source = {
			profile: { properties: { "cc-content-valid": "yes" } },
			multimediaMap: (
				[
					[hint, "file"],
					[shared, "file"],
					[gone, "gone"],
				] as const
			).map(([path, id]) => ({
				path,
				multimediaId: id,
				mediaType: "CommCareImage" as const,
				unreadable: false,
			})),
		};
		const planned = (references: HqMediaReference[]) =>
			planReadingMedia({ source, references, appId: APP, runsOn: ["android"] });
		const only = planned([
			ref(hint, "unheld-itext"),
			ref(gone, "unheld-itext"),
		]);
		const both = planned([ref(hint, "unheld-itext"), ref(shared, "form")]);
		expect(both.plan.files.map((file) => file.paths)).toEqual([[shared]]);

		await withPeer(async (peer) => {
			const { answer } = judge(peer, only.plan, {
				stage: recordingStaging().stage,
			});
			await peer.until(() => peer.all.length === 2);
			for (const request of peer.all) {
				// Invalid image bytes from a successful source-only read still settle availability.
				peer.answer(
					request,
					request.id === "gone" ? 404 : 200,
					Buffer.from("data"),
				);
			}
			const result = await answer;
			if (result.kind !== "done") throw new Error("No file verdicts");
			expect(result.plan.verdicts).toEqual({
				"CommCareImage/file": { kind: "available" },
				"CommCareImage/gone": { kind: "missing" },
			});
			expect(result.plan.staged.size).toBe(0);
			expect(vi.mocked(validateSniffedMediaBytes)).not.toHaveBeenCalled();
			expect(adoptedMediaFiles(result.plan)).toEqual([]);
			expect(readingMediaRows(result.plan).size).toBe(0);
			const judged = readingMediaFindings({
				media: only.media,
				plan: result.plan,
				runsOn: ["android"],
			});
			expect(
				judged.findings.map((finding) => [finding.code, finding.place]),
			).toEqual([["media-file-unreadable", { kind: "media", path: gone }]]);
			expect(judged.claims).toEqual([]);
		});
		const base = planned([ref(hint, "unheld-itext")]).plan;
		const union = unionPlan(base, both.plan);
		expect(unionPlan(both.plan, base)).toEqual(union);
		await withPeer(async (peer) => {
			const oldHeld = planned([ref(hint, "form")]).plan;
			const renamed = unionPlan(oldHeld, both.plan);
			expect(renamed).toEqual(union);
			const { answer } = judge(peer, renamed, {
				stage: recordingStaging().stage,
			});
			await peer.until(() => peer.all.length === 1);
			const [request] = peer.all;
			if (!request) throw new Error("The file request was lost");
			peer.answer(request, 200);
			const result = await answer;
			if (result.kind !== "done") throw new Error("No file verdict");
			expect(peer.all).toHaveLength(1);
			expect(vi.mocked(validateSniffedMediaBytes)).toHaveBeenCalledTimes(1);
			expect(result.plan.verdicts["CommCareImage/file"]).toMatchObject({
				kind: "held",
				file: { originalFilename: "shared.png" },
			});
			const before = withJudged(base, result.plan);
			expect(before.verdicts["CommCareImage/file"]).toEqual({
				kind: "available",
			});
			expect(adoptedMediaFiles(before)).toEqual([]);
			expect(before.staged.size).toBe(0);
			expect(
				adoptedMediaFiles(withJudged(both.plan, result.plan)).map(
					(file) => file.hqPath,
				),
			).toEqual([shared]);
			expect(result.plan.staged.size).toBe(1);
		});
	});
	it("holds every fetch to four requests and 64 MiB of the kinds' limits, a video beside at most one sound", async () => {
		const order: readonly (readonly [MediaKind, string])[] = [
			["video", "v1"],
			["audio", "a1"],
			["audio", "a2"],
			["image", "i1"],
			["image", "i2"],
			["image", "i3"],
			["image", "i4"],
			["image", "i5"],
			["video", "v2"],
			["audio", "a3"],
		];
		await withPeer(async (peer) => {
			const { answer, progress } = judge(peer, planOf(order));
			let maxOpen = 0;
			let started = 0;
			for (;;) {
				// Wait for every file the window has room for, in the plan's order.
				const open = peer.open();
				let caps = open.reduce(
					(sum, each) => sum + ASSET_SIZE_CAPS_BYTES[each.kind],
					0,
				);
				let count = open.length;
				let next = started;
				while (
					next < order.length &&
					count < 4 &&
					caps +
						ASSET_SIZE_CAPS_BYTES[(order[next] as [MediaKind, string])[0]] <=
						64 * MIB
				) {
					caps +=
						ASSET_SIZE_CAPS_BYTES[(order[next] as [MediaKind, string])[0]];
					count += 1;
					next += 1;
				}
				await peer.until(() => peer.all.length === next);
				started = next;
				const waiting = peer.open();
				maxOpen = Math.max(maxOpen, waiting.length);
				const oldest = waiting[0];
				if (oldest === undefined) break;
				const done = progress.length;
				peer.answer(oldest, 200);
				await peer.until(() => progress.length === done + 1);
			}
			const result = await answer;
			expect(peer.breaches).toEqual([]);
			expect(maxOpen).toBe(4);
			// The first video went out beside one sound, and the second sound waited for it.
			expect(new Set(peer.all.slice(0, 2).map((each) => each.id))).toEqual(
				new Set(["v1", "a1"]),
			);
			expect(peer.all.map((each) => each.id).sort()).toEqual(
				order.map(([, id]) => id).sort(),
			);
			expect(result.kind).toBe("done");
			if (result.kind !== "done") return;
			expect(
				Object.values(result.plan.verdicts).map((verdict) => verdict.kind),
			).toEqual(order.map(() => "held"));
			expect(result.plan.staged.size).toBe(0);
		});
	});

	it("stages the bytes of each held file in a create, and no other file's", async () => {
		const plan = planOf([
			["image", "held"],
			["image", "gone"],
			["image", "big"],
			["audio", "picture"],
		]);
		for (const create of [false, true]) {
			const staging = recordingStaging();
			await withPeer(async (peer) => {
				const { answer } = judge(
					peer,
					plan,
					create ? { stage: staging.stage } : {},
				);
				await peer.until(() => peer.open().length === 4);
				for (const held of peer.open()) {
					if (held.id === "held") peer.answer(held, 200);
					else if (held.id === "gone") peer.answer(held, 404, Buffer.alloc(0));
					else if (held.id === "big")
						peer.answer(
							held,
							200,
							Buffer.alloc(ASSET_SIZE_CAPS_BYTES.image + 1),
						);
					else peer.answer(held, 200, BYTES.image);
				}
				const result = await answer;
				expect(result.kind).toBe("done");
				if (result.kind !== "done") return;
				expect(result.plan.verdicts["CommCareImage/held"]).toMatchObject({
					kind: "held",
					file: {
						kind: "image",
						mimeType: "image/png",
						mediaFormat: "png",
						sizeBytes: BYTES.image.length,
						originalFilename: "held.png",
					},
				});
				expect(result.plan.verdicts["CommCareImage/gone"]).toEqual({
					kind: "missing",
				});
				expect(result.plan.verdicts["CommCareImage/big"]).toEqual({
					kind: "over-limit",
					mediaKind: "image",
					capBytes: ASSET_SIZE_CAPS_BYTES.image,
				});
				expect(result.plan.verdicts["CommCareAudio/picture"]).toEqual({
					kind: "wrong-kind",
					sniffedKind: "image",
				});
				const held = result.plan.verdicts["CommCareImage/held"];
				if (held?.kind !== "held") throw new Error("the file was not held");
				/* Staged by the content, not by the file's key. */
				expect([...result.plan.staged.keys()]).toEqual(
					create ? [held.file.contentHash] : [],
				);
				expect(staging.calls.map((call) => call.bytes)).toEqual(
					create ? [BYTES.image] : [],
				);
				expect(staging.calls.map((call) => call.file)).toEqual(
					create ? [held.file] : [],
				);
			});
		}
	});

	it("stages once for files of three ids that hold the same bytes", async () => {
		const plan = planOf([
			["image", "one"],
			["image", "two"],
			["image", "three"],
		]);
		const staging = recordingStaging();
		await withPeer(async (peer) => {
			const { answer } = judge(peer, plan, { stage: staging.stage });
			await peer.until(() => peer.open().length === 3);
			for (const held of peer.open()) peer.answer(held, 200);
			const result = await answer;
			if (result.kind !== "done") throw new Error("the files were not judged");
			const hashes = new Set(
				Object.values(result.plan.verdicts).map((verdict) =>
					verdict.kind === "held" ? verdict.file.contentHash : null,
				),
			);
			expect(hashes.size).toBe(1);
			expect(result.plan.staged.size).toBe(1);
			expect(staging.calls).toHaveLength(1);
		});
	});

	it("gives every byte it read back to the request's lease once the file is judged and staged, in a create as in a review", async () => {
		for (const create of [true, false]) {
			const meter = new MemoryMeter({ heap: 64 * MIB, external: 64 * MIB });
			const lease = meter.open();
			const plan = planOf([
				["image", "one"],
				["image", "two"],
				["audio", "three"],
			]);
			const staging = recordingStaging();
			await withPeer(async (peer) => {
				const { answer } = runInLease(lease, () =>
					judge(peer, plan, create ? { stage: staging.stage } : {}),
				);
				await peer.until(() => peer.open().length === 3);
				for (const held of peer.open())
					peer.answer(
						held,
						200,
						held.id === "three" ? BYTES.audio : BYTES.image,
					);
				const result = await answer;
				if (result.kind !== "done")
					throw new Error("the files were not judged");
				expect(result.plan.staged.size).toBe(create ? 2 : 0);
				expect(lease.held()).toEqual({ heap: 0, external: 0 });
			});
			lease.end();
			expect(meter.held()).toEqual({ heap: 0, external: 0 });
		}
	});

	it("stages a file an earlier step read from that read's own bytes, never a copy", async () => {
		const plan = planOf([["image", "settled"]]);
		const read = new Uint8Array(BYTES.image);
		const staging = recordingStaging();
		const result = await judgeReadingMedia({
			creds: CREDS,
			plan,
			stage: staging.stage,
			onProgress: () => {},
			fetched: new Map([["settled", { kind: "read", bytes: read }]]),
		});
		if (result.kind !== "done") throw new Error("the file was not judged");
		expect(result.plan.staged.size).toBe(1);
		expect(staging.calls[0]?.bytes.buffer).toBe(read.buffer);
	});

	it("asks for every file however many the app names, past what one in-memory export takes", async () => {
		const total = MAX_MEDIA_EXPORT_ASSETS + 1;
		const plan = {
			...planOf(
				Array.from({ length: total }, (_, i) => ["image", `i${i}`] as const),
			),
		};
		const only = {
			...plan,
			files: plan.files.map((file) => ({
				...file,
				availabilityOnly: true as const,
			})),
		};
		await withPeer(async (peer) => {
			const { answer, progress } = judge(peer, only);
			while (progress.length < total) {
				await peer.until(
					() => peer.open().length > 0 || progress.length === total,
				);
				for (const held of peer.open())
					peer.answer(held, 200, Buffer.from("x"));
			}
			const result = await answer;
			if (result.kind !== "done") throw new Error("the files were not judged");
			expect(peer.all).toHaveLength(total);
			expect(peer.breaches).toEqual([]);
			expect(
				Object.values(result.plan.verdicts).every(
					(verdict) => verdict.kind === "available",
				),
			).toBe(true);
		});
	});

	it("ends the call with a staging's failure, once the requests in flight settle, and stages nothing more", async () => {
		const plan = planOf([
			["image", "one"],
			["audio", "two"],
		]);
		let staged = 0;
		await withPeer(async (peer) => {
			const { answer } = judge(peer, plan, {
				stage: async () => {
					staged += 1;
					throw new Error("The bucket refused the staged object.");
				},
			});
			const settled = answer.then(
				() => null,
				(error: unknown) => error,
			);
			await peer.until(() => peer.open().length === 2);
			peer.answer(peer.open()[0] as Held, 200);
			await peer.until(() => peer.open().every((held) => held.closed));
			expect(await settled).toMatchObject({
				message: "The bucket refused the staged object.",
			});
			expect(staged).toBe(1);
		});
	});

	it("asks once more for a file CommCare HQ could not send, and the verdict stands", async () => {
		await withPeer(async (peer) => {
			const { answer } = judge(peer, planOf([["image", "i"]]));
			await peer.until(() => peer.open().length === 1);
			peer.answer(peer.open()[0] as Held, 503, Buffer.alloc(0));
			await peer.until(() => peer.all.length === 2 && peer.open().length === 1);
			peer.answer(peer.open()[0] as Held, 200);
			const result = await answer;
			expect(
				result.kind === "done" && result.plan.verdicts["CommCareImage/i"]?.kind,
			).toBe("held");
		});
	});

	it("ends the call on a file HQ could not send twice, aborting the requests in flight", async () => {
		await withPeer(async (peer) => {
			const { answer } = judge(
				peer,
				planOf([
					["image", "a"],
					["image", "b"],
				]),
			);
			await peer.until(() => peer.open().length === 2);
			const other = peer.all.find((each) => each.id === "b") as Held;
			const first = peer.all.find((each) => each.id === "a") as Held;
			peer.answer(first, 503, Buffer.alloc(0));
			await peer.until(
				() => peer.all.filter((each) => each.id === "a").length === 2,
			);
			peer.answer(
				peer.all.filter((each) => each.id === "a")[1] as Held,
				503,
				Buffer.alloc(0),
			);
			expect(await answer).toEqual({
				kind: "failed",
				failure: classifyHqFailure(
					{ success: false, status: 503, edgeRefusal: false },
					"media-file",
				),
			});
			await peer.until(() => other.closed);
			expect(other.released).toBe(false);
		});
	});

	it("settles when cancelled part way, aborting the requests in flight", async () => {
		const cancel = new AbortController();
		await withPeer(async (peer) => {
			const { answer } = judge(
				peer,
				planOf([
					["image", "a"],
					["image", "b"],
					["image", "c"],
				]),
				{
					cancel: cancel.signal,
				},
			);
			await peer.until(() => peer.open().length === 3);
			peer.answer(peer.all[0] as Held, 200);
			await peer.until(() => (peer.all[0] as Held).closed);
			cancel.abort();
			const result = await answer;
			expect(result.kind).toBe("failed");
			await peer.until(() => peer.all.every((each) => each.closed));
			expect(peer.all).toHaveLength(3);
		});
	});
});
