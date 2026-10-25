/**
 * The classification's production reader, `storageMediaReader`, over
 * controlled storage responses: the `@google-cloud/storage` client mocked as
 * `lib/storage/__tests__/captureStorageAuthority.test.ts` mocks it.
 *
 * Contract: a 404 from the object's metadata is a missing object, a reported
 * size is a number, and an object whose stream runs past the cap after a
 * smaller reported size stops the run as a failed read, never as a file too
 * large for its kind, because that is a bucket that moved during the run.
 */

import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getMetadata = vi.fn();
const createReadStream = vi.fn();
const file = vi.fn((key: string) => ({
	getMetadata: () => getMetadata(key),
	createReadStream: () => createReadStream(key),
}));

vi.mock("@google-cloud/storage", () => ({
	Storage: class {
		bucket() {
			return { file };
		}
	},
}));

beforeEach(() => {
	getMetadata.mockReset();
	createReadStream.mockReset();
	file.mockClear();
	vi.stubEnv("NOVA_MEDIA_BUCKET", "test-bucket");
});

afterEach(() => vi.unstubAllEnvs());

const ROW = {
	id: "00000000-0000-4000-8000-000000000001",
	project_id: "project",
	status: "ready",
	kind: "audio",
	mime_type: "audio/wav",
	extension: ".wav",
	content_hash: "0".repeat(64),
	gcs_object_key: "projects/project/tone",
} as const;

describe("storageMediaReader", () => {
	it("reads a 404 from the object's metadata as a missing object", async () => {
		getMetadata.mockRejectedValue(
			Object.assign(new Error("No such object"), { code: 404 }),
		);
		const { storageMediaReader } = await import("../media");
		await expect(
			storageMediaReader.size(ROW.gcs_object_key),
		).resolves.toBeNull();
	});

	it("reads the reported size as a number", async () => {
		getMetadata.mockResolvedValue([{ size: "2048" }]);
		const { storageMediaReader } = await import("../media");
		await expect(storageMediaReader.size(ROW.gcs_object_key)).resolves.toBe(
			2048,
		);
	});

	it("stops the run as a failed read where the stream runs past the cap after a smaller reported size", async () => {
		getMetadata.mockResolvedValue([{ size: "16" }]);
		createReadStream.mockImplementation(() =>
			Readable.from([Buffer.alloc(8), Buffer.alloc(30 * 1024 * 1024)]),
		);
		const { classifyFleetMedia, MediaReadError, storageMediaReader } =
			await import("../media");
		const error = await classifyFleetMedia([ROW], storageMediaReader).catch(
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(MediaReadError);
		expect((error as InstanceType<typeof MediaReadError>).assetId).toBe(ROW.id);
	});
});
