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
 *  - `persistResponseSnapshot` merges the fold's cumulative assistant
 *    snapshots per barrier (marker untouched) and, at stream end, retires
 *    the live-stream marker — but ONLY while the marker still names its own
 *    run's stream, so a final write that lost the app to a newer claim can't
 *    clobber that claim's fresh marker. The merge arm is Project-guarded;
 *    the marker arm deliberately is not.
 *  - a response continuing the trailing assistant message (an answered
 *    askQuestions round) REPLACES it rather than appending a same-id
 *    sibling — mirroring the client's own continuation semantics.
 *  - `clawBackThreadResponse` reverts a FAILED turn to its pre-run state
 *    (delete a fresh partial, restore a continuation seed) and clears the
 *    marker in one transaction — and does nothing at all once a successor
 *    owns the thread. A re-drive claim removes its dead predecessor's
 *    trailing partial the same id-scoped way.
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
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import type { MediaAssetId } from "@/lib/domain";
import { RunHolderLostError } from "../commitGuard";
import { deleteMediaAssetForActor } from "../mediaDeletion";
import { getAppDb } from "../pg";
import {
	clawBackThreadResponse,
	listThreadMetas,
	loadThread,
	mergeThreadTurnMessages,
	mergeTranscript,
	upsertThreadTurn as persistOwnedThreadTurn,
	persistResponseSnapshot,
	resolveThreadStream,
	ThreadAttachmentUnavailableError,
} from "../threads";
import { setupAppStateTestDb } from "./appStateTestDb";

const NONCE = "00000000-0000-4000-8000-0000000000aa";
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

function attachmentMsg(id: string, assetId: string): UIMessage {
	return {
		...userMsg(id, "Please read this"),
		metadata: {
			attachments: [
				{
					assetId,
					kind: "pdf",
					filename: "requirements.pdf",
					mimeType: "application/pdf",
				},
			],
		},
	} as UIMessage;
}

