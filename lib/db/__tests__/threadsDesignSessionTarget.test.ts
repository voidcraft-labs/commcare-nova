/**
 * The transcript/stream protocol against DESIGN-SESSION targets — the §20.11
 * mirror of the app-target corpus in `threads.test.ts`, exercising every
 * target-distinct code path: session-row authority locking and holder
 * proofs, the exactly-one-target thread guards, barrier/terminal/claw-back/
 * tombstone/re-drive semantics on a session thread, loader reconciliation
 * against session liveness, the actor-bound continuation-nonce projection
 * off the session holder, materialized-session delegation to the bound app,
 * and the pre-app half of the split media projection (§20.12).
 *
 * Protocol identity is the contract: every behavior here must match the app
 * corpus test-for-test, differing only in which authority row supplies the
 * holder. A divergence is a Unit D gate-4 failure, not a test to relax.
 */
import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import type { MediaAssetId } from "@/lib/domain";
import { RunHolderLostError } from "../commitGuard";
import { generationTargetHeldLive } from "../generationTargetScope";
import type { GenerationTarget } from "../generationTargets";
import { deleteMediaAssetForActor } from "../mediaDeletion";
import { appendStreamChunks } from "../streamChunks";
import {
	clawBackThreadResponse,
	listThreadMetas,
	loadThread,
	mergeThreadTurnMessages,
	persistResponseSnapshot,
	resolveThreadStream,
	ThreadAttachmentUnavailableError,
	upsertThreadTurn,
} from "../threads";
import { setupAppStateTestDb } from "./appStateTestDb";

const h = setupAppStateTestDb("threads_ds_");
const ACTOR = "owner-test";
const PROJECT = "project-test";
const NONCE = "00000000-0000-4000-8000-0000000000e1";
const OTHER_NONCE = "00000000-0000-4000-8000-0000000000e2";

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
			project_id: PROJECT,
			owner: ACTOR,
			content_hash: assetId.padEnd(64, "a").slice(0, 64),
			mime_type: "application/pdf",
			extension: ".pdf",
			size_bytes: 128,
			dimensions: null,
			duration_ms: null,
			kind: "pdf",
			gcs_object_key: `projects/${PROJECT}/${assetId}.pdf`,
			original_filename: "requirements.pdf",
			display_name: "Requirements",
			status: "ready",
			extract: null,
		})
		.execute();
}

/** Seed a live-held build session and return its thread target + ids. */
async function seedHeldSession(
	suffix: string,
	opts: { awaiting?: boolean; lapsed?: boolean } = {},
): Promise<{
	sessionId: string;
	target: GenerationTarget;
	runId: string;
}> {
	const runId = `run-${suffix}`;
	const sessionId = await h.seedDesignSession({
		owner_user_id: ACTOR,
		awaiting_input: opts.awaiting ?? false,
		run_id: runId,
		run_holder_nonce: NONCE,
		run_actor_user_id: ACTOR,
		run_lease_expires_at: new Date(
			Date.now() + (opts.lapsed ? -60_000 : 600_000),
		),
		reservation: {
			period: "2026-08",
			reserved: 100,
			settled: false,
			userId: ACTOR,
			runId,
		},
	});
	return {
		sessionId,
		target: { kind: "design-session", designSessionId: sessionId },
		runId,
	};
}

