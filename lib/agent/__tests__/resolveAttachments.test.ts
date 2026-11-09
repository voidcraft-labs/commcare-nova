import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { NovaUIMessage } from "@/lib/chat/attachmentRefs";
import {
	type RetainedSources,
	selectedSourceReferenceKey,
	sourceReferenceKey,
} from "@/lib/chat/retainedSource";
import type { SelectedSourceDocument } from "@/lib/chat/selectedSources";
import { asMediaAssetId } from "@/lib/domain/multimedia";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { resolveAttachments } from "../resolveAttachments";
import {
	includeSelectedSource,
	loadSourceMaterial,
	sourceAttachmentsMessage,
} from "../sources";

const assetId = asMediaAssetId("80000000-0000-4000-8000-000000000001");
const message: NovaUIMessage = {
	id: "request",
	role: "user",
	parts: [{ type: "text", text: "Use this source" }],
	metadata: {
		attachments: [
			{ assetId, kind: "text", filename: "spec.txt", mimeType: "text/plain" },
		],
	},
};
const retained: RetainedSources = new Map([
	[
		sourceReferenceKey(message.id, assetId),
		{
			messageId: message.id,
			assetId,
			revision: "old-revision",
			provenance: "admitted",
			source: {
				kind: "text",
				filename: "spec.txt",
				mimeType: "text/plain",
				contentHash: "original",
				content: {
					kind: "document",
					text: "The admitted requirements",
					version: 1,
					truncated: false,
				},
			},
		},
	],
]);

describe("retained evidence projection", () => {
	it("uses the same pinned text in edit and build contexts without modifying the transcript", async () => {
		const before = structuredClone(message);
		const projected = resolveAttachments([message], retained);
		expect(projected[0].parts).toEqual([
			message.parts[0],
			expect.objectContaining({
				type: "text",
				text: expect.stringContaining("The admitted requirements"),
			}),
		]);
		const material = await loadSourceMaterial({
			projectId: "project",
			messages: [message],
			retainedSources: retained,
		});
		expect(material.documents).toEqual([
			{
				id: assetId,
				name: "spec.txt",
				text: "The admitted requirements",
				truncated: false,
				revision: "old-revision",
			},
		]);
		expect(message).toEqual(before);
	});
	it("keeps unavailable legacy evidence explicit and rejects an absent retention record", async () => {
		const unavailable: RetainedSources = new Map([
			[
				sourceReferenceKey(message.id, assetId),
				{
					messageId: message.id,
					assetId,
					revision: null,
					provenance: "unavailable",
					source: null,
				},
			],
		]);
		expect(resolveAttachments([message], unavailable)[0].parts).toEqual([
			message.parts[0],
			expect.objectContaining({
				text: expect.stringContaining("could not be retained"),
			}),
		]);
		expect(
			(
				await loadSourceMaterial({
					projectId: "project",
					messages: [message],
					retainedSources: unavailable,
				})
			).documents,
		).toEqual([]);
		expect(() => resolveAttachments([message], new Map())).toThrow(
			"no retained source",
		);
	});
	it("preserves the admitted image bytes and labels a migration baseline honestly", () => {
		const bytes = Buffer.from("retained image bytes");
		const dataUrl = `data:image/png;base64,${bytes.toString("base64")}`;
		const imageMessage: NovaUIMessage = {
			...message,
			metadata: {
				attachments: [
					{
						assetId,
						kind: "image",
						filename: "figure.png",
						mimeType: "image/png",
					},
				],
			},
		};
		const images: RetainedSources = new Map([
			[
				sourceReferenceKey(message.id, assetId),
				{
					messageId: message.id,
					assetId,
					revision: "image-revision",
					provenance: "admitted",
					source: {
						kind: "image",
						filename: "figure.png",
						mimeType: "image/png",
						contentHash: "original",
						content: {
							kind: "image",
							mediaType: "image/png",
							dataUrl,
							bytesDigest: createHash("sha256").update(bytes).digest("hex"),
						},
					},
				},
			],
		]);
		expect(resolveAttachments([imageMessage], images)[0].parts[1]).toEqual({
			type: "file",
			mediaType: "image/png",
			url: dataUrl,
			filename: "figure.png",
		});
		const baseline = new Map(retained);
		const ref = baseline.get(sourceReferenceKey(message.id, assetId));
		if (!ref) throw new Error("Missing test reference");
		baseline.set(sourceReferenceKey(message.id, assetId), {
			...ref,
			provenance: "migration-baseline",
		});
		expect(resolveAttachments([message], baseline)[0].parts[1]).toMatchObject({
			text: expect.stringContaining("not a verified copy"),
		});
	});
});

it.each(["migration-baseline", "unavailable"] as const)(
	"keeps %s notices visible without giving them user-turn identity",
	async (provenance) => {
		const ref = retained.get(sourceReferenceKey(message.id, assetId));
		if (!ref) throw new Error("Missing fixture");
		const sources: RetainedSources = new Map([
			[
				sourceReferenceKey(message.id, assetId),
				{
					...ref,
					provenance,
					...(provenance === "unavailable"
						? { source: null, revision: null }
						: {}),
				},
			],
		]);
		const before = await loadSourceMaterial({
			projectId: "project",
			messages: [message],
			retainedSources: sources,
		});
		const after = await loadSourceMaterial({
			projectId: "project",
			messages: [
				message,
				{
					id: "continue",
					role: "user",
					parts: [{ type: "text", text: "Please continue" }],
				},
			],
			retainedSources: sources,
		});
		expect(before.requests.at(-1)?.key).toBe("request:request:0");
		expect(after.requests.at(-1)?.key).toBe("request:continue:0");
		expect(JSON.stringify(sourceAttachmentsMessage(before))).toContain(
			provenance === "unavailable"
				? "could not be retained"
				: "not a verified copy",
		);
	},
);

it("preserves the exact source snapshot when a newly selected revision resumes beside older revisions", async () => {
	const old = retained.get(sourceReferenceKey(message.id, assetId));
	if (!old?.source) throw new Error("Missing fixture");
	const first = { ...old, messageId: "" };
	const selected = (
		revision: string,
		text: string,
	): SelectedSourceDocument => ({
		assetId,
		kind: "text",
		filename: "spec.txt",
		mimeType: "text/plain",
		contentHash: "original",
		extractVersion: 1,
		extractDigest: canonicalJsonDigest(text),
		revision,
	});
	const firstSelection = selected("old-revision", "The admitted requirements");
	const secondSelection = selected(
		"new-revision",
		"The replacement requirements",
	);
	const second = {
		...first,
		revision: secondSelection.revision,
		source: {
			...old.source,
			content: {
				kind: "document" as const,
				text: "The replacement requirements",
				version: 1,
				truncated: false,
			},
		},
	};
	const sources = new Map([
		[selectedSourceReferenceKey(assetId, firstSelection.revision), first],
	]);
	const initial = await loadSourceMaterial({
		projectId: "project",
		messages: [],
		selectedSources: [firstSelection],
		retainedSources: sources,
	});
	const live = includeSelectedSource({
		material: initial,
		selected: secondSelection,
		retainedContent: second.source,
	});
	sources.set(
		selectedSourceReferenceKey(assetId, secondSelection.revision),
		second,
	);
	const resumed = await loadSourceMaterial({
		projectId: "project",
		messages: [],
		selectedSources: [secondSelection],
		retainedSources: new Map([...sources].reverse()),
	});
	expect(resumed).toEqual(live);
	expect(sourceAttachmentsMessage(resumed)).toEqual(
		sourceAttachmentsMessage(live),
	);
});
