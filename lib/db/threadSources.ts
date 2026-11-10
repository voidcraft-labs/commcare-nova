import { createHash } from "node:crypto";
import { type Kysely, sql, type Transaction } from "kysely";
import { jsonArrayFrom } from "kysely/helpers/postgres";
import type { AdmittedSources } from "@/lib/agent/incomingSources";
import type { NovaUIMessage } from "@/lib/chat/attachmentRefs";
import {
	type RetainedSource,
	type RetainedSources,
	retainedSourceSchema,
	type SourceProvenance,
	selectedSourceReferenceKey,
	sourceReferenceKey,
} from "@/lib/chat/retainedSource";
import { incomingSourceReferences } from "@/lib/chat/sourceAdmission";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import type { GenerationTarget } from "./generationTargets";
import { MediaReferenceProjectionError } from "./mediaAssets";
import { type AppDatabase, getAppDb } from "./pg";

export function retainedSourceRevision(source: RetainedSource): string {
	return source.content.kind === "document"
		? canonicalJsonDigest({
				contentHash: source.contentHash,
				extractVersion: source.content.version,
				extractDigest: canonicalJsonDigest(source.content.text),
			})
		: canonicalJsonDigest({
				contentHash: source.contentHash,
				mediaType: source.content.mediaType,
				bytesDigest: source.content.bytesDigest,
			});
}

function checkedSource(value: RetainedSource): RetainedSource {
	const source = retainedSourceSchema.parse(value);
	if ((source.kind === "image") !== (source.content.kind === "image"))
		throw new Error("Retained source kind does not match its content");
	if (source.content.kind === "image") {
		const prefix = `data:${source.content.mediaType};base64,`;
		if (!source.content.dataUrl.startsWith(prefix))
			throw new Error("Invalid retained image encoding");
		const bytes = Buffer.from(
			source.content.dataUrl.slice(prefix.length),
			"base64",
		);
		if (
			bytes.length === 0 ||
			bytes.length > 8 * 1024 * 1024 ||
			createHash("sha256").update(bytes).digest("hex") !==
				source.content.bytesDigest
		)
			throw new Error("Retained image digest does not match its bytes");
	} else if (Buffer.byteLength(source.content.text) > 4 * 1024 * 1024) {
		throw new Error("Retained document exceeds its content budget");
	}
	return source;
}

/** The caller owns authority -> thread locks. Bodies are inserted once, never updated. */
export async function retainThreadSource(
	tx: Transaction<AppDatabase>,
	args: {
		threadId: string;
		messageId: string;
		assetId: string;
		source: RetainedSource | null;
		filename?: string;
		provenance: SourceProvenance;
	},
) {
	const source = args.source === null ? null : checkedSource(args.source);
	const revision = source === null ? null : retainedSourceRevision(source);
	if (source !== null && revision !== null) {
		// Filename is reference metadata. Equal content across messages has one body.
		const { filename: _filename, ...body } = source;
		await tx
			.insertInto("thread_source_contents")
			.values({
				thread_id: args.threadId,
				revision,
				content: JSON.stringify(body),
				digest: canonicalJsonDigest(body),
			})
			.onConflict((oc) => oc.columns(["thread_id", "revision"]).doNothing())
			.execute();
		const stored = await tx
			.selectFrom("thread_source_contents")
			.select("digest")
			.where("thread_id", "=", args.threadId)
			.where("revision", "=", revision)
			.executeTakeFirstOrThrow();
		if (stored.digest !== canonicalJsonDigest(body))
			throw new Error("A retained source revision cannot change its content");
	}
	const referenceKey =
		args.messageId === ""
			? selectedSourceReferenceKey(args.assetId, revision ?? "unavailable")
			: sourceReferenceKey(args.messageId, args.assetId);
	const values = {
		reference_key: referenceKey,
		thread_id: args.threadId,
		message_id: args.messageId,
		asset_id: args.assetId,
		revision,
		provenance: args.provenance,
		filename: source?.filename ?? args.filename ?? "Unavailable source",
	};
	const inserted = await tx
		.insertInto("thread_source_links")
		.values(values)
		.onConflict((oc) => oc.columns(["thread_id", "reference_key"]).doNothing())
		.returning("revision")
		.executeTakeFirst();
	if (!inserted) {
		const existing = await tx
			.selectFrom("thread_source_links")
			.select(["revision", "provenance"])
			.where("thread_id", "=", args.threadId)
			.where("reference_key", "=", referenceKey)
			.executeTakeFirstOrThrow();
		if (
			existing.revision !== revision ||
			(existing.provenance !== args.provenance &&
				// Selecting unchanged migrated evidence keeps its original provenance.
				!(
					args.messageId === "" &&
					args.provenance === "admitted" &&
					(existing.provenance === "verified-legacy" ||
						existing.provenance === "migration-baseline")
				))
		)
			throw new Error(
				"A conversation source reference cannot change after admission",
			);
	}
	return revision;
}

