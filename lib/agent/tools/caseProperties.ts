import { z } from "zod";
import { deepEqual } from "@/lib/doc/deepEqual";
import {
	authoredCasePropertyNameSchema,
	casePropertySchema,
} from "@/lib/domain";
import { casePropertyInputSchema } from "../planningSchemas";
import type { ToolInvocationContext } from "../workspace/types";
import {
	guardedMutate,
	type MutatingToolResult,
	toToolErrorResult,
} from "./common";
import type { MutationSuccess } from "./shared/toolCallSummary";

const address = {
	caseType: z.string().min(1),
	property: authoredCasePropertyNameSchema,
};

export const getCasePropertyInputSchema = z.strictObject(address);

const {
	name: _name,
	data_type: _dataType,
	...editable
} = casePropertyInputSchema.shape;
export const updateCasePropertyInputSchema = z.strictObject({
	...address,
	updates: z
		.strictObject(editable)
		.partial()
		.refine(
			(value) => Object.values(value).some((item) => item !== undefined),
			"Supply at least one property setting to change.",
		),
});

function findProperty(
	ctx: ToolInvocationContext,
	input: z.infer<typeof getCasePropertyInputSchema>,
) {
	return ctx.snapshot.doc.caseTypes
		?.find((record) => record.name === input.caseType)
		?.properties.find((property) => property.name === input.property);
}

function missing(input: z.infer<typeof getCasePropertyInputSchema>) {
	return {
		error: `Property ${input.caseType}.${input.property} does not exist.`,
	};
}

export const getCasePropertyTool = {
	description:
		"Read one record property's definition, including its type, wording, choices, and catalog rules.",
	inputSchema: getCasePropertyInputSchema,
	async execute(
		input: z.infer<typeof getCasePropertyInputSchema>,
		ctx: ToolInvocationContext,
	) {
		const property = findProperty(ctx, input);
		return {
			kind: "read" as const,
			data:
				property === undefined
					? missing(input)
					: { caseType: input.caseType, property },
		};
	},
};

export const updateCasePropertyTool = {
	description:
		"Edit one record property's wording, choices, or catalog rules. Omit settings to keep them; null clears optional settings. Existing form questions keep their own wording and rules. Property renames use renameCaseProperties; type conversions use editField.",
	inputSchema: updateCasePropertyInputSchema,
	async execute(
		input: z.infer<typeof updateCasePropertyInputSchema>,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<MutationSuccess | { error: string }>> {
		try {
			const current = findProperty(ctx, input);
			if (current === undefined)
				return {
					kind: "mutate" as const,
					mutations: [],
					result: missing(input),
				};
			const merged: Record<string, unknown> = { ...current };
			for (const [key, value] of Object.entries(input.updates)) {
				if (value === null) delete merged[key];
				else if (value !== undefined) merged[key] = value;
			}
			// Check the complete resulting definition, including settings retained
			// by a partial edit. The workspace still owns whole-app admission.
			const property = casePropertySchema.parse(
				casePropertyInputSchema.parse(merged),
			);
			if (deepEqual(current, property))
				return {
					kind: "mutate" as const,
					mutations: [],
					result: { ok: true as const, summary: { noop: true } },
				};
			const commit = await guardedMutate(
				ctx,
				[{ kind: "setCaseProperty", caseType: input.caseType, property }],
				"case-property:update",
			);
			if (!commit.ok)
				return {
					kind: "mutate" as const,
					mutations: [],
					result: { error: commit.error },
				};
			return {
				kind: "mutate" as const,
				mutations: commit.mutations,
				result: {
					ok: true as const,
					summary: { subject: `${input.caseType}.${input.property}` },
				},
			};
		} catch (error) {
			return toToolErrorResult(error);
		}
	},
};
