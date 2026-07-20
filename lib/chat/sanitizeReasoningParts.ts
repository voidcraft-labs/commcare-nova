/**
 * Reasoning-part repair for the chat route — the wire contract that keeps a
 * resumed thread from ever poisoning its own model requests.
 *
 * Nova runs OpenAI's Responses API STATELESS (`store: false` +
 * `include: ["reasoning.encrypted_content"]` — verified against live chunk
 * logs: every reasoning part streams back with
 * `providerMetadata.openai.{itemId, reasoningEncryptedContent}`). Replayed
 * history therefore re-sends reasoning as full encrypted items, and the wire
 * enforces two pairing rules on them:
 *
 *   - a replayed reasoning item must be followed by the item that originally
 *     followed it ("Item 'rs_…' of type 'reasoning' was provided without its
 *     required following item");
 *   - a function call whose OUTPUT is being submitted must keep the reasoning
 *     items that preceded it ("'function_call' was provided without its
 *     required 'reasoning' item").
 *
 * Both rules bind the CURRENT tool loop — the items since the last user
 * message. Deeper history is exempt: OpenAI documents that prior-turn
 * reasoning items are "smartly ignored", so replaying them buys nothing,
 * bills their tokens as input every turn, and carries a third hazard —
 * encrypted reasoning is MODEL-BOUND ("The encrypted content could not be
 * verified"), so one model change would 400 every old thread forever.
 *
 * The repair, applied AFTER `sanitizeHistoricalToolParts` (which may drop
 * tool parts and thereby change what pairing survives):
 *
 *   1. HISTORICAL assistant messages (everything but a trailing assistant
 *      continuation) drop their reasoning parts. Text and tool parts stay —
 *      completed function_call/output pairs in deep history replay fine
 *      without reasoning.
 *   2. The TRAILING assistant message — the answered-askQuestions auto-resend,
 *      the one shape that submits a function call's output — KEEPS its
 *      reasoning when it still carries tool parts and its `metadata.model`
 *      matches the model running this turn (the route stamps the producing
 *      model on every assistant message via `messageMetadata`).
 *   3. A trailing pause whose model does NOT match (a deploy switched the SA
 *      model while a question round sat open, or the stamp is missing) is
 *      unreplayable both ways — its encrypted reasoning won't verify, and its
 *      function_call can't ride without that reasoning. The round is
 *      converted to TEXT: each answered `askQuestions` part renders as the
 *      questions-and-answers dialogue, every other tool part drops (the SA
 *      re-reads doc state through its read tools), reasoning drops. The SA
 *      sees the full exchange; nothing pairs on the wire.
 *
 * Deterministic in its inputs (same messages + same model → same output) so
 * successive requests keep identical cacheable prefixes; unchanged messages
 * return by reference.
 */

import type { UIMessage } from "ai";

type Part = UIMessage["parts"][number];

/** Structural view of an `askQuestions` round: the SA's input (header +
 * questions) and the client's output (answers keyed by question index as a
 * string — `AskQuestionsCard.applyAnswer`). Parsed defensively: parts ride in
 * from the client, and this module deliberately doesn't import the agent's
 * Zod schemas (the repair must never throw on a malformed round — it renders
 * what it can read). */
interface AskQuestionsShape {
	input?: {
		header?: unknown;
		questions?: { question?: unknown }[];
	};
	output?: Record<string, unknown>;
	state?: string;
}

function isReasoningPart(part: Part): boolean {
	return part.type === "reasoning";
}

function isToolPart(part: Part): boolean {
	return part.type.startsWith("tool-");
}

/** Render an answered `askQuestions` part as plain dialogue text — the same
 * projection the threads migration applies to pre-thread question rounds, so
 * the SA reads a consistent shape for any round that can't replay as wire
 * items. */
function askQuestionsPartToText(part: Part): string {
	const shaped = part as unknown as AskQuestionsShape;
	const lines: string[] = [];
	const header = shaped.input?.header;
	if (typeof header === "string" && header.length > 0) lines.push(header);
	const questions = Array.isArray(shaped.input?.questions)
		? shaped.input.questions
		: [];
	questions.forEach((q, i) => {
		const question = typeof q?.question === "string" ? q.question : null;
		if (!question) return;
		const answer = shaped.output?.[String(i)];
		lines.push(
			`${question}\n→ ${typeof answer === "string" ? answer : "(unanswered)"}`,
		);
	});
	return lines.join("\n\n");
}

/**
 * Apply the reasoning-part contract above. `turnModel` is the model id
 * the SA will run THIS turn (`SA_EDIT_MODEL` / `SA_BUILD_MODEL` by mode).
 */
export function sanitizeHistoricalReasoningParts<M extends UIMessage>(
	messages: M[],
	turnModel: string,
): M[] {
	const lastIndex = messages.length - 1;
	const out: M[] = [];
	let changedAny = false;

	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		if (m.role !== "assistant" || !m.parts.some(isReasoningPart)) {
			out.push(m);
			continue;
		}

		const isContinuationTail = i === lastIndex;
		if (isContinuationTail && m.parts.some(isToolPart)) {
			const producedBy = (m.metadata as { model?: unknown } | undefined)?.model;
			if (producedBy === turnModel) {
				// Same model, pairing intact — the one shape that must replay
				// verbatim (reasoning + function_call + the output being
				// submitted).
				out.push(m);
				continue;
			}
			// Model crossing: textify the question rounds, drop what can't ride.
			const parts: Part[] = [];
			for (const p of m.parts) {
				if (isReasoningPart(p)) continue;
				if (p.type === "tool-askQuestions") {
					const text = askQuestionsPartToText(p);
					if (text.length > 0)
						parts.push({ type: "text", text } as unknown as Part);
					continue;
				}
				if (isToolPart(p)) continue;
				parts.push(p);
			}
			// A message repaired down to nothing drops whole (mirroring
			// `sanitizeHistoricalToolParts`) — an empty assistant message is
			// noise to the model and rejected by some validators.
			if (parts.some((p) => p.type !== "step-start")) {
				out.push({ ...m, parts });
			}
			changedAny = true;
			continue;
		}

		out.push({ ...m, parts: m.parts.filter((p) => !isReasoningPart(p)) });
		changedAny = true;
	}

	return changedAny ? out : messages;
}