describe("upsertThreadTurn on a design-session target", () => {
	it("inserts a new thread live under the session's exact holder (initial thread write)", async () => {
		const { target, runId } = await seedHeldSession("insert");
		const written = await upsertThreadTurn({
			target,
			threadId: "ds-thread-1",
			runId,
			streamId: "stream-1",
			holderNonce: NONCE,
			threadType: "build",
			messages: [userMsg("m1", "build me an app")],
			expectedProjectId: PROJECT,
		});
		expect(written).toBe(true);
		const row = await h
			.db()
			.selectFrom("threads")
			.selectAll()
			.where("thread_id", "=", "ds-thread-1")
			.executeTakeFirstOrThrow();
		expect(row).toMatchObject({
			app_id: null,
			design_session_id:
				target.kind === "design-session" ? target.designSessionId : null,
			thread_type: "build",
			run_id: runId,
			active_stream_id: "stream-1",
			summary: "build me an app",
		});
	});

	it("proves the session holder: a stale nonce merges real history but never installs its marker", async () => {
		const { target, runId } = await seedHeldSession("holder");
		await upsertThreadTurn({
			target,
			threadId: "ds-thread-h",
			runId,
			streamId: "stream-owned",
			holderNonce: NONCE,
			threadType: "build",
			messages: [userMsg("m1", "first turn")],
			expectedProjectId: PROJECT,
		});
		await expect(
			upsertThreadTurn({
				target,
				threadId: "ds-thread-h",
				runId,
				streamId: "stream-stale",
				holderNonce: OTHER_NONCE,
				threadType: "build",
				messages: [userMsg("m1", "first turn"), userMsg("m2", "second turn")],
				expectedProjectId: PROJECT,
			}),
		).rejects.toBeInstanceOf(RunHolderLostError);
		const row = await h
			.db()
			.selectFrom("threads")
			.select(["active_stream_id", "messages"])
			.where("thread_id", "=", "ds-thread-h")
			.executeTakeFirstOrThrow();
		/* The merge-only arm landed the real message; the marker stayed the
		 * owner's. */
		expect(row.active_stream_id).toBe("stream-owned");
		expect((row.messages as UIMessage[]).map((m) => m.id)).toEqual([
			"m1",
			"m2",
		]);
	});

	it("a wrong Project reads as released holder loss", async () => {
		const { target, runId } = await seedHeldSession("project");
		await expect(
			upsertThreadTurn({
				target,
				threadId: "ds-thread-p",
				runId,
				streamId: "stream-p",
				holderNonce: NONCE,
				threadType: "build",
				messages: [userMsg("m1", "hi")],
				expectedProjectId: "some-other-project",
			}),
		).rejects.toBeInstanceOf(RunHolderLostError);
	});

	it("writes NOTHING when the thread id belongs to another target (cross-target guard)", async () => {
		const { target, runId } = await seedHeldSession("guard-a");
		const other = await seedHeldSession("guard-b");
		await upsertThreadTurn({
			target,
			threadId: "ds-thread-g",
			runId,
			streamId: "stream-g",
			holderNonce: NONCE,
			threadType: "build",
			messages: [userMsg("m1", "mine")],
			expectedProjectId: PROJECT,
		});
		expect(
			await upsertThreadTurn({
				target: other.target,
				threadId: "ds-thread-g",
				runId: other.runId,
				streamId: "stream-forged",
				holderNonce: NONCE,
				threadType: "build",
				messages: [userMsg("mx", "forged")],
				expectedProjectId: PROJECT,
			}),
		).toBe(false);
		const row = await h
			.db()
			.selectFrom("threads")
			.select(["active_stream_id", "design_session_id"])
			.where("thread_id", "=", "ds-thread-g")
			.executeTakeFirstOrThrow();
		expect(row.active_stream_id).toBe("stream-g");
	});

	it("a FRESH session thread admits no assistant history; a stale client's copy merges without erasing (stale-client merge)", async () => {
		const { target, runId } = await seedHeldSession("merge");
		await upsertThreadTurn({
			target,
			threadId: "ds-thread-m",
			runId,
			streamId: "stream-m1",
			holderNonce: NONCE,
			threadType: "build",
			messages: [userMsg("m1", "turn one"), assistantMsg("a-forged", "fake")],
			expectedProjectId: PROJECT,
		});
		let row = await h
			.db()
			.selectFrom("threads")
			.select("messages")
			.where("thread_id", "=", "ds-thread-m")
			.executeTakeFirstOrThrow();
		expect((row.messages as UIMessage[]).map((m) => m.id)).toEqual(["m1"]);
		/* A server barrier lands a real answer; a stale client that never saw
		 * it cannot erase it. */
		await persistResponseSnapshot({
			target,
			threadId: "ds-thread-m",
			streamId: "stream-m1",
			expectedProjectId: PROJECT,
			responseMessage: assistantMsg("a1", "real answer"),
			clearMarker: false,
		});
		await upsertThreadTurn({
			target,
			threadId: "ds-thread-m",
			runId,
			streamId: "stream-m2",
			holderNonce: NONCE,
			threadType: "build",
			messages: [userMsg("m1", "turn one"), userMsg("m2", "turn two")],
			expectedProjectId: PROJECT,
		});
		row = await h
			.db()
			.selectFrom("threads")
			.select("messages")
			.where("thread_id", "=", "ds-thread-m")
			.executeTakeFirstOrThrow();
		expect((row.messages as UIMessage[]).map((m) => m.id)).toEqual([
			"m1",
			"a1",
			"m2",
		]);
	});
});

