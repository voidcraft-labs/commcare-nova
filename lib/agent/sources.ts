import type { ModelMessage } from "ai";
import { z } from "zod";
import {
	attachmentRefSchema,
	type NovaUIMessage,
} from "@/lib/chat/attachmentRefs";
import {
	type RetainedSource,
	type RetainedSources,
	selectedSourceReferenceKey,
	sourceProvenanceNotice,
	sourceReferenceKey,
} from "@/lib/chat/retainedSource";
import type { SelectedSourceDocument } from "@/lib/chat/selectedSources";
import type { MediaAssetId } from "@/lib/domain/multimedia";
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
	readonly notices?: readonly { readonly key: string; readonly text: string }[];
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
	readonly retainedSources?: RetainedSources;
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
			references.set(
				sourceReferenceKey(message.id, reference.assetId),
				reference,
			);
		}
	}
	for (const selected of args.selectedSources ?? [])
		references.set(
			selectedSourceReferenceKey(selected.assetId, selected.revision),
			selected,
		);
	for (const [key, ref] of args.retainedSources ?? []) {
		if (ref.messageId === "" && ref.source)
			references.set(key, {
				assetId: ref.assetId as MediaAssetId,
				kind: ref.source.kind,
				filename: ref.source.filename,
				mimeType: ref.source.mimeType,
			});
	}
	const notices: { key: string; text: string }[] = [];
	const documents: SourceDocument[] = [];
	const images: Array<SourceMaterial["images"][number]> = [];
	const seen = new Set<string>();
	for (const [key, reference] of references) {
		const retained =
			args.retainedSources?.get(key) ??
			args.retainedSources?.get(
				selectedSourceReferenceKey(reference.assetId, "unavailable"),
			);
		if (!retained)
			throw new SourceMaterialError(
				`The source "${reference.filename}" has no retained conversation record.`,
			);
		const notice = sourceProvenanceNotice(retained.provenance);
		if (notice)
			notices.push({
				key,
				text: `${reference.filename}: ${notice}`,
			});
		if (!retained.source || retained.revision === null) continue;
		const unique = `${reference.assetId}:${retained.revision}`;
		if (seen.has(unique)) continue;
		seen.add(unique);
		const content = retained.source.content;
		if (content.kind === "document")
			documents.push({
				id: reference.assetId,
				name: reference.filename,
				text: content.text,
				truncated: content.truncated,
				revision: retained.revision,
			});
		else
			images.push({
				id: reference.assetId,
				name: reference.filename,
				mediaType: content.mediaType,
				dataUrl: content.dataUrl,
				bytesDigest: content.bytesDigest,
			});
	}
	return sourceMaterialSnapshot({ requests, documents, images, notices });
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
		material.documents.reduce(
			(sum, document) => sum + document.text.length,
			0,
		) +
		(material.notices ?? []).reduce(
			(sum, notice) => sum + notice.text.length,
			0,
		);
	if (characters > MAX_SOURCE_CHARACTERS)
		throw new SourceMaterialError(
			"This conversation and its documents exceed the supported source size. Use a shorter document or split the request into separate conversations.",
		);

	// Evidence is a set of pinned revisions; selection/reload traversal order
	// must not change the context or invalidate a completed review.
	const documents = [...material.documents].sort((a, b) =>
		`${a.id}:${a.revision ?? ""}`.localeCompare(`${b.id}:${b.revision ?? ""}`),
	);
	const images = [...material.images].sort((a, b) =>
		`${a.id}:${a.bytesDigest}`.localeCompare(`${b.id}:${b.bytesDigest}`),
	);
	const notices = [...(material.notices ?? [])].sort((a, b) =>
		a.key.localeCompare(b.key),
	);
	return {
		...material,
		documents,
		images,
		notices,
		digest: canonicalJsonDigest({
			requests: material.requests.map(({ key, message }) => ({ key, message })),
			notices,
			documents,
			images: images.map(({ dataUrl: _, ...image }) => image),
		}),
	};
}

export function includeSelectedSource(args: {
	readonly material: SourceMaterial;
	readonly selected: SelectedSourceDocument;
	readonly retainedContent: RetainedSource;
}): SourceMaterial {
	const content = args.retainedContent.content;
	if (
		content.kind !== "document" ||
		canonicalJsonDigest(content.text) !== args.selected.extractDigest ||
		content.version !== args.selected.extractVersion
	)
		throw new SourceMaterialError(
			"The selected source does not match its retained content.",
		);
	const documents = [...args.material.documents];
	if (
		!documents.some(
			(item) =>
				item.id === args.selected.assetId &&
				item.revision === args.selected.revision,
		)
	)
		documents.push({
			id: args.selected.assetId,
			name: args.selected.filename,
			text: content.text,
			truncated: content.truncated,
			revision: args.selected.revision,
		});
	return sourceMaterialSnapshot({ ...args.material, documents });
}

/** File bytes appear once in a role's source context, never in a tool catalog. */
export function sourceAttachmentsMessage(
	material: SourceMaterial,
): ModelMessage | null {
	if (
		!material.documents.length &&
		!material.images.length &&
		!material.notices?.length
	)
		return null;
	return {
		role: "user",
		content: [
			{
				type: "text",
				text: JSON.stringify({
					notices: material.notices?.map(({ text }) => text) ?? [],
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
