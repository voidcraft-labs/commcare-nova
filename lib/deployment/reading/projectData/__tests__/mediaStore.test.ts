/**
 * Judging a reading's media files against a CommCare HQ peer the test holds
 * open: the real media reader, the real gate, a loopback socket.
 *
 * A window that lets memory follow the app, a read that stores, bytes kept for
 * a file that will not come in, an unbounded fetch, a wrong retry rule and work
 * that outlives its request are what these cases catch.
 */

import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withSocketHttpPeer } from "@/__tests__/helpers/httpPeer";
import type { HqMediaType } from "@/lib/commcare/hq/appSource";
import { classifyHqFailure } from "@/lib/commcare/hq/failure";
import {
	ASSET_SIZE_CAPS_BYTES,
	MAX_MEDIA_EXPORT_ASSETS,
	type MediaKind,
} from "@/lib/domain/multimedia";
import { validateSniffedMediaBytes } from "@/lib/media/validate";
import { deleteAsset, uploadAssetBytes } from "@/lib/storage/media";
import { provisionalReadingMediaId } from "../../mediaIds";
import type { ReadingMediaPlan } from "../media";
import { judgeReadingMedia } from "../mediaStore";

vi.mock("@/lib/storage/media", () => ({
	uploadAssetBytes: vi.fn(),
	deleteAsset: vi.fn(),
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
		kept: new Map(),
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

/** Calls `judgeReadingMedia`, counting verdicts as they come in for the peer to wait on. */
function judge(
	peer: Peer,
	plan: ReadingMediaPlan,
	options: { readonly keep?: boolean; readonly cancel?: AbortSignal } = {},
) {
	const progress: number[] = [];
	const answer = judgeReadingMedia({
		creds: CREDS,
		plan,
		keep: options.keep ?? false,
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
	expect(uploadAssetBytes).not.toHaveBeenCalled();
	expect(deleteAsset).not.toHaveBeenCalled();
	vi.mocked(validateSniffedMediaBytes).mockClear();
});

describe("judgeReadingMedia", () => {
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
			expect(result.plan.kept.size).toBe(0);
		});
	});

	it("keeps the bytes of each held file in a create, and no other file's", async () => {
		const plan = planOf([
			["image", "held"],
			["image", "gone"],
			["image", "big"],
			["audio", "picture"],
		]);
		for (const keep of [false, true]) {
			await withPeer(async (peer) => {
				const { answer } = judge(peer, plan, { keep });
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
				expect([...result.plan.kept.keys()]).toEqual(
					keep ? ["CommCareImage/held"] : [],
				);
				if (keep)
					expect(result.plan.kept.get("CommCareImage/held")).toEqual(
						BYTES.image,
					);
			});
		}
	});

	it("asks for nothing over Nova's count of files", async () => {
		const plan = planOf(
			Array.from(
				{ length: MAX_MEDIA_EXPORT_ASSETS + 1 },
				(_, i) => ["image", `i${i}`] as const,
			),
		);
		await withPeer(async (peer) => {
			const { answer } = judge(peer, plan);
			expect(await answer).toEqual({ kind: "done", plan });
			expect(peer.all).toEqual([]);
		});
	});

	it("starts no file once the held files pass Nova's media budget, and lets those in flight finish", async () => {
		const actual = vi.mocked(validateSniffedMediaBytes).getMockImplementation();
		let hash = 0;
		vi.mocked(validateSniffedMediaBytes).mockImplementation(async (bytes) => {
			const judged = await (actual as typeof validateSniffedMediaBytes)(bytes);
			if (!judged.ok) return judged;
			hash += 1;
			return {
				ok: true,
				validated: {
					...judged.validated,
					contentHash: `h${hash}`,
					sizeBytes: 60 * MIB,
				},
			};
		});
		try {
			const plan = planOf(
				Array.from({ length: 10 }, (_, i) => ["image", `i${i}`] as const),
			);
			await withPeer(async (peer) => {
				const { answer, progress } = judge(peer, plan);
				// One answer at a time: 60, 120 and 180 MB held each let one more file start, and
				// 240 MB lets none.
				for (let answered = 0; answered < 7; answered += 1) {
					await peer.until(() => peer.open().length > 0);
					peer.answer(peer.open()[0] as Held, 200);
					await peer.until(() => progress.length === answered + 1);
				}
				const result = await answer;
				expect(peer.all.map((each) => each.id).sort()).toEqual([
					"i0",
					"i1",
					"i2",
					"i3",
					"i4",
					"i5",
					"i6",
				]);
				expect(result.kind).toBe("done");
				if (result.kind === "done")
					expect(Object.keys(result.plan.verdicts)).toHaveLength(7);
			});
		} finally {
			vi.mocked(validateSniffedMediaBytes).mockImplementation(
				actual as typeof validateSniffedMediaBytes,
			);
		}
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