describe("persistResponseSnapshot / clawBackThreadResponse on a design-session target", () => {
	async function seedThread(suffix: string) {
		const seeded = await seedHeldSession(suffix);
		const threadId = `ds-thread-${suffix}`;
		const streamId = `stream-${suffix}`;
		await upsertThreadTurn({
			target: seeded.target,
			threadId,
			runId: seeded.runId,
			streamId,
			holderNonce: NONCE,
			threadType: "build",
			messages: [userMsg("m1", "question")],
			expectedProjectId: PROJECT,
		});
		return { ...seeded, threadId, streamId };
	}

	it("grows the message per barrier, merges the final state, and retires the marker at terminal success", async () => {
		const { target, threadId, streamId } = await seedThread("barrier");
		await persistResponseSnapshot({
			target,
			threadId,
			streamId,
			expectedProjectId: PROJECT,
			responseMessage: assistantMsg("a1", "step one"),
			clearMarker: false,
		});
		const row = await h
			.db()
			.selectFrom("threads")
			.select(["messages", "active_stream_id"])
			.where("thread_id", "=", threadId)
			.executeTakeFirstOrThrow();
		expect(row.active_stream_id).toBe(streamId);
		expect((row.messages as UIMessage[]).map((m) => m.id)).toEqual([
			"m1",
			"a1",
		]);
		await persistResponseSnapshot({
			target,
			threadId,
			streamId,
			expectedProjectId: PROJECT,
			responseMessage: assistantMsg("a1", "step one and two"),
			clearMarker: true,
		});
		const terminal = await h
			.db()
			.selectFrom("threads")
			.select(["messages", "active_stream_id", "active_holder_nonce"])
			.where("thread_id", "=", threadId)
			.executeTakeFirstOrThrow();
		expect(terminal.active_stream_id).toBeNull();
		expect(terminal.active_holder_nonce).toBeNull();
	});

	it("terminal pause retains the continuation nonce (§20.11 terminal pause)", async () => {
		const { target, threadId, streamId } = await seedThread("pause");
		await persistResponseSnapshot({
			target,
			threadId,
			streamId,
			expectedProjectId: PROJECT,
			responseMessage: assistantMsg("a1", "which case types?"),
			clearMarker: true,
			retainHolderNonce: true,
		});
		const row = await h
			.db()
			.selectFrom("threads")
			.select(["active_stream_id", "active_holder_nonce"])
			.where("thread_id", "=", threadId)
			.executeTakeFirstOrThrow();
		expect(row.active_stream_id).toBeNull();
		expect(row.active_holder_nonce).toBe(NONCE);
	});

	it("claws back a failed turn's partial with a tombstone that refuses stale resurrection", async () => {
		const { target, threadId, streamId, runId } = await seedThread("claw");
		await persistResponseSnapshot({
			target,
			threadId,
			streamId,
			expectedProjectId: PROJECT,
			responseMessage: assistantMsg("a-dead", "partial ans"),
			clearMarker: false,
		});
		await clawBackThreadResponse({
			target,
			threadId,
			streamId,
			messageId: "a-dead",
		});
		const row = await h
			.db()
			.selectFrom("threads")
			.select(["messages", "active_stream_id", "clawed_back_ids"])
			.where("thread_id", "=", threadId)
			.executeTakeFirstOrThrow();
		expect((row.messages as UIMessage[]).map((m) => m.id)).toEqual(["m1"]);
		expect(row.active_stream_id).toBeNull();
		expect(row.clawed_back_ids).toEqual(["a-dead"]);
		/* The tombstone refuses the partial riding the next send. */
		await upsertThreadTurn({
			target,
			threadId,
			runId,
			streamId: "stream-next",
			holderNonce: NONCE,
			threadType: "build",
			messages: [
				userMsg("m1", "question"),
				assistantMsg("a-dead", "partial ans"),
				userMsg("m2", "retry"),
			],
			expectedProjectId: PROJECT,
		});
		const afterRetry = await h
			.db()
			.selectFrom("threads")
			.select(["messages"])
			.where("thread_id", "=", threadId)
			.executeTakeFirstOrThrow();
		expect((afterRetry.messages as UIMessage[]).map((m) => m.id)).toEqual([
			"m1",
			"m2",
		]);
	});

	it("a re-drive claim removes the dead run's trailing partial (re-drive marker replacement)", async () => {
		const { target, threadId, streamId, runId } = await seedThread("redrive");
		await persistResponseSnapshot({
			target,
			threadId,
			streamId,
			expectedProjectId: PROJECT,
			responseMessage: assistantMsg("a-dead", "half an answer"),
			clearMarker: false,
		});
		await upsertThreadTurn({
			target,
			threadId,
			runId,
			streamId: "stream-redrive",
			holderNonce: NONCE,
			threadType: "build",
			messages: [userMsg("m1", "question")],
			expectedProjectId: PROJECT,
			redrive: true,
		});
		const row = await h
			.db()
			.selectFrom("threads")
			.select(["messages", "active_stream_id", "clawed_back_ids"])
			.where("thread_id", "=", threadId)
			.executeTakeFirstOrThrow();
		expect((row.messages as UIMessage[]).map((m) => m.id)).toEqual(["m1"]);
		expect(row.active_stream_id).toBe("stream-redrive");
		expect(row.clawed_back_ids).toEqual(["a-dead"]);
	});

	it("a re-drive rewinds a continued assistant message to its exact completed prefix", async () => {
		const { target, threadId, streamId, runId } =
			await seedThread("redrive-prefix");
		const completed = {
			id: "a-continued",
			role: "assistant",
			parts: [
				{ type: "step-start" },
				{
					type: "tool-askQuestions",
					toolCallId: "ask-1",
					state: "output-available",
					input: { questions: [] },
					output: { answers: ["Nurses"] },
				},
			],
		} as UIMessage;
		await persistResponseSnapshot({
			target,
			threadId,
			streamId,
			expectedProjectId: PROJECT,
			responseMessage: {
				...completed,
				parts: [
					...completed.parts,
					{ type: "step-start" },
					{ type: "text", text: "unfinished continuation" },
				],
			},
			clearMarker: false,
		});
		await upsertThreadTurn({
			target,
			threadId,
			runId,
			streamId: "stream-redrive-prefix",
			holderNonce: NONCE,
			threadType: "build",
			messages: [userMsg("m1", "question"), completed],
			expectedProjectId: PROJECT,
			redrive: true,
		});

		const row = await h
			.db()
			.selectFrom("threads")
			.select(["messages", "active_stream_id", "clawed_back_ids"])
			.where("thread_id", "=", threadId)
			.executeTakeFirstOrThrow();
		const messages = row.messages as UIMessage[];
		expect(messages.map((message) => message.id)).toEqual([
			"m1",
			"a-continued",
		]);
		expect(messages[1]).toEqual(completed);
		expect(row.active_stream_id).toBe("stream-redrive-prefix");
		expect(row.clawed_back_ids).toEqual(["a-continued"]);

		await mergeThreadTurnMessages({
			target,
			threadId,
			messages: [
				userMsg("m1", "question"),
				{
					...completed,
					parts: [
						...completed.parts,
						{ type: "step-start" },
						{ type: "text", text: "stale unfinished continuation" },
					],
				},
			],
			expectedProjectId: PROJECT,
		});
		const afterStaleMerge = await h
			.db()
			.selectFrom("threads")
			.select(["messages", "clawed_back_ids"])
			.where("thread_id", "=", threadId)
			.executeTakeFirstOrThrow();
		expect((afterStaleMerge.messages as UIMessage[])[1]).toEqual(completed);
		expect(afterStaleMerge.clawed_back_ids).toEqual(["a-continued"]);
	});

	it("bailed-history merge lands real state without touching identity or marker", async () => {
		const { target, threadId, streamId } = await seedThread("bail");
		expect(
			await mergeThreadTurnMessages({
				target,
				threadId,
				messages: [userMsg("m1", "question"), userMsg("m2", "answered round")],
				expectedProjectId: PROJECT,
			}),
		).toBe(true);
		const row = await h
			.db()
			.selectFrom("threads")
			.select(["messages", "active_stream_id"])
			.where("thread_id", "=", threadId)
			.executeTakeFirstOrThrow();
		expect((row.messages as UIMessage[]).map((m) => m.id)).toEqual([
			"m1",
			"m2",
		]);
		expect(row.active_stream_id).toBe(streamId);
	});
});

