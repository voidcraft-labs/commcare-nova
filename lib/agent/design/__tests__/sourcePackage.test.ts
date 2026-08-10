/**
 * The source-package builder — offline, with fake resource seams: labeled
 * bounded projections, honest over-bound rejection, Project-scoped asset
 * resolution, and a digest that binds content (image bytes through their
 * content digest, never the base64 transport).
 */

import { describe, expect, it } from "vitest";
import {
	buildDesignSourcePackage,
	computeSourcePackageDigest,
	MAX_DOCUMENT_ATTACHMENTS,
	MAX_REQUEST_BLOCK_CHARS,
	type SourcePackageDeps,
	SourcePackageError,
	toPersistedSourcePackage,
} from "@/lib/agent/design/sourcePackage";
import type { NovaUIMessage } from "@/lib/chat/attachmentRefs";
import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import { asMediaAssetId } from "@/lib/domain/multimedia";

const SESSION_ID = "00000000-0000-4000-8000-000000000800";
const THREAD_ID = "00000000-0000-4000-8000-000000000801";
const DOC_ASSET = "00000000-0000-4000-8000-000000000810";
const IMG_ASSET = "00000000-0000-4000-8000-000000000811";

function userMessage(
	id: string,
	text: string,
	attachments: Array<{
		assetId: string;
		filename: string;
		kind: "pdf" | "image";
	}> = [],
): NovaUIMessage {
	return {
		id,
		role: "user",
		parts: [{ type: "text", text }],
		metadata: {
			attachments: attachments.map((a) => ({
				assetId: a.assetId,
				filename: a.filename,
				mimeType: a.kind === "pdf" ? "application/pdf" : "image/png",
				kind: a.kind,
			})),
		},
	} as NovaUIMessage;
}

function fakeAsset(id: string): MediaAssetRecord {
	return {
		id: asMediaAssetId(id),
		extract: { title: "Program spec", summary: "A CHW visit program." },
	} as unknown as MediaAssetRecord;
}

function fakeDeps(
	overrides: Partial<SourcePackageDeps> = {},
): SourcePackageDeps {
	return {
		loadAssets: async (ids) => ids.map((id) => fakeAsset(id)),
		readExtract: async () => ({
			text: "## Requirements\nRegister patients and record visits.",
			truncated: false,
		}),
		loadImage: async () => ({
			mediaType: "image/png",
			dataUrl: "data:image/png;base64,AAAA",
			bytesDigest: "f".repeat(64),
		}),
		...overrides,
	};
}

function baseArgs(messages: NovaUIMessage[]) {
	return {
		designSessionId: SESSION_ID,
		projectId: "proj-1",
		threadId: THREAD_ID,
		messages,
		deps: fakeDeps(),
	};
}

