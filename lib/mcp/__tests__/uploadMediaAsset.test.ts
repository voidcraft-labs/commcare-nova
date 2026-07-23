/**
 * Behavioral tests for the MCP-only `upload_media_asset` tool.
 *
 * The tool decodes inline base64, runs the shared validation pipeline,
 * dedups, and stores. The pipeline + storage + DB calls are mocked so the
 * test exercises the tool's branching, not the real GCS / sharp /
 * music-metadata stack. Coverage:
 *   1. Happy path — validate → store → confirm → returns asset id.
 *   2. Dedup — a matching `ready` asset returns its id, no store.
 *   3. Validation rejection — `invalid_input` envelope with the message.
 *   4. Empty/invalid base64 — `invalid_input` envelope.
 *   5. Oversized inline payload — rejected before Buffer allocation.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ValidationResult } from "@/lib/media/validate";
import { registerUploadMediaAsset } from "../tools/uploadMediaAsset";
import type { ToolContext } from "../types";
import { makeFakeServer } from "./fakeServer";

// `vi.hoisted` lifts the mock fns above the hoisted `vi.mock` factories so
// the factories can close over them without a "cannot access before
// initialization" hoist error.
const {
	validateMediaBytes,
	findReadyAssetByProjectAndHash,
	createPendingAsset,
	confirmAssetReady,
	uploadAssetBytes,
	ensurePersonalProject,
	withMediaObjectKeyLock,
} = vi.hoisted(() => ({
	validateMediaBytes: vi.fn(),
	findReadyAssetByProjectAndHash: vi.fn(),
	createPendingAsset: vi.fn(),
	confirmAssetReady: vi.fn(() => Promise.resolve()),
	uploadAssetBytes: vi.fn(() => Promise.resolve()),
	// The MCP upload is app-less — it lands in the caller's personal Project.
	ensurePersonalProject: vi.fn(() => Promise.resolve("project-1")),
	withMediaObjectKeyLock: vi.fn(
		async (_key: string, body: (lockedDb: unknown) => Promise<unknown>) =>
			body({ pinned: true }),
	),
}));

vi.mock("@/lib/media/validate", () => ({
	validateMediaBytes,
}));
vi.mock("@/lib/db/mediaAssets", () => ({
	findReadyAssetByProjectAndHash,
	createPendingAsset,
	confirmAssetReady,
}));
vi.mock("@/lib/storage/media", () => ({
	uploadAssetBytes,
}));
vi.mock("@/lib/auth/provisionProject", () => ({
	ensurePersonalProject,
}));
vi.mock("@/lib/storage/mediaObjectKeyLock", () => ({
	withMediaObjectKeyLock,
}));

const toolCtx: ToolContext = {
	userId: "user-1",
	scopes: [],
	authKind: "oauth",
};

/** A successful image-validation result. */
const validatedImage: ValidationResult = {
	ok: true,
	validated: {
		contentHash: "deadbeef",
		mimeType: "image/png",
		extension: ".png",
		sizeBytes: 5,
		kind: "image",
		dimensions: { width: 10, height: 10 },
	},
};

beforeEach(() => {
	vi.clearAllMocks();
});

/** Parse the JSON content payload off a tool result envelope. */
function parsePayload(out: unknown): Record<string, unknown> {
	const result = out as { content: { text: string }[]; isError?: boolean };
	return JSON.parse(result.content[0]?.text ?? "{}");
}

describe("uploadMediaAsset", () => {
	it("validates, stores, and returns a fresh asset id", async () => {
		validateMediaBytes.mockResolvedValue(validatedImage);
		findReadyAssetByProjectAndHash.mockResolvedValue(null);
		createPendingAsset.mockResolvedValue({
			assetId: "new-asset-id",
			gcsObjectKey: "projects/project-1/deadbeef.png",
		});

		const { server, capture } = makeFakeServer();
		registerUploadMediaAsset(server, toolCtx);
		const out = await capture()({
			filename: "logo.png",
			mime_type: "image/png",
			data_base64: "aGVsbG8=",
		});

		const payload = parsePayload(out);
		expect(payload.asset_id).toBe("new-asset-id");
		expect(payload.kind).toBe("image");
		expect(payload.deduplicated).toBe(false);
		expect(uploadAssetBytes).toHaveBeenCalledOnce();
		expect(withMediaObjectKeyLock).toHaveBeenCalledWith(
			"projects/project-1/deadbeef.png",
			expect.any(Function),
		);
		expect(confirmAssetReady).toHaveBeenCalledWith(
			{
				assetId: "new-asset-id",
				dimensions: { width: 10, height: 10 },
			},
			expect.anything(),
		);
	});

	it("returns the existing asset on a content-hash dedup hit", async () => {
		validateMediaBytes.mockResolvedValue(validatedImage);
		findReadyAssetByProjectAndHash.mockResolvedValue({ id: "existing-id" });

		const { server, capture } = makeFakeServer();
		registerUploadMediaAsset(server, toolCtx);
		const out = await capture()({
			filename: "logo.png",
			mime_type: "image/png",
			data_base64: "aGVsbG8=",
		});

		const payload = parsePayload(out);
		expect(payload.asset_id).toBe("existing-id");
		expect(payload.deduplicated).toBe(true);
		expect(uploadAssetBytes).not.toHaveBeenCalled();
		expect(createPendingAsset).not.toHaveBeenCalled();
	});

	it("surfaces a validation rejection as invalid_input", async () => {
		validateMediaBytes.mockResolvedValue({
			ok: false,
			reason: "magic-bytes-sniff-failed",
			message: "Couldn't identify the format of `x.png`.",
		} satisfies ValidationResult);

		const { server, capture } = makeFakeServer();
		registerUploadMediaAsset(server, toolCtx);
		const out = (await capture()({
			filename: "x.png",
			mime_type: "image/png",
			data_base64: "aGVsbG8=",
		})) as { isError?: boolean };

		expect(out.isError).toBe(true);
		const payload = parsePayload(out);
		expect(payload.error_type).toBe("invalid_input");
		expect(payload.message).toContain("Couldn't identify the format");
		expect(uploadAssetBytes).not.toHaveBeenCalled();
	});

	it("rejects an undecodable base64 payload as invalid_input", async () => {
		const { server, capture } = makeFakeServer();
		registerUploadMediaAsset(server, toolCtx);
		const out = (await capture()({
			filename: "x.png",
			mime_type: "image/png",
			// Characters Buffer.from(.., "base64") drops to zero bytes.
			data_base64: "!!!!",
		})) as { isError?: boolean };

		expect(out.isError).toBe(true);
		const payload = parsePayload(out);
		expect(payload.error_type).toBe("invalid_input");
		expect(validateMediaBytes).not.toHaveBeenCalled();
	});

	it("rejects an oversized inline payload before decoding", async () => {
		const oversizedBase64 = {
			replace: vi.fn(() => ({ length: Number.MAX_SAFE_INTEGER })),
		} as unknown as string;

		const { server, capture } = makeFakeServer();
		registerUploadMediaAsset(server, toolCtx);
		const out = (await capture()({
			filename: "huge.mp4",
			mime_type: "video/mp4",
			data_base64: oversizedBase64,
		})) as { isError?: boolean };

		expect(out.isError).toBe(true);
		const payload = parsePayload(out);
		expect(payload.error_type).toBe("invalid_input");
		expect(String(payload.message)).toContain("too large");
		expect(validateMediaBytes).not.toHaveBeenCalled();
		expect(uploadAssetBytes).not.toHaveBeenCalled();
	});
});
