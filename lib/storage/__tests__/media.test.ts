/**
 * `uploadAssetStream` — the streamed byte-PUT write path.
 *
 * Exercises the real stream pipeline (web `ReadableStream` → `Readable.fromWeb`
 * → cap-guard `Transform` → GCS write stream) against a draining fake GCS
 * writable, pinning the cap boundary: exactly `maxBytes` succeeds, one byte
 * over throws `AssetUploadTooLargeError` (so `> maxBytes`, not `>=`).
 */

import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AssetUploadTooLargeError, uploadAssetStream } from "../media";

// Fake GCS: every `createWriteStream` returns a writable that just drains, so
// the pipeline completes without real I/O. No timers or handles are left open.
vi.mock("@google-cloud/storage", () => {
	class FakeStorage {
		bucket() {
			return {
				file: () => ({
					createWriteStream: () =>
						new Writable({
							write(_chunk, _enc, cb) {
								cb();
							},
						}),
				}),
			};
		}
	}
	return { Storage: FakeStorage };
});

beforeAll(() => {
	vi.stubEnv("NOVA_MEDIA_BUCKET", "test-bucket");
	// Unset so `ensureEmulatorBucket` no-ops (no emulator network call).
	vi.stubEnv("NOVA_MEDIA_EMULATOR_HOST", "");
});
afterAll(() => {
	vi.unstubAllEnvs();
});

/** A web ReadableStream emitting exactly `totalBytes` of zeroed chunks. */
function streamOf(totalBytes: number): ReadableStream<Uint8Array> {
	let sent = 0;
	const chunk = 256;
	return new ReadableStream({
		pull(controller) {
			if (sent >= totalBytes) {
				controller.close();
				return;
			}
			const n = Math.min(chunk, totalBytes - sent);
			controller.enqueue(new Uint8Array(n));
			sent += n;
		},
	});
}

async function run(totalBytes: number, maxBytes: number) {
	await uploadAssetStream({
		gcsObjectKey: "pending/u/a.bin",
		body: streamOf(totalBytes),
		contentType: "application/octet-stream",
		maxBytes,
	});
}

describe("uploadAssetStream cap", () => {
	it("accepts a body under the cap", async () => {
		await expect(run(500, 1000)).resolves.toBeUndefined();
	});

	it("accepts a body exactly at the cap", async () => {
		await expect(run(1000, 1000)).resolves.toBeUndefined();
	});

	it("rejects a body one byte over the cap", async () => {
		await expect(run(1001, 1000)).rejects.toBeInstanceOf(
			AssetUploadTooLargeError,
		);
	});
});
