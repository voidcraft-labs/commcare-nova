import { sql, type Transaction } from "kysely";
import { preserveStoredThreadAttachments } from "@/lib/chat/threadAttachments";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import type { AppDatabase } from "./pg";
import { type ThreadMessage, threadMessageSchema } from "./types";

/** Reconstruct within the caller's SQL snapshot, including any thread marker
 * selected alongside it. Callers own target authorization. No second read may
 * combine an earlier marker with a later transcript. */
export function threadMessagesSql(threadIdColumn = "threads.thread_id") {
	return sql<unknown[]>`COALESCE((
		SELECT jsonb_agg(message.data || jsonb_build_object('parts', COALESCE((
			SELECT jsonb_agg(part.data ORDER BY part.ordinal)
			FROM thread_message_parts part
			WHERE part.thread_id = message.thread_id AND part.message_ordinal = message.ordinal
		), '[]'::jsonb)) ORDER BY message.ordinal)
		FROM thread_messages message WHERE message.thread_id = ${sql.ref(threadIdColumn)}
	), '[]'::jsonb)`;
}

export function threadMessageCountSql() {
	return sql<number>`(SELECT count(*)::int FROM thread_messages message WHERE message.thread_id = threads.thread_id)`;
}

/** The authority/identity/thread locks are owned by the calling transaction.
 * Read only small fingerprints, then send and replace only changed parts.
 * Array ordinals preserve the existing transcript order and merge semantics,
 * including historical repeated ids; message id is a lookup, not a new PK. */
async function writeMessage(
	tx: Transaction<AppDatabase>,
	threadId: string,
	ordinal: number,
	message: ThreadMessage,
	existing: { digest: string; part_count: number } | undefined,
) {
	const { parts, ...data } = message;
	const digest = canonicalJsonDigest(message);
	if (existing?.digest === digest) return;
	if (!existing) {
		await tx
			.insertInto("thread_messages")
			.values({
				thread_id: threadId,
				ordinal,
				message_id: message.id,
				data: JSON.stringify(data),
				digest,
				part_count: parts.length,
			})
			.execute();
	} else {
		await tx
			.updateTable("thread_messages")
			.set({
				message_id: message.id,
				data: JSON.stringify(data),
				digest,
				part_count: parts.length,
			})
			.where("thread_id", "=", threadId)
			.where("ordinal", "=", ordinal)
			.execute();
	}
	const previous = existing
		? await tx
				.selectFrom("thread_message_parts")
				.select(["ordinal", "digest"])
				.where("thread_id", "=", threadId)
				.where("message_ordinal", "=", ordinal)
				.execute()
		: [];
	const byOrdinal = new Map(
		previous.map((part) => [part.ordinal, part.digest]),
	);
	const changed = parts.flatMap((part, index) => {
		const partDigest = canonicalJsonDigest(part);
		return byOrdinal.get(index) === partDigest
			? []
			: [
					{
						thread_id: threadId,
						message_ordinal: ordinal,
						ordinal: index,
						data: JSON.stringify(part),
						digest: partDigest,
					},
				];
	});
	// Bound parameters even for transcripts with thousands of tiny parts.
	for (let offset = 0; offset < changed.length; offset += 500) {
		await tx
			.insertInto("thread_message_parts")
			.values(changed.slice(offset, offset + 500))
			.onConflict((conflict) =>
				conflict
					.columns(["thread_id", "message_ordinal", "ordinal"])
					.doUpdateSet((eb) => ({
						data: eb.ref("excluded.data"),
						digest: eb.ref("excluded.digest"),
					})),
			)
			.execute();
	}
	if (previous.some((part) => part.ordinal >= parts.length)) {
		await tx
			.deleteFrom("thread_message_parts")
			.where("thread_id", "=", threadId)
			.where("message_ordinal", "=", ordinal)
			.where("ordinal", ">=", parts.length)
			.execute();
	}
}

/** Replace a logical transcript after the caller has applied admission, merge,
 * claw-back, or Project-remap rules. Unchanged stored parts are never rewritten. */
export async function writeThreadTranscript(
	tx: Transaction<AppDatabase>,
	threadId: string,
	messages: readonly unknown[],
) {
	const parsed = threadMessageSchema.array().parse(messages);
	const previous = await tx
		.selectFrom("thread_messages")
		.select(["ordinal", "digest", "part_count"])
		.where("thread_id", "=", threadId)
		.execute();
	const byOrdinal = new Map(
		previous.map((message) => [message.ordinal, message]),
	);
	for (const [ordinal, message] of parsed.entries()) {
		await writeMessage(tx, threadId, ordinal, message, byOrdinal.get(ordinal));
	}
	await tx
		.deleteFrom("thread_messages")
		.where("thread_id", "=", threadId)
		.where("ordinal", ">=", parsed.length)
		.execute();
}

/** The hot path never loads or serializes the rest of the conversation, nor
 * the stored body of a growing answer. Equal part counts keep the existing
 * incoming-wins rule, and stored attachment metadata remains authoritative. */
export async function mergeThreadResponse(
	tx: Transaction<AppDatabase>,
	threadId: string,
	incoming: unknown,
) {
	const message = threadMessageSchema.parse(incoming);
	const existing = message.id
		? await tx
				.selectFrom("thread_messages")
				.select(["ordinal", "data", "part_count", "digest"])
				.where("thread_id", "=", threadId)
				.where("message_id", "=", message.id)
				.orderBy("ordinal")
				.execute()
		: [];
	if (existing.length) {
		for (const stored of existing) {
			if (message.parts.length < stored.part_count) continue;
			await writeMessage(
				tx,
				threadId,
				stored.ordinal,
				threadMessageSchema.parse(
					preserveStoredThreadAttachments(stored.data, message),
				),
				stored,
			);
		}
	} else {
		const last = await tx
			.selectFrom("thread_messages")
			.select("ordinal")
			.where("thread_id", "=", threadId)
			.orderBy("ordinal", "desc")
			.limit(1)
			.executeTakeFirst();
		await writeMessage(
			tx,
			threadId,
			(last?.ordinal ?? -1) + 1,
			message,
			undefined,
		);
	}
}
