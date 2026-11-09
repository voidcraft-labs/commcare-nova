/** Read-only capture of available legacy evidence. It never starts extraction. */
import { createHash } from "node:crypto";
import { type Kysely, sql } from "kysely";
import { attachmentRefSchema } from "@/lib/chat/attachmentRefs";
import {
	type RetainedSource,
	type SourceProvenance,
	selectedSourceReferenceKey,
	sourceReferenceKey,
} from "@/lib/chat/retainedSource";
import {
	type SelectedSourceDocument,
	selectedSourceDocumentsSchema,
} from "@/lib/chat/selectedSources";
import { mediaAssetRecordFromRow } from "@/lib/db/mediaAssets";
import type { AppDatabase } from "@/lib/db/pg";
import { retainedSourceRevision } from "@/lib/db/threadSources";
import { hasLegacyThreadStorage } from "@/lib/db/threadStorageScan";
import { threadMessagesSql } from "@/lib/db/threadTranscript";
import { threadMessageSchema } from "@/lib/db/types";
import {
	extractGcsObjectKeyFor,
	isDocumentKind,
	isModelReadableImageMimeType,
} from "@/lib/domain/multimedia";
import { downloadAssetBytes, readTextObject } from "@/lib/storage/media";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";

export interface SourceBaselineEntry {
	threadId: string;
	projectId: string;
	messageId: string;
	assetId: string;
	filename: string;
	source: RetainedSource | null;
	provenance: SourceProvenance;
}
export function sourceBaselineReferenceKey(entry: SourceBaselineEntry): string {
	return entry.messageId === ""
		? selectedSourceReferenceKey(
				entry.assetId,
				entry.source ? retainedSourceRevision(entry.source) : "unavailable",
			)
		: sourceReferenceKey(entry.messageId, entry.assetId);
}

export interface SourceBaselineDeps {
	readText: typeof readTextObject;
	readBytes: typeof downloadAssetBytes;
}
const productionDeps: SourceBaselineDeps = {
	readText: readTextObject,
	readBytes: downloadAssetBytes,
};

