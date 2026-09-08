/**
 * The Solutions Architect's per-turn history pipeline, in the order the chat
 * route runs it. One function so the route and the agent-anatomy page read
 * the same sequence: a step added, removed, or reordered here changes both.
 *
 * Attachment resolution happens BEFORE this pipeline (it can claim an
 * extraction job, so the caller owns it); the app-state tail is appended
 * AFTER it (a retry replaces that tail, so the caller owns that too).
 */

import {
	convertToModelMessages,
	type ModelMessage,
	type ToolSet,
	type UIMessage,
	validateUIMessages,
} from "ai";
import { projectCompatibleCompactedHistory } from "@/lib/chat/compaction";
import { sanitizeHistoricalReasoningParts } from "@/lib/chat/sanitizeReasoningParts";
import { sanitizeHistoricalToolParts } from "@/lib/chat/sanitizeToolParts";
import { markStablePrefixBoundary } from "./prompts";

export interface ProjectedArchitectHistory<UI extends UIMessage> {
	/** After the tool-part repair, the reasoning-part policy, and the
	 * compaction projection: the history validation saw. */
	readonly effective: UIMessage[];
	/** The validated history the route threads back as `originalMessages`. */
	readonly validated: UI[];
	/** The wire history: converted, with the explicit cache boundary marked
	 * on the deepest stable user item. */
	readonly modelMessages: ModelMessage[];
}

export async function projectArchitectHistory<
	UI extends UIMessage = UIMessage,
>(args: {
	messages: UIMessage[];
	/** The architect's tool set: definitions decide which historical tool
	 * parts survive and how they validate. Only `inputSchema`, `description`,
	 * and `strict` are read, so a definition-only record projects identically
	 * to the mounted one. */
	tools: ToolSet;
	/** The model this turn runs on: prior-turn reasoning and compaction
	 * checkpoints are model-bound. */
	model: string;
}): Promise<ProjectedArchitectHistory<UI>> {
	/* Repair deploy-crossing histories BEFORE validation: preserve the AI
	 * SDK's native `dynamic-tool` conversion for loadable terminal history,
	 * while dropping non-terminal missing tools and typed parts whose recorded
	 * input/output no longer parses after a schema change. Without that
	 * repair, validation below would throw, fail+refund the run, and re-poison
	 * every retry with the same history. The full contract, the drop
	 * semantics, and the validation mirror live on
	 * `sanitizeHistoricalToolParts`. The repair runs on EVERY turn: every
	 * request sends full history, and resumed threads routinely carry parts
	 * recorded under earlier deploys, or under the OTHER tool set entirely (an
	 * edit turn continuing a build thread drops the generation-tool parts; the
	 * dialogue survives). Keyed on the active tools so the filter never drifts
	 * from the active set. */
	const sanitized = await sanitizeHistoricalToolParts(
		args.messages,
		args.tools,
	);

	/* Apply the reasoning-part wire contract AFTER the tool repair (what
	 * pairing survives depends on which tool parts did): historical assistant
	 * messages drop their reasoning parts: prior-turn reasoning is ignored
	 * server-side, bills as input every turn, and is model-bound (one model
	 * change would 400 every old thread), while a trailing answered
	 * askQuestions continuation keeps its reasoning (the wire REQUIRES it
	 * beside the function call whose output this turn submits) unless the
	 * pause crossed a model change, in which case the round rides as plain
	 * dialogue text. Contract + sources on the module. */
	const reasoningSafe = sanitizeHistoricalReasoningParts(sanitized, args.model);
	const effective = projectCompatibleCompactedHistory(
		reasoningSafe,
		args.model,
	);

	/* Validate against the architect's tools and convert, exactly as
	 * `createAgentUIStream` would. `validateUIMessages`' tools slot is a
	 * per-name mapped type a plain `ToolSet` cannot satisfy nominally;
	 * validation only ever reads each tool's `inputSchema`, so the widening
	 * is behavior-safe. */
	const validated = await validateUIMessages<UI>({
		messages: effective,
		tools: args.tools as Parameters<typeof validateUIMessages<UI>>[0]["tools"],
	});
	/* The request-local marker writes a reusable entry before the volatile
	 * app-state tail. It changes no transcript token and does not mutate the
	 * durable UI history. */
	const modelMessages = markStablePrefixBoundary(
		await convertToModelMessages(validated, { tools: args.tools }),
	);
	return { effective, validated, modelMessages };
}
