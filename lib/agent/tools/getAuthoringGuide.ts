import { z } from "zod";
import { AUTHORING_REFERENCE } from "../authoring/reference";
import type { ReadToolResult } from "./common";

const inputSchema = z
	.object({
		topic: z.enum(["fields", "formLogic", "recordQueries", "automations"]),
	})
	.strict();

export const getAuthoringGuideTool = {
	description:
		"Read the authoring reference for field types, form calculations and wording, record filters and relationships, or automations. Includes syntax and examples for less common features.",
	inputSchema,
	async execute(
		input: z.infer<typeof inputSchema>,
	): Promise<ReadToolResult<{ topic: string; reference: string }>> {
		return {
			kind: "read",
			data: {
				topic: input.topic,
				reference: AUTHORING_REFERENCE[input.topic](),
			},
		};
	},
};
