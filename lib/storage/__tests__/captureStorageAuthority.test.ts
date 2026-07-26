import { beforeEach, describe, expect, it, vi } from "vitest";
import { STAGED_CAPTURE_PREFIX } from "@/lib/domain/captureFormats";

const expectedBytes = Buffer.from("nova-capture-storage-authority-v1", "utf8");
const sourceGeneration = "4102";
const destinationGeneration = "4103";
const checksum = "cHJvYmUtY3Jj";

const save = vi.fn();
const getMetadata = vi.fn();
const download = vi.fn();
const copy = vi.fn();
const deleteObject = vi.fn();
const file = vi.fn(
	(key: string, options?: { readonly generation?: string }) => {
		const handle = {
			key,
			generation: options?.generation,
			save: (...args: unknown[]) => save(key, ...args),
			getMetadata: () => getMetadata(key, options?.generation),
			download: () => download(key, options?.generation),
			copy: (destination: { readonly key: string }, copyOptions: unknown) =>
				copy(key, options?.generation, destination.key, copyOptions),
			delete: (deleteOptions: unknown) =>
				deleteObject(key, options?.generation, deleteOptions),
		};
		return handle;
	},
);

vi.mock("@google-cloud/storage", () => ({
	Storage: class {
		bucket() {
			return { file };
		}
	},
}));

function isSourceKey(key: string): boolean {
	return key.startsWith(STAGED_CAPTURE_PREFIX);
}

describe("capture storage authority probe", () => {
	beforeEach(() => {
		vi.resetModules();
		save.mockReset().mockResolvedValue(undefined);
		getMetadata.mockReset().mockImplementation((key: string) =>
			Promise.resolve([
				{
					generation: isSourceKey(key)
						? sourceGeneration
						: destinationGeneration,
					size: String(expectedBytes.byteLength),
					crc32c: checksum,
					contentType: "application/octet-stream",
				},
			]),
		);
		download
			.mockReset()
			.mockImplementation(() => Promise.resolve([expectedBytes]));
		copy.mockReset().mockResolvedValue(undefined);
		deleteObject.mockReset().mockResolvedValue(undefined);
		file.mockClear();
		process.env.NOVA_MEDIA_BUCKET = "test-bucket";
	});

	it("proves create-only staged-to-durable copy and cleans up both exact generations", async () => {
		const { probeCaptureStorageAuthority } = await import("../media");
		await probeCaptureStorageAuthority();

		const sourceKey = file.mock.calls
			.map(([key]) => key)
			.find((key) => isSourceKey(key));
		const destinationKey = file.mock.calls
			.map(([key]) => key)
			.find((key) => key.startsWith("projects/"));
		expect(sourceKey).toMatch(
			new RegExp(
				`^${STAGED_CAPTURE_PREFIX}_health-[0-9a-f-]+/[0-9a-f-]+\\.probe$`,
			),
		);
		expect(destinationKey).toMatch(
			/^projects\/_health-[0-9a-f-]+\/captures\/[0-9a-f-]+\.probe$/,
		);
		expect(save).toHaveBeenCalledWith(
			sourceKey,
			expectedBytes,
			expect.objectContaining({
				resumable: false,
				contentType: "application/octet-stream",
				preconditionOpts: { ifGenerationMatch: 0 },
			}),
		);
		expect(copy).toHaveBeenCalledWith(
			sourceKey,
			sourceGeneration,
			destinationKey,
			{ preconditionOpts: { ifGenerationMatch: 0 } },
		);
		expect(download).toHaveBeenCalledWith(sourceKey, sourceGeneration);
		expect(download).toHaveBeenCalledWith(
			destinationKey,
			destinationGeneration,
		);
		expect(deleteObject).toHaveBeenCalledWith(
			destinationKey,
			destinationGeneration,
			{ ignoreNotFound: true },
		);
		expect(deleteObject).toHaveBeenCalledWith(sourceKey, sourceGeneration, {
			ignoreNotFound: true,
		});
	});

	it("fails closed when durable bytes differ but still deletes both exact generations", async () => {
		download.mockImplementation((key: string) =>
			Promise.resolve([
				key.startsWith("projects/")
					? Buffer.from("wrong", "utf8")
					: expectedBytes,
			]),
		);
		const { probeCaptureStorageAuthority } = await import("../media");

		await expect(probeCaptureStorageAuthority()).rejects.toThrow(
			"did not read back the durable bytes",
		);
		expect(deleteObject).toHaveBeenCalledTimes(2);
	});

	it("resolves and deletes the durable generation after an ambiguous copy failure", async () => {
		copy.mockRejectedValueOnce(new Error("copy response lost"));
		const { probeCaptureStorageAuthority } = await import("../media");

		await expect(probeCaptureStorageAuthority()).rejects.toThrow(
			"copy response lost",
		);
		const destinationDelete = deleteObject.mock.calls.find(
			([key]) => typeof key === "string" && key.startsWith("projects/"),
		);
		expect(destinationDelete).toEqual([
			expect.stringMatching(/^projects\//),
			destinationGeneration,
			{ ignoreNotFound: true },
		]);
		expect(deleteObject).toHaveBeenCalledTimes(2);
	});

	it("surfaces the operation failure and every exact-generation cleanup failure", async () => {
		download.mockImplementation((key: string) =>
			key.startsWith("projects/")
				? Promise.reject(new Error("durable read denied"))
				: Promise.resolve([expectedBytes]),
		);
		deleteObject.mockRejectedValue(new Error("delete denied"));
		const { probeCaptureStorageAuthority } = await import("../media");

		const failure = await probeCaptureStorageAuthority().catch(
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(AggregateError);
		expect((failure as AggregateError).errors).toHaveLength(3);
	});
});
