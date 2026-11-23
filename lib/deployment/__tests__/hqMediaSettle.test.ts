/**
 * Settling a published path by the content of the file CommCare HQ holds
 * there, through the media reader, against a peer that answers each file.
 * The reader keeps nothing of HQ's answer but a status and bytes (its own
 * test holds that), so the peer's files are written here.
 *
 * It would catch: a file replaced in CommCare HQ read as this app's because
 * its id moved to another document of the same bytes and nobody looked; an
 * outage read as "nothing changed", so a publish writes over a person's file;
 * one document fetched once per path that names it; and a file over Nova's
 * limit kept or read whole.
 */

import { createHash } from "node:crypto";
import type { MockAgent } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import { MemoryMeter, runInLease } from "@/lib/commcare/hq/memoryMeter";
import { ASSET_SIZE_CAPS_BYTES } from "@/lib/domain";
import { type HqMediaPath, hqMediaStandings } from "../hqMedia";
import { settleHqMedia } from "../hqMediaSettle";

const CREDS = { username: "account", apiKey: "key", server: "india" } as const;
const HOST = "https://india.commcarehq.org";
const OWN = Buffer.from("this app's own picture");
const OTHER = Buffer.from("a picture a person uploaded in CommCare HQ");
const sha256 = (bytes: Buffer) =>
	createHash("sha256").update(bytes).digest("hex");

afterEach(() => vi.useRealTimers());

const fileAt = (id: string, type = "CommCareImage") =>
	`/hq/multimedia/file/${type}/${id}/`;
const intercept = (peer: MockAgent, id: string) =>
	peer.get(HOST).intercept({
		path: fileAt(id),
		method: "GET",
		headers: { authorization: "ApiKey account:key" },
	});
const calls = (peer: MockAgent) =>
	(peer.getCallHistory()?.calls() ?? []).map((call) =>
		call.fullUrl.replace(HOST, ""),
	);

/**
 * The standings of one published image per `[wirePath, id]`, each a
 * candidate: `moved` where `recorded` names another id, else `unrecorded`.
 */
function candidates(
	entries: readonly (readonly [string, string])[],
	recorded: Readonly<Record<string, string>> | null = null,
): readonly HqMediaPath[] {
	return hqMediaStandings({
		published: entries.map(([wirePath]) => ({
			wirePath,
			assetId: testMediaAssetId(wirePath),
			contentHash: sha256(OWN),
			kind: "image",
		})),
		record: recorded,
		now: entries.map(([wirePath, id]) => ({
			path: `jr://file/${wirePath}`,
			multimediaId: id,
			mediaType: "CommCareImage",
			unreadable: false,
		})),
	});
}

