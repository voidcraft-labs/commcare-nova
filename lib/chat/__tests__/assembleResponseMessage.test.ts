/**
 * Chunk-log → assistant-UIMessage assembly. The chunk log is the single
 * source of truth for what a POST streamed, and this assembly must match
 * what a live client assembled from the same chunks — including the
 * turn-retry shape (suppressed `start`, explicit part closures) and the
 * paused-askQuestions shape (tool part left `input-available`).
 */
import type { UIMessage, UIMessageChunk } from "ai";
import { beforeEach, describe, expect, it } from "vitest";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { appendStreamChunks } from "@/lib/db/streamChunks";
import { assembleResponseMessage } from "../assembleResponseMessage";

const h = setupAppStateTestDb("assemble_");
const APP = "app-assemble";

beforeEach(async () => {
	await h.seedApp({ id: APP });
});

const c = (chunk: Record<string, unknown>) => chunk as UIMessageChunk;

async function seedStream(streamId: string, chunks: UIMessageChunk[]) {
	await appendStreamChunks({
		streamId,
		appId: APP,
		runId: "run-1",
		firstIndex: 0,
		chunks,
		terminal: true,
	});
}

describe("assembleResponseMessage", () => {
	it("assembles a plain text response with the streamed message id", async () => {
		await seedStream("s1", [
			c({ type: "start", messageId: "resp-1" }),
			c({ type: "start-step" }),
			c({ type: "text-start", id: "0" }),
			c({ type: "text-delta", id: "0", delta: "hel" }),
			c({ type: "text-delta", id: "0", delta: "lo" }),
			c({ type: "text-end", id: "0" }),
			c({ type: "finish-step" }),
			c({ type: "finish" }),
		]);

		const msg = await assembleResponseMessage("s1");
		expect(msg?.id).toBe("resp-1");
		expect(msg?.role).toBe("assistant");
		const text = msg?.parts.find((p) => p.type === "text");
		expect(text && "text" in text ? text.text : undefined).toBe("hello");
	});

	it("excludes transient data parts (the route's data-* envelopes)", async () => {
		await seedStream("s2", [
			c({ type: "start", messageId: "resp-2" }),
			c({
				type: "data-run-id",
				data: { runId: "run-1" },
				transient: true,
			}),
			c({ type: "text-start", id: "0" }),
			c({ type: "text-delta", id: "0", delta: "hi" }),
			c({ type: "text-end", id: "0" }),
			c({ type: "finish" }),
		]);

		const msg = await assembleResponseMessage("s2");
		expect(msg?.parts.some((p) => p.type.startsWith("data-"))).toBe(false);
	});

	it("assembles a paused askQuestions round as input-available", async () => {
		await seedStream("s3", [
			c({ type: "start", messageId: "resp-3" }),
			c({ type: "start-step" }),
			c({
				type: "tool-input-start",
				toolCallId: "ask-1",
				toolName: "askQuestions",
			}),
			c({
				type: "tool-input-available",
				toolCallId: "ask-1",
				toolName: "askQuestions",
				input: { header: "Setup", questions: [] },
			}),
			c({ type: "finish-step" }),
			c({ type: "finish" }),
		]);

		const msg = await assembleResponseMessage("s3");
		const ask = msg?.parts.find((p) => p.type === "tool-askQuestions");
		expect(ask && "state" in ask ? ask.state : undefined).toBe(
			"input-available",
		);
	});

	it("continues a trailing assistant message into ONE merged message", async () => {
		const answered: UIMessage = {
			id: "resp-4",
			role: "assistant",
			parts: [{ type: "text", text: "which case type?" }],
		};
		await seedStream("s4", [
			// The continuation reuses the trailing message's id (the route
			// threads `originalMessages` into `toUIMessageStream`).
			c({ type: "start", messageId: "resp-4" }),
			c({ type: "start-step" }),
			c({ type: "text-start", id: "1" }),
			c({ type: "text-delta", id: "1", delta: "done" }),
			c({ type: "text-end", id: "1" }),
			c({ type: "finish-step" }),
			c({ type: "finish" }),
		]);

		const msg = await assembleResponseMessage("s4", answered);
		expect(msg?.id).toBe("resp-4");
		const texts = msg?.parts.filter((p) => p.type === "text");
		expect(texts).toHaveLength(2);
		// The caller's copy stays pristine (the processor works on a clone).
		expect(answered.parts).toHaveLength(1);
	});

	it("returns null for an empty log, a contentless run, and a dead continuation", async () => {
		expect(await assembleResponseMessage("missing")).toBeNull();

		await seedStream("s5", [c({ type: "start" }), c({ type: "finish" })]);
		expect(await assembleResponseMessage("s5")).toBeNull();

		const seed: UIMessage = {
			id: "resp-6",
			role: "assistant",
			parts: [{ type: "text", text: "round" }],
		};
		await seedStream("s6", [
			c({ type: "start", messageId: "resp-6" }),
			c({ type: "finish" }),
		]);
		expect(await assembleResponseMessage("s6", seed)).toBeNull();
	});
});
