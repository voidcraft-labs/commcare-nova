/**
 * Thread extraction utilities — converts live UIMessage arrays into the
 * compact StoredThreadMessage format for Firestore persistence.
 *
 * Only display-relevant parts are preserved: user text and completed
 * askQuestions tool calls. Everything else (tool-generateApp, data-*,
 * step-start, etc.) is stripped — it's in the event log if needed.
 */

import type { UIMessage } from "ai";
import type {
	StoredMessagePart,
	StoredThreadMessage,
	ThreadDoc,
} from "@/lib/db/types";

/** Maximum length for the thread summary (first user message, truncated). */
const SUMMARY_MAX_LENGTH = 200;

/**
 * Extract a StoredThreadMessage from a UIMessage, keeping only visible parts.
 *
 * Returns null if the message has no display-relevant parts after filtering
 * (e.g. an assistant message that was entirely tool calls with no text).
 */
function extractMessage(message: UIMessage): StoredThreadMessage | null {
	const parts: StoredMessagePart[] = [];

	for (const part of message.parts) {
		if (part.type === "text") {
			const text = part.text.trim();
			if (text) {
				parts.push({ type: "text", text });
			}
		} else if (
			part.type === "tool-askQuestions" &&
			"state" in part &&
			part.state === "output-available"
		) {
			/* Flatten the interactive askQuestions card into compact Q&A pairs.
			 * Raw input has the full options array; we only keep the question
			 * text and the selected answer for historical display.
			 * Type guard validates shape at runtime — if the tool schema changes,
			 * this safely skips instead of persisting garbage. */
			const input = part.input as Record<string, unknown> | undefined;
			const output = (part.output ?? {}) as Record<string, string>;
			if (
				!input?.header ||
				!Array.isArray(input.questions) ||
				typeof input.header !== "string"
			) {
				continue;
			}

			const questions = (
				input.questions as { question?: string; options?: unknown[] }[]
			).map((q, idx) => ({
				question: typeof q.question === "string" ? q.question : "",
				answer: output[String(idx)] ?? "",
			}));

			parts.push({
				type: "askQuestions",
				toolCallId: part.toolCallId,
				header: input.header as string,
				questions,
			});
		}
		/* All other part types (tool-generateApp, tool-editApp, data-*,
		 * step-start, etc.) are intentionally skipped — they're invisible
		 * in the chat UI and live in the event log for debugging. */
	}

	if (parts.length === 0) return null;

	return {
		id: message.id,
		role: message.role as "user" | "assistant",
		parts,
	};
}

/**
 * Extract a complete ThreadDoc from the current useChat messages array.
 *
 * Called on each status=ready transition to persist the thread incrementally.
 * Each call produces a full snapshot — Firestore `set()` overwrites the
 * previous version, so partial failures are harmless.
 *
 * @param messages  - Live UIMessage array from useChat
 * @param runId     - Generation session UUID (becomes the threadId)
 * @param isEdit    - Whether this is an edit session (true) or initial build (false)
 * @param createdAt - ISO 8601 timestamp captured on first save (prevents drift on incremental overwrites)
 */
export function extractThread(
	messages: UIMessage[],
	runId: string,
	isEdit: boolean,
	createdAt: string,
): ThreadDoc {
	const storedMessages: StoredThreadMessage[] = [];
	let summary = "";

	for (const msg of messages) {
		const stored = extractMessage(msg);
		if (!stored) continue;

		/* Capture the first user message as the thread summary. */
		if (!summary && stored.role === "user") {
			const firstText = stored.parts.find((p) => p.type === "text");
			if (firstText && firstText.type === "text") {
				summary =
					firstText.text.length > SUMMARY_MAX_LENGTH
						? `${firstText.text.slice(0, SUMMARY_MAX_LENGTH)}…`
						: firstText.text;
			}
		}

		storedMessages.push(stored);
	}

	return {
		created_at: createdAt,
		thread_type: isEdit ? "edit" : "build",
		summary,
		run_id: runId,
		messages: storedMessages,
	};
}
