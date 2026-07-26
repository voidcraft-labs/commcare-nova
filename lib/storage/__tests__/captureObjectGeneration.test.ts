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
	vi.resetModules();
	vi.clearAllMocks();
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
});

describe("capture object generation fencing", () => {
	it("signs an exact-size, create-only PUT and returns every required header", async () => {
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
				contentType: "image/png",
				extensionHeaders: {
					"x-goog-content-length-range": "17,17",
					"x-goog-if-generation-match": "0",
				},
			}),
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
			expect.any(Buffer),
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

	it("accepts 412 only when the existing destination metadata is identical", async () => {
		copyMock.mockRejectedValue({ code: 412 });
		const { copyAssetObjectIfAbsent } = await import("../media");
		const args = {
			sourceGcsObjectKey: "captures-staged/project/attachment.png",
			sourceGeneration: "source-generation",
			destinationGcsObjectKey: "projects/project/captures/attachment.png",
			expectedSize: 17,
			expectedChecksum: "checksum",
			expectedContentType: "image/png",
		};
		await expect(copyAssetObjectIfAbsent(args)).resolves.toEqual({
			destinationGeneration: "destination-generation",
			replay: true,
		});

		getMetadataMock.mockResolvedValueOnce([
			{
				size: "18",
				generation: "other-generation",
				crc32c: "other-checksum",
				contentType: "image/png",
			},
		]);
		await expect(copyAssetObjectIfAbsent(args)).rejects.toThrow(
			/does not match the staged source generation/,
		);
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
