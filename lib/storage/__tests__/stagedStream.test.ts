/**
 * The staged object a file read from CommCare HQ past its kind's cap streams
 * into, and the reads by range the gate judges it through, against a bucket
 * client the test holds: the create-only precondition, the upload's own
 * timeout, a size the bucket reads back as other than the bytes written, the
 * delete a stopped write leaves, and ranges asked of exactly the generation
 * written, with HTTP's inclusive end.
 */

import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	fileMock,
	createWriteStreamMock,
	getMetadataMock,
	deleteMock,
	downloadMock,
	setMetadataMock,
} = vi.hoisted(() => ({
	fileMock: vi.fn(),
	createWriteStreamMock: vi.fn(),
	getMetadataMock: vi.fn(),
	deleteMock: vi.fn(),
	downloadMock: vi.fn(),
	setMetadataMock: vi.fn(),
}));

vi.mock("@google-cloud/storage", () => ({
	Storage: class {
		bucket() {
			return { file: fileMock };
		}
	},
}));

/** What the upload stream received, chunk by chunk. */
let received: Buffer[] = [];

beforeEach(() => {
	vi.resetAllMocks();
	vi.stubEnv("NOVA_MEDIA_BUCKET", "staged-test");
	received = [];
	createWriteStreamMock.mockImplementation(
		() =>
			new Writable({
				write(chunk: Buffer, _encoding, done) {
					received.push(Buffer.from(chunk));
					done();
				},
			}),
	);
	getMetadataMock.mockResolvedValue([
		{ size: "6", generation: "1700", crc32c: "crc" },
	]);
	deleteMock.mockResolvedValue(undefined);
	setMetadataMock.mockResolvedValue(undefined);
	fileMock.mockImplementation((key: string, options?: unknown) => ({
		key,
		options,
		createWriteStream: createWriteStreamMock,
		getMetadata: getMetadataMock,
		delete: deleteMock,
		download: downloadMock,
		setMetadata: setMetadataMock,
	}));
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("openStagedAssetWrite", () => {
	it("streams each chunk into a create-only upload with its own timeout and answers the generation", async () => {
		const { openStagedAssetWrite } = await import("../media");
		const write = openStagedAssetWrite({
			gcsObjectKey: "pending/project/streamed",
			contentType: "application/octet-stream",
			timeoutMs: 600_000,
		});
		await write.write(Buffer.from("abc"));
		await write.write(Buffer.from("def"));
		expect(await write.finish()).toEqual({
			gcsObjectKey: "pending/project/streamed",
			generation: "1700",
			checksum: "crc",
		});
		expect(Buffer.concat(received).toString()).toBe("abcdef");
		expect(createWriteStreamMock).toHaveBeenCalledWith({
			resumable: false,
			timeout: 600_000,
			contentType: "application/octet-stream",
			validation: "crc32c",
			preconditionOpts: { ifGenerationMatch: 0 },
		});
	});

	it("refuses an object the bucket reads back at another size than the bytes written", async () => {
		const { openStagedAssetWrite } = await import("../media");
		const write = openStagedAssetWrite({
			gcsObjectKey: "pending/project/streamed",
			contentType: "application/octet-stream",
			timeoutMs: 1_000,
		});
		await write.write(Buffer.from("abcde"));
		await expect(write.finish()).rejects.toThrow(
			/did not read back as the 5 bytes just written/,
		);
	});

	it("deletes what a stopped write left, and says why a failed upload failed", async () => {
		const { openStagedAssetWrite } = await import("../media");
		const stopped = openStagedAssetWrite({
			gcsObjectKey: "pending/project/stopped",
			contentType: "application/octet-stream",
			timeoutMs: 1_000,
		});
		await stopped.write(Buffer.from("abc"));
		await stopped.abort();
		expect(deleteMock).toHaveBeenCalledWith({ ignoreNotFound: true });

		createWriteStreamMock.mockImplementation(
			() =>
				new Writable({
					write(_chunk, _encoding, done) {
						done(new Error("The bucket refused the upload."));
					},
				}),
		);
		const failing = openStagedAssetWrite({
			gcsObjectKey: "pending/project/failing",
			contentType: "application/octet-stream",
			timeoutMs: 1_000,
		});
		await expect(
			(async () => {
				await failing.write(Buffer.from("abc"));
				return failing.finish();
			})(),
		).rejects.toThrow("The bucket refused the upload.");
		await failing.abort();
	});
});

describe("stagedObjectBytes", () => {
	it("reads exactly the generation staged, by inclusive ranges of whole blocks", async () => {
		const { STAGED_READ_BLOCK_BYTES, stagedObjectBytes } = await import(
			"../media"
		);
		const size = STAGED_READ_BLOCK_BYTES + 10;
		const file = Buffer.alloc(size);
		for (let at = 0; at < size; at++) file[at] = at % 251;
		downloadMock.mockImplementation(
			async ({ start, end }: { start: number; end: number }) => [
				file.subarray(start, end + 1),
			],
		);
		const source = stagedObjectBytes(
			{
				gcsObjectKey: "pending/project/streamed",
				generation: "1700",
				checksum: "crc",
			},
			size,
		);
		/* A read across the block boundary asks for both blocks, each once. */
		const across = await source.read(STAGED_READ_BLOCK_BYTES - 2, 6);
		expect([...across]).toEqual([
			...file.subarray(
				STAGED_READ_BLOCK_BYTES - 2,
				STAGED_READ_BLOCK_BYTES + 4,
			),
		]);
		await source.read(0, 4);
		expect(fileMock).toHaveBeenCalledWith("pending/project/streamed", {
			generation: "1700",
		});
		expect(downloadMock.mock.calls).toEqual([
			[{ start: 0, end: STAGED_READ_BLOCK_BYTES - 1, validation: false }],
			[{ start: STAGED_READ_BLOCK_BYTES, end: size - 1, validation: false }],
		]);
		/* Past the end: nothing, and no request. */
		expect((await source.read(size, 4)).byteLength).toBe(0);
		expect(downloadMock).toHaveBeenCalledTimes(2);
	});

	it("refuses a range the bucket answers short", async () => {
		const { stagedObjectBytes } = await import("../media");
		downloadMock.mockResolvedValue([Buffer.alloc(3)]);
		const source = stagedObjectBytes(
			{
				gcsObjectKey: "pending/project/gone",
				generation: "9",
				checksum: "crc",
			},
			100,
		);
		await expect(source.read(0, 10)).rejects.toThrow(
			/A read of 100 bytes of the staged media object/,
		);
	});
});

describe("setStagedContentType", () => {
	it("types exactly the generation staged", async () => {
		const { setStagedContentType } = await import("../media");
		await setStagedContentType(
			{
				gcsObjectKey: "pending/project/streamed",
				generation: "1700",
				checksum: "crc",
			},
			"audio/mp4",
		);
		expect(fileMock).toHaveBeenCalledWith("pending/project/streamed", {
			generation: "1700",
		});
		expect(setMetadataMock).toHaveBeenCalledWith(
			{ contentType: "audio/mp4" },
			{ ifGenerationMatch: 1700 },
		);
	});
});