describe("loaders on a design-session target", () => {
	it("lists metas, resolves the thread stream to the session target, and projects the holder off the session lease", async () => {
		const { sessionId, target, runId } = await seedHeldSession("load");
		await upsertThreadTurn({
			target,
			threadId: "ds-thread-l",
			runId,
			streamId: "stream-l",
			holderNonce: NONCE,
			threadType: "build",
			messages: [userMsg("m1", "hello")],
			expectedProjectId: PROJECT,
		});
		const metas = await listThreadMetas(target);
		expect(metas).toHaveLength(1);
		expect(metas[0]).toMatchObject({
			thread_id: "ds-thread-l",
			active_stream_id: "stream-l",
		});
		expect(await resolveThreadStream("ds-thread-l")).toEqual({
			target: { kind: "design-session", designSessionId: sessionId },
			activeStreamId: "stream-l",
			runId,
		});
		/* A LIVE run's nonce projects to its owning actor only. */
		const ownerView = await loadThread(target, "ds-thread-l", ACTOR);
		expect(ownerView?.run_paused).toBeUndefined();
		expect(ownerView?.holder_nonce).toBe(NONCE);
		await h.seedProjectMember("co-member", PROJECT, "editor");
		const coView = await loadThread(target, "ds-thread-l", "co-member");
		expect(coView?.holder_nonce).toBeUndefined();
		/* Park the run on a question round: run_paused stamps, and the nonce
		 * projects to the pause's own answering actor. */
		await h
			.db()
			.updateTable("design_sessions")
			.set({ awaiting_input: true })
			.where("id", "=", sessionId)
			.execute();
		const paused = await loadThread(target, "ds-thread-l", ACTOR);
		expect(paused?.run_paused).toBe(true);
		expect(paused?.holder_nonce).toBe(NONCE);
	});

	it("stamps resume_interrupted only for a dead unsealed stream; a sealed finished stream projects retired (§20.11 recovery)", async () => {
		/* An at-rest session (no holder) with a marked thread is the
		 * instance-death signature. */
		const sessionId = await h.seedDesignSession({ owner_user_id: ACTOR });
		const target: GenerationTarget = {
			kind: "design-session",
			designSessionId: sessionId,
		};
		const held = await seedHeldSession("dead");
		await upsertThreadTurn({
			target: held.target,
			threadId: "ds-thread-dead",
			runId: held.runId,
			streamId: "stream-dead",
			holderNonce: NONCE,
			threadType: "build",
			messages: [userMsg("m1", "hi")],
			expectedProjectId: PROJECT,
		});
		/* Release the holder so the session reads at rest, marker stranded. */
		await h
			.db()
			.updateTable("design_sessions")
			.set({
				run_id: null,
				run_holder_nonce: null,
				run_actor_user_id: null,
				run_mode: null,
				run_lease_expires_at: null,
				res_period: null,
				res_reserved: null,
				res_settled: null,
				res_user_id: null,
				res_run_id: null,
			})
			.where("id", "=", held.sessionId)
			.execute();
		void target;
		const interrupted = await loadThread(held.target, "ds-thread-dead", ACTOR);
		expect(interrupted?.resume_interrupted).toBe(true);
		expect(interrupted?.active_stream_id).toBeNull();
		/* The row itself was never written — the signal is level-triggered. */
		const raw = await h
			.db()
			.selectFrom("threads")
			.select("active_stream_id")
			.where("thread_id", "=", "ds-thread-dead")
			.executeTakeFirstOrThrow();
		expect(raw.active_stream_id).toBe("stream-dead");
		/* Seal the stream as completed: the stranded marker now projects
		 * RETIRED, never interrupted — the finished answer is not re-driven. */
		await appendStreamChunks({
			streamId: "stream-dead",
			target: held.target,
			runId: held.runId,
			firstIndex: 0,
			chunks: [{ type: "finish" }],
			terminal: true,
			terminalOutcome: "completed",
		});
		const retired = await loadThread(held.target, "ds-thread-dead", ACTOR);
		expect(retired?.resume_interrupted).toBeUndefined();
		expect(retired?.active_stream_id).toBeNull();
	});

	it("generationTargetHeldLive follows a materialized session to its bound app", async () => {
		/* A stream keeps its design-session target for its whole life, so the
		 * reconnect endpoint's dead-run fallback asks THIS question after
		 * materialization — the terminal session row alone would read dead
		 * and cut a still-live run's tail. */
		const liveAppId = await h.seedApp({
			id: "app-heldlive-live",
			owner: ACTOR,
			status: "generating",
			run_id: "run-hl",
			run_holder_nonce: NONCE,
		});
		const liveSession = await h.seedDesignSession({
			owner_user_id: ACTOR,
			state: "materialized",
			app_id: liveAppId,
		});
		expect(
			await generationTargetHeldLive({
				kind: "design-session",
				designSessionId: liveSession,
			}),
		).toBe(true);
		const idleAppId = await h.seedApp({
			id: "app-heldlive-idle",
			owner: ACTOR,
			status: "complete",
		});
		const idleSession = await h.seedDesignSession({
			owner_user_id: ACTOR,
			state: "materialized",
			app_id: idleAppId,
		});
		expect(
			await generationTargetHeldLive({
				kind: "design-session",
				designSessionId: idleSession,
			}),
		).toBe(false);
	});

	it("a MATERIALIZED session's thread delegates authority to the bound app (§20.11 materialized resolution)", async () => {
		/* Build the lineage: a session that materialized into an app whose row
		 * now holds the live build. */
		const appId = await h.seedApp({
			id: "app-materialized",
			owner: ACTOR,
			status: "generating",
			run_id: "run-mat",
			run_holder_nonce: NONCE,
		});
		const sessionId = await h.seedDesignSession({
			owner_user_id: ACTOR,
			state: "materialized",
			app_id: appId,
		});
		const target: GenerationTarget = {
			kind: "design-session",
			designSessionId: sessionId,
		};
		/* The thread stays design-session-targeted; the APP row's holder is
		 * what admits the write. */
		const written = await upsertThreadTurn({
			target,
			threadId: "ds-thread-mat",
			runId: "run-mat",
			streamId: "stream-mat",
			holderNonce: NONCE,
			threadType: "build",
			messages: [userMsg("m1", "post-materialization turn")],
			expectedProjectId: PROJECT,
		});
		expect(written).toBe(true);
		const row = await h
			.db()
			.selectFrom("threads")
			.select(["design_session_id", "app_id"])
			.where("thread_id", "=", "ds-thread-mat")
			.executeTakeFirstOrThrow();
		expect(row).toEqual({ design_session_id: sessionId, app_id: null });
		/* A stale session-shaped holder that no longer matches the APP's
		 * holder is refused. */
		await expect(
			upsertThreadTurn({
				target,
				threadId: "ds-thread-mat",
				runId: "run-mat",
				streamId: "stream-stale",
				holderNonce: OTHER_NONCE,
				threadType: "build",
				messages: [userMsg("m1", "post-materialization turn")],
				expectedProjectId: PROJECT,
			}),
		).rejects.toBeInstanceOf(RunHolderLostError);
		/* And the loader projects the app's live holder to its owner. */
		const loaded = await loadThread(target, "ds-thread-mat", ACTOR);
		expect(loaded?.holder_nonce).toBe(NONCE);
	});
});

