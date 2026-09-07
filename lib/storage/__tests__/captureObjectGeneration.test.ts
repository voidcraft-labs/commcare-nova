import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	fileMock,
	getSignedUrlMock,
	saveMock,
	copyMock,
	getMetadataMock,
	deleteMock,
} = vi.hoisted(() => ({
	fileMock: vi.fn(),
	getSignedUrlMock: vi.fn(),
	saveMock: vi.fn(),
	copyMock: vi.fn(),
	getMetadataMock: vi.fn(),
	deleteMock: vi.fn(),
}));

vi.mock("@google-cloud/storage", () => ({
	Storage: class {
		bucket() {
			return {
				file: fileMock,
				addLifecycleRule: vi.fn(),
				setCorsConfiguration: vi.fn(),
			};
		}
	},
}));

beforeEach(() => {
	vi.resetAllMocks();
	vi.stubEnv("NODE_ENV", "production");
	vi.stubEnv("NOVA_MEDIA_BUCKET", "capture-test");
	getSignedUrlMock.mockResolvedValue(["https://storage.test/upload"]);
	saveMock.mockResolvedValue(undefined);
	copyMock.mockResolvedValue(undefined);
	getMetadataMock.mockResolvedValue([
		{
			size: "17",
			generation: "destination-generation",
			crc32c: "checksum",
			contentType: "image/png",
		},
	]);
	deleteMock.mockResolvedValue(undefined);
	fileMock.mockImplementation((key: string, options?: unknown) => ({
		key,
		options,
		getSignedUrl: getSignedUrlMock,
		save: saveMock,
		copy: copyMock,
		getMetadata: getMetadataMock,
		delete: deleteMock,
	}));
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("capture object generation fencing", () => {
	it("signs an exact-size, create-only PUT and returns every required header", async () => {
		vi.spyOn(Date, "now").mockReturnValue(1_000_000);
		const { createSignedUploadUrl } = await import("../media");
		const result = await createSignedUploadUrl({
			gcsObjectKey: "captures-staged/project/attachment.png",
			contentType: "image/png",
			minBytes: 17,
			maxBytes: 17,
		});

		expect(getSignedUrlMock).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "write",
				version: "v4",
				expires: 1_300_000,
				contentType: "image/png",
				extensionHeaders: {
					"x-goog-content-length-range": "17,17",
					"x-goog-if-generation-match": "0",
				},
			}),
		);
		expect(result).toMatchObject({
			url: "https://storage.test/upload",
			expiresAtMs: 1_300_000,
		});
		expect(fileMock).toHaveBeenCalledWith(
			"captures-staged/project/attachment.png",
		);
		expect(result.requiredHeaders).toEqual({
			"x-goog-content-length-range": "17,17",
			"x-goog-if-generation-match": "0",
		});
	});

	it("uses generation-match zero for the dev surrogate's create-only save", async () => {
		const { uploadAssetBytes } = await import("../media");
		await uploadAssetBytes({
			gcsObjectKey: "captures-staged/project/attachment.png",
			bytes: Buffer.from("capture"),
			contentType: "image/png",
			ifAbsent: true,
		});

		expect(saveMock).toHaveBeenCalledWith(
			Buffer.from("capture"),
			expect.objectContaining({
				preconditionOpts: { ifGenerationMatch: 0 },
			}),
		);
	});

	it("pins the source generation and creates the durable destination once", async () => {
		const { copyAssetObjectIfAbsent } = await import("../media");
		await expect(
			copyAssetObjectIfAbsent({
				sourceGcsObjectKey: "captures-staged/project/attachment.png",
				sourceGeneration: "source-generation",
				destinationGcsObjectKey: "projects/project/captures/attachment.png",
				expectedSize: 17,
				expectedChecksum: "checksum",
				expectedContentType: "image/png",
			}),
		).resolves.toEqual({
			destinationGeneration: "destination-generation",
			replay: false,
		});

		expect(fileMock).toHaveBeenCalledWith(
			"captures-staged/project/attachment.png",
			{ generation: "source-generation" },
		);
		expect(copyMock).toHaveBeenCalledWith(
			expect.objectContaining({
				key: "projects/project/captures/attachment.png",
			}),
			{ preconditionOpts: { ifGenerationMatch: 0 } },
		);
	});

	it.each([404, "404", 412, "412"])(
		"accepts %s only after verifying the existing destination",
		async (code) => {
			copyMock.mockRejectedValue({ code });
			const { copyAssetObjectIfAbsent } = await import("../media");
			await expect(
				copyAssetObjectIfAbsent({
					sourceGcsObjectKey: "captures-staged/project/attachment.png",
					sourceGeneration: "source-generation",
					destinationGcsObjectKey: "projects/project/captures/attachment.png",
					expectedSize: 17,
					expectedChecksum: "checksum",
					expectedContentType: "image/png",
				}),
			).resolves.toEqual({
				destinationGeneration: "destination-generation",
				replay: true,
			});
			expect(getMetadataMock).toHaveBeenCalledOnce();
		},
	);

	it.each([404, 412, "copy succeeded"])(
		"refuses mismatched destination metadata after %s",
		async (code) => {
			if (code !== "copy succeeded") copyMock.mockRejectedValue({ code });
			const { copyAssetObjectIfAbsent } = await import("../media");
			const args = {
				sourceGcsObjectKey: "captures-staged/project/attachment.png",
				sourceGeneration: "source-generation",
				destinationGcsObjectKey: "projects/project/captures/attachment.png",
				expectedSize: 17,
				expectedChecksum: "checksum",
				expectedContentType: "image/png",
			};
			const mismatches = [
				{
					size: "18",
					generation: "other-generation",
					crc32c: "checksum",
					contentType: "image/png",
				},
				{
					size: "17",
					generation: "other-generation",
					crc32c: "other-checksum",
					contentType: "image/png",
				},
				{
					size: "17",
					generation: "other-generation",
					crc32c: "checksum",
					contentType: "application/octet-stream",
				},
				{
					size: "17",
					generation: undefined,
					crc32c: "checksum",
					contentType: "image/png",
				},
			];
			for (const metadata of mismatches) {
				getMetadataMock.mockResolvedValueOnce([metadata]);
				await expect(copyAssetObjectIfAbsent(args)).rejects.toThrow(
					/does not match the staged source generation/,
				);
			}
		},
	);

	it("propagates unrelated copy failures without adopting an existing object", async () => {
		const failure = Object.assign(new Error("access denied"), { code: 403 });
		copyMock.mockRejectedValue(failure);
		const { copyAssetObjectIfAbsent } = await import("../media");
		await expect(
			copyAssetObjectIfAbsent({
				sourceGcsObjectKey: "staged",
				sourceGeneration: "12",
				destinationGcsObjectKey: "durable",
				expectedSize: 17,
				expectedChecksum: "checksum",
				expectedContentType: "image/png",
			}),
		).rejects.toBe(failure);
		expect(getMetadataMock).not.toHaveBeenCalled();
	});

	it("deletes only the confirmed source generation", async () => {
		const { deleteAssetGeneration } = await import("../media");
		await deleteAssetGeneration(
			"captures-staged/project/attachment.png",
			"source-generation",
		);

		expect(fileMock).toHaveBeenCalledWith(
			"captures-staged/project/attachment.png",
			{ generation: "source-generation" },
		);
		expect(deleteMock).toHaveBeenCalledWith({ ignoreNotFound: true });
	});
});
