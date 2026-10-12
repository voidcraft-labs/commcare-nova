import { z } from "zod";
import type { SelectedSourceDocument } from "@/lib/chat/selectedSources";
import { findSourceAssets, type MediaAssetRecord } from "@/lib/db/mediaAssets";
import {
	type DocumentKind,
	EXTRACTOR_VERSION,
	extractGcsObjectKeyFor,
	isDocumentKind,
	type MediaAssetId,
} from "@/lib/domain/multimedia";
import { readTextObject } from "@/lib/storage/media";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	type AttachmentCondenser,
	EXTRACT_MAX_BYTES,
} from "./documentExtraction";
import {
	EXTRACTING_STALE_MS,
	ensureStoredExtract,
	type StoredExtractResult,
} from "./documentExtractionStore";

export const readSourceInputSchema = z.strictObject({
	document: z
		.string()
		.min(1)
		.max(255)
		.describe(
			"Library document id or exact filename. Use listMediaAssets to find files.",
		),
	offset: z
		.number()
		.int()
		.nonnegative()
		.optional()
		.describe("Character offset; defaults to zero."),
	length: z
		.number()
		.int()
		.min(1)
		.max(24_000)
		.optional()
		.describe("Characters to read; defaults to 12,000."),
	revision: z
		.string()
		.min(1)
		.max(128)
		.optional()
		.describe(
			"Revision returned by the first page. Required when offset is greater than zero, so pages cannot mix different extracts.",
		),
});
export type ReadSourceInput = z.infer<typeof readSourceInputSchema>;

export type { SelectedSourceDocument } from "@/lib/chat/selectedSources";

/** Embedded authoring binds preparation to its existing metered run. An MCP
 * host supplies no prepare callback and can never start hidden model work. */
export interface SourceDocumentRuntime {
	readonly signal?: AbortSignal;
	readonly prepare?: (
		asset: MediaAssetRecord,
		kind: DocumentKind,
		signal?: AbortSignal,
		onProgress?: (deltaChars: number) => void,
	) => Promise<StoredExtractResult>;
	readonly selected?: (
		source: SelectedSourceDocument,
		requestId: string,
	) => Promise<void>;
}

/** Keep automatic preparation inside its real run's authority and meter. The
 * monitor exists only while preparation is awaited; Stop or membership loss
 * aborts the provider/wait, and teardown joins an outstanding authority read. */
export async function prepareEmbeddedSourceDocument(args: {
	readonly asset: MediaAssetRecord;
	readonly documentKind: DocumentKind;
	readonly condenser: AttachmentCondenser;
	readonly authorize: () => Promise<unknown>;
	readonly signal?: AbortSignal;
	readonly onProgress?: (deltaChars: number) => void;
}): Promise<StoredExtractResult> {
	await args.authorize();
	args.signal?.throwIfAborted();
	const authorityAbort = new AbortController();
	const signal = args.signal
		? AbortSignal.any([args.signal, authorityAbort.signal])
		: authorityAbort.signal;
	let checking: Promise<void> | undefined;
	const timer = setInterval(() => {
		if (checking) return;
		checking = args
			.authorize()
			.then(
				() => undefined,
				(error: unknown) => {
					authorityAbort.abort(error);
				},
			)
			.finally(() => {
				checking = undefined;
			});
	}, 60_000);
	timer.unref?.();
	let result: StoredExtractResult;
	try {
		result = await ensureStoredExtract({
			asset: args.asset,
			documentKind: args.documentKind,
			condenser: args.condenser,
			onInflight: "wait",
			signal,
			onProgress: args.onProgress,
		});
	} catch (error) {
		// Preserve the owning authority failure instead of a transport's generic
		// AbortError, so the caller terminates the run rather than retrying a tool.
		signal.throwIfAborted();
		throw error;
	} finally {
		clearInterval(timer);
		await checking;
	}
	signal.throwIfAborted();
	return result;
}

export interface SourceDocumentDeps {
	readonly find: typeof findSourceAssets;
	readonly readText: typeof readTextObject;
}
const productionDeps: SourceDocumentDeps = {
	find: findSourceAssets,
	readText: readTextObject,
};

export type SourceDocumentResult =
	| {
			readonly status: "ready";
			readonly assetId: MediaAssetId;
			readonly document: string;
			readonly representation: "requirements-extract";
			readonly revision: string;
			readonly extractVersion: number;
			readonly text: string;
			readonly offset: number;
			readonly nextOffset: number | null;
			readonly totalCharacters: number;
			readonly extractTruncated: boolean;
	  }
	| {
			readonly status:
				| "not_found"
				| "ambiguous"
				| "unsupported"
				| "uploading"
				| "preparation_required"
				| "extracting"
				| "failed"
				| "source_changed"
				| "invalid_offset"
				| "revision_required";
			readonly error: string;
			readonly candidates?: readonly {
				assetId: MediaAssetId;
				filename: string;
			}[];
	  };

/** One Project-gated source reader for every tool surface. Discovery never
 * loads bytes, and reading one file never adds the rest of the library. */
