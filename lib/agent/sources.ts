import type { ModelMessage } from "ai";
import { z } from "zod";
import {
	attachmentRefSchema,
	type NovaUIMessage,
} from "@/lib/chat/attachmentRefs";
import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import {
	asMediaAssetId,
	type DocumentKind,
	isDocumentKind,
	type MediaAssetId,
} from "@/lib/domain/multimedia";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { askQuestionsInputSchema } from "./tools/askQuestions";

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_CHARACTERS = 400_000;
export class SourceMaterialError extends Error {
	readonly name = "SourceMaterialError";
}
export interface SourceMaterialDeps {
	loadAssets(
		ids: readonly MediaAssetId[],
		projectId: string,
	): Promise<MediaAssetRecord[]>;
	readExtract(
		asset: MediaAssetRecord,
		kind: DocumentKind,
	): Promise<{ text: string; truncated: boolean }>;
	loadImage(
		asset: MediaAssetRecord,
	): Promise<{ mediaType: string; dataUrl: string; bytesDigest: string }>;
}
export interface SourceDocument {
	readonly id: string;
	readonly name: string;
	readonly text: string;
	readonly truncated: boolean;
}
export interface SourceMaterial {
	readonly digest: string;
	readonly requests: readonly {
		readonly key: string;
		readonly message: ModelMessage;
	}[];
	readonly documents: readonly SourceDocument[];
	readonly images: readonly {
		readonly id: string;
		readonly name: string;
		readonly mediaType: string;
		readonly dataUrl: string;
		readonly bytesDigest: string;
	}[];
}

/** Keep the user's words and answers. Documents are read on demand through their
 * authorized extracts; only their names and lengths enter the initial context. */
export async function loadSourceMaterial(args: {
	readonly projectId: string;
	readonly messages: readonly NovaUIMessage[];
	readonly deps: SourceMaterialDeps;
}): Promise<SourceMaterial> {
	const requests: Array<{ key: string; message: ModelMessage }> = [];
	const references = new Map<string, z.infer<typeof attachmentRefSchema>>();
	for (const message of args.messages) {
		if (message.role === "user") {
			for (const [index, part] of message.parts.entries()) {
				if (part.type === "text" && part.text.trim())
					requests.push({
						key: `request:${message.id}:${index}`,
						message: { role: "user", content: part.text },
					});
			}
		}
		if (message.role === "assistant") {
			for (const [index, part] of message.parts.entries()) {
				if (
					part.type !== "tool-askQuestions" ||
					part.state !== "output-available"
				)
					continue;
				const input = askQuestionsInputSchema.parse(part.input);
				const answers = z.record(z.string(), z.string()).parse(part.output);
				const pairs = input.questions.map((question, i) => {
					const answer = answers[String(i)];
					if (!answer?.trim())
						throw new SourceMaterialError(
							"A completed question card is missing an answer.",
						);
					return { question: question.question, answer };
				});
				requests.push({
					key: `answers:${message.id}:${index}`,
					message: {
						role: "user",
						content: JSON.stringify({ answers: pairs }),
					},
				});
			}
		}
		// Question replies can carry attachments on an assistant tool part's message.
		for (const raw of message.metadata?.attachments ?? []) {
			const reference = attachmentRefSchema.parse(raw);
			references.set(reference.assetId, reference);
		}
	}
	const assets = await args.deps.loadAssets(
		[...references.keys()].map(asMediaAssetId),
		args.projectId,
	);
	const byId = new Map(assets.map((asset) => [asset.id as string, asset]));
	const documents: SourceDocument[] = [];
	const images: Array<SourceMaterial["images"][number]> = [];
	for (const reference of references.values()) {
		const asset = byId.get(reference.assetId);
		if (asset?.status !== "ready" || asset.kind !== reference.kind)
			throw new SourceMaterialError(
				`The attachment "${reference.filename}" is unavailable in this Project.`,
			);
		if (isDocumentKind(reference.kind)) {
			const extract = await args.deps.readExtract(asset, reference.kind);
			if (!extract.text.trim())
				throw new SourceMaterialError(
					`No text could be read from "${reference.filename}".`,
				);
			documents.push({
				id: asset.id,
				name: reference.filename,
				text: extract.text,
				truncated: extract.truncated,
			});
		} else {
			images.push({
				id: asset.id,
				name: reference.filename,
				...(await args.deps.loadImage(asset)),
			});
		}
	}
	const characters =
		requests.reduce(
			(sum, request) => sum + JSON.stringify(request.message).length,
			0,
		) + documents.reduce((sum, document) => sum + document.text.length, 0);
	if (characters > MAX_SOURCE_CHARACTERS)
		throw new SourceMaterialError(
			"This conversation and its documents exceed the supported source size. Use a shorter document or split the request into separate conversations.",
		);
	const digest = canonicalJsonDigest({
		requests,
		documents,
		images: images.map(({ dataUrl: _, ...image }) => image),
	});
	return { digest, requests, documents, images };
}

export const readSourceInputSchema = z
	.object({
		document: z.string().describe("Document name or id."),
		offset: z
			.number()
			.int()
			.nonnegative()
			.optional()
			.describe("Character offset; starts at zero."),
		length: z
			.number()
			.int()
			.min(1)
			.max(24_000)
			.optional()
			.describe("Characters to read; defaults to 12,000."),
	})
	.strict();

export function readSource(material: SourceMaterial, raw: unknown) {
	const input = readSourceInputSchema.parse(raw);
	const matches = material.documents.filter(
		(document) =>
			document.id === input.document || document.name === input.document,
	);
	if (matches.length !== 1)
		throw new SourceMaterialError(
			"The document name is missing or ambiguous. Use an id from the source list.",
		);
	const document = matches[0];
	const offset = input.offset ?? 0;
	const end = Math.min(document.text.length, offset + (input.length ?? 12_000));
	if (offset > document.text.length)
		throw new SourceMaterialError(
			`This document contains ${document.text.length} characters.`,
		);
	return {
		document: document.name,
		text: document.text.slice(offset, end),
		offset,
		nextOffset: end < document.text.length ? end : null,
		totalCharacters: document.text.length,
		extractTruncated: document.truncated,
	};
}

/** File bytes appear once in a role's source context, never in a tool catalog. */
export function sourceAttachmentsMessage(
	material: SourceMaterial,
): ModelMessage | null {
	if (!material.documents.length && !material.images.length) return null;
	return {
		role: "user",
		content: [
			{
				type: "text",
				text: JSON.stringify({
					documents: material.documents.map((document) => ({
						id: document.id,
						name: document.name,
						characters: document.text.length,
						extractTruncated: document.truncated,
					})),
					images: material.images.map((image) => ({
						id: image.id,
						name: image.name,
					})),
				}),
			},
			...material.images.map((image) => ({
				type: "image" as const,
				image: new URL(image.dataUrl),
				mediaType: image.mediaType,
			})),
		],
	};
}
