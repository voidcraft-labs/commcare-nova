import { createHash } from "node:crypto";
import { type Kysely, sql } from "kysely";
import {
	canonicalJsonDigest,
	canonicalJsonText,
} from "@/lib/utils/canonicalJson";
import { LEASE_COLUMNS, leaseView } from "./leaseView";
import type { AppDatabase } from "./pg";
import { designSessionLeaseState, runLeaseState } from "./runLiveness";
import { threadMessagesSql } from "./threadTranscript";
import { threadMessageSchema } from "./types";

export async function hasLegacyThreadStorage<DB>(
	db: Kysely<DB>,
): Promise<boolean> {
	const result = await sql<{ present: boolean }>`SELECT EXISTS (
		SELECT 1 FROM information_schema.columns
		WHERE table_schema = 'public' AND table_name = 'threads' AND column_name = 'messages'
	) AS present`.execute(db);
	return result.rows[0].present;
}

/** The caller owns a repeatable-read snapshot (or the maintenance table locks).
 * The digest fences every logical message and its thread identity, not volatile
 * stream markers. Reports contain no conversation text or operational ids. */
export async function scanThreadStorage(db: Kysely<AppDatabase>) {
	const legacy = await hasLegacyThreadStorage(db);
	const report = {
		format: legacy ? "whole-transcript" : "message-parts",
		threads: 0,
		messages: 0,
		parts: 0,
		bytes: 0,
		largestThreadBytes: 0,
		largestMessageBytes: 0,
		largestPartBytes: 0,
		invalidThreads: 0,
		lossyThreads: 0,
		duplicateMessageIds: 0,
		emptyMessageIds: 0,
		attachments: 0,
		selectedSources: 0,
		invalidStoredRows: 0,
	};
	const digest = createHash("sha256");
	let after: string | undefined;
	while (true) {
		const rows = await db
			.selectFrom("threads")
			.select([
				"thread_id",
				"selected_sources",
				(legacy ? sql<unknown[]>`threads.messages` : threadMessagesSql()).as(
					"messages",
				),
			])
			.where(sql<boolean>`${after === undefined} OR thread_id > ${after ?? ""}`)
			.orderBy("thread_id")
			.limit(50)
			.execute();
		if (!rows.length) break;
		for (const row of rows) {
			report.threads++;
			if (legacy) {
				const roundTrip = await sql<{
					unchanged: boolean;
				}>`SELECT messages = ${JSON.stringify(row.messages)}::jsonb AS unchanged FROM threads WHERE thread_id = ${row.thread_id}`.execute(
					db,
				);
				if (!roundTrip.rows[0].unchanged) report.lossyThreads++;
			}
			digest.update(
				canonicalJsonText({ threadId: row.thread_id, messages: row.messages }),
			);
			const bytes = Buffer.byteLength(JSON.stringify(row.messages));
			report.bytes += bytes;
			report.largestThreadBytes = Math.max(report.largestThreadBytes, bytes);
			const parsed = threadMessageSchema.array().safeParse(row.messages);
			if (!parsed.success) report.invalidThreads++;
			else {
				const ids = new Set<string>();
				for (const message of parsed.data) {
					report.messages++;
					if (ids.has(message.id)) report.duplicateMessageIds++;
					if (!message.id) report.emptyMessageIds++;
					ids.add(message.id);
					report.largestMessageBytes = Math.max(
						report.largestMessageBytes,
						Buffer.byteLength(JSON.stringify(message)),
					);
					for (const part of message.parts) {
						report.parts++;
						report.largestPartBytes = Math.max(
							report.largestPartBytes,
							Buffer.byteLength(JSON.stringify(part)),
						);
					}
					const metadata = message.metadata as
						| { attachments?: unknown[] }
						| undefined;
					report.attachments += metadata?.attachments?.length ?? 0;
				}
			}
			report.selectedSources += row.selected_sources.length;
			if (!legacy) {
				const messages = await db
					.selectFrom("thread_messages")
					.selectAll()
					.where("thread_id", "=", row.thread_id)
					.orderBy("ordinal")
					.execute();
				const parts = await db
					.selectFrom("thread_message_parts")
					.selectAll()
					.where("thread_id", "=", row.thread_id)
					.orderBy("message_ordinal")
					.orderBy("ordinal")
					.execute();
				for (const [ordinal, message] of messages.entries()) {
					const body = parts.filter(
						(part) => part.message_ordinal === message.ordinal,
					);
					if (
						message.ordinal !== ordinal ||
						message.part_count !== body.length ||
						message.message_id !== message.data.id ||
						message.digest !== canonicalJsonDigest(row.messages[ordinal])
					)
						report.invalidStoredRows++;
					for (const [partOrdinal, part] of body.entries()) {
						if (
							part.ordinal !== partOrdinal ||
							part.digest !== canonicalJsonDigest(part.data)
						)
							report.invalidStoredRows++;
					}
				}
			}
			after = row.thread_id;
		}
	}
	const apps = await db.selectFrom("apps").select(LEASE_COLUMNS).execute();
	const sessions = await db.selectFrom("design_sessions").selectAll().execute();
	const leases = [
		...apps.map((row) => runLeaseState(leaseView(row))),
		...sessions.map((row) => designSessionLeaseState(row)),
	];
	return {
		...report,
		runningTargets: leases.filter((lease) => lease.live && !lease.paused)
			.length,
		pausedTargets: leases.filter((lease) => lease.paused).length,
		unsettledTargets: leases.filter((lease) => lease.markerSettleable).length,
		transcriptDigest: digest.digest("hex"),
	};
}
