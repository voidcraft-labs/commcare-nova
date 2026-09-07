/** Attachment-reference projection. Persistence/storage replies are controlled;
 * the sibling extraction-store Postgres suite owns claims and publication. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import {
	type AttachmentRef,
	attachmentRefSchema,
	type NovaUIMessage,
} from "@/lib/chat/attachmentRefs";
import { loadAssetsByIds, type MediaAssetRecord } from "@/lib/db/mediaAssets";
import { EXTRACTOR_VERSION } from "@/lib/domain/multimedia";
import { downloadAssetBytes } from "@/lib/storage/media";
import type { AttachmentCondenser } from "../documentExtraction";
import { ensureStoredExtract } from "../documentExtractionStore";
import {
	countDocumentsNeedingRead,
	resolveAttachments,
} from "../resolveAttachments";

vi.mock("@/lib/db/mediaAssets", () => ({ loadAssetsByIds: vi.fn() }));
vi.mock("@/lib/storage/media", () => ({ downloadAssetBytes: vi.fn() }));
vi.mock("../documentExtractionStore", () => ({ ensureStoredExtract: vi.fn() }));

const condenser: AttachmentCondenser = {
	async extractDocumentStructured() {
		throw new Error("The resolver delegates model work to the store");
	},
};
const DOC = testMediaAssetId("doc-1");
const IMAGE = testMediaAssetId("image-1");
function asset(over: Partial<MediaAssetRecord> = {}): MediaAssetRecord {
	return {
		id: DOC,
		owner: "uploader",
		project_id: "shared-project",
		contentHash: "a".repeat(64),
		mimeType: "text/markdown",
		extension: ".md",
		sizeBytes: 100,
		kind: "text",
		gcsObjectKey: "projects/shared-project/aaaa.md",
		originalFilename: "spec.md",
		status: "ready",
		created_at: new Date(0),
		...over,
	};
}
function ref(over: Partial<AttachmentRef> = {}): AttachmentRef {
	return attachmentRefSchema.parse({
		assetId: DOC,
		filename: "spec.md",
		kind: "text",
		mimeType: "text/markdown",
		...over,
	});
}
function userMsg(id: string, ...refs: AttachmentRef[]): NovaUIMessage {
	return {
		id,
		role: "user",
		parts: [{ type: "text", text: "Build this workflow" }],
		metadata: { attachments: refs },
	};
}
beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(loadAssetsByIds).mockResolvedValue([asset()]);
	vi.mocked(ensureStoredExtract).mockResolvedValue({
		status: "ready",
		text: "EXTRACT",
		version: EXTRACTOR_VERSION,
		truncated: false,
		charCount: 7,
	});
	vi.mocked(downloadAssetBytes).mockResolvedValue(Buffer.from([0, 127, 255]));
});

describe("resolveAttachments", () => {
	it("projects all user turns in order, deduplicates work, and preserves the source transcript", async () => {
		const img = asset({
			id: IMAGE,
			kind: "image",
			mimeType: "image/png",
			extension: ".png",
			originalFilename: "diagram.png",
			gcsObjectKey: "projects/shared-project/image.png",
		});
		vi.mocked(loadAssetsByIds).mockResolvedValue([img, asset()]);
		const messages = [
			userMsg(
				"first",
				ref(),
				ref({
					assetId: IMAGE,
					kind: "image",
					filename: "diagram.png",
					mimeType: "image/png",
				}),
			),
			userMsg("second", ref()),
		];
		const before = JSON.stringify(messages);
		const resolved = await resolveAttachments(
			messages,
			"shared-project",
			condenser,
		);
		expect(JSON.stringify(messages)).toBe(before);
		expect(resolved).not.toBe(messages);
		expect(resolved[0]).not.toBe(messages[0]);
		expect(resolved[0].parts).toEqual([
			messages[0].parts[0],
			{ type: "text", text: "<<Attachment: spec.md>>\nEXTRACT" },
			{
				type: "file",
				mediaType: "image/png",
				url: "data:image/png;base64,AH//",
				filename: "diagram.png",
			},
		]);
		expect(resolved[1].parts).toEqual([
			messages[1].parts[0],
			resolved[0].parts[1],
		]);
		expect(loadAssetsByIds).toHaveBeenCalledExactlyOnceWith(
			[DOC, IMAGE],
			"shared-project",
		);
		expect(ensureStoredExtract).toHaveBeenCalledOnce();
		expect(downloadAssetBytes).toHaveBeenCalledOnce();
	});

	it.each(["text", "pdf", "docx", "xlsx"] as const)(
		"uses authoritative %s asset kind and delegates extraction with wait/progress",
		async (kind) => {
			const formats = {
				text: ["text/markdown", ".md"],
				pdf: ["application/pdf", ".pdf"],
				docx: [
					"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
					".docx",
				],
				xlsx: [
					"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
					".xlsx",
				],
			} as const;
			const [mimeType, extension] = formats[kind];
			const record = asset({
				kind,
				mimeType,
				extension,
				originalFilename: `spec${extension}`,
			});
			vi.mocked(loadAssetsByIds).mockResolvedValue([record]);
			const progress = vi.fn();
			// Display-only metadata disagrees; persisted asset kind controls resolution.
			const [resolved] = await resolveAttachments(
				[userMsg("u", ref({ kind: "image", mimeType: "image/png" }))],
				"shared-project",
				condenser,
				progress,
			);
			expect(resolved.parts.at(-1)).toEqual({
				type: "text",
				text: "<<Attachment: spec.md>>\nEXTRACT",
			});
			expect(ensureStoredExtract).toHaveBeenCalledExactlyOnceWith({
				asset: record,
				documentKind: kind,
				condenser,
				onInflight: "wait",
				onProgress: progress,
			});
			expect(downloadAssetBytes).not.toHaveBeenCalled();
		},
	);

	it.each(["absent", "pending"] as const)(
		"keeps a placeholder for an %s asset without reading bytes",
		async (state) => {
			vi.mocked(loadAssetsByIds).mockResolvedValue(
				state === "absent" ? [] : [asset({ status: "pending" })],
			);
			const [resolved] = await resolveAttachments(
				[userMsg("u", ref())],
				"shared-project",
				condenser,
			);
			expect(resolved.parts).toHaveLength(2);
			expect(resolved.parts.at(-1)).toMatchObject({
				type: "text",
				text: expect.stringContaining("spec.md"),
			});
			expect(ensureStoredExtract).not.toHaveBeenCalled();
			expect(downloadAssetBytes).not.toHaveBeenCalled();
		},
	);

	it("keeps every attachment visible when the authorized batch read fails", async () => {
		vi.mocked(loadAssetsByIds).mockRejectedValue(
			new Error("database unavailable"),
		);
		const [resolved] = await resolveAttachments(
			[
				userMsg(
					"u",
					ref(),
					ref({ assetId: IMAGE, filename: "diagram.png", kind: "image" }),
				),
			],
			"shared-project",
			condenser,
		);
		expect(resolved.parts.slice(1)).toEqual([
			{ type: "text", text: expect.stringContaining("spec.md") },
			{ type: "text", text: expect.stringContaining("diagram.png") },
		]);
		expect(ensureStoredExtract).not.toHaveBeenCalled();
		expect(downloadAssetBytes).not.toHaveBeenCalled();
	});

	it.each(["document", "image"] as const)(
		"keeps a %s read failure as a safe named placeholder",
		async (kind) => {
			if (kind === "document")
				vi.mocked(ensureStoredExtract).mockResolvedValue({
					status: "failed",
					reason: "private diagnostic",
				});
			else {
				vi.mocked(loadAssetsByIds).mockResolvedValue([
					asset({ kind: "image", mimeType: "image/png" }),
				]);
				vi.mocked(downloadAssetBytes).mockRejectedValue(
					new Error("private diagnostic"),
				);
			}
			const [resolved] = await resolveAttachments(
				[userMsg("u", ref())],
				"shared-project",
				condenser,
			);
			expect(resolved.parts.at(-1)).toMatchObject({
				type: "text",
				text: expect.stringContaining("spec.md"),
			});
			expect(JSON.stringify(resolved)).not.toContain("private diagnostic");
		},
	);

	it("carries the historical incomplete-extract warning with the exact text", async () => {
		vi.mocked(ensureStoredExtract).mockResolvedValue({
			status: "ready",
			text: "PARTIAL",
			version: 1,
			truncated: true,
			charCount: 7,
		});
		const [resolved] = await resolveAttachments(
			[userMsg("u", ref())],
			"shared-project",
			condenser,
		);
		expect(resolved.parts.at(-1)).toMatchObject({
			type: "text",
			text: expect.stringContaining("PARTIAL"),
		});
		expect(resolved.parts.at(-1)).toMatchObject({
			type: "text",
			text: expect.stringContaining(
				"trailing content from the original document may be missing",
			),
		});
	});

	it("passes a ref-free transcript through without I/O", async () => {
		const messages: NovaUIMessage[] = [
			{ id: "u", role: "user", parts: [{ type: "text", text: "No files" }] },
		];
		expect(
			await resolveAttachments(messages, "shared-project", condenser),
		).toBe(messages);
		expect(loadAssetsByIds).not.toHaveBeenCalled();
	});
});

/* The gate for the "Reading your documents" status: a document attachment counts
 * only when its extract wasn't ready when attached (no `title` snapshot on the
 * ref). An already-read document — or an image — resolves instantly and must not
 * make the status flash. Pure function; no storage/db. */
