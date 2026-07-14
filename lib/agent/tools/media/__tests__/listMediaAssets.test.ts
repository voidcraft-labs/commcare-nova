/**
 * Behavioral tests for `list_media_assets`.
 *
 * The tool delegates to `listReadyAssetsForProject` (mocked) and projects
 * each row through `toWireMediaAsset`. Coverage:
 *   1. Returns the projected wire assets + nextCursor.
 *   2. Threads the app's Project and the optional kind/cursor.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import { listMediaAssetsTool } from "../listMediaAssets";
import { makeMediaFixture } from "./fixtures";

// `vi.hoisted` lifts the mock fn above the hoisted `vi.mock` factory so the
// factory can close over it without tripping the "cannot access before
// initialization" hoist error.
const { listReadyAssetsForProject } = vi.hoisted(() => ({
	listReadyAssetsForProject: vi.fn(),
}));

vi.mock("@/lib/db/apps", () => ({
	loadAppProjectId: vi.fn(() => Promise.resolve("project-1")),
}));
vi.mock("@/lib/db/mediaAssets", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/db/mediaAssets")>();
	return {
		...actual,
		listReadyAssetsForProject,
	};
});

beforeEach(() => {
	vi.clearAllMocks();
});

/** A minimal `ready` asset record for the mock to return. */
function readyRecord(id: string): MediaAssetRecord {
	return {
		id,
		owner: "user-1",
		project_id: "project-1",
		contentHash: "abc",
		mimeType: "image/png",
		kind: "image",
		extension: ".png",
		sizeBytes: 100,
		originalFilename: `${id}.png`,
		displayName: `${id}.png`,
		status: "ready",
		gcsObjectKey: `projects/project-1/abc.png`,
		// `created_at` is a `Date` (Postgres timestamptz); the wire projector calls
		// `.toISOString()` on it.
		created_at: new Date("2026-01-01T00:00:00Z"),
	} as MediaAssetRecord;
}

describe("listMediaAssets", () => {
	it("returns projected wire assets and the next cursor", async () => {
		const { doc, ctx } = makeMediaFixture();
		listReadyAssetsForProject.mockResolvedValue({
			assets: [readyRecord("a1"), readyRecord("a2")],
			nextCursor: "cursor-2",
		});

		const result = await listMediaAssetsTool.execute({}, ctx, doc);

		expect(result.kind).toBe("read");
		expect(result.data.assets).toHaveLength(2);
		expect(result.data.assets[0].id).toBe("a1");
		// Wire shape drops the server-only fields `owner` + `gcsObjectKey` (the
		// reverse index lives in its own table now — never on the record).
		expect(result.data.assets[0]).not.toHaveProperty("owner");
		expect(result.data.assets[0]).not.toHaveProperty("gcsObjectKey");
		expect(result.data.nextCursor).toBe("cursor-2");
	});

	it("projects a document's extract title + summary to the wire but keeps failureReason and model server-side", async () => {
		const { doc, ctx } = makeMediaFixture();
		// A document record whose extract carries the human title + summary (both
		// wanted on the wire — the library labels the asset, the preview header
		// shows them) alongside the internal failureReason/model (must NOT leak).
		const record = {
			...readyRecord("d1"),
			kind: "pdf",
			mimeType: "application/pdf",
			extension: ".pdf",
			originalFilename: "anc.pdf",
			displayName: "anc.pdf",
			extract: {
				status: "ready",
				version: 3,
				model: "openai/gpt-5.6-luna",
				truncated: false,
				charCount: 1234,
				// `extractedAt` is epoch ms (jsonb carries no Date).
				extractedAt: Date.parse("2026-01-02T00:00:00Z"),
				failureReason: "internal detail that must stay server-side",
				title: "ANC Program — Data Collection Requirements",
				summary: "A few-sentence précis the preview header shows.",
			},
		} as unknown as MediaAssetRecord;
		listReadyAssetsForProject.mockResolvedValue({
			assets: [record],
			nextCursor: null,
		});

		const result = await listMediaAssetsTool.execute({}, ctx, doc);
		const wire = result.data.assets[0];

		expect(wire.extract?.title).toBe(
			"ANC Program — Data Collection Requirements",
		);
		expect(wire.extract?.summary).toBe(
			"A few-sentence précis the preview header shows.",
		);
		expect(wire.extract).not.toHaveProperty("failureReason");
		expect(wire.extract).not.toHaveProperty("model");
	});

	it("passes the Project and the kind/cursor filters through", async () => {
		const { doc, ctx } = makeMediaFixture();
		listReadyAssetsForProject.mockResolvedValue({
			assets: [],
			nextCursor: null,
		});

		await listMediaAssetsTool.execute(
			{ kind: "audio", cursor: "page-1" },
			ctx,
			doc,
		);

		expect(listReadyAssetsForProject).toHaveBeenCalledWith("project-1", {
			// The tool's single-kind input is wrapped into the DB layer's kind SET.
			kinds: ["audio"],
			cursor: "page-1",
		});
	});

	it("omits kind/cursor when not supplied", async () => {
		const { doc, ctx } = makeMediaFixture();
		listReadyAssetsForProject.mockResolvedValue({
			assets: [],
			nextCursor: null,
		});

		await listMediaAssetsTool.execute({}, ctx, doc);

		expect(listReadyAssetsForProject).toHaveBeenCalledWith("project-1", {});
	});
});
