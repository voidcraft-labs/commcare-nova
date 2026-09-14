import { z } from "zod";
import {
	AUTHORING_REFERENCE,
	expressionFunctionReference,
} from "../authoring/reference";
import type { ReadToolResult } from "./common";

const inputSchema = z
	.object({
		topic: z.enum(
			Object.keys(AUTHORING_REFERENCE) as (keyof typeof AUTHORING_REFERENCE)[],
		),
		functionName: z
			.string()
			.optional()
			.describe(
				"For expressions: look up one function's availability and arguments.",
			),
	})
	.strict();

export const getAuthoringGuideTool = {
	description: "Read guidance on a topic, or look up an expression function.",
	inputSchema,
	async execute(
		input: z.infer<typeof inputSchema>,
	): Promise<
		ReadToolResult<{ topic: string; reference: string } | { error: string }>
	> {
		const reference =
			input.functionName === undefined
				? AUTHORING_REFERENCE[input.topic]()
				: input.topic === "expressions"
					? expressionFunctionReference(input.functionName)
					: undefined;
		if (reference === undefined)
			return {
				kind: "read",
				data: {
					error:
						input.topic !== "expressions"
							? "Function lookup uses the expressions topic."
							: `Unknown expression function: ${input.functionName}.`,
				},
			};
		return {
			kind: "read",
			data: {
				topic: input.topic,
				reference,
			},
		};
	},
};
