/**
 * Thread persistence — the durable conversation store's contract, on a real
 * per-test Postgres.
 *
 * The invariants under test are the ones the resume design leans on:
 *
 *  - `upsertThreadTurn` marks the thread live and MERGES the incoming
 *    history into the stored transcript (a stale tab must not erase turns
 *    other sessions added); its update arm is app-guarded so a forged
 *    thread id writes nothing.
 *  - `appendThreadResponse` merges the assistant message AND retires the
 *    live-stream marker — but ONLY while the marker still names its own
 *    run's stream, so a finalize that lost the app to a newer claim can't
 *    clobber that claim's fresh marker.
 *  - a response continuing the trailing assistant message (an answered
 *    askQuestions round) REPLACES it rather than appending a same-id
 *    sibling — mirroring the client's own continuation semantics.
 *  - `listThreadMetas` orders by recency and carries the live marker; the
 *    loaders reconcile a marker against ACTUAL app liveness, stripping and
 *    healing one stranded by a run that died before finalize.
 *
 * The seeded app is `generating` (held live) so live markers survive the
 *  loaders' liveness reconciliation; the heal test seeds an at-rest app.
 */
import type { UIMessage } from "ai";
import { beforeEach, describe, expect, it } from "vitest";
import { getAppDb } from "../pg";
import {
	appendThreadResponse,
	listThreadMetas,
	loadThread,
	mergeTranscript,
	resolveThreadStream,
	upsertThreadTurn,
} from "../threads";
import { setupAppStateTestDb } from "./appStateTestDb";

const h = setupAppStateTestDb("threads_");
const APP = "app-threads";
const OTHER_APP = "app-other";

beforeEach(async () => {
	/* `generating` + fresh updated_at = held live (the build lease), so the
	 * loaders' dead-marker reconciliation leaves live markers alone. */
	await h.seedApp({ id: APP, status: "generating" });
	await h.seedApp({ id: OTHER_APP, status: "generating" });
});

function userMsg(id: string, text: string): UIMessage {
	return { id, role: "user", parts: [{ type: "text", text }] };
}

function assistantMsg(id: string, text: string): UIMessage {
	return { id, role: "assistant", parts: [{ type: "text", text }] };
}

const T1 = "thread-1";

describe("mergeTranscript", () => {
	const m = (id: string, partCount = 1) => ({
		id,
		parts: Array.from({ length: partCount }, (_, i) => ({
			type: "text",
			text: `p${i}`,
		})),
	});

	it("unions: stored-only survive, incoming-only append in order", () => {
		const merged = mergeTranscript([m("a"), m("b")], [m("a"), m("c"), m("d")]);
		expect(merged.map((x) => x.id)).toEqual(["a", "b", "c", "d"]);
	});

	it("richer version wins a shared id; incoming wins ties", () => {
		const richStored = m("a", 3);
		const staleIncoming = m("a", 1);
		expect(mergeTranscript([richStored], [staleIncoming])[0]).toBe(richStored);

		const tieIncoming = m("b", 2);
		expect(mergeTranscript([m("b", 2)], [tieIncoming])[0]).toBe(tieIncoming);
	});
});

