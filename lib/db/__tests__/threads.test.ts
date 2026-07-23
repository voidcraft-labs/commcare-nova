/**
 * Thread persistence — the durable conversation store's contract, on a real
 * per-test Postgres.
 *
 * The invariants under test are the ones the resume design leans on:
 *
 *  - `upsertThreadTurn` proves the compatibility-admitted app holder before
 *    marking the thread live and MERGES the incoming history into the stored
 *    transcript (a stale tab must not erase turns other sessions added); a
 *    lost holder may merge messages but cannot replace its successor marker,
 *    and the update arm is app-guarded so a forged thread id writes nothing.
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
import { RunHolderLostError } from "../commitGuard";
import { getAppDb } from "../pg";
import { declareRuntimeReader } from "../runtimeReaderVersion";
import {
	appendThreadResponse,
	listThreadMetas,
	loadThread,
	mergeThreadTurnMessages,
	mergeTranscript,
	upsertThreadTurn as persistOwnedThreadTurn,
	resolveThreadStream,
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
const PAUSED_ACTOR = "paused-actor";
const OTHER_ACTOR = "other-actor";
const HOLDER_NONCE = "00000000-0000-4000-8000-000000000001";
const OTHER_NONCE = "00000000-0000-4000-8000-000000000002";

/**
 * The production writer now proves the app holder that the route claimed
 * before installing a thread marker. Keep these persistence-focused tests
 * honest by establishing that holder explicitly; at-rest fixtures are
 * restored after the write so dead-marker reconciliation still sees them
 * at rest.
 */
async function upsertThreadTurn(
	args: Parameters<typeof persistOwnedThreadTurn>[0],
): Promise<boolean> {
	const db = await getAppDb();
	const original = await db
		.selectFrom("apps")
		.select([
			"status",
			"awaiting_input",
			"run_id",
			"run_holder_nonce",
			"res_period",
			"res_run_id",
			"lock_run_id",
			"lock_actor_user_id",
			"lock_expire_at",
		])
		.where("id", "=", args.appId)
		.executeTakeFirstOrThrow();
	const wasAtRest =
		original.status !== "generating" && original.lock_run_id === null;
	await db.transaction().execute(async (tx) => {
		if (args.holderNonce) await declareRuntimeReader(tx);
		if (args.threadType === "build") {
			await tx
				.updateTable("apps")
				.set({
					status: "generating",
					run_id: args.runId,
					run_holder_nonce: args.holderNonce ?? null,
					...(original.res_period !== null && { res_run_id: args.runId }),
					lock_run_id: null,
					lock_actor_user_id: null,
					lock_expire_at: null,
				})
				.where("id", "=", args.appId)
				.execute();
		} else {
			await tx
				.updateTable("apps")
				.set({
					status: "complete",
					lock_run_id: args.runId,
					lock_actor_user_id: "owner-test",
					lock_expire_at: new Date(Date.now() + 15 * 60_000),
					run_holder_nonce: args.holderNonce ?? null,
				})
				.where("id", "=", args.appId)
				.execute();
		}
	});

	const written = await persistOwnedThreadTurn(args);
	if (wasAtRest) {
		await db.transaction().execute(async (tx) => {
			if (args.holderNonce) await declareRuntimeReader(tx);
			await tx
				.updateTable("apps")
				.set({
					status: original.status,
					awaiting_input: original.awaiting_input,
					run_id: original.run_id,
					run_holder_nonce: original.run_holder_nonce,
					res_run_id: original.res_run_id,
					lock_run_id: original.lock_run_id,
					lock_actor_user_id: original.lock_actor_user_id,
					lock_expire_at: original.lock_expire_at,
				})
				.where("id", "=", args.appId)
				.execute();
		});
	}
	return written;
}

