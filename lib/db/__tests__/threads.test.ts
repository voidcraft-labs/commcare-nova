/**
 * Thread persistence — the durable conversation store's contract, on a real
 * per-test Postgres.
 *
 * The invariants under test are the ones the resume design leans on:
 *
 *  - `upsertThreadTurn` marks the thread live and replaces the transcript;
 *    its update arm is app-guarded so a forged thread id writes nothing.
 *  - `appendThreadResponse` appends the assistant message AND clears the
 *    live-stream marker in ONE write — a reader never sees "response
 *    persisted + stream still live" (the state that would double-render a
 *    response after resume).
 *  - a response continuing the trailing assistant message (an answered
 *    askQuestions round) REPLACES it rather than appending a same-id
 *    sibling — mirroring the client's own continuation semantics.
 *  - `listThreadMetas` orders by recency and carries the live marker.
 */
import type { UIMessage } from "ai";
import { beforeEach, describe, expect, it } from "vitest";
import { getAppDb } from "../pg";
import {
	appendThreadResponse,
	listThreadMetas,
	loadLatestThread,
	loadThread,
	resolveThreadStream,
	threadAppId,
	upsertThreadTurn,
} from "../threads";
import { setupAppStateTestDb } from "./appStateTestDb";

const h = setupAppStateTestDb("threads_");
const APP = "app-threads";
const OTHER_APP = "app-other";

beforeEach(async () => {
	await h.seedApp({ id: APP });
	await h.seedApp({ id: OTHER_APP });
});

function userMsg(id: string, text: string): UIMessage {
	return { id, role: "user", parts: [{ type: "text", text }] };
}

function assistantMsg(id: string, text: string): UIMessage {
	return { id, role: "assistant", parts: [{ type: "text", text }] };
}

const T1 = "thread-1";

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
			responseMessage: assistantMsg("mx", "hijack"),
		});
		const doc = await loadThread(APP, T1);
		expect(doc?.messages).toHaveLength(1);
		expect(doc?.active_stream_id).toBe("stream-1");
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

		const latest = await loadLatestThread(APP);
		expect(latest?.thread_id).toBe("t-new");
	});

	it("resolveThreadStream + threadAppId resolve globally by thread id", async () => {
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
		expect(await threadAppId(T1)).toBe(APP);
		expect(await resolveThreadStream("nope")).toBeNull();
		expect(await threadAppId("nope")).toBeNull();
	});
});