export async function pinIncomingThreadSources(
	tx: Transaction<AppDatabase>,
	args: {
		threadId: string;
		projectId: string;
		candidateMessages: readonly unknown[];
		previousMessages: readonly unknown[];
		admittedSources?: AdmittedSources;
	},
) {
	const incoming = incomingSourceReferences(
		args.candidateMessages as NovaUIMessage[],
		args.previousMessages as NovaUIMessage[],
	);
	for (const { messageId, ref } of incoming.sort((a, b) =>
		a.ref.assetId.localeCompare(b.ref.assetId),
	)) {
		const admitted = args.admittedSources?.get(ref.assetId);
		if (
			!admitted ||
			admitted.asset.project_id !== args.projectId ||
			admitted.asset.kind !== ref.kind
		)
			throw new MediaReferenceProjectionError(
				`Source content was not admitted for ${ref.filename}`,
				ref.assetId,
				"invalid-projection",
				ref.kind,
			);
		// Serialize successful admission against library deletion and Project moves.
		const asset = await tx
			.selectFrom("media_assets")
			.select(["project_id", "status", "kind", "content_hash"])
			.where("id", "=", ref.assetId)
			.forShare()
			.executeTakeFirst();
		if (
			!asset ||
			asset.project_id !== args.projectId ||
			asset.status !== "ready" ||
			asset.kind !== ref.kind ||
			asset.content_hash !== admitted.asset.contentHash
		)
			throw new MediaReferenceProjectionError(
				`Source changed before admission: ${ref.filename}`,
				ref.assetId,
				!asset
					? "missing"
					: asset.project_id !== args.projectId
						? "wrong-project"
						: asset.status !== "ready"
							? "not-ready"
							: asset.kind !== ref.kind
								? "wrong-kind"
								: "invalid-projection",
				ref.kind,
			);
		await retainThreadSource(tx, {
			threadId: args.threadId,
			messageId,
			assetId: ref.assetId,
			provenance: "admitted",
			source: {
				kind: ref.kind,
				filename: ref.filename,
				mimeType: admitted.asset.mimeType,
				contentHash: admitted.asset.contentHash,
				content: admitted.content,
			},
		});
	}
}

/** Already-authorized internal callers still bind both target and Project in SQL. */
export async function loadThreadRetainedSources(
	target: GenerationTarget,
	threadId: string,
	projectId: string,
): Promise<RetainedSources> {
	const db = await getAppDb();
	const targetColumn =
		target.kind === "app" ? "threads.app_id" : "threads.design_session_id";
	const targetId =
		target.kind === "app" ? target.appId : target.designSessionId;
	// Keep authorization, links and bodies in one SQL snapshot, but transfer and
	// validate each immutable body only once regardless of reference multiplicity.
	const snapshot = await db
		.selectFrom("threads")
		.leftJoin("apps", "apps.id", "threads.app_id")
		.leftJoin(
			"design_sessions",
			"design_sessions.id",
			"threads.design_session_id",
		)
		.select((eb) => [
			jsonArrayFrom(
				eb
					.selectFrom("thread_source_links")
					.selectAll()
					.whereRef("thread_source_links.thread_id", "=", "threads.thread_id"),
			).as("links"),
			jsonArrayFrom(
				eb
					.selectFrom("thread_source_contents")
					.selectAll()
					.whereRef(
						"thread_source_contents.thread_id",
						"=",
						"threads.thread_id",
					),
			).as("contents"),
		])
		.where("threads.thread_id", "=", threadId)
		.where(targetColumn, "=", targetId)
		.where((eb) =>
			eb.or([
				eb("apps.project_id", "=", projectId),
				eb("design_sessions.project_id", "=", projectId),
			]),
		)
		.executeTakeFirst();
	if (!snapshot) return new Map();
	const contents = new Map(
		snapshot.contents.map((row) => {
			if (canonicalJsonDigest(row.content) !== row.digest)
				throw new Error("Retained source content is damaged");
			return [
				row.revision,
				checkedSource({ ...row.content, filename: "Retained source" }),
			] as const;
		}),
	);
	return new Map(
		snapshot.links.map((row) => {
			const body = row.revision === null ? null : contents.get(row.revision);
			if (
				body === undefined ||
				(body === null) !== (row.provenance === "unavailable")
			)
				throw new Error("Retained source reference is incomplete");
			return [
				row.reference_key,
				{
					messageId: row.message_id,
					assetId: row.asset_id,
					filename: row.filename,
					revision: row.revision,
					provenance: row.provenance,
					source: body === null ? null : { ...body, filename: row.filename },
				},
			];
		}),
	);
}

/** Check only identities and kinds; transcript writes never reload retained bodies. */
export async function assertRetainedThreadReferences(
	tx: Kysely<AppDatabase>,
	args: {
		threadId: string;
		messages: readonly NovaUIMessage[];
		selected: readonly import("@/lib/chat/selectedSources").SelectedSourceDocument[];
	},
) {
	const rows = await tx
		.selectFrom("thread_source_links as link")
		.leftJoin("thread_source_contents as body", (j) =>
			j
				.onRef("body.thread_id", "=", "link.thread_id")
				.onRef("body.revision", "=", "link.revision"),
		)
		.select([
			"link.reference_key",
			"link.message_id",
			"link.asset_id",
			"link.revision",
			"link.provenance",
			sql<string | null>`body.content->>'kind'`.as("kind"),
		])
		.where("link.thread_id", "=", args.threadId)
		.execute();
	const byKey = new Map(rows.map((r) => [r.reference_key, r]));
	for (const message of args.messages)
		for (const ref of message.metadata?.attachments ?? []) {
			const stored = byKey.get(sourceReferenceKey(message.id, ref.assetId));
			if (
				!stored ||
				(stored.provenance !== "unavailable" && stored.kind !== ref.kind)
			)
				throw new Error("Conversation attachment has no retained source");
		}
	for (const ref of args.selected) {
		const stored =
			byKey.get(selectedSourceReferenceKey(ref.assetId, ref.revision)) ??
			byKey.get(selectedSourceReferenceKey(ref.assetId, "unavailable"));
		if (
			!stored ||
			(stored.provenance !== "unavailable" &&
				(stored.kind !== ref.kind || stored.revision !== ref.revision))
		)
			throw new Error("Selected document has no retained source");
	}
}