describe("pre-app thread media references (§20.12)", () => {
	it("a session thread's attachment lands in thread_media_refs and blocks deletion", async () => {
		const assetId = testMediaAssetId("80000000-0000-4000-8000-000000000001");
		await seedReadyDocument(assetId);
		const { target, runId } = await seedHeldSession("media");
		await upsertThreadTurn({
			target,
			threadId: "ds-thread-media",
			runId,
			streamId: "stream-media",
			holderNonce: NONCE,
			threadType: "build",
			messages: [attachmentMsg("m1", assetId)],
			expectedProjectId: PROJECT,
		});
		expect(
			await h
				.db()
				.selectFrom("thread_media_refs")
				.select(["thread_id", "project_id"])
				.where("asset_id", "=", assetId)
				.executeTakeFirst(),
		).toEqual({ thread_id: "ds-thread-media", project_id: PROJECT });
		/* A pre-app conversation reference prevents deletion. */
		await expect(
			deleteMediaAssetForActor({
				assetId,
				actorUserId: ACTOR,
				expectedProjectId: PROJECT,
			}),
		).resolves.toMatchObject({
			kind: "referenced",
			references: [expect.stringContaining("conversation attachment")],
		});
	});

	it("a transcript reference blocks deletion even with its projection row missing", async () => {
		/* The deletion guard's defense-in-depth backstop: the per-thread
		 * projection is the authority the writers maintain, but deletion is
		 * irreversible (the bytes purge post-commit), so a missing
		 * `thread_media_refs` row — a writer predating the projection, a
		 * rollout window — must not authorize a purge the transcript itself
		 * refutes. */
		const assetId = testMediaAssetId("80000000-0000-4000-8000-000000000003");
		await seedReadyDocument(assetId);
		const { target, runId } = await seedHeldSession("backstop");
		await upsertThreadTurn({
			target,
			threadId: "ds-thread-backstop",
			runId,
			streamId: "stream-backstop",
			holderNonce: NONCE,
			threadType: "build",
			messages: [attachmentMsg("m1", assetId)],
			expectedProjectId: PROJECT,
		});
		await h
			.db()
			.deleteFrom("thread_media_refs")
			.where("asset_id", "=", assetId)
			.execute();
		await expect(
			deleteMediaAssetForActor({
				assetId,
				actorUserId: ACTOR,
				expectedProjectId: PROJECT,
			}),
		).resolves.toMatchObject({
			kind: "referenced",
			references: [expect.stringContaining("conversation attachment")],
		});
	});

	it("two threads never erase each other's edges; a failed write changes no edges", async () => {
		const shared = testMediaAssetId("80000000-0000-4000-8000-000000000002");
		const missing = testMediaAssetId("80000000-0000-4000-8000-00000000dead");
		await seedReadyDocument(shared);
		const a = await seedHeldSession("edges-a");
		const b = await seedHeldSession("edges-b");
		await upsertThreadTurn({
			target: a.target,
			threadId: "ds-thread-ea",
			runId: a.runId,
			streamId: "stream-ea",
			holderNonce: NONCE,
			threadType: "build",
			messages: [attachmentMsg("m1", shared)],
			expectedProjectId: PROJECT,
		});
		await upsertThreadTurn({
			target: b.target,
			threadId: "ds-thread-eb",
			runId: b.runId,
			streamId: "stream-eb",
			holderNonce: NONCE,
			threadType: "build",
			messages: [attachmentMsg("m2", shared)],
			expectedProjectId: PROJECT,
		});
		const edges = await h
			.db()
			.selectFrom("thread_media_refs")
			.select("thread_id")
			.where("asset_id", "=", shared)
			.orderBy("thread_id")
			.execute();
		expect(edges.map((edge) => edge.thread_id)).toEqual([
			"ds-thread-ea",
			"ds-thread-eb",
		]);
		/* A rejected transcript write (missing asset) rolls back whole: no
		 * thread, no edges. */
		const c = await seedHeldSession("edges-c");
		await expect(
			upsertThreadTurn({
				target: c.target,
				threadId: "ds-thread-ec",
				runId: c.runId,
				streamId: "stream-ec",
				holderNonce: NONCE,
				threadType: "build",
				messages: [attachmentMsg("m3", missing)],
				expectedProjectId: PROJECT,
			}),
		).rejects.toBeInstanceOf(ThreadAttachmentUnavailableError);
		expect(await loadThread(c.target, "ds-thread-ec")).toBeNull();
	});
});