async function seedPausedThread(suffix: string): Promise<{
	appId: string;
	threadId: string;
	streamId: string;
}> {
	const appId = `app-paused-${suffix}`;
	const threadId = `thread-paused-${suffix}`;
	const streamId = `stream-paused-${suffix}`;
	const runId = `run-paused-${suffix}`;
	await h.seedApp({
		id: appId,
		owner: PAUSED_ACTOR,
		status: "generating",
		awaiting_input: true,
		run_id: runId,
		run_holder_nonce: HOLDER_NONCE,
		reservation: {
			period: "2026-07",
			reserved: 100,
			settled: false,
			userId: PAUSED_ACTOR,
			runId,
		},
	});
	await upsertThreadTurn({
		appId,
		threadId,
		runId,
		streamId,
		holderNonce: HOLDER_NONCE,
		threadType: "build",
		messages: [userMsg(`message-${suffix}`, "answer the question")],
	});
	return { appId, threadId, streamId };
}

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

	it("keeps stored attachment identity authoritative for a shared message id", () => {
		const stored = {
			...m("attached"),
			metadata: {
				attachments: [
					{
						assetId: "destination-asset",
						kind: "pdf",
						filename: "requirements.pdf",
						mimeType: "application/pdf",
					},
				],
			},
		};
		const stale = {
			...m("attached", 2),
			metadata: {
				attachments: [
					{
						assetId: "source-asset",
						kind: "pdf",
						filename: "requirements.pdf",
						mimeType: "application/pdf",
					},
				],
				model: "new-model",
			},
		};

		expect(mergeTranscript([stored], [stale])).toEqual([
			{
				...stale,
				metadata: {
					...stale.metadata,
					attachments: stored.metadata.attachments,
				},
			},
		]);
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

	it("reports holder loss before a concurrently foreign thread id", async () => {
		await upsertThreadTurn({
			appId: APP,
			threadId: T1,
			runId: "run-owner",
			streamId: "stream-owner",
			threadType: "build",
			messages: [userMsg("m1", "owner turn")],
		});
		await upsertThreadTurn({
			appId: OTHER_APP,
			threadId: "other-thread",
			runId: "run-successor",
			streamId: "stream-successor",
			threadType: "build",
			messages: [userMsg("m2", "successor turn")],
		});

		await expect(
			persistOwnedThreadTurn({
				appId: OTHER_APP,
				threadId: T1,
				runId: "run-stale",
				streamId: "stream-stale",
				threadType: "build",
				messages: [userMsg("mx", "must not cross apps")],
			}),
		).rejects.toMatchObject({
			name: new RunHolderLostError().name,
			outcome: "superseded",
		});

		const ownerThread = await loadThread(APP, T1);
		expect(ownerThread?.messages.map((message) => message.id)).toEqual(["m1"]);
		expect(ownerThread?.active_stream_id).toBe("stream-owner");
	});

	it("merges a lost holder's transcript without replacing the successor marker", async () => {
		const sharedRunId = "same-public-run";
		await upsertThreadTurn({
			appId: APP,
			threadId: T1,
			runId: sharedRunId,
			streamId: "stream-old",
			holderNonce: HOLDER_NONCE,
			threadType: "build",
			messages: [userMsg("m1", "first turn")],
		});

		// Exercise the nonce half of exact-holder identity: the successor reuses
		// the public run id but owns a fresh generation capability.
		const db = await getAppDb();
		await db
			.updateTable("lookup_reference_compatibility")
			.set({
				minimum_runtime_reader_version: 1,
				run_holder_nonce_enforced: true,
			})
			.where("id", "=", 1)
			.execute();
		await upsertThreadTurn({
			appId: APP,
			threadId: T1,
			runId: sharedRunId,
			streamId: "stream-successor",
			holderNonce: OTHER_NONCE,
			threadType: "build",
			messages: [userMsg("m1", "first turn"), userMsg("m2", "successor turn")],
		});

		await expect(
			persistOwnedThreadTurn({
				appId: APP,
				threadId: T1,
				runId: sharedRunId,
				streamId: "stream-stale",
				holderNonce: HOLDER_NONCE,
				threadType: "build",
				messages: [
					userMsg("m1", "first turn"),
					userMsg("m3", "stale tab's real turn"),
				],
			}),
		).rejects.toMatchObject({
			name: new RunHolderLostError().name,
			outcome: "superseded",
		});

		const row = await db
			.selectFrom("threads")
			.select(["run_id", "active_stream_id", "active_holder_nonce", "messages"])
			.where("thread_id", "=", T1)
			.executeTakeFirstOrThrow();
		expect(row).toMatchObject({
			run_id: sharedRunId,
			active_stream_id: "stream-successor",
			active_holder_nonce: OTHER_NONCE,
		});
		expect((row.messages as UIMessage[]).map((message) => message.id)).toEqual([
			"m1",
			"m2",
			"m3",
		]);
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

	it("retains a paused nonce and clears it only for the matching terminal stream", async () => {
		const { appId, threadId, streamId } = await seedPausedThread("finalize");
		const db = await getAppDb();

		await appendThreadResponse({
			appId,
			threadId,
			streamId,
			responseMessage: assistantMsg("m-paused", "Which case type?"),
			retainHolderNonce: true,
		});
		let row = await db
			.selectFrom("threads")
			.select(["active_stream_id", "active_holder_nonce"])
			.where("thread_id", "=", threadId)
			.executeTakeFirstOrThrow();
		expect(row).toMatchObject({
			active_stream_id: null,
			active_holder_nonce: HOLDER_NONCE,
		});

		await upsertThreadTurn({
			appId,
			threadId,
			runId: "run-paused-finalize",
			streamId: "stream-successor",
			holderNonce: HOLDER_NONCE,
			threadType: "build",
			messages: [userMsg("m-answer", "Patients")],
		});
		await appendThreadResponse({
			appId,
			threadId,
			streamId: "wrong-stream",
			responseMessage: null,
		});
		row = await db
			.selectFrom("threads")
			.select(["active_stream_id", "active_holder_nonce"])
			.where("thread_id", "=", threadId)
			.executeTakeFirstOrThrow();
		expect(row).toMatchObject({
			active_stream_id: "stream-successor",
			active_holder_nonce: HOLDER_NONCE,
		});

		await appendThreadResponse({
			appId,
			threadId,
			streamId: "stream-successor",
			responseMessage: assistantMsg("m-done", "Done"),
		});
		row = await db
			.selectFrom("threads")
			.select(["active_stream_id", "active_holder_nonce"])
			.where("thread_id", "=", threadId)
			.executeTakeFirstOrThrow();
		expect(row).toMatchObject({
			active_stream_id: null,
			active_holder_nonce: null,
		});
	});
});

describe("loaders", () => {
	it("projects a paused holder nonce only to the exact pause actor", async () => {
		const { appId, threadId } = await seedPausedThread("actor");

		expect(
			(await loadThread(appId, threadId, PAUSED_ACTOR))?.holder_nonce,
		).toBe(HOLDER_NONCE);
		expect(await loadThread(appId, threadId, OTHER_ACTOR)).not.toHaveProperty(
			"holder_nonce",
		);
		expect(await loadThread(appId, threadId)).not.toHaveProperty(
			"holder_nonce",
		);
	});

	it("withholds a stored nonce that does not match fresh app authority", async () => {
		const { appId, threadId } = await seedPausedThread("mismatch");
		await (await getAppDb())
			.updateTable("threads")
			.set({ active_holder_nonce: OTHER_NONCE })
			.where("thread_id", "=", threadId)
			.execute();

		expect(await loadThread(appId, threadId, PAUSED_ACTOR)).not.toHaveProperty(
			"holder_nonce",
		);
	});

	it("withholds the nonce after the holder is unpaused or reaped", async () => {
		const unpaused = await seedPausedThread("unpaused");
		const reaped = await seedPausedThread("reaped");
		const db = await getAppDb();
		await db.transaction().execute(async (tx) => {
			await declareRuntimeReader(tx);
			await tx
				.updateTable("apps")
				.set({ awaiting_input: false })
				.where("id", "=", unpaused.appId)
				.execute();
			await tx
				.updateTable("apps")
				.set({
					status: "error",
					awaiting_input: false,
					res_settled: true,
					res_run_id: null,
				})
				.where("id", "=", reaped.appId)
				.execute();
		});

		expect(
			await loadThread(unpaused.appId, unpaused.threadId, PAUSED_ACTOR),
		).not.toHaveProperty("holder_nonce");
		expect(
			await loadThread(reaped.appId, reaped.threadId, PAUSED_ACTOR),
		).not.toHaveProperty("holder_nonce");
	});

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
			runId: "run-1",
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
