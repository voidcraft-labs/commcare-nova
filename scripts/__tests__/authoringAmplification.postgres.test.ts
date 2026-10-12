import { expect, it } from "vitest";
import { persistModelMessage } from "@/lib/agent/modelMessagePersistence";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { upsertThreadTurn } from "@/lib/db/threads";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	inspectAuthoringAmplification,
	repairAuthoringAmplification,
} from "../lib/authoringAmplificationStore";
import {
	amplifiedConversation,
	durableFinal,
} from "./fixtures/authoringAmplification";

const h = setupAppStateTestDb();
it("repairs only the scanned inactive history and prevents an old browser restoring duplicates", async () => {
	const nonce = crypto.randomUUID();
	const sessionId = await h.seedDesignSession({
		owner_user_id: "owner",
		project_id: "project",
		run_id: "run",
		run_holder_nonce: nonce,
		run_actor_user_id: "owner",
		run_lease_expires_at: new Date(0),
		awaiting_input: true,
	});
	const contextId = crypto.randomUUID();
	const now = new Date();
	await h
		.db()
		.insertInto("design_model_contexts")
		.values({
			id: contextId,
			design_session_id: sessionId,
			context_kind: "architect",
			generation: 0,
			supersedes_context_id: null,
			model_id: "fixture",
			prompt_version: "fixture",
			toolset_digest: "a".repeat(64),
			context_version: "fixture",
			revision: 1,
			created_at: now,
			updated_at: now,
		})
		.execute();
	await h
		.db()
		.insertInto("design_model_context_items")
		.values({
			context_id: contextId,
			ordinal: 1,
			append_key: "response:fixture",
			append_index: 0,
			item_digest: canonicalJsonDigest(persistModelMessage(durableFinal)),
			message: JSON.stringify(persistModelMessage(durableFinal)),
			created_by_run_id: "run",
			created_at: now,
		})
		.execute();
	const messages = amplifiedConversation(1918);
	await h
		.db()
		.insertInto("threads")
		.values({
			thread_id: "thread",
			app_id: null,
			design_session_id: sessionId,
			created_at: now.toISOString(),
			updated_at: now.toISOString(),
			thread_type: "build",
			summary: "Fixture",
			run_id: "run",
			active_stream_id: null,
			active_holder_nonce: null,
			messages: JSON.stringify(messages),
		})
		.execute();
	const scan = await inspectAuthoringAmplification("thread");
	if (!scan) throw new Error("Expected incident finding.");
	const args = {
		threadId: "thread",
		guardDigest: scan.guardDigest,
		transcriptDigest: scan.transcriptDigest,
		apply: false,
	};
	expect(scan.repairable).toBe(true);
	await expect(repairAuthoringAmplification(args)).resolves.toMatchObject({
		applied: false,
		removedParts: 1917,
	});
	expect(
		(await inspectAuthoringAmplification("thread"))?.transcriptDigest,
	).toBe(scan.transcriptDigest);
	await expect(
		repairAuthoringAmplification({
			...args,
			transcriptDigest: "wrong",
			apply: true,
		}),
	).rejects.toThrow("Scan evidence changed");
	await h
		.db()
		.updateTable("design_sessions")
		.set({ run_holder_nonce: crypto.randomUUID() })
		.where("id", "=", sessionId)
		.execute();
	await expect(
		repairAuthoringAmplification({ ...args, apply: true }),
	).rejects.toThrow("Scan evidence changed");
	await h
		.db()
		.updateTable("design_sessions")
		.set({ run_holder_nonce: nonce })
		.where("id", "=", sessionId)
		.execute();
	await h
		.db()
		.updateTable("design_sessions")
		.set({
			awaiting_input: false,
			run_lease_expires_at: new Date(Date.now() + 60_000),
		})
		.where("id", "=", sessionId)
		.execute();
	const liveScan = await inspectAuthoringAmplification("thread");
	if (!liveScan) throw new Error("Expected live incident finding.");
	expect(liveScan.repairable).toBe(false);
	await expect(
		repairAuthoringAmplification({
			...args,
			guardDigest: liveScan.guardDigest,
			apply: true,
		}),
	).rejects.toThrow("inactive, pre-app");
	await h
		.db()
		.updateTable("design_sessions")
		.set({ awaiting_input: true, run_lease_expires_at: new Date(0) })
		.where("id", "=", sessionId)
		.execute();
	const refreshed = await inspectAuthoringAmplification("thread");
	if (!refreshed) throw new Error("Expected repaired candidate.");
	await expect(
		repairAuthoringAmplification({
			...args,
			guardDigest: refreshed.guardDigest,
			apply: true,
		}),
	).resolves.toMatchObject({ applied: true, removedParts: 1917 });
	const repaired = await h
		.db()
		.selectFrom("threads")
		.selectAll()
		.where("thread_id", "=", "thread")
		.executeTakeFirstOrThrow();
	expect(repaired.messages).toEqual([
		messages[0],
		{ ...messages[1], parts: messages[1]?.parts.slice(0, 2) },
	]);
	expect(repaired.input_round).toBeNull();
	expect(repaired.clawed_back_ids).toContainEqual({ id: "response", cap: 0 });
	expect(
		(
			await h
				.db()
				.selectFrom("design_model_context_items")
				.select("message")
				.where("context_id", "=", contextId)
				.executeTakeFirstOrThrow()
		).message,
	).toEqual(persistModelMessage(durableFinal));
	await upsertThreadTurn({
		target: { kind: "design-session", designSessionId: sessionId },
		threadId: "thread",
		runId: "run",
		holderNonce: nonce,
		streamId: "next-stream",
		threadType: "build",
		expectedProjectId: "project",
		messages: [
			...messages,
			{
				id: "new-input",
				role: "user",
				parts: [{ type: "text", text: "Here is the missing information." }],
			},
		],
	});
	const merged = await h
		.db()
		.selectFrom("threads")
		.select("messages")
		.where("thread_id", "=", "thread")
		.executeTakeFirstOrThrow();
	expect(merged.messages.slice(0, 2)).toEqual(repaired.messages);
	expect(merged.messages).toHaveLength(3);
});
