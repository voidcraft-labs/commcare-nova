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
 *    loaders reconcile a marker against ACTUAL app liveness — REPORT-ONLY:
 *    a marker stranded by a run that died before finalize is stripped from
 *    the projection and stamped `resume_interrupted`, but the row is never
 *    written, so the signal stands until a re-drive retires it.
 *
 * The seeded app is `generating` (held live) so live markers survive the
 *  loaders' liveness reconciliation; the dead-marker tests seed an at-rest
 *  app.
 */
import type { UIMessage } from "ai";
import { beforeEach, describe, expect, it } from "vitest";
import { getAppDb } from "../pg";
import {
	appendThreadResponse,
	listThreadMetas,
	loadThread,
	mergeThreadTurnMessages,
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

	it("strips a dead marker from the projection but NEVER writes the row — the signal is level-triggered", async () => {
		/* An at-rest app (no live run) with a marked thread is the
		 * instance-death signature — finalize never ran, so nothing cleared
		 * the marker. The loaders must report it dead (no perpetual LIVE
		 * badge, no phantom resume) while leaving the ROW untouched: a read
		 * must not consume the recovery signal (the thread list, a heal
		 * refetch, and the page load all read these rows, and only one of
		 * them re-drives). */
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
		expect(metas[0].resume_interrupted).toBe(true);

		// Report-only: the raw column survives the read.
		const db = await getAppDb();
		const row = await db
			.selectFrom("threads")
			.select(["active_stream_id"])
			.where("thread_id", "=", "t-stranded")
			.executeTakeFirst();
		expect(row?.active_stream_id).toBe("stream-dead");

		/* Level-triggered: EVERY subsequent load re-derives the signal until
		 * an acting re-drive retires the marker through its own run. */
		const again = await listThreadMetas(deadApp);
		expect(again[0].resume_interrupted).toBe(true);
		const doc = await loadThread(deadApp, "t-stranded");
		expect(doc?.resume_interrupted).toBe(true);

		/* A re-drive retires it: its claim's upsert overwrites the marker
		 * (fresh live stream), its finalize clears it — after which no load
		 * sees the signal. */
		await upsertThreadTurn({
			appId: deadApp,
			threadId: "t-stranded",
			runId: "run-redrive",
			streamId: "stream-redrive",
			threadType: "build",
			messages: [userMsg("m1", "a build the deploy killed")],
		});
		await appendThreadResponse({
			appId: deadApp,
			threadId: "t-stranded",
			streamId: "stream-redrive",
			responseMessage: assistantMsg("m2", "recovered"),
		});
		const recovered = await loadThread(deadApp, "t-stranded");
		expect(recovered?.active_stream_id).toBeNull();
		expect(recovered?.resume_interrupted).toBeUndefined();
	});

	it("stamps the signal on loadThread when it performs the detection itself", async () => {
		const deadApp = await h.seedApp({ id: "app-dead-2", status: "complete" });
		await upsertThreadTurn({
			appId: deadApp,
			threadId: "t-stranded-2",
			runId: "run-dead",
			streamId: "stream-dead-2",
			threadType: "edit",
			messages: [userMsg("m1", "an edit the deploy killed")],
		});

		const doc = await loadThread(deadApp, "t-stranded-2");
		expect(doc?.active_stream_id).toBeNull();
		expect(doc?.resume_interrupted).toBe(true);
	});

	it("mergeThreadTurnMessages merges history without touching identity, liveness, or foreign apps", async () => {
		/* The bailed-POST writer: a serialize-wait timeout or superseded
		 * resume ran nothing, but its history carries the user's answered
		 * question round — that must land WITHOUT claiming the thread. */
		const app = await h.seedApp({ id: "app-bail", status: "generating" });
		await upsertThreadTurn({
			appId: app,
			threadId: "t-bail",
			runId: "run-owner",
			streamId: "stream-owner",
			threadType: "build",
			messages: [userMsg("m1", "build it")],
		});

		await mergeThreadTurnMessages({
			appId: app,
			threadId: "t-bail",
			messages: [userMsg("m1", "build it"), assistantMsg("m2", "answered")],
		});

		const db = await getAppDb();
		const row = await db
			.selectFrom("threads")
			.select(["run_id", "active_stream_id", "messages"])
			.where("thread_id", "=", "t-bail")
			.executeTakeFirstOrThrow();
		/* The owning run's identity + marker survive the merge untouched. */
		expect(row.run_id).toBe("run-owner");
		expect(row.active_stream_id).toBe("stream-owner");
		expect((row.messages as UIMessage[]).map((m) => m.id)).toEqual([
			"m1",
			"m2",
		]);

		/* Foreign app: writes nothing. */
		const other = await h.seedApp({ id: "app-bail-2", status: "complete" });
		await mergeThreadTurnMessages({
			appId: other,
			threadId: "t-bail",
			messages: [userMsg("mx", "cross-app forge")],
		});
		const unchanged = await db
			.selectFrom("threads")
			.select(["messages"])
			.where("thread_id", "=", "t-bail")
			.executeTakeFirstOrThrow();
		expect((unchanged.messages as UIMessage[]).map((m) => m.id)).toEqual([
			"m1",
			"m2",
		]);

		/* Unknown thread id: update-only, never an insert (nothing ran, so
		 * there is nothing to continue). */
		await mergeThreadTurnMessages({
			appId: app,
			threadId: "t-never-existed",
			messages: [userMsg("m1", "hello")],
		});
		const ghost = await db
			.selectFrom("threads")
			.select(["thread_id"])
			.where("thread_id", "=", "t-never-existed")
			.executeTakeFirst();
		expect(ghost).toBeUndefined();
	});

	it("never stamps the signal on a thread whose run is genuinely live", async () => {
		/* `h.seedApp` seeds `generating` apps as live builds — the marker must
		 * survive AND carry no interruption signal. */
		const liveApp = await h.seedApp({
			id: "app-live-marker",
			status: "generating",
		});
		await upsertThreadTurn({
			appId: liveApp,
			threadId: "t-live",
			runId: "run-live",
			streamId: "stream-live",
			threadType: "build",
			messages: [userMsg("m1", "a build mid-flight")],
		});

		const doc = await loadThread(liveApp, "t-live");
		expect(doc?.active_stream_id).toBe("stream-live");
		expect(doc?.resume_interrupted).toBeUndefined();
	});
});
