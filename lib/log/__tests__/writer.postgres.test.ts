/** Real INSERT, JSONB, identity allocation and failure isolation. Batching
 * schedules use controlled sinks in writer.test.ts rather than database waits. */
import { sql } from "kysely";
import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { DESTINATIONS_LOOKUP } from "@/lib/__tests__/lookupFixtures";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import type { SelectOptionsSource } from "@/lib/domain";
import { lookupTableIdSchema } from "@/lib/domain/lookupIds";
import { readEvents } from "../reader";
import type { Event, MutationEvent } from "../types";
import { LogWriter } from "../writer";

const h = setupAppStateTestDb("log_writer_");
const APP = "app-writer";
function event(seq: number): MutationEvent {
	return {
		kind: "mutation",
		runId: "run",
		ts: 1000 + seq,
		seq,
		source: "chat",
		actor: "agent",
		stage: "app",
		mutation: { kind: "setAppName", name: `Name ${seq}` },
	};
}

it("persists each complete event with an authoritative source and matching query envelope", async () => {
	const writer = new LogWriter(APP, "mcp");
	const events: Event[] = [
		event(0),
		{
			kind: "conversation",
			runId: "run",
			ts: 1001,
			seq: 1,
			source: "chat",
			payload: { type: "user-message", text: "A visit" },
		},
	];
	for (const e of events) writer.logEvent(e);
	await writer.flush();
	const rows = await h
		.db()
		.selectFrom("events")
		.selectAll()
		.orderBy("seq")
		.execute();
	expect(
		rows.map(({ id, ts, ...row }) => ({ ...row, ts: Number(ts) })),
	).toEqual(
		events.map((e) => ({
			app_id: APP,
			run_id: e.runId,
			ts: e.ts,
			seq: e.seq,
			source: "mcp",
			kind: e.kind,
			event: { ...e, source: "mcp" },
		})),
	);
	expect(new Set(rows.map((row) => row.id)).size).toBe(2);
	expect(await readEvents(APP, "run")).toEqual(
		events.map((e) => ({ ...e, source: "mcp" })),
	);
});

it("retains concurrent writers' events even when run, timestamp and sequence collide", async () => {
	const chat = new LogWriter(APP, "chat");
	const mcp = new LogWriter(APP, "mcp");
	const first = event(0);
	const second = {
		...event(0),
		mutation: { kind: "setAppName", name: "From MCP" },
	} satisfies Event;
	chat.logEvent(first);
	mcp.logEvent(second);
	await Promise.all([chat.flush(), mcp.flush()]);
	const rows = await h
		.db()
		.selectFrom("events")
		.selectAll()
		.orderBy("source")
		.execute();
	expect(rows.map((row) => row.event)).toEqual([
		first,
		{ ...second, source: "mcp" },
	]);
	expect(new Set(rows.map((row) => row.id)).size).toBe(2);
});

it("preserves lookup identity changes and inline replacement through JSONB and the strict reader", async () => {
	const source = DESTINATIONS_LOOKUP.optionsSource;
	const replacements: SelectOptionsSource[] = [
		source,
		{
			...source,
			tableId: lookupTableIdSchema.parse(
				"018f3e8a-7b2c-7def-8abc-1234567890ac",
			),
		},
		{
			kind: "inline",
			options: [
				{
					uuid: testUuid("option"),
					value: "a",
					label: { parts: [{ kind: "text", text: "A" }] },
				},
				{
					uuid: testUuid("option-b"),
					value: "b",
					label: { parts: [{ kind: "text", text: "B" }] },
				},
			],
		},
	];
	const events = replacements.map(
		(optionsSource, seq): Event => ({
			...event(seq),
			kind: "mutation",
			actor: "agent",
			mutation: {
				kind: "updateField",
				uuid: testUuid("field"),
				targetKind: "single_select",
				patch: { optionsSource },
			},
		}),
	);
	const writer = new LogWriter(APP, "chat");
	for (const e of events) writer.logEvent(e);
	await writer.flush();
	const rows = await h
		.db()
		.selectFrom("events")
		.select("event")
		.orderBy("seq")
		.execute();
	expect(rows.map((row) => row.event)).toEqual(events);
	expect(await readEvents(APP, "run")).toEqual(events);
});

it("loses the failed batch atomically and accepts a later batch after a real INSERT refusal", async () => {
	await sql`create function reject_log_event() returns trigger language plpgsql as $$ begin if NEW.seq = 1 then raise exception 'event insert refused'; end if; return NEW; end; $$`.execute(
		h.db(),
	);
	await sql`create trigger reject_log_event before insert on events for each row execute function reject_log_event()`.execute(
		h.db(),
	);
	const writer = new LogWriter(APP, "chat");
	writer.logEvent(event(0));
	writer.logEvent(event(1));
	await expect(writer.flush()).resolves.toBeUndefined();
	expect(await h.db().selectFrom("events").selectAll().execute()).toEqual([]);
	await sql`drop trigger reject_log_event on events`.execute(h.db());
	writer.logEvent(event(2));
	await expect(writer.flush()).resolves.toBeUndefined();
	expect(await readEvents(APP, "run")).toEqual([event(2)]);
});