describe("countDocumentsNeedingRead", () => {
	const ref = (over: Partial<AttachmentRef>): AttachmentRef => ({
		assetId: testMediaAssetId("a"),
		kind: "text",
		filename: "spec.md",
		mimeType: "text/markdown",
		...over,
	});

	const userMsgWith = (...refs: AttachmentRef[]): NovaUIMessage => ({
		id: "u",
		role: "user",
		parts: [{ type: "text", text: "build this" }],
		metadata: { attachments: refs },
	});

	it("counts a document whose extract wasn't ready (no title snapshot)", () => {
		expect(countDocumentsNeedingRead([userMsgWith(ref({}))])).toBe(1);
	});

	it("does NOT count a document already read (title snapshot present)", () => {
		expect(
			countDocumentsNeedingRead([userMsgWith(ref({ title: "Spec" }))]),
		).toBe(0);
	});

	it("does NOT count an image (read directly, never extracted)", () => {
		expect(
			countDocumentsNeedingRead([
				userMsgWith(ref({ kind: "image", filename: "d.png" })),
			]),
		).toBe(0);
	});

	it("counts only the unread documents in a mixed batch", () => {
		expect(
			countDocumentsNeedingRead([
				userMsgWith(
					ref({ assetId: testMediaAssetId("read"), title: "Done" }),
					ref({ assetId: testMediaAssetId("unread1") }),
					ref({ assetId: testMediaAssetId("unread2") }),
					ref({
						assetId: testMediaAssetId("img"),
						kind: "image",
						filename: "d.png",
					}),
				),
			]),
		).toBe(2);
	});

	it("returns 0 when the last message carries no attachments", () => {
		const plain: NovaUIMessage = {
			id: "u",
			role: "user",
			parts: [{ type: "text", text: "no files" }],
		};
		expect(countDocumentsNeedingRead([plain])).toBe(0);
	});

	it("ignores attachments on anything but the LAST message", () => {
		// A prior turn's unread doc must not re-trigger the status on a later turn —
		// the status is for the new turn's docs only.
		const prior = userMsgWith(ref({ assetId: testMediaAssetId("old") }));
		const latest: NovaUIMessage = {
			id: "u2",
			role: "user",
			parts: [{ type: "text", text: "follow-up, no files" }],
		};
		expect(countDocumentsNeedingRead([prior, latest])).toBe(0);
	});

	it("returns 0 when the last message isn't a user message", () => {
		const assistant: NovaUIMessage = {
			id: "a",
			role: "assistant",
			parts: [{ type: "text", text: "done" }],
		};
		expect(countDocumentsNeedingRead([assistant])).toBe(0);
	});
});
