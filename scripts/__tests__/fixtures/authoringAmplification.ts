import type { ModelMessage } from "ai";
import type { NovaUIMessage } from "@/lib/chat/attachmentRefs";

/** Sanitized structural incident: one answered card followed by repeated final text.
 * Counts mirror the frozen Oct 9 snapshots; customer text and identifiers are absent. */
export function amplifiedConversation(copies: number): NovaUIMessage[] {
	return [
		{
			id: "request",
			role: "user",
			parts: [{ type: "text", text: "Build from the reference files." }],
		},
		{
			id: "response",
			role: "assistant",
			parts: [
				{
					type: "tool-askQuestions",
					toolCallId: "question",
					state: "output-available",
					input: {
						header: "Reference data",
						questions: [
							{ question: "Supply the reference data?", options: [] },
						],
					},
					output: { "0": "I will supply it." },
				},
				...Array.from({ length: copies }, () => ({
					type: "text" as const,
					state: "done" as const,
					text: "Please supply the remaining reference data.",
				})),
			],
		},
	];
}
export const durableFinal = {
	role: "assistant",
	content: [
		{ type: "text", text: "Please supply the remaining reference data." },
	],
} satisfies ModelMessage;