export async function readSourceDocument(args: {
	readonly projectId: string;
	readonly input: ReadSourceInput;
	readonly requestId: string;
	readonly runtime?: SourceDocumentRuntime;
	readonly deps?: SourceDocumentDeps;
}): Promise<SourceDocumentResult> {
	const { input, runtime } = args;
	const deps = args.deps ?? productionDeps;
	const offset = input.offset ?? 0;
	if (offset > 0 && input.revision === undefined)
		return {
			status: "revision_required",
			error:
				"Pass the revision from the first page when continuing a document.",
		};
	runtime?.signal?.throwIfAborted();
	let matches = await deps.find(args.projectId, input.document);
	if (matches.length === 0)
		return {
			status: "not_found",
			error:
				"No matching file is available in this Project. Search the library with listMediaAssets and use its document id.",
		};
	if (matches.length !== 1)
		return {
			status: "ambiguous",
			error:
				"More than one file has this name. Use a document id from listMediaAssets.",
			candidates: matches.map((asset) => ({
				assetId: asset.id,
				filename: asset.displayName ?? asset.originalFilename,
			})),
		};
	let asset = matches[0];
	if (!isDocumentKind(asset.kind))
		return {
			status: "unsupported",
			error:
				"This file is not a document. Source reading supports PDF, text, Word and Excel files.",
		};
	if (asset.status !== "ready")
		return {
			status: "uploading",
			error:
				"This file is still uploading. Its document can be read after the upload finishes.",
		};
	let text = await readyText(asset, deps, runtime?.signal);
	if (text === null && runtime?.prepare !== undefined) {
		const prepared = await runtime.prepare(asset, asset.kind, runtime.signal);
		runtime.signal?.throwIfAborted();
		if (prepared.status !== "ready")
			return {
				status: prepared.status,
				error:
					prepared.status === "extracting"
						? "This document is being prepared. It can be read when preparation finishes."
						: "This document could not be prepared. Retry preparation from the Library; its uploaded file is still saved.",
			};
		// Preparation can race deletion or a newer extractor. Read the published
		// metadata/text pair, never combine an old asset snapshot with new bytes.
		matches = await deps.find(args.projectId, asset.id);
		if (matches.length !== 1 || matches[0].status !== "ready")
			return {
				status: "not_found",
				error: "This file is no longer available in this Project.",
			};
		asset = matches[0];
		text = await readyText(asset, deps, runtime.signal);
	}
	if (text === null) {
		const status =
			asset.extract?.status === "extracting" &&
			Date.now() - asset.extract.extractedAt >= EXTRACTING_STALE_MS
				? undefined
				: asset.extract?.status;
		return {
			status:
				status === "extracting" || status === "failed"
					? status
					: "preparation_required",
			error:
				status === "extracting"
					? "This document is being prepared. It can be read when preparation finishes."
					: "This document needs preparation before it can be read. Prepare or retry it in the Library; no reupload is needed.",
		};
	}
	if (!isDocumentKind(asset.kind) || asset.extract?.status !== "ready")
		throw new Error("A prepared source lost its document identity.");
	if (!text.trim())
		return {
			status: "failed",
			error:
				"The prepared document contains no readable text. Retry preparation in the Library.",
		};
	const extractDigest = canonicalJsonDigest(text);
	const revision = canonicalJsonDigest({
		contentHash: asset.contentHash,
		extractVersion: asset.extract.version,
		extractDigest,
	});
	if (input.revision !== undefined && input.revision !== revision)
		return {
			status: "source_changed",
			error:
				"This document's prepared text changed. Read again from offset zero without the old revision before continuing.",
		};
	if (offset > text.length)
		return {
			status: "invalid_offset",
			error: `This document contains ${text.length} characters. Read an offset within that range.`,
		};
	const end = Math.min(text.length, offset + (input.length ?? 12_000));
	runtime?.signal?.throwIfAborted();
	await runtime?.selected?.(
		{
			assetId: asset.id,
			kind: asset.kind,
			filename: asset.originalFilename,
			mimeType: asset.mimeType,
			contentHash: asset.contentHash,
			extractVersion: asset.extract.version,
			extractDigest,
			revision,
		},
		args.requestId,
	);
	return {
		status: "ready",
		assetId: asset.id,
		document: asset.displayName ?? asset.originalFilename,
		representation: "requirements-extract",
		revision,
		extractVersion: asset.extract.version,
		text: text.slice(offset, end),
		offset,
		nextOffset: end < text.length ? end : null,
		totalCharacters: text.length,
		extractTruncated: asset.extract.truncated,
	};
}

async function readyText(
	asset: MediaAssetRecord,
	deps: SourceDocumentDeps,
	signal?: AbortSignal,
): Promise<string | null> {
	signal?.throwIfAborted();
	if (
		asset.extract?.status !== "ready" ||
		asset.extract.version < EXTRACTOR_VERSION
	)
		return null;
	const text = await deps.readText(
		extractGcsObjectKeyFor(
			asset.project_id,
			asset.contentHash,
			asset.extract.version,
		),
		EXTRACT_MAX_BYTES,
		signal,
	);
	signal?.throwIfAborted();
	return text;
}
