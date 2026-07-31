import type { z } from "zod";
import { replaceFieldOptionsSourceMutation } from "@/lib/doc/lookupOptionsSourceMutations";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import { findAuthoredBlueprintIdentity } from "@/lib/domain";
import { prepareToolOptionsSource } from "../contentProcessing";
import type { ToolExecutionContext } from "../toolExecutionContext";
import { projectedOptionsSourceSchema } from "../toolSchemaGenerator";
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
		source: projectedOptionsSourceSchema.describe(
			"The complete replacement choice source. Use kind inline with at least two options, or kind lookup with the table and its value/label columns. Replacing one kind discards the previous source.",
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

			// The one `optionUuid` -> `uuid` bridge, run before the identity
			// guard so admission sees the stored shape it will persist.
			const source = prepareToolOptionsSource(input.source);
			// A replacement may keep identities this field already owns, but may
			// not capture another authored object's UUID or repeat one inside the
			// source — the same rule `editField` applies to the same slot.
			if (source.kind === "inline") {
				const ownOptionUuids = new Set<Uuid>(
					field.optionsSource.kind === "inline"
						? field.optionsSource.options.map((option) => option.uuid)
						: [],
				);
				const seen = new Set<Uuid>();
				for (const option of source.options) {
					const existing = findAuthoredBlueprintIdentity(doc, option.uuid);
					if (
						seen.has(option.uuid) ||
						(existing !== undefined && !ownOptionUuids.has(option.uuid))
					) {
						return {
							kind: "mutate",
							mutations: [],
							newDoc: doc,
							result: {
								error: `Option UUID ${option.uuid} is duplicated in this call or already belongs to another authored object.`,
							},
						};
					}
					seen.add(option.uuid);
				}
			}

			const mutation = replaceFieldOptionsSourceMutation(
				field.uuid,
				field.kind,
				source,
			);
			/* Name the table the way the author does. The catalog is already in
			 * scope, and a UUID in a message the SA relays to a person is a
			 * string nobody can act on. */
			const tableName =
				source.kind === "lookup"
					? ((await ctx.lookupCatalog?.())?.definitions.find(
							(table) => table.id === source.tableId,
						)?.name ?? "the selected table")
					: undefined;
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
				// The admitted batch that actually committed, never the locally
				// built array — those are the same values only until admission
				// has anything to say about them.
				mutations: commit.mutations,
				newDoc: commit.newDoc,
				result: {
					message:
						source.kind === "inline"
							? `Set "${field.id}" to ${source.options.length} inline choices.`
							: `Set "${field.id}" to the ${tableName} data table.`,
					summary: { subject: field.id },
				},
			};
		} catch (error) {
			return toToolErrorResult(error, doc);
		}
	},
};
