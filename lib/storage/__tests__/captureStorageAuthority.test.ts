import { beforeEach, describe, expect, it, vi } from "vitest";
import { STAGED_CAPTURE_PREFIX } from "@/lib/domain/captureFormats";

const save = vi.fn();
const getMetadata = vi.fn();
const download = vi.fn();
const deleteObject = vi.fn();
const file = vi.fn(
	(_key: string, options?: { readonly generation?: string }) => ({
		save,
		getMetadata,
		download: options?.generation === undefined ? vi.fn() : download,
		delete: options?.generation === undefined ? vi.fn() : deleteObject,
	}),
);

vi.mock("@google-cloud/storage", () => ({
	Storage: class {
		bucket() {
			return { file };
		}
	},
}));

describe("capture storage authority probe", () => {
	beforeEach(() => {
		vi.resetModules();
		save.mockReset().mockResolvedValue(undefined);
		getMetadata.mockReset().mockResolvedValue([{ generation: "4102" }]);
		download
			.mockReset()
			.mockResolvedValue([
				Buffer.from("nova-capture-storage-authority-v1", "utf8"),
			]);
		deleteObject.mockReset().mockResolvedValue(undefined);
		file.mockClear();
		process.env.NOVA_MEDIA_BUCKET = "test-bucket";
	});

	it("creates, reads, and deletes one exact generation below the staged lifecycle prefix", async () => {
		const { probeCaptureStorageAuthority } = await import("../media");
		await probeCaptureStorageAuthority();

		const key = file.mock.calls[0]?.[0];
		expect(key).toMatch(
			new RegExp(`^${STAGED_CAPTURE_PREFIX}_health/[0-9a-f-]+\\.probe$`),
		);
		expect(save).toHaveBeenCalledWith(
			Buffer.from("nova-capture-storage-authority-v1", "utf8"),
			expect.objectContaining({
				resumable: false,
				preconditionOpts: { ifGenerationMatch: 0 },
			}),
		);
		expect(file).toHaveBeenCalledWith(key, { generation: "4102" });
		expect(download).toHaveBeenCalledOnce();
		expect(deleteObject).toHaveBeenCalledWith({ ignoreNotFound: false });
	});

	it("fails closed when the read bytes differ but still deletes the exact generation", async () => {
		download.mockResolvedValueOnce([Buffer.from("wrong", "utf8")]);
		const { probeCaptureStorageAuthority } = await import("../media");

		await expect(probeCaptureStorageAuthority()).rejects.toThrow(
			"did not read back the bytes",
		);
		expect(deleteObject).toHaveBeenCalledOnce();
	});

	it("surfaces both a storage failure and an exact-delete failure", async () => {
		download.mockRejectedValueOnce(new Error("read denied"));
		deleteObject.mockRejectedValueOnce(new Error("delete denied"));
		const { probeCaptureStorageAuthority } = await import("../media");

		await expect(probeCaptureStorageAuthority()).rejects.toBeInstanceOf(
			AggregateError,
		);
	});
});
