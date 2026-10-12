import type { ModelMessage } from "ai";
import { z } from "zod";
import {
	attachmentRefSchema,
	type NovaUIMessage,
} from "@/lib/chat/attachmentRefs";
import type { SelectedSourceDocument } from "@/lib/chat/selectedSources";
import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import {
	asMediaAssetId,
	type DocumentKind,
	isDocumentKind,
	type MediaAssetId,
} from "@/lib/domain/multimedia";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import type { SourceDocumentRuntime } from "./sourceDocuments";
import { askQuestionsInputSchema } from "./tools/askQuestions";

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_CHARACTERS = 400_000;
export class SourceMaterialError extends Error {
	readonly name = "SourceMaterialError";
}
export interface SourceMaterialDeps {
	prepareDocument?: SourceDocumentRuntime["prepare"];
	loadAssets(
		ids: readonly MediaAssetId[],
		projectId: string,
	): Promise<MediaAssetRecord[]>;
	readExtract(
		asset: MediaAssetRecord,
		kind: DocumentKind,
	): Promise<{ text: string; truncated: boolean; version?: number }>;
	loadImage(
		asset: MediaAssetRecord,
	): Promise<{ mediaType: string; dataUrl: string; bytesDigest: string }>;
}
export interface SourceDocument {
	readonly id: string;
	readonly name: string;
	readonly text: string;
	readonly truncated: boolean;
	readonly revision?: string;
}
export interface SourceMaterial {
	readonly digest: string;
	readonly requests: readonly {
		readonly key: string;
		readonly legacyKeys?: readonly string[];
		readonly legacyKeyPrefix?: string;
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
	readonly selectedSources?: readonly SelectedSourceDocument[];
}): Promise<SourceMaterial> {
	const requests: Array<{
		key: string;
		legacyKeys?: readonly string[];
		legacyKeyPrefix?: string;
		message: ModelMessage;
	}> = [];
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
					key: `answers:${message.id}:${part.toolCallId}`,
					legacyKeys: [`answers:${message.id}:${index}`],
					legacyKeyPrefix: `answers:${message.id}:`,
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
	for (const selected of args.selectedSources ?? [])
		if (!references.has(selected.assetId))
			references.set(selected.assetId, selected);
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
				...((extract.version !== undefined ||
					asset.extract?.status === "ready") && {
					revision: canonicalJsonDigest({
						contentHash: asset.contentHash,
						extractVersion: extract.version ?? asset.extract?.version,
						extractDigest: canonicalJsonDigest(extract.text),
					}),
				}),
			});
		} else {
			images.push({
				id: asset.id,
				name: reference.filename,
				...(await args.deps.loadImage(asset)),
			});
		}
	}
	return sourceMaterialSnapshot({ requests, documents, images });
}

/** Capture the exact evidence available to a review. Selecting another library
 * document changes the snapshot without rewriting the user's attachments. */
export function sourceMaterialSnapshot(
	material: Omit<SourceMaterial, "digest">,
): SourceMaterial {
	const characters =
		material.requests.reduce(
			(sum, request) => sum + JSON.stringify(request.message).length,
			0,
		) +
		material.documents.reduce((sum, document) => sum + document.text.length, 0);
	if (characters > MAX_SOURCE_CHARACTERS)
		throw new SourceMaterialError(
			"This conversation and its documents exceed the supported source size. Use a shorter document or split the request into separate conversations.",
		);

	return {
		...material,
		digest: canonicalJsonDigest({
			requests: material.requests.map(({ key, message }) => ({ key, message })),
			documents: material.documents,
			images: material.images.map(({ dataUrl: _, ...image }) => image),
		}),
	};
}

export async function includeSelectedSource(args: {
	readonly material: SourceMaterial;
	readonly selected: SelectedSourceDocument;
	readonly projectId: string;
	readonly deps: SourceMaterialDeps;
}): Promise<SourceMaterial> {
	const [asset] = await args.deps.loadAssets(
		[args.selected.assetId],
		args.projectId,
	);
	if (
		asset?.status !== "ready" ||
		asset.kind !== args.selected.kind ||
		asset.contentHash !== args.selected.contentHash
	)
		throw new SourceMaterialError(
			"The selected document is no longer available in this Project.",
		);
	const extract = await args.deps.readExtract(asset, args.selected.kind);
	if (
		canonicalJsonDigest(extract.text) !== args.selected.extractDigest ||
		(extract.version ?? asset.extract?.version) !== args.selected.extractVersion
	)
		throw new SourceMaterialError(
			"The selected document changed while it was being read. Read it again from the first page.",
		);
	const documents = [...args.material.documents];
	const document = {
		id: args.selected.assetId,
		name: args.selected.filename,
		text: extract.text,
		truncated: extract.truncated,
		revision: args.selected.revision,
	};
	const index = documents.findIndex(
		(item) => item.id === args.selected.assetId,
	);
	if (index < 0) documents.push(document);
	else documents[index] = document;
	return sourceMaterialSnapshot({ ...args.material, documents });
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
						...(document.revision && { revision: document.revision }),
					})),
					images: material.images.map((image) => ({
						id: image.id,
						name: image.name,
					})),
				}),
			},
			...material.images.map((image) => ({
				type: "file" as const,
				data: new URL(image.dataUrl),
				mediaType: image.mediaType,
			})),
		],
	};
}