export async function scanConversationSources(
	db: Kysely<AppDatabase>,
	deps = productionDeps,
) {
	const legacy = await hasLegacyThreadStorage(db);
	const threads = await db
		.selectFrom("threads")
		.leftJoin("apps", "apps.id", "threads.app_id")
		.leftJoin(
			"design_sessions",
			"design_sessions.id",
			"threads.design_session_id",
		)
		.select([
			"thread_id",
			"selected_sources",
			sql<string>`COALESCE(apps.project_id, design_sessions.project_id)`.as(
				"project_id",
			),
			(legacy ? sql<unknown[]>`threads.messages` : threadMessagesSql()).as(
				"messages",
			),
		])
		.orderBy("thread_id")
		.execute();
	const byReference = new Map<string, SourceBaselineEntry>();
	const cache = new Map<string, Promise<RetainedSource | null>>();
	for (const thread of threads) {
		const messages = threadMessageSchema.array().parse(thread.messages);
		const selected = selectedSourceDocumentsSchema.parse(
			thread.selected_sources,
		);
		const refs = messages.flatMap((message) => {
			const metadata = message.metadata as
				| { attachments?: unknown[] }
				| undefined;
			return (metadata?.attachments ?? []).map((raw) => ({
				messageId: message.id,
				ref: attachmentRefSchema.parse(raw),
				selected: undefined as SelectedSourceDocument | undefined,
			}));
		});
		refs.push(
			...selected.map((ref) => ({ messageId: "", ref, selected: ref })),
		);
		for (const { messageId, ref, selected: prior } of refs) {
			if (!thread.project_id)
				throw new Error("A source conversation has no owning Project");
			const key = JSON.stringify([
				thread.project_id,
				ref.assetId,
				prior?.revision ?? null,
			]);
			let pending = cache.get(key);
			if (!pending) {
				pending = (async (): Promise<RetainedSource | null> => {
					const row = await db
						.selectFrom("media_assets")
						.selectAll()
						.where("id", "=", ref.assetId)
						.where("project_id", "=", thread.project_id)
						.executeTakeFirst();
					if (!row) return null;
					const asset = mediaAssetRecordFromRow(row);
					if (asset.status !== "ready" || asset.kind !== ref.kind) return null;
					const base = {
						kind: ref.kind,
						filename: ref.filename,
						mimeType: asset.mimeType,
						contentHash: asset.contentHash,
					};
					if (asset.kind === "image") {
						if (!isModelReadableImageMimeType(asset.mimeType)) return null;
						let bytes: Buffer;
						try {
							bytes = await deps.readBytes(asset.gcsObjectKey, 8 * 1024 * 1024);
						} catch (error) {
							// Missing legacy bytes are an explicit unavailable source. An
							// authorization or transport failure cannot establish absence.
							if ((error as { code?: number } | null)?.code === 404)
								return null;
							throw error;
						}
						const bytesDigest = createHash("sha256")
							.update(bytes)
							.digest("hex");
						if (bytesDigest !== asset.contentHash)
							throw new Error(
								"Historical image bytes differ from their immutable content hash",
							);
						return {
							...base,
							content: {
								kind: "image",
								mediaType: asset.mimeType,
								dataUrl: `data:${asset.mimeType};base64,${bytes.toString("base64")}`,
								bytesDigest,
							},
						};
					}
					if (!isDocumentKind(asset.kind)) return null;
					const version =
						prior?.extractVersion ??
						(asset.extract?.status === "ready"
							? asset.extract.version
							: undefined);
					if (
						version === undefined ||
						(prior && prior.contentHash !== asset.contentHash)
					)
						return null;
					const text = await deps.readText(
						extractGcsObjectKeyFor(
							thread.project_id,
							asset.contentHash,
							version,
						),
						4 * 1024 * 1024,
					);
					if (
						!text?.trim() ||
						(prior && canonicalJsonDigest(text) !== prior.extractDigest)
					)
						return null;
					// Legacy selected-source records did not retain truncated. If the
					// matching metadata no longer exists, conservatively label it true.
					const truncated =
						asset.extract?.version === version ? asset.extract.truncated : true;
					return {
						...base,
						content: { kind: "document", text, version, truncated },
					};
				})();
				cache.set(key, pending);
			}
			const captured = await pending;
			const source =
				captured === null ? null : { ...captured, filename: ref.filename };
			const entry: SourceBaselineEntry = {
				threadId: thread.thread_id,
				projectId: thread.project_id,
				messageId,
				assetId: ref.assetId,
				filename: ref.filename,
				source,
				provenance:
					source === null
						? "unavailable"
						: prior || source.content.kind === "image"
							? "verified-legacy"
							: "migration-baseline",
			};
			const identity = JSON.stringify([
				entry.threadId,
				sourceBaselineReferenceKey(entry),
			]);
			const existing = byReference.get(identity);
			if (
				existing &&
				canonicalJsonDigest(existing) !== canonicalJsonDigest(entry)
			)
				throw new Error(
					"Historical source references conflict for one message or selection.",
				);
			byReference.set(identity, entry);
		}
	}
	const entries = [...byReference.values()];
	const counts = {
		references: entries.length,
		verifiedLegacy: 0,
		migrationBaselines: 0,
		unavailable: 0,
		retainedBytes: 0,
	};
	const unique = new Map<string, RetainedSource>();
	for (const entry of entries) {
		if (entry.provenance === "verified-legacy") counts.verifiedLegacy++;
		if (entry.provenance === "migration-baseline") counts.migrationBaselines++;
		if (entry.provenance === "unavailable") counts.unavailable++;
		if (entry.source)
			unique.set(
				`${entry.threadId}:${retainedSourceRevision(entry.source)}`,
				entry.source,
			);
	}
	for (const source of unique.values())
		counts.retainedBytes += Buffer.byteLength(JSON.stringify(source));
	const scanDigest = canonicalJsonDigest({
		threads: threads.map((t) => [t.thread_id, t.project_id]),
		entries: entries.map(({ source, ...entry }) => ({
			...entry,
			digest: source === null ? null : canonicalJsonDigest(source),
		})),
	});
	return {
		entries,
		report: { ...counts, uniqueContents: unique.size, scanDigest },
	};
}