describe("settleHqMedia", () => {
	it("reads the app's own bytes as recorded and learns the id, and other bytes as replaced", async () => {
		await withHttpPeer(async (peer) => {
			intercept(peer, "doc-same").reply(200, OWN, {
				headers: { "content-type": "image/png" },
			});
			intercept(peer, "doc-other").reply(200, OTHER, {
				headers: { "content-type": "image/png" },
			});
			const settled = await settleHqMedia(
				CREDS,
				candidates(
					[
						["commcare/same.png", "doc-same"],
						["commcare/other.png", "doc-other"],
					],
					{ "commcare/same.png": "doc-before" },
				),
				{},
			);
			expect(settled).toMatchObject({
				kind: "settled",
				learned: { "commcare/same.png": "doc-same" },
			});
			if (settled.kind !== "settled") throw new Error("Expected settled");
			expect(settled.paths.map((path) => path.standing)).toEqual([
				"recorded",
				"replaced",
			]);
			/* Nothing of a fetched file is kept: the answer holds no bytes. */
			expect(
				JSON.stringify(settled).includes(OWN.toString("base64")) ||
					JSON.stringify(settled).includes(OTHER.toString()),
			).toBe(false);
			expect(
				settled.paths.some((path) =>
					Object.values(path).some((value) => value instanceof Uint8Array),
				),
			).toBe(false);
		});
	});

	it("recognizes an adopted picture larger than the direct upload limit by streaming its digest", async () => {
		const bytes = Buffer.alloc(ASSET_SIZE_CAPS_BYTES.image + 137, 37);
		await withHttpPeer(async (peer) => {
			intercept(peer, "doc-large").reply(200, bytes, {
				headers: { "content-type": "image/png" },
			});
			const paths = candidates([["commcare/large.png", "doc-large"]]).map(
				(p) => ({ ...p, sizeBytes: bytes.length, contentHash: sha256(bytes) }),
			);
			const settled = await settleHqMedia(CREDS, paths, { retain: true });
			expect(settled).toMatchObject({
				kind: "settled",
				learned: { "commcare/large.png": "doc-large" },
			});
			if (settled.kind === "settled") expect(settled.reads.size).toBe(0);
		});
	});
	it("reads a file over Nova's limit for its kind and an unreadable entry as replaced, and a 404 as absent", async () => {
		await withHttpPeer(async (peer) => {
			intercept(peer, "doc-big").reply(
				200,
				Buffer.alloc(ASSET_SIZE_CAPS_BYTES.image + 1),
				{ headers: { "content-type": "image/png" } },
			);
			intercept(peer, "doc-gone").reply(404, "Not found", {
				headers: { "content-type": "text/html" },
			});
			const paths = [
				...candidates([
					["commcare/big.png", "doc-big"],
					["commcare/gone.png", "doc-gone"],
				]),
				...hqMediaStandings({
					published: [
						{
							wirePath: "commcare/unreadable.png",
							assetId: testMediaAssetId("unreadable"),
							contentHash: sha256(OWN),
							kind: "image",
						},
					],
					record: null,
					now: [
						{
							path: "jr://file/commcare/unreadable.png",
							multimediaId: null,
							mediaType: null,
							unreadable: true,
						},
					],
				}),
			];
			const settled = await settleHqMedia(CREDS, paths, {});
			if (settled.kind !== "settled") throw new Error("Expected settled");
			expect(settled.paths.map((path) => path.standing)).toEqual([
				"replaced",
				"absent",
				"replaced",
			]);
			expect(settled.learned).toEqual({});
			expect(calls(peer)).toEqual([fileAt("doc-big"), fileAt("doc-gone")]);
		});
	});

	it("keeps what it read for a later step only where asked to retain it: each file read whole, and each 404", async () => {
		const serve = (peer: MockAgent) => {
			intercept(peer, "doc-other").reply(200, OTHER, {
				headers: { "content-type": "image/png" },
			});
			intercept(peer, "doc-big").reply(
				200,
				Buffer.alloc(ASSET_SIZE_CAPS_BYTES.image + 1),
				{ headers: { "content-type": "image/png" } },
			);
			intercept(peer, "doc-gone").reply(404, "Not found", {
				headers: { "content-type": "text/html" },
			});
		};
		const paths = candidates([
			["commcare/other.png", "doc-other"],
			["commcare/big.png", "doc-big"],
			["commcare/gone.png", "doc-gone"],
		]);
		const meter = new MemoryMeter({ heap: 1 << 30, external: 1 << 30 });
		const lease = meter.open();
		await withHttpPeer(async (peer) => {
			serve(peer);
			const settled = await runInLease(lease, () =>
				settleHqMedia(CREDS, paths, { retain: true }),
			);
			if (settled.kind !== "settled") throw new Error("Expected settled");
			/* The request's lease holds what was retained, and nothing of the
			 * file past its limit or of the refusal. */
			expect(lease.held()).toEqual({ heap: 0, external: OTHER.byteLength });
			expect(settled.paths.map((path) => path.standing)).toEqual([
				"replaced",
				"replaced",
				"absent",
			]);
			/* A file over the limit was never read whole, so nothing of it is kept. */
			expect([...settled.reads.keys()].sort()).toEqual([
				"doc-gone",
				"doc-other",
			]);
			const other = settled.reads.get("doc-other");
			expect(other?.kind).toBe("read");
			if (other?.kind === "read")
				expect(Buffer.from(other.bytes).equals(OTHER)).toBe(true);
			expect(settled.reads.get("doc-gone")).toEqual({ kind: "missing" });
		});
		lease.end();
		const unretained = meter.open();
		await withHttpPeer(async (peer) => {
			serve(peer);
			const settled = await runInLease(unretained, () =>
				settleHqMedia(CREDS, paths, {}),
			);
			if (settled.kind !== "settled") throw new Error("Expected settled");
			expect(settled.reads.size).toBe(0);
			/* Each file hashed and let go, given back where it was let go. */
			expect(unretained.held()).toEqual({ heap: 0, external: 0 });
		});
		unretained.end();
		expect(meter.held()).toEqual({ heap: 0, external: 0 });
	});

	it("asks once per id however many paths name it, and nothing for a path an id settles", async () => {
		await withHttpPeer(async (peer) => {
			intercept(peer, "doc-shared").reply(200, OWN, {
				headers: { "content-type": "image/png" },
			});
			const paths = candidates(
				[
					["commcare/one.png", "doc-shared"],
					["commcare/two.png", "doc-shared"],
					["commcare/kept.png", "doc-kept"],
				],
				{ "commcare/kept.png": "doc-kept" },
			);
			expect(paths.map((path) => path.standing)).toEqual([
				"unrecorded",
				"unrecorded",
				"recorded",
			]);
			const settled = await settleHqMedia(CREDS, paths, {});
			expect(settled).toMatchObject({
				kind: "settled",
				learned: {
					"commcare/one.png": "doc-shared",
					"commcare/two.png": "doc-shared",
				},
			});
			expect(calls(peer)).toEqual([fileAt("doc-shared")]);
		});
	});

	it("answers failed, never nothing changed, where a file still cannot be sent after the resend", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		await withHttpPeer(async (peer) => {
			intercept(peer, "doc-down").reply(503, "").times(2);
			const pending = settleHqMedia(
				CREDS,
				candidates([["commcare/down.png", "doc-down"]]),
				{},
			);
			/* The reader waits one second before its one resend. */
			while (vi.getTimerCount() < 2)
				await new Promise<void>((resolve) => setImmediate(resolve));
			await vi.advanceTimersByTimeAsync(1_000);
			expect(await pending).toEqual({
				kind: "failed",
				failure: expect.objectContaining({ success: false, status: 503 }),
			});
			expect(calls(peer)).toEqual([fileAt("doc-down"), fileAt("doc-down")]);
		});
	});

	it("answers failed on a refusal, with the status the account's sentence is chosen by", async () => {
		await withHttpPeer(async (peer) => {
			intercept(peer, "doc-forbidden").reply(403, "Forbidden", {
				headers: { "content-type": "text/html" },
			});
			expect(
				await settleHqMedia(
					CREDS,
					candidates([["commcare/forbidden.png", "doc-forbidden"]]),
					{},
				),
			).toEqual({
				kind: "failed",
				failure: expect.objectContaining({ success: false, status: 403 }),
			});
		});
	});

	it("asks nothing where every path is settled by its id", async () => {
		await withHttpPeer(async (peer) => {
			const paths = candidates([["commcare/kept.png", "doc-kept"]], {
				"commcare/kept.png": "doc-kept",
			});
			expect(await settleHqMedia(CREDS, paths, {})).toEqual({
				kind: "settled",
				paths,
				learned: {},
				reads: new Map(),
			});
			expect(calls(peer)).toEqual([]);
		});
	});
});
