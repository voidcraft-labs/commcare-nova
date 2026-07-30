import type { z } from "zod";
import { replaceFieldOptionsSourceMutation } from "@/lib/doc/lookupOptionsSourceMutations";
import { type BlueprintDoc, selectOptionsSourceSchema } from "@/lib/domain";
import type { ToolExecutionContext } from "../toolExecutionContext";
import {
	guardedMutate,
	type MutatingToolResult,
	toToolErrorResult,
} from "./common";
import {
	fieldAddressSchema,
	resolveFieldAddress,
} from "./shared/entityAddresses";
import type { MutationSuccess } from "./shared/toolCallSummary";

export const setFieldOptionsSourceInputSchema = fieldAddressSchema
	.extend({
		source: selectOptionsSourceSchema.describe(
			"The complete replacement choice source. Use kind inline with at least two UUID-identified options, or kind lookup with the table and its value/label columns. Replacing one kind discards the previous source.",
		),
	})
	.strict();

export type SetFieldOptionsSourceInput = z.infer<
	typeof setFieldOptionsSourceInputSchema
>;
export type SetFieldOptionsSourceResult = MutationSuccess | { error: string };

export const setFieldOptionsSourceTool = {
	description:
		"Atomically replace a single- or multiple-choice field’s complete choice source. The source is either inline choices or a Project data table; there is no retained inactive source.",
	inputSchema: setFieldOptionsSourceInputSchema,
	async execute(
		input: SetFieldOptionsSourceInput,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<MutatingToolResult<SetFieldOptionsSourceResult>> {
		try {
			const address = resolveFieldAddress(doc, input);
			if (!address.ok) {
				return {
					kind: "mutate",
					mutations: [],
					newDoc: doc,
					result: { error: address.error },
				};
			}
			const { field } = address;
			if (field.kind !== "single_select" && field.kind !== "multi_select") {
				return {
					kind: "mutate",
					mutations: [],
					newDoc: doc,
					result: {
						error: `"${field.id}" is not a single- or multiple-choice field.`,
					},
				};
			}

			const mutation = replaceFieldOptionsSourceMutation(
				field.uuid,
				field.kind,
				input.source,
			);
			const commit = await guardedMutate(ctx, doc, [mutation], "field:options");
			if (!commit.ok) {
				return {
					kind: "mutate",
					mutations: [],
					newDoc: doc,
					result: { error: commit.error },
				};
			}
			return {
				kind: "mutate",
				mutations: [mutation],
				newDoc: commit.newDoc,
				result: {
					message:
						input.source.kind === "inline"
							? `Set "${field.id}" to ${input.source.options.length} inline choices.`
							: `Set "${field.id}" to Project data table ${input.source.tableId}.`,
					summary: { subject: field.id },
				},
			};
		} catch (error) {
			return toToolErrorResult(error, doc);
		}
	},
};
