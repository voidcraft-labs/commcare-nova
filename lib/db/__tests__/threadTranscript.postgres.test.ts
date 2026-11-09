import { createHash } from "node:crypto";
import type { UIMessage } from "ai";
import { Kysely, PostgresDialect, sql } from "kysely";
import { expect, it } from "vitest";
import { insertThreadFixture } from "@/__tests__/helpers/threadFixture";
import { __setAppDbForTests, type AppDatabase } from "../pg";
import { loadThread, persistResponseSnapshot } from "../threads";
import { threadMessagesSql, writeThreadTranscript } from "../threadTranscript";
import { setupAppStateTestDb } from "./appStateTestDb";

const h = setupAppStateTestDb("thread_parts_");
const APP = "parts-app";
const THREAD = "parts-thread";
const STREAM = "parts-stream";

async function seed(messages: UIMessage[]) {
	await h.seedApp({ id: APP });
	await insertThreadFixture(h.db(), {
		thread_id: THREAD,
		app_id: APP,
		design_session_id: null,
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
		thread_type: "edit",
		summary: "Synthetic transcript",
		run_id: "parts-run",
		active_stream_id: STREAM,
		messages: JSON.stringify(messages),
	});
}

async function snapshot(responseMessage: UIMessage, clearMarker = false) {
	await persistResponseSnapshot({
		target: { kind: "app", appId: APP },
		threadId: THREAD,
		streamId: STREAM,
		expectedProjectId: "project-test",
		responseMessage,
		clearMarker,
	});
}

it("updates only changed parts and atomically commits their terminal marker", async () => {
	const user: UIMessage = {
		id: "user",
		role: "user",
		parts: [{ type: "text", text: "Original request" }],
	};
	const answer: UIMessage = {
		id: "answer",
		role: "assistant",
		parts: [
			{ type: "text", text: "Completed step" },
			{ type: "text", text: "In progress" },
		],
	};
	await seed([user, answer]);
	const tuples = () =>
		sql<{ message_ordinal: number; ordinal: number; version: string }>`
		SELECT message_ordinal, ordinal, xmin::text AS version FROM thread_message_parts
		WHERE thread_id = ${THREAD} ORDER BY message_ordinal, ordinal`.execute(
			h.db(),
		);
	const before = (await tuples()).rows;
	const completed: UIMessage = {
		...answer,
		parts: [
			answer.parts[0],
			{ type: "text", text: "Finished" },
			{ type: "text", text: "New step" },
		],
	};
	await snapshot(completed);
	const after = (await tuples()).rows;
	expect(after.slice(0, 2)).toEqual(before.slice(0, 2));
	expect(after[2].version).not.toBe(before[2].version);
	expect(after).toHaveLength(4);
	await snapshot(completed);
	expect((await tuples()).rows).toEqual(after);
	await sql`CREATE FUNCTION reject_terminal_marker() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN IF NEW.active_stream_id IS NULL THEN RAISE EXCEPTION 'controlled terminal failure'; END IF; RETURN NEW; END $$`.execute(
		h.db(),
	);
	await sql`CREATE TRIGGER reject_terminal_marker BEFORE UPDATE ON threads FOR EACH ROW EXECUTE FUNCTION reject_terminal_marker()`.execute(
		h.db(),
	);
	const final: UIMessage = {
		...completed,
		parts: [...completed.parts, { type: "text", text: "Final" }],
	};
	await expect(snapshot(final, true)).rejects.toThrow(
		"controlled terminal failure",
	);
	expect((await tuples()).rows).toEqual(after);
	const stored = await h
		.db()
		.selectFrom("threads")
		.select(["active_stream_id", threadMessagesSql().as("messages")])
		.where("thread_id", "=", THREAD)
		.executeTakeFirstOrThrow();
	expect(stored).toEqual({
		active_stream_id: STREAM,
		messages: [user, completed],
	});
	await sql`DROP TRIGGER reject_terminal_marker ON threads`.execute(h.db());
	await snapshot(final, true);
	expect(
		(await loadThread({ kind: "app", appId: APP }, THREAD))?.messages,
	).toEqual([user, final]);
});