describe("buildDesignSourcePackage", () => {
	it("projects labeled blocks, extracts, and images, and seals the digest", async () => {
		const pkg = await buildDesignSourcePackage(
			baseArgs([
				userMessage("m1", "Build a CHW visit tracker.", [
					{ assetId: DOC_ASSET, filename: "spec.pdf", kind: "pdf" },
					{ assetId: IMG_ASSET, filename: "mockup.png", kind: "image" },
				]),
				{
					id: "a1",
					role: "assistant",
					parts: [{ type: "text", text: "Sounds good — a question first." }],
				} as NovaUIMessage,
				userMessage("m2", "Supervisors also review the visit queue."),
			]),
		);

		expect(pkg.request.blocks).toHaveLength(2);
		expect(pkg.request.blocks[0]?.ref).toEqual({
			kind: "message",
			threadId: THREAD_ID,
			messageId: "m1",
			partIndex: 0,
		});
		expect(pkg.attachments).toHaveLength(1);
		expect(pkg.attachments[0]?.title).toBe("Program spec");
		expect(pkg.images).toHaveLength(1);
		// The source index carries every projected source: two message blocks,
		// the document extract, and the image — each with its citable ref.
		expect(pkg.sources).toHaveLength(4);
		expect(pkg.sources.map((source) => source.ref)).toContainEqual({
			kind: "image",
			assetId: IMG_ASSET,
			bytesDigest: "f".repeat(64),
		});
		// Sealed digest recomputes.
		const { packageDigest, ...unsealed } = pkg;
		expect(computeSourcePackageDigest(unsealed)).toBe(packageDigest);

		const persisted = toPersistedSourcePackage(pkg);
		expect(persisted.imageCount).toBe(1);
		// The persisted index round-trips the image coordinate — the reference
		// persists, the bytes never do.
		expect(persisted.sources).toContainEqual({
			kind: "image",
			assetId: IMG_ASSET,
			bytesDigest: "f".repeat(64),
		});
		expect(JSON.stringify(persisted)).not.toContain("Register patients");
		expect(JSON.stringify(persisted)).not.toContain("base64");
	});

	it("the digest binds image CONTENT, not the base64 transport", async () => {
		const args = baseArgs([
			userMessage("m1", "Build it.", [
				{ assetId: IMG_ASSET, filename: "mockup.png", kind: "image" },
			]),
		]);
		const first = await buildDesignSourcePackage(args);
		const second = await buildDesignSourcePackage({
			...args,
			deps: fakeDeps({
				loadImage: async () => ({
					mediaType: "image/png",
					// Different transport bytes, same content digest.
					dataUrl: "data:image/png;base64,BBBB",
					bytesDigest: "f".repeat(64),
				}),
			}),
		});
		expect(second.packageDigest).toBe(first.packageDigest);
	});

	it("keeps an explicit build retry out of design evidence and the digest", async () => {
		const original = userMessage("m1", "Build it.");
		const first = await buildDesignSourcePackage(baseArgs([original]));
		const retried = await buildDesignSourcePackage(
			baseArgs([
				original,
				{
					id: "m2",
					role: "user",
					parts: [{ type: "text", text: "Try again" }],
					metadata: { designBuildRetry: true },
				} as NovaUIMessage,
			]),
		);

		expect(retried.request.blocks).toEqual(first.request.blocks);
		expect(retried.packageDigest).toBe(first.packageDigest);
	});

	it("clips an oversized message part and flags the truncation", async () => {
		const pkg = await buildDesignSourcePackage(
			baseArgs([userMessage("m1", "x".repeat(MAX_REQUEST_BLOCK_CHARS + 5))]),
		);
		expect(pkg.request.blocks[0]?.text).toHaveLength(MAX_REQUEST_BLOCK_CHARS);
		expect(pkg.request.blocks[0]?.truncated).toBe(true);
	});

	it("refuses a source with no user request text", async () => {
		await expect(
			buildDesignSourcePackage(
				baseArgs([
					{
						id: "a1",
						role: "assistant",
						parts: [{ type: "text", text: "Hello" }],
					} as NovaUIMessage,
				]),
			),
		).rejects.toThrow(SourcePackageError);
	});

	it("refuses an attachment that no longer resolves in the Project", async () => {
		await expect(
			buildDesignSourcePackage({
				...baseArgs([
					userMessage("m1", "Build it.", [
						{ assetId: DOC_ASSET, filename: "spec.pdf", kind: "pdf" },
					]),
				]),
				deps: fakeDeps({ loadAssets: async () => [] }),
			}),
		).rejects.toThrow(/no longer available in this Project/);
	});

	it("refuses more documents than the bound admits, honestly", async () => {
		const refs = Array.from(
			{ length: MAX_DOCUMENT_ATTACHMENTS + 1 },
			(_, i) => ({
				assetId: `00000000-0000-4000-8000-0000000009${i.toString(10).padStart(2, "0")}`,
				filename: `doc-${i}.pdf`,
				kind: "pdf" as const,
			}),
		);
		await expect(
			buildDesignSourcePackage(baseArgs([userMessage("m1", "Build.", refs)])),
		).rejects.toThrow(/bounded at/);
	});
});
