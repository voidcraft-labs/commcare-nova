/**
 * Cross-kind id resolution for the inspect scripts' not-found paths.
 *
 * An app id that "isn't found" is usually one of two mistakes, and a bare
 * "not found" helps with neither:
 *
 *   - the id names a DIFFERENT ENTITY KIND — a run id copied off a log
 *     line or an error report, a thread id — whose owning app is one
 *     query away;
 *   - the id is right but the DATABASE is wrong — the entity lives in
 *     the local dev Postgres and the script was pointed at production
 *     (`--prod`), or vice versa.
 *
 * `describeUnknownId` answers both: it looks the id up as every other
 * kind this database knows (finalized runs via `run_summaries`, live or
 * never-finalized runs via `events`, threads via `threads`) and names
 * the owning app when it hits, and it always says WHICH database was
 * searched and how to flip to the other one. Read-only.
 */

import { getAppDb } from "@/lib/db/pg";

/**
 * Diagnostic lines for an id that didn't resolve as an app id. Print them
 * after the "not found" line. `prod` is the script's `--prod` flag — it
 * only changes the which-database wording, never the queries (the caller
 * already pointed the connection layer at the right instance).
 */
export async function describeUnknownId(
	id: string,
	prod: boolean,
): Promise<string[]> {
	const lines: string[] = [];
	const db = await getAppDb();

	const runSummary = await db
		.selectFrom("run_summaries")
		.select("app_id")
		.where("run_id", "=", id)
		.executeTakeFirst();
	// A run that logged events but never finalized has no summary row —
	// the events table still knows its app.
	const runEvent = runSummary
		? undefined
		: await db
				.selectFrom("events")
				.select("app_id")
				.where("run_id", "=", id)
				.limit(1)
				.executeTakeFirst();
	const runAppId = runSummary?.app_id ?? runEvent?.app_id;
	if (runAppId !== undefined) {
		lines.push(
			`This id is a RUN on app ${runAppId}${runSummary ? "" : " (never finalized — no summary row)"}.`,
			`  npx tsx scripts/inspect-app.ts ${runAppId}${prod ? " --prod" : ""}`,
			`  npx tsx scripts/inspect-logs.ts ${runAppId} --run=${id}${prod ? " --prod" : ""}`,
		);
	}

	if (runAppId === undefined) {
		const thread = await db
			.selectFrom("threads")
			.select(["app_id", "run_id"])
			.where("thread_id", "=", id)
			.executeTakeFirst();
		if (thread) {
			lines.push(
				`This id is a THREAD on app ${thread.app_id} (run ${thread.run_id}).`,
				`  npx tsx scripts/inspect-app.ts ${thread.app_id}${prod ? " --prod" : ""} --threads`,
				`  npx tsx scripts/inspect-logs.ts ${thread.app_id} --run=${thread.run_id}${prod ? " --prod" : ""}`,
			);
		}
	}

	lines.push(
		prod
			? "Searched the PRODUCTION database (--prod). If this is local dev data, drop --prod."
			: "Searched the LOCAL dev database (NOVA_DB_LOCAL_URL). If this is production data, add --prod.",
	);
	return lines;
}