it("preserves message order and only deletes the explicit replacement suffix", async () => {
	const messages: UIMessage[] = ["one", "two", "three"].map((id) => ({
		id,
		role: "user",
		parts: [{ type: "text", text: id }],
	}));
	await seed(messages);
	await h
		.db()
		.transaction()
		.execute((tx) => writeThreadTranscript(tx, THREAD, messages.slice(0, 2)));
	expect(
		(await loadThread({ kind: "app", appId: APP }, THREAD))?.messages,
	).toEqual(messages.slice(0, 2));
	expect(
		await h
			.db()
			.selectFrom("thread_message_parts")
			.select("message_ordinal")
			.where("thread_id", "=", THREAD)
			.execute(),
	).toHaveLength(2);
});

/** The control is the former whole-value storage operation on a synthetic
 * table, under the same app/thread locks. It is a storage microbenchmark;
 * concurrency/authorization coverage runs through the actual thread APIs. */
it("bounds snapshot SQL bytes as the history and active answer grow", async () => {
	const text = (seed: string, blocks: number) =>
		Array.from({ length: blocks }, (_, index) =>
			createHash("sha256").update(`${seed}:${index}`).digest("hex"),
		).join("");
	const history: UIMessage[] = Array.from({ length: 64 }, (_, index) => ({
		id: `history-${index}`,
		role: index % 2 ? "assistant" : "user",
		parts: [{ type: "text", text: text(`history-${index}`, 256) }],
	}));
	await seed(history);
	await sql`CREATE TABLE transcript_control (id text PRIMARY KEY, messages jsonb NOT NULL)`.execute(
		h.db(),
	);
	await sql`INSERT INTO transcript_control VALUES (${THREAD}, ${JSON.stringify(history)}::jsonb)`.execute(
		h.db(),
	);
	let bytes = 0;
	let databaseMs = 0;
	// The fixture owns this pool; this instrumented facade owns no connection.
	const measured = new Kysely<AppDatabase>({
		dialect: new PostgresDialect({ pool: h.pool() }),
		log(event) {
			bytes += Buffer.byteLength(JSON.stringify(event.query.parameters));
			databaseMs += event.queryDurationMillis;
		},
	});
	const samples: {
		kind: string;
		parameterBytes: number;
		connectionMs: number;
		databaseMs: number;
	}[] = [];
	const snapshots: UIMessage[] = [];
	for (let index = 0; index < 24; index++)
		snapshots.push({
			id: "growing-answer",
			role: "assistant",
			parts: Array.from({ length: index + 1 }, (_, part) => ({
				type: "text",
				text: text(`step-${part}`, 128),
			})),
		});
	try {
		__setAppDbForTests(measured);
		for (const kind of ["whole-value-control", "incremental"] as const) {
			bytes = 0;
			databaseMs = 0;
			const started = performance.now();
			for (const answer of snapshots) {
				if (kind === "incremental") await snapshot(answer);
				else
					await measured.transaction().execute(async (tx) => {
						await tx
							.selectFrom("apps")
							.select("id")
							.where("id", "=", APP)
							.forShare()
							.execute();
						await tx
							.selectFrom("threads")
							.select("thread_id")
							.where("thread_id", "=", THREAD)
							.forUpdate()
							.execute();
						const row = await sql<{
							messages: UIMessage[];
						}>`SELECT messages FROM transcript_control WHERE id = ${THREAD}`.execute(
							tx,
						);
						const merged = [
							...row.rows[0].messages.filter(
								(message) => message.id !== answer.id,
							),
							answer,
						];
						await sql`UPDATE transcript_control SET messages = ${JSON.stringify(merged)}::jsonb WHERE id = ${THREAD}`.execute(
							tx,
						);
					});
			}
			samples.push({
				kind,
				parameterBytes: bytes,
				connectionMs: performance.now() - started,
				databaseMs,
			});
		}
	} finally {
		__setAppDbForTests(h.db());
	}
	const control = await sql<{
		messages: UIMessage[];
	}>`SELECT messages FROM transcript_control WHERE id = ${THREAD}`.execute(
		h.db(),
	);
	expect(
		(await loadThread({ kind: "app", appId: APP }, THREAD))?.messages,
	).toEqual(control.rows[0].messages);
	expect(samples[1].parameterBytes).toBeLessThan(
		samples[0].parameterBytes / 20,
	);
	// Durations are measurements, not a flaky speed assertion on shared CI.
	console.info(
		"Transcript storage synthetic benchmark",
		JSON.stringify(samples),
	);
});
