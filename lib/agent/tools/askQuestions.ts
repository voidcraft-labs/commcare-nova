/**
 * SA tool: `askQuestions` — client-side multiple-choice question UI.
 *
 * Unlike every other SA tool, this one has no `execute`. When the agent
 * emits an `askQuestions` tool call, the AI SDK's ToolLoopAgent stops
 * there and the ChatSidebar renders the questions as tappable options.
 * The user's selections come back on the next request as an
 * `askQuestions` tool result, and the agent resumes.
 *
 * Shared between the chat factory and future MCP adapters. MCP adapters
 * wrap this the same way — emit the call, wait for the result. The
 * schema + description stay identical across surfaces so the LLM sees
 * the same contract either way.
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
	name: "askQuestions",
	description:
		"Ask the user clarifying questions about their app requirements. Up to 5 questions per call — call as many times as needed. Most requests need several rounds. Don't rush to generate; an app built on assumptions is worse than one that took extra questions to get right.",
	inputSchema: askQuestionsInputSchema,
};
