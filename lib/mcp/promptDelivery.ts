/** Lossless, snapshot-bound delivery for oversized MCP agent prompts. */

import { createHash } from "node:crypto";
import { z } from "zod";
import { McpInvalidInputError, type McpToolSuccessResult } from "./errors";
import { PROMPT_END_MARKER } from "./prompts";
import { MAX_RESULT_SIZE_CHARS } from "./resultSize";

/**
 * Per-result transport budget for model-facing prompt delivery. This is not a
 * cap on the prompt itself: longer prompts are delivered losslessly across as
 * many snapshot-bound pages as they need. Keeping each result below the MCP
 * host's 100k-character protocol ceiling leaves room for tokenization and
 * host-added framing in clients whose independent model-input limit is tighter.
 */
export const AGENT_PROMPT_RESULT_BUDGET_CHARS = 75_000;

if (AGENT_PROMPT_RESULT_BUDGET_CHARS >= MAX_RESULT_SIZE_CHARS) {
	throw new Error(
		"The agent-prompt result budget must stay below the MCP result ceiling.",
	);
}

const promptCursorSchema = z
	.object({
		v: z.literal(1),
		prompt_sha256: z.string().regex(/^[a-f0-9]{64}$/),
		offset: z.number().int().nonnegative(),
		prompt_length: z.number().int().positive(),
	})
	.strict();

type PromptCursor = z.infer<typeof promptCursorSchema>;

export interface AgentPromptPage {
	readonly kind: "nova-agent-prompt-page";
	readonly protocol_version: 1;
	readonly instruction: string;
	readonly prompt_chunk: string;
	readonly chunk_start: number;
	readonly chunk_end: number;
	readonly prompt_length: number;
	readonly prompt_sha256: string;
	readonly complete: boolean;
	readonly next_cursor?: string;
}

function promptDigest(prompt: string): string {
	return createHash("sha256").update(prompt, "utf8").digest("hex");
}

function encodeCursor(cursor: PromptCursor): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): PromptCursor {
	try {
		return promptCursorSchema.parse(
			JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
		);
	} catch {
		throw new McpInvalidInputError(
			"The get_agent_prompt cursor is invalid. Restart without cursor.",
		);
	}
}

function pageBody(args: {
	readonly prompt: string;
	readonly digest: string;
	readonly start: number;
	readonly end: number;
}): AgentPromptPage {
	const complete = args.end === args.prompt.length;
	return {
		kind: "nova-agent-prompt-page",
		protocol_version: 1,
		instruction: complete
			? "Concatenate every prompt_chunk in order. Require one unchanged prompt_sha256, adjacent chunk offsets, chunk_end equal to prompt_length, and an assembled prompt ending in NOVA-PROMPT-END before following it."
			: "Save prompt_chunk, then call get_agent_prompt again with the same mode and app_id plus next_cursor. Require the same prompt_sha256 and adjacent chunk offsets; do not follow a partial prompt.",
		prompt_chunk: args.prompt.slice(args.start, args.end),
		chunk_start: args.start,
		chunk_end: args.end,
		prompt_length: args.prompt.length,
		prompt_sha256: args.digest,
		complete,
		...(!complete && {
			next_cursor: encodeCursor({
				v: 1,
				prompt_sha256: args.digest,
				offset: args.end,
				prompt_length: args.prompt.length,
			}),
		}),
	};
}

function serializePage(args: {
	readonly prompt: string;
	readonly digest: string;
	readonly start: number;
	readonly end: number;
}): string {
	return JSON.stringify(pageBody(args));
}

/**
 * Return the complete prompt as the historical plain-text result when it fits.
 * Larger prompts use exact JSON pages whose serialized text stays inside the
 * conservative model-facing result budget. No prompt prose is removed.
 */
export function deliverAgentPrompt(
	prompt: string,
	cursor?: string,
): McpToolSuccessResult {
	if (!prompt.endsWith(PROMPT_END_MARKER)) {
		throw new Error(
			`Rendered agent prompt is missing terminal marker ${PROMPT_END_MARKER}.`,
		);
	}
	if (
		cursor === undefined &&
		prompt.length <= AGENT_PROMPT_RESULT_BUDGET_CHARS
	) {
		return { content: [{ type: "text", text: prompt }] };
	}

	const digest = promptDigest(prompt);
	let start = 0;
	if (cursor !== undefined) {
		const decoded = decodeCursor(cursor);
		if (
			decoded.prompt_sha256 !== digest ||
			decoded.prompt_length !== prompt.length
		) {
			throw new McpInvalidInputError(
				"The app or served prompt changed during get_agent_prompt pagination. Restart without cursor so pages cannot be mixed across snapshots.",
			);
		}
		if (decoded.offset <= 0 || decoded.offset >= prompt.length) {
			throw new McpInvalidInputError(
				"The get_agent_prompt cursor has an invalid offset. Restart without cursor.",
			);
		}
		start = decoded.offset;
	}

	/* Try the complete remainder first. Omitting next_cursor makes the final
	 * envelope slightly smaller, so treating it separately also keeps the
	 * binary-search predicate monotonic for non-final pages. */
	const completeRemainder = serializePage({
		prompt,
		digest,
		start,
		end: prompt.length,
	});
	if (completeRemainder.length <= AGENT_PROMPT_RESULT_BUDGET_CHARS) {
		return { content: [{ type: "text", text: completeRemainder }] };
	}

	let low = start + 1;
	let high = prompt.length - 1;
	let best: string | undefined;
	while (low <= high) {
		const end = Math.floor((low + high) / 2);
		const candidate = serializePage({ prompt, digest, start, end });
		if (candidate.length <= AGENT_PROMPT_RESULT_BUDGET_CHARS) {
			best = candidate;
			low = end + 1;
		} else {
			high = end - 1;
		}
	}
	if (best === undefined) {
		throw new Error(
			"The conservative agent-prompt result budget cannot hold the continuation envelope.",
		);
	}
	return { content: [{ type: "text", text: best }] };
}