describe("upsertThreadTurn", () => {
	it("inserts a new thread live, with the first user text as summary", async () => {
		const written = await upsertThreadTurn({
			appId: APP,
			threadId: T1,
			runId: "run-1",
			streamId: "stream-1",
			threadType: "build",
			messages: [userMsg("m1", "a clinic registration app")],
		});
		expect(written).toBe(true);

		const doc = await loadThread(APP, T1);
		expect(doc?.summary).toBe("a clinic registration app");
		expect(doc?.thread_type).toBe("build");
		expect(doc?.run_id).toBe("run-1");
		expect(doc?.active_stream_id).toBe("stream-1");
		expect(doc?.messages).toHaveLength(1);
	});

	it("updates transcript + run + stream on an existing thread, pinning summary/type/created_at", async () => {
		await upsertThreadTurn({
			appId: APP,
			threadId: T1,
			runId: "run-1",
			streamId: "stream-1",
			threadType: "build",
			messages: [userMsg("m1", "first ask")],
		});
		const before = await loadThread(APP, T1);

		const written = await upsertThreadTurn({
			appId: APP,
			threadId: T1,
			runId: "run-2",
			streamId: "stream-2",
			threadType: "edit",
			messages: [
				userMsg("m1", "first ask"),
				assistantMsg("m2", "done"),
				userMsg("m3", "now add a follow-up form"),
			],
		});
		expect(written).toBe(true);

		const doc = await loadThread(APP, T1);
		expect(doc?.messages).toHaveLength(3);
		expect(doc?.run_id).toBe("run-2");
		expect(doc?.active_stream_id).toBe("stream-2");
		// Identity fields pin to the first write.
		expect(doc?.summary).toBe("first ask");
		expect(doc?.thread_type).toBe("build");
		expect(doc?.created_at).toBe(before?.created_at);
	});

	it("MERGES a stale client's history instead of erasing other sessions' turns", async () => {
		/* Session A persisted a full exchange; session B (hydrated before it,
		 * never re-fetched) sends its own turn on top of the OLD history. The
		 * durable transcript must keep A's exchange AND gain B's turn. */
		await upsertThreadTurn({
			appId: APP,
			threadId: T1,
			runId: "run-a",
			streamId: "stream-a",
			threadType: "build",
			messages: [
				userMsg("m1", "first ask"),
				userMsg("m2", "session A's turn"),
				assistantMsg("m3", "session A's answer"),
			],
		});

		await upsertThreadTurn({
			appId: APP,
			threadId: T1,
			runId: "run-b",
			streamId: "stream-b",
			threadType: "build",
			messages: [userMsg("m1", "first ask"), userMsg("m4", "session B's turn")],
		});

		const doc = await loadThread(APP, T1);
		expect(doc?.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3", "m4"]);
		expect(doc?.active_stream_id).toBe("stream-b");
	});

	it("keeps the RICHER version of a shared message (a continuation-extended reply)", async () => {
		await upsertThreadTurn({
			appId: APP,
			threadId: T1,
			runId: "run-a",
			streamId: "stream-a",
			threadType: "build",
			messages: [
				userMsg("m1", "ask"),
				{
					id: "m2",
					role: "assistant",
					parts: [
						{ type: "text", text: "question round" },
						{ type: "text", text: "continuation answer" },
					],
				},
			],
		});

		// A stale copy of m2 (one part) must not regress the stored two-part one.
		await upsertThreadTurn({
			appId: APP,
			threadId: T1,
			runId: "run-b",
			streamId: "stream-b",
			threadType: "build",
			messages: [
				userMsg("m1", "ask"),
				assistantMsg("m2", "question round"),
				userMsg("m5", "next turn"),
			],
		});

		const doc = await loadThread(APP, T1);
		expect(doc?.messages[1]?.parts).toHaveLength(2);
		expect(doc?.messages.map((m) => m.id)).toEqual(["m1", "m2", "m5"]);
	});

	it("writes NOTHING when the thread id belongs to another app", async () => {
		await upsertThreadTurn({
			appId: APP,
			threadId: T1,
			runId: "run-1",
			streamId: "stream-1",
			threadType: "build",
			messages: [userMsg("m1", "mine")],
		});

		const written = await upsertThreadTurn({
			appId: OTHER_APP,
			threadId: T1,
			runId: "run-x",
			streamId: "stream-x",
			threadType: "edit",
			messages: [userMsg("mx", "hijack attempt")],
		});
		expect(written).toBe(false);

		// The original row is untouched, and the other app gained nothing.
		const doc = await loadThread(APP, T1);
		expect(doc?.run_id).toBe("run-1");
		expect(doc?.summary).toBe("mine");
		expect(await loadThread(OTHER_APP, T1)).toBeNull();
	});
});

describe("appendThreadResponse", () => {
	beforeEach(async () => {
		await upsertThreadTurn({
			appId: APP,
			threadId: T1,
			runId: "run-1",
			streamId: "stream-1",
			threadType: "build",
			messages: [userMsg("m1", "build me an app")],
		});
	});

	it("appends the assistant message and clears the live marker in one write", async () => {
		await appendThreadResponse({
			appId: APP,
			threadId: T1,
			streamId: "stream-1",
			responseMessage: assistantMsg("m2", "built it"),
		});

		const doc = await loadThread(APP, T1);
		expect(doc?.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
		expect(doc?.active_stream_id).toBeNull();
	});

	it("clears the live marker even with no response to keep (a zero-step failure)", async () => {
		await appendThreadResponse({
			appId: APP,
			threadId: T1,
			streamId: "stream-1",
			responseMessage: null,
		});

		const doc = await loadThread(APP, T1);
		expect(doc?.messages).toHaveLength(1);
		expect(doc?.active_stream_id).toBeNull();
	});

	it("REPLACES a trailing same-id assistant message (a continuation), never splits it", async () => {
		/* An answered askQuestions round: the incoming history's last message
		 * is the assistant's; the continuation streams under the SAME message
		 * id and the assembled response carries the merged parts. */
		await upsertThreadTurn({
			appId: APP,
			threadId: T1,
			runId: "run-1",
			streamId: "stream-2",
			threadType: "build",
			messages: [
				userMsg("m1", "build me an app"),
				assistantMsg("m2", "which case type?"),
			],
		});
		const merged: UIMessage = {
			id: "m2",
			role: "assistant",
			parts: [
				{ type: "text", text: "which case type?" },
				{ type: "text", text: "done — added the client module" },
			],
		};
		await appendThreadResponse({
			appId: APP,
			threadId: T1,
			streamId: "stream-2",
			responseMessage: merged,
		});

		const doc = await loadThread(APP, T1);
		expect(doc?.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
		expect(doc?.messages[1]?.parts).toHaveLength(2);
	});

	it("is app-guarded like the upsert", async () => {
		await appendThreadResponse({
			appId: OTHER_APP,
			threadId: T1,
			streamId: "stream-1",
			responseMessage: assistantMsg("mx", "hijack"),
		});
		const doc = await loadThread(APP, T1);
		expect(doc?.messages).toHaveLength(1);
		expect(doc?.active_stream_id).toBe("stream-1");
	});

	it("never clobbers a NEWER claim's marker or turns (finalize lost the race)", async () => {
		/* The app releases before finalize completes, so a competing POST can
		 * claim + persist its turn first. The old run's late append must merge
		 * its response WITHOUT touching the new run's marker or its turn. */
		await upsertThreadTurn({
			appId: APP,
			threadId: T1,
			runId: "run-2",
			streamId: "stream-2",
			threadType: "build",
			messages: [
				userMsg("m1", "build me an app"),
				userMsg("m3", "the NEWER claim's turn"),
			],
		});

		await appendThreadResponse({
			appId: APP,
			threadId: T1,
			streamId: "stream-1", // the OLD run's stream — no longer the marker
			responseMessage: assistantMsg("m2", "the old run's answer"),
		});

		const doc = await loadThread(APP, T1);
		expect(doc?.messages.map((m) => m.id)).toEqual(["m1", "m3", "m2"]);
		// The newer run is still resumable — its marker survived.
		expect(doc?.active_stream_id).toBe("stream-2");
	});
});

describe("loaders", () => {
	it("listThreadMetas orders by recency and carries counts + live markers", async () => {
		await upsertThreadTurn({
			appId: APP,
			threadId: "t-old",
			runId: "run-1",
			streamId: "s1",
			threadType: "build",
			messages: [userMsg("m1", "older"), assistantMsg("m2", "ok")],
		});
		await appendThreadResponse({
			appId: APP,
			threadId: "t-old",
			streamId: "s1",
			responseMessage: null,
		});
		await upsertThreadTurn({
			appId: APP,
			threadId: "t-new",
			runId: "run-2",
			streamId: "s2",
			threadType: "edit",
			messages: [userMsg("m3", "newer")],
		});
		/* The writes above can land within one millisecond (ISO-text
		 * timestamps), which would leave recency a tie — backdate the older
		 * thread so the ordering under test is the data's, not the clock's. */
		const db = await getAppDb();
		await db
			.updateTable("threads")
			.set({ updated_at: new Date(Date.now() - 60_000).toISOString() })
			.where("thread_id", "=", "t-old")
			.execute();

		const metas = await listThreadMetas(APP);
		expect(metas.map((m) => m.thread_id)).toEqual(["t-new", "t-old"]);
		expect(metas[0].active_stream_id).toBe("s2");
		expect(metas[0].message_count).toBe(1);
		expect(metas[1].active_stream_id).toBeNull();
		expect(metas[1].message_count).toBe(2);
	});

	it("resolveThreadStream resolves globally by thread id", async () => {
		await upsertThreadTurn({
			appId: APP,
			threadId: T1,
			runId: "run-1",
			streamId: "stream-1",
			threadType: "build",
			messages: [userMsg("m1", "hello")],
		});

		expect(await resolveThreadStream(T1)).toEqual({
			appId: APP,
			activeStreamId: "stream-1",
		});
		expect(await resolveThreadStream("nope")).toBeNull();
	});

	it("strips AND heals a marker stranded by a run that died before finalize", async () => {
		/* An at-rest app (no live run) with a marked thread is the
		 * instance-death signature — finalize never ran, so nothing cleared
		 * the marker. The loaders must report it dead (no perpetual LIVE
		 * badge, no phantom resume) and repair the row. */
		const deadApp = await h.seedApp({ id: "app-dead", status: "complete" });
		await upsertThreadTurn({
			appId: deadApp,
			threadId: "t-stranded",
			runId: "run-dead",
			streamId: "stream-dead",
			threadType: "build",
			messages: [userMsg("m1", "a build the deploy killed")],
		});

		const metas = await listThreadMetas(deadApp);
		expect(metas[0].active_stream_id).toBeNull();

		// The row itself healed — the raw column is cleared, not just stripped.
		const db = await getAppDb();
		const row = await db
			.selectFrom("threads")
			.select(["active_stream_id"])
			.where("thread_id", "=", "t-stranded")
			.executeTakeFirst();
		expect(row?.active_stream_id).toBeNull();
	});
});
