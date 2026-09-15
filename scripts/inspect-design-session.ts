/** Read-only inspection of the current authoring session and its conversations. */
import "dotenv/config";
import { setTimeout as delay } from "node:timers/promises";
import { Command } from "commander";
import { sql } from "kysely";
import { readDesignSession } from "@/lib/agent/anatomy/recorded";
import { closeCaseStoreDatabase } from "@/lib/case-store/postgres/connection";
import { getAppDb } from "@/lib/db/pg";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { runMain } from "./lib/main";
import { targetProdDb } from "./lib/prodDb";

const command = new Command()
	.argument(
		"<id>",
		"session, app, proposed app, thread, run or model-context id",
	)
	.option("--prod", "read production using the operator identity")
	.option(
		"--full",
		"include the Markdown plan, messages, reasoning summaries and tool results",
	)
	.option(
		"--json",
		"print the complete inspection as JSON, including authored content",
	)
	.option("--watch", "print changes every three seconds")
	.option("--until-terminal", "stop watching when the run finishes or fails")
	.parse();
const options = command.opts<{
	prod?: boolean;
	full?: boolean;
	json?: boolean;
	watch?: boolean;
	untilTerminal?: boolean;
}>();
if (options.prod) targetProdDb();

async function inspect(identifier: string) {
	const db = await getAppDb();
	const resolved = await sql<{ id: string }>`
		SELECT session.id FROM design_sessions session
		WHERE session.id::text = ${identifier}
			OR session.app_id = ${identifier} OR session.proposed_app_id = ${identifier}
			OR session.run_id = ${identifier}
			OR EXISTS (SELECT 1 FROM threads thread WHERE thread.design_session_id = session.id
				AND (thread.thread_id = ${identifier} OR thread.run_id = ${identifier}))
			OR EXISTS (SELECT 1 FROM design_model_contexts context WHERE context.design_session_id = session.id
				AND context.id::text = ${identifier})
			OR EXISTS (SELECT 1 FROM run_summaries run WHERE run.design_session_id = session.id AND run.run_id = ${identifier})
		ORDER BY session.updated_at DESC LIMIT 1
	`.execute(db);
	const id = resolved.rows[0]?.id;
	if (!id) throw new Error("No authoring session matches that id.");
	const [
		session,
		event,
		plan,
		workspaces,
		checkpoints,
		runs,
		threads,
		recorded,
	] = await Promise.all([
		db
			.selectFrom("design_sessions")
			.select(["id", "app_id", "state", "mode", "authoring_version"])
			.where("id", "=", id)
			.executeTakeFirstOrThrow(),
		db
			.selectFrom("authoring_events")
			.select(["revision", "kind", "payload", "created_at"])
			.where("design_session_id", "=", id)
			.orderBy("revision", "desc")
			.executeTakeFirst(),
		db
			.selectFrom("authoring_plan_revisions")
			.select(["revision", "editor", "markdown", "created_at"])
			.where("session_id", "=", id)
			.orderBy("revision", "desc")
			.executeTakeFirst(),
		db
			.selectFrom("authoring_workspaces")
			.select(["id", "kind", "status", "base_seq", "plan_revision"])
			.where("design_session_id", "=", id)
			.orderBy("created_at")
			.execute(),
		db
			.selectFrom("authoring_checkpoints")
			.select(["request_id", "plan_revision", "seq", "committed_at"])
			.where("design_session_id", "=", id)
			.orderBy("seq")
			.execute(),
		db
			.selectFrom("run_summaries")
			.select([
				"run_id",
				"model",
				"input_tokens",
				"output_tokens",
				"cache_read_tokens",
				"cost_estimate",
				"started_at",
				"finished_at",
			])
			.where("design_session_id", "=", id)
			.orderBy("started_at")
			.execute(),
		db
			.selectFrom("threads")
			.select(["thread_id", "active_stream_id", "messages"])
			.where((eb) =>
				eb.or([
					eb("design_session_id", "=", id),
					eb(
						"app_id",
						"in",
						db
							.selectFrom("design_sessions")
							.select("app_id")
							.where("id", "=", id),
					),
				]),
			)
			.execute(),
		readDesignSession(id),
	]);
	const full = options.full || options.json;
	return {
		session,
		event: full
			? event
			: event && {
					revision: event.revision,
					kind: event.kind,
					createdAt: event.created_at,
				},
		plan: full
			? plan
			: plan && {
					revision: plan.revision,
					editor: plan.editor,
					characters: plan.markdown.length,
				},
		workspaces,
		checkpoints,
		runs,
		threads: full
			? threads
			: threads.map(({ thread_id, active_stream_id }) => ({
					thread_id,
					active_stream_id,
				})),
		contexts: recorded?.contexts.map((context) =>
			full
				? context
				: {
						id: context.contextId,
						role: context.kind,
						model: context.modelId,
						generation: context.generation,
						promptVersion: context.promptVersion,
						messages: context.items.length,
						integrityFailures: context.items.filter((item) => !item.verified)
							.length,
						steps: context.steps,
					},
		),
	};
}

runMain(async () => {
	if (options.untilTerminal && !options.watch)
		throw new Error("--until-terminal requires --watch.");
	const stop = new AbortController();
	const interrupt = () => stop.abort();
	process.once("SIGINT", interrupt);
	process.once("SIGTERM", interrupt);
	try {
		let previous: string | undefined;
		do {
			const result = await inspect(command.args[0] ?? "");
			const digest = canonicalJsonDigest(result);
			if (digest !== previous) console.log(JSON.stringify(result, null, 2));
			previous = digest;
			if (
				!options.watch ||
				(options.untilTerminal &&
					(result.event?.kind === "finished" ||
						result.event?.kind === "failed") &&
					result.threads.every((thread) => thread.active_stream_id === null))
			)
				break;
			try {
				await delay(3000, undefined, { signal: stop.signal });
			} catch (error) {
				if (!stop.signal.aborted) throw error;
			}
		} while (!stop.signal.aborted);
	} finally {
		process.removeListener("SIGINT", interrupt);
		process.removeListener("SIGTERM", interrupt);
		await closeCaseStoreDatabase();
	}
});