async function seedReadyDocument(assetId: MediaAssetId): Promise<void> {
	await h
		.db()
		.insertInto("media_assets")
		.values({
			id: assetId,
			project_id: "project-test",
			owner: "owner-test",
			content_hash: assetId.padEnd(64, "a").slice(0, 64),
			mime_type: "application/pdf",
			extension: ".pdf",
			size_bytes: 128,
			dimensions: null,
			duration_ms: null,
			kind: "pdf",
			gcs_object_key: `projects/project-test/${assetId}.pdf`,
			original_filename: "requirements.pdf",
			display_name: "Requirements",
			status: "ready",
			extract: null,
		})
		.execute();
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
	args: Omit<
		Parameters<typeof persistOwnedThreadTurn>[0],
		"expectedProjectId"
	> & {
		expectedProjectId?: string;
	},
): Promise<boolean> {
	const admittedArgs = {
		expectedProjectId: "project-test",
		...args,
	};
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

	const written = await persistOwnedThreadTurn(admittedArgs);
	if (wasAtRest) {
		await db.transaction().execute(async (tx) => {
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
						assetId: "70000000-0000-4000-8000-000000000002",
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
						assetId: "70000000-0000-4000-8000-000000000003",
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

describe("thread attachment admission", () => {
	it("locks and exactly indexes attachments so deletion re-walks the thread carrier", async () => {
		const assetId = testMediaAssetId("70000000-0000-4000-8000-000000000001");
		await seedReadyDocument(assetId);
		await upsertThreadTurn({
			appId: APP,
			threadId: "thread-with-document",
			runId: "run-document",
			streamId: "stream-document",
			holderNonce: NONCE,
			threadType: "build",
			messages: [attachmentMsg("message-document", assetId)],
		});

		const edge = await h
			.db()
			.selectFrom("media_asset_refs")
			.select(["project_id", "asset_id", "app_id"])
			.where("asset_id", "=", assetId)
			.executeTakeFirst();
		expect(edge).toEqual({
			project_id: "project-test",
			asset_id: assetId,
			app_id: APP,
		});
		await expect(
			deleteMediaAssetForActor({
				assetId,
				actorUserId: "owner-test",
				expectedProjectId: "project-test",
			}),
		).resolves.toMatchObject({
			kind: "referenced",
			references: [expect.stringContaining("conversation attachment")],
		});
	});

	it("rejects a missing attachment without persisting the thread", async () => {
		await expect(
			upsertThreadTurn({
				appId: APP,
				threadId: "thread-missing-document",
				runId: "run-missing-document",
				streamId: "stream-missing-document",
				holderNonce: NONCE,
				threadType: "build",
				messages: [
					attachmentMsg(
						"message-missing",
						testMediaAssetId("missing-document"),
					),
				],
			}),
		).rejects.toBeInstanceOf(ThreadAttachmentUnavailableError);
		expect(await loadThread(APP, "thread-missing-document")).toBeNull();
	});

	it("rejects an attachment whose stored asset kind does not match metadata", async () => {
		const assetId = testMediaAssetId("70000000-0000-4000-8000-000000000009");
		await seedReadyDocument(assetId);
		await h
			.db()
			.updateTable("media_assets")
			.set({ kind: "image" })
			.where("id", "=", assetId)
			.execute();

		await expect(
			upsertThreadTurn({
				appId: APP,
				threadId: "thread-kind-mismatch",
				runId: "run-kind-mismatch",
				streamId: "stream-kind-mismatch",
				holderNonce: NONCE,
				threadType: "build",
				messages: [attachmentMsg("message-kind-mismatch", assetId)],
			}),
		).rejects.toBeInstanceOf(ThreadAttachmentUnavailableError);
		expect(await loadThread(APP, "thread-kind-mismatch")).toBeNull();
	});
});

describe("upsertThreadTurn", () => {
	it("inserts a new thread live, with the first user text as summary", async () => {
		const written = await upsertThreadTurn({
			appId: APP,
			threadId: T1,
			runId: "run-1",
			streamId: "stream-1",
			holderNonce: NONCE,
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
			holderNonce: NONCE,
			threadType: "build",
			messages: [userMsg("m1", "first ask")],
		});
		const before = await loadThread(APP, T1);

		const written = await upsertThreadTurn({
			appId: APP,
			threadId: T1,
			runId: "run-2",
			streamId: "stream-2",
			holderNonce: NONCE,
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
			holderNonce: NONCE,
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
			holderNonce: NONCE,
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
			holderNonce: NONCE,
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
			holderNonce: NONCE,
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
			holderNonce: NONCE,
			threadType: "build",
			messages: [userMsg("m1", "mine")],
		});

		const written = await upsertThreadTurn({
			appId: OTHER_APP,
			threadId: T1,
			runId: "run-x",
			streamId: "stream-x",
			holderNonce: NONCE,
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
			holderNonce: NONCE,
			threadType: "build",
			messages: [userMsg("m1", "owner turn")],
		});
		await upsertThreadTurn({
			appId: OTHER_APP,
			threadId: "other-thread",
			runId: "run-successor",
			streamId: "stream-successor",
			holderNonce: NONCE,
			threadType: "build",
			messages: [userMsg("m2", "successor turn")],
		});

		await expect(
			persistOwnedThreadTurn({
				appId: OTHER_APP,
				threadId: T1,
				runId: "run-stale",
				streamId: "stream-stale",
				holderNonce: NONCE,
				threadType: "build",
				messages: [userMsg("mx", "must not cross apps")],
				expectedProjectId: "project-test",
			}),
		).rejects.toMatchObject({
			name: new RunHolderLostError().name,
			outcome: "superseded",
		});

		const ownerThread = await loadThread(APP, T1);
		expect(ownerThread?.messages.map((message) => message.id)).toEqual(["m1"]);
		expect(ownerThread?.active_stream_id).toBe("stream-owner");
	});
});

describe("persistResponseSnapshot", () => {
	beforeEach(async () => {
		await upsertThreadTurn({
			appId: APP,
			threadId: T1,
			runId: "run-1",
			streamId: "stream-1",
			holderNonce: NONCE,
			threadType: "build",
			messages: [userMsg("m1", "build me an app")],
		});
	});

	it("grows the assistant message per barrier, leaving the run's marker live", async () => {
		await persistResponseSnapshot({
			appId: APP,
			threadId: T1,
			streamId: "stream-1",
			expectedProjectId: "project-test",
			responseMessage: assistantMsg("m2", "step one"),
			clearMarker: false,
		});
		let doc = await loadThread(APP, T1);
		expect(doc?.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
		expect(doc?.active_stream_id).toBe("stream-1");

		/* Snapshots are cumulative: barrier 2 carries both steps' parts and
		 * replaces the one-part copy via more-parts-wins. */
		await persistResponseSnapshot({
			appId: APP,
			threadId: T1,
			streamId: "stream-1",
			expectedProjectId: "project-test",
			responseMessage: {
				id: "m2",
				role: "assistant",
				parts: [
					{ type: "text", text: "step one" },
					{ type: "text", text: "step two" },
				],
			},
			clearMarker: false,
		});
		doc = await loadThread(APP, T1);
		expect(doc?.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
		expect(doc?.messages[1]?.parts).toHaveLength(2);
		expect(doc?.active_stream_id).toBe("stream-1");
	});

	it("merges the final state and clears the live marker in one write at stream end", async () => {
		await persistResponseSnapshot({
			appId: APP,
			threadId: T1,
			streamId: "stream-1",
			expectedProjectId: "project-test",
			responseMessage: assistantMsg("m2", "built it"),
			clearMarker: true,
		});

		const doc = await loadThread(APP, T1);
		expect(doc?.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
		expect(doc?.active_stream_id).toBeNull();
	});

	it("clears the live marker even with no response to keep (a zero-step failure)", async () => {
		await persistResponseSnapshot({
			appId: APP,
			threadId: T1,
			streamId: "stream-1",
			expectedProjectId: "project-test",
			responseMessage: null,
			clearMarker: true,
		});

		const doc = await loadThread(APP, T1);
		expect(doc?.messages).toHaveLength(1);
		expect(doc?.active_stream_id).toBeNull();
	});

	it("never merges an empty-parts assistant shell", async () => {
		await persistResponseSnapshot({
			appId: APP,
			threadId: T1,
			streamId: "stream-1",
			expectedProjectId: "project-test",
			responseMessage: { id: "m2", role: "assistant", parts: [] },
			clearMarker: false,
		});

		const doc = await loadThread(APP, T1);
		expect(doc?.messages.map((m) => m.id)).toEqual(["m1"]);
		expect(doc?.active_stream_id).toBe("stream-1");
	});

	it("REPLACES a trailing same-id assistant message (a continuation), never splits it", async () => {
		/* An answered askQuestions round: the incoming history's last message
		 * is the assistant's; the continuation streams under the SAME message
		 * id and the fold's snapshots carry the merged parts. */
		await upsertThreadTurn({
			appId: APP,
			threadId: T1,
			runId: "run-1",
			streamId: "stream-2",
			holderNonce: NONCE,
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
		await persistResponseSnapshot({
			appId: APP,
			threadId: T1,
			streamId: "stream-2",
			expectedProjectId: "project-test",
			responseMessage: merged,
			clearMarker: true,
		});

		const doc = await loadThread(APP, T1);
		expect(doc?.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
		expect(doc?.messages[1]?.parts).toHaveLength(2);
	});

	it("is app-guarded like the upsert", async () => {
		await persistResponseSnapshot({
			appId: OTHER_APP,
			threadId: T1,
			streamId: "stream-1",
			expectedProjectId: "project-test",
			responseMessage: assistantMsg("mx", "hijack"),
			clearMarker: true,
		});
		const doc = await loadThread(APP, T1);
		expect(doc?.messages).toHaveLength(1);
		expect(doc?.active_stream_id).toBe("stream-1");
	});

	it("skips the merge when the app moved Projects, but still clears the marker", async () => {
		/* The split guards: content must not land in a Project the run no
		 * longer belongs to, but a completed run's marker must never strand
		 * (a stranded marker reads as an instance death and re-drives a
		 * finished turn). */
		await persistResponseSnapshot({
			appId: APP,
			threadId: T1,
			streamId: "stream-1",
			expectedProjectId: "project-somewhere-else",
			responseMessage: assistantMsg("m2", "late content"),
			clearMarker: true,
		});

		const doc = await loadThread(APP, T1);
		expect(doc?.messages.map((m) => m.id)).toEqual(["m1"]);
		expect(doc?.active_stream_id).toBeNull();
	});

	it("strips attachment metadata off an assistant snapshot before merging", async () => {
		const withAttachments = {
			...assistantMsg("m2", "answer"),
			metadata: {
				model: "sol",
				attachments: [{ assetId: "a-1", kind: "pdf" }],
			},
		} as UIMessage;
		await persistResponseSnapshot({
			appId: APP,
			threadId: T1,
			streamId: "stream-1",
			expectedProjectId: "project-test",
			responseMessage: withAttachments,
			clearMarker: true,
		});

		const doc = await loadThread(APP, T1);
		const stored = doc?.messages[1] as
			| { metadata?: Record<string, unknown> }
			| undefined;
		expect(stored?.metadata).toEqual({ model: "sol" });
	});

	it("never clobbers a NEWER claim's marker or turns (final write lost the race)", async () => {
		/* The app releases before the final write completes, so a competing
		 * POST can claim + persist its turn first. The old run's late write
		 * must merge its response WITHOUT touching the new run's marker or
		 * its turn. */
		await upsertThreadTurn({
			appId: APP,
			threadId: T1,
			runId: "run-2",
			streamId: "stream-2",
			holderNonce: NONCE,
			threadType: "build",
			messages: [
				userMsg("m1", "build me an app"),
				userMsg("m3", "the NEWER claim's turn"),
			],
		});

		await persistResponseSnapshot({
			appId: APP,
			threadId: T1,
			streamId: "stream-1", // the OLD run's stream — no longer the marker
			expectedProjectId: "project-test",
			responseMessage: assistantMsg("m2", "the old run's answer"),
			clearMarker: true,
		});

		const doc = await loadThread(APP, T1);
		expect(doc?.messages.map((m) => m.id)).toEqual(["m1", "m3", "m2"]);
		// The newer run is still resumable — its marker survived.
		expect(doc?.active_stream_id).toBe("stream-2");
	});

	it("retains a paused nonce and clears it only for the matching terminal stream", async () => {
		const { appId, threadId, streamId } = await seedPausedThread("finalize");
		const db = await getAppDb();

		await persistResponseSnapshot({
			appId,
			threadId,
			streamId,
			expectedProjectId: "project-test",
			responseMessage: assistantMsg("m-paused", "Which case type?"),
			clearMarker: true,
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
		await persistResponseSnapshot({
			appId,
			threadId,
			streamId: "wrong-stream",
			expectedProjectId: "project-test",
			responseMessage: null,
			clearMarker: true,
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

		await persistResponseSnapshot({
			appId,
			threadId,
			streamId: "stream-successor",
			expectedProjectId: "project-test",
			responseMessage: assistantMsg("m-done", "Done"),
			clearMarker: true,
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

describe("clawBackThreadResponse", () => {
	beforeEach(async () => {
		await upsertThreadTurn({
			appId: APP,
			threadId: T1,
			runId: "run-1",
			streamId: "stream-1",
			holderNonce: NONCE,
			threadType: "build",
			messages: [userMsg("m1", "build me an app")],
		});
	});

	it("deletes a failed turn's fresh partial and clears the marker in one write", async () => {
		await persistResponseSnapshot({
			appId: APP,
			threadId: T1,
			streamId: "stream-1",
			expectedProjectId: "project-test",
			responseMessage: assistantMsg("m2", "half an answer"),
			clearMarker: false,
		});

		await clawBackThreadResponse({
			appId: APP,
			threadId: T1,
			streamId: "stream-1",
			messageId: "m2",
		});

		const doc = await loadThread(APP, T1);
		expect(doc?.messages.map((m) => m.id)).toEqual(["m1"]);
		expect(doc?.active_stream_id).toBeNull();
		const db = await getAppDb();
		const row = await db
			.selectFrom("threads")
			.select("active_holder_nonce")
			.where("thread_id", "=", T1)
			.executeTakeFirstOrThrow();
		expect(row.active_holder_nonce).toBeNull();
	});

	it("restores a continuation to its pre-run seed", async () => {
		const seed = assistantMsg("m2", "which case type?");
		await upsertThreadTurn({
			appId: APP,
			threadId: T1,
			runId: "run-1",
			streamId: "stream-2",
			holderNonce: NONCE,
			threadType: "build",
			messages: [userMsg("m1", "build me an app"), seed],
		});
		await persistResponseSnapshot({
			appId: APP,
			threadId: T1,
			streamId: "stream-2",
			expectedProjectId: "project-test",
			responseMessage: {
				id: "m2",
				role: "assistant",
				parts: [
					{ type: "text", text: "which case type?" },
					{ type: "text", text: "half of the continuation" },
				],
			},
			clearMarker: false,
		});

		await clawBackThreadResponse({
			appId: APP,
			threadId: T1,
			streamId: "stream-2",
			messageId: "m2",
			revertTo: seed,
		});

		const doc = await loadThread(APP, T1);
		expect(doc?.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
		expect(doc?.messages[1]?.parts).toHaveLength(1);
		expect(doc?.active_stream_id).toBeNull();
	});

	it("does nothing at all once a successor owns the thread", async () => {
		await persistResponseSnapshot({
			appId: APP,
			threadId: T1,
			streamId: "stream-1",
			expectedProjectId: "project-test",
			responseMessage: assistantMsg("m2", "the dead run's partial"),
			clearMarker: false,
		});
		await upsertThreadTurn({
			appId: APP,
			threadId: T1,
			runId: "run-2",
			streamId: "stream-2",
			holderNonce: NONCE,
			threadType: "build",
			messages: [
				userMsg("m1", "build me an app"),
				userMsg("m3", "the successor's turn"),
			],
		});

		await clawBackThreadResponse({
			appId: APP,
			threadId: T1,
			streamId: "stream-1", // no longer the marker
			messageId: "m2",
		});

		const doc = await loadThread(APP, T1);
		expect(doc?.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
		expect(doc?.active_stream_id).toBe("stream-2");
	});

	it("shrinks nothing but its own message id", async () => {
		/* A misfire naming an id the fold never owned removes no content —
		 * containment is per-message — while the marker (the failed turn's)
		 * still clears. */
		await persistResponseSnapshot({
			appId: APP,
			threadId: T1,
			streamId: "stream-1",
			expectedProjectId: "project-test",
			responseMessage: assistantMsg("m2", "someone's content"),
			clearMarker: false,
		});

		await clawBackThreadResponse({
			appId: APP,
			threadId: T1,
			streamId: "stream-1",
			messageId: "m-never-existed",
		});

		const doc = await loadThread(APP, T1);
		expect(doc?.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
		expect(doc?.active_stream_id).toBeNull();
	});
});

describe("re-drive claim claw-back (upsertThreadTurn redrive)", () => {
	beforeEach(async () => {
		await upsertThreadTurn({
			appId: APP,
			threadId: T1,
			runId: "run-dead",
			streamId: "stream-dead",
			holderNonce: NONCE,
			threadType: "build",
			messages: [userMsg("m1", "build me an app")],
		});
		/* The dead run's barrier writes left a trailing partial, and the run
		 * died before any terminal write. */
		await persistResponseSnapshot({
			appId: APP,
			threadId: T1,
			streamId: "stream-dead",
			expectedProjectId: "project-test",
			responseMessage: assistantMsg("m2", "half an answer, then death"),
			clearMarker: false,
		});
	});

	it("removes the dead run's trailing partial the incoming history no longer carries", async () => {
		/* The client's regenerate() trims the partial before re-sending, so
		 * the re-drive claim arrives without m2 — and must remove the stored
		 * copy the by-id merge would otherwise keep forever. */
		await upsertThreadTurn({
			appId: APP,
			threadId: T1,
			runId: "run-redrive",
			streamId: "stream-redrive",
			holderNonce: NONCE,
			threadType: "build",
			messages: [userMsg("m1", "build me an app")],
			redrive: true,
		});

		const doc = await loadThread(APP, T1);
		expect(doc?.messages.map((m) => m.id)).toEqual(["m1"]);
		expect(doc?.active_stream_id).toBe("stream-redrive");
	});

	it("keeps a trailing assistant message the incoming history still carries", async () => {
		await upsertThreadTurn({
			appId: APP,
			threadId: T1,
			runId: "run-redrive",
			streamId: "stream-redrive",
			holderNonce: NONCE,
			threadType: "build",
			messages: [
				userMsg("m1", "build me an app"),
				assistantMsg("m2", "half an answer, then death"),
			],
			redrive: true,
		});

		const doc = await loadThread(APP, T1);
		expect(doc?.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
	});

	it("keeps a trailing USER message even when absent from the incoming history", async () => {
		/* The removal is assistant-only: a stored trailing user turn is real
		 * conversation another session added, never a dead run's partial. */
		await upsertThreadTurn({
			appId: APP,
			threadId: T1,
			runId: "run-3",
			streamId: "stream-3",
			holderNonce: NONCE,
			threadType: "build",
			messages: [
				userMsg("m1", "build me an app"),
				assistantMsg("m2", "half an answer, then death"),
				userMsg("m4", "a co-member's turn"),
			],
		});
		await upsertThreadTurn({
			appId: APP,
			threadId: T1,
			runId: "run-redrive",
			streamId: "stream-redrive",
			holderNonce: NONCE,
			threadType: "build",
			messages: [userMsg("m1", "build me an app")],
			redrive: true,
		});

		const doc = await loadThread(APP, T1);
		expect(doc?.messages.map((m) => m.id)).toEqual(["m1", "m2", "m4"]);
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

	it("projects a LIVE run's nonce to its owning actor only, and never a reaped one's", async () => {
		/* Unpausing the fixture leaves a LIVE generating build: its owning
		 * actor gets the nonce (a rewound tail replay starts past the chunk
		 * that carried the nonce marker, so activation re-seeds it from the
		 * thread row), a co-member still gets nothing. A reaped holder
		 * projects to no one. */
		const unpaused = await seedPausedThread("unpaused");
		const reaped = await seedPausedThread("reaped");
		const db = await getAppDb();
		await db.transaction().execute(async (tx) => {
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
			(await loadThread(unpaused.appId, unpaused.threadId, PAUSED_ACTOR))
				?.holder_nonce,
		).toBe(HOLDER_NONCE);
		expect(
			await loadThread(unpaused.appId, unpaused.threadId, OTHER_ACTOR),
		).not.toHaveProperty("holder_nonce");
		expect(
			await loadThread(reaped.appId, reaped.threadId, PAUSED_ACTOR),
		).not.toHaveProperty("holder_nonce");
	});

	it("stamps run_paused only while the app's holder is this thread's run and parked awaiting input", async () => {
		const { appId, threadId } = await seedPausedThread("posture");

		/* Genuinely paused: the posture rides the load, actor or not. */
		expect((await loadThread(appId, threadId))?.run_paused).toBe(true);
		expect((await loadThread(appId, threadId, OTHER_ACTOR))?.run_paused).toBe(
			true,
		);

		/* Unpaused (the run resumed): the posture clears. */
		const db = await getAppDb();
		await db
			.updateTable("apps")
			.set({ awaiting_input: false })
			.where("id", "=", appId)
			.execute();
		expect(await loadThread(appId, threadId)).not.toHaveProperty("run_paused");
	});

	it("listThreadMetas orders by recency and carries counts + live markers", async () => {
		await upsertThreadTurn({
			appId: APP,
			threadId: "t-old",
			runId: "run-1",
			streamId: "s1",
			holderNonce: NONCE,
			threadType: "build",
			messages: [userMsg("m1", "older"), assistantMsg("m2", "ok")],
		});
		await persistResponseSnapshot({
			appId: APP,
			threadId: "t-old",
			streamId: "s1",
			expectedProjectId: "project-test",
			responseMessage: null,
			clearMarker: true,
		});
		await upsertThreadTurn({
			appId: APP,
			threadId: "t-new",
			runId: "run-2",
			streamId: "s2",
			holderNonce: NONCE,
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
			holderNonce: NONCE,
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
			holderNonce: NONCE,
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
			holderNonce: NONCE,
			threadType: "build",
			messages: [userMsg("m1", "a build the deploy killed")],
		});
		await persistResponseSnapshot({
			appId: deadApp,
			threadId: "t-stranded",
			streamId: "stream-redrive",
			expectedProjectId: "project-test",
			responseMessage: assistantMsg("m2", "recovered"),
			clearMarker: true,
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
			holderNonce: NONCE,
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
			holderNonce: NONCE,
			threadType: "build",
			messages: [userMsg("m1", "build it")],
		});

		await mergeThreadTurnMessages({
			appId: app,
			threadId: "t-bail",
			messages: [userMsg("m1", "build it"), assistantMsg("m2", "answered")],
			expectedProjectId: "project-test",
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
			expectedProjectId: "project-test",
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
			expectedProjectId: "project-test",
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
			holderNonce: NONCE,
			threadType: "build",
			messages: [userMsg("m1", "a build mid-flight")],
		});

		const doc = await loadThread(liveApp, "t-live");
		expect(doc?.active_stream_id).toBe("stream-live");
		expect(doc?.resume_interrupted).toBeUndefined();
	});
});
