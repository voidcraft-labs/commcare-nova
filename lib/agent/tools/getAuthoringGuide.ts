import { z } from "zod";
import { AUTHORING_REFERENCE } from "../authoring/reference";
import type { ReadToolResult } from "./common";

const inputSchema = z
	.object({
		topic: z.enum(
			Object.keys(AUTHORING_REFERENCE) as (keyof typeof AUTHORING_REFERENCE)[],
		),
	})
	.strict();

export const getAuthoringGuideTool = {
	description:
		"Read focused guidance for workflows, fields, form logic and wording, record queries, languages, people and places, shared data, or automations.",
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
