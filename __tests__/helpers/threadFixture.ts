import type { Insertable, Kysely } from "kysely";
import type { AppDatabase, ThreadsTable } from "@/lib/db/pg";
import { writeThreadTranscript } from "@/lib/db/threadTranscript";

/** A historical thread fixture, with its transcript committed atomically through
 * the production row writer. Holder/admission tests use the actual thread APIs. */
export async function insertThreadFixture(
	db: Kysely<AppDatabase>,
	row: Insertable<ThreadsTable> & { messages: string },
) {
	const { messages, ...header } = row;
	await db.transaction().execute(async (tx) => {
		await tx.insertInto("threads").values(header).execute();
		await writeThreadTranscript(tx, row.thread_id, JSON.parse(messages));
	});
}
