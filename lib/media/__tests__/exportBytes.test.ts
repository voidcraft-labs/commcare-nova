import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { expect, it, vi } from "vitest";
import { getStoredObjectMetadata, streamAsset } from "@/lib/storage/media";
import { projectMediaByteSource } from "../exportBytes";

vi.mock("@/lib/storage/media", () => ({
	getStoredObjectMetadata: vi.fn(),
	streamAsset: vi.fn(),
}));

it("reopens the generation that passed preflight even if the current Project object changes", async () => {
	const original = Buffer.from("one"),
		changed = Buffer.from("two"),
		key = "projects/a/file.png";
	let generation = "17";
	vi.mocked(getStoredObjectMetadata).mockImplementation(async () => ({
		size: 3,
		generation,
		checksum: "crc32c",
		contentType: "image/png",
	}));
	vi.mocked(streamAsset).mockImplementation((path, requested) => {
		expect(path).toBe(key);
		if (requested === "17") return Readable.from([original]);
		if (requested === "18") return Readable.from([changed]);
		throw new Error("The Project object generation was not bound");
	});
	const hash = createHash("sha256").update(original).digest("hex");
	const prepared = projectMediaByteSource(key, 3, hash);
	expect(await buffer(prepared.open())).toEqual(original);
	generation = "18";
	expect(await buffer(prepared.open())).toEqual(original);
	const separate = projectMediaByteSource(key, 3, hash);
	await expect(buffer(separate.open())).rejects.toThrow(
		"does not match its Project record",
	);
	expect(vi.mocked(streamAsset).mock.calls).toEqual([
		[key, "17"],
		[key, "17"],
		[key, "18"],
	]);
});
