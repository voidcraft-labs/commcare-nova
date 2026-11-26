import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { vi } from "vitest";
import {
	downloadAssetBytes,
	getStoredObjectMetadata,
	streamAsset,
} from "@/lib/storage/media";

/** Serve the same Project objects to both the download and generation-pinned streaming paths. */
export function servePublishImages(project: string, ...files: Buffer[]): void {
	const objects = new Map<string, Buffer>(
		files.map((bytes) => {
			const hash = createHash("sha256").update(bytes).digest("hex");
			return [`projects/${project}/${hash}.png`, bytes] as const;
		}),
	);
	const read = (key: string) => {
		const bytes = objects.get(key);
		if (!bytes) throw new Error("The requested Project object does not exist.");
		return bytes;
	};
	vi.mocked(downloadAssetBytes).mockImplementation(async (key, limit) => {
		const bytes = read(key);
		if (bytes.length > limit)
			throw new Error("The requested image exceeds the read limit.");
		return bytes;
	});
	vi.mocked(getStoredObjectMetadata).mockImplementation(async (key) => {
		const bytes = objects.get(key);
		return bytes
			? {
					contentType: "image/png",
					generation: "1",
					size: bytes.length,
					checksum: "fixture",
				}
			: null;
	});
	vi.mocked(streamAsset).mockImplementation((key, generation) => {
		if (generation !== "1")
			throw new Error("The requested object generation does not exist.");
		return Readable.from([read(key)]);
	});
}
