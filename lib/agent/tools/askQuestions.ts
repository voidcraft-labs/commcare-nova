/**
 * SA tool: `askQuestions` — client-side multiple-choice question UI.
 *
 * Unlike every other SA tool, this one has no `execute`. When the agent
 * emits an `askQuestions` tool call, the AI SDK's ToolLoopAgent stops
 * there and the ChatSidebar renders the questions as tappable options.
 * The user's selections come back on the next request as an
 * `askQuestions` tool result, and the agent resumes.
 *
 * Shipped on the SA surface only; the MCP adapter does not register it
 * because MCP clients have their own user-interaction mechanism (e.g.,
 * Claude Code's `AskUserQuestion`). The schema + description live here
 * so the chat surface has a single import surface matching the other
 * extracted tools.
 */

import { z } from "zod";

export const askQuestionsInputSchema = z.object({
	header: z.string().describe("Short header for this group of questions"),
	questions: z.array(
		z.object({
			question: z.string(),
			options: z.array(
				z.object({
					label: z.string(),
					description: z.string().optional(),
				}),
			),
		}),
	),
});

export type AskQuestionsInput = z.infer<typeof askQuestionsInputSchema>;

/**
 * No `execute` — this is a client-side tool. The agent loop halts on
 * emission and resumes once the user responds. The SA wrapper spreads
 * `{ description, inputSchema }` directly; the AI SDK's `tool()` helper
 * requires an execute function, so the wrapper uses an object literal
 * rather than `tool({...})`.
 */
export const askQuestionsTool = {
	name: "askQuestions" as const,
	description:
		"Ask the user clarifying questions about their app requirements. Up to 5 questions per call — call as many times as needed. Most requests need several rounds. Don't rush to generate; an app built on assumptions is worse than one that took extra questions to get right.",
	inputSchema: askQuestionsInputSchema,
};
