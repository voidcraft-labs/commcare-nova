import { z } from "zod";
import type { FormEntryChange } from "@/lib/doc/formEntryMutations";
import {
	formEntryChangeSchema,
	formEntrySharedOperations,
} from "@/lib/doc/formEntryMutations";
import { newFormSelectionTag } from "@/lib/domain/advancedEntryDatums";
import {
	computedEntryValueSchema,
	formCaseSelectionSchema,
} from "@/lib/domain/formEntryCases";
import { formOpeningAssignmentSchema } from "@/lib/domain/forms";
import { uuidSchema } from "@/lib/domain/uuid";
import type { ToolInvocationContext } from "../workspace/types";
import {
	guardedMutate,
	type MutatingToolResult,
	toToolErrorResult,
} from "./common";
import {
	formAddressSchema,
	resolveFormAddress,
} from "./shared/entityAddresses";
import type { MutationSuccess } from "./shared/toolCallSummary";

const addChoice = formCaseSelectionSchema
	.omit({ tag: true, uuid: true })
	.extend({ uuid: uuidSchema.optional() });
const addValue = computedEntryValueSchema
	.omit({ uuid: true })
	.extend({ uuid: uuidSchema.optional() });
const after = uuidSchema.nullable().optional();
const editSchema = z.discriminatedUnion("operation", [
	z.strictObject({
		operation: z.literal("add-assignment"),
		value: formOpeningAssignmentSchema
			.omit({ uuid: true })
			.extend({ uuid: uuidSchema.optional() }),
		after,
	}),
	z.strictObject({
		operation: z.literal("add-choice"),
		value: addChoice,
		after,
	}),
	z.strictObject({ operation: z.literal("add-value"), value: addValue, after }),
	z.strictObject({
		operation: z.literal("edit-choice"),
		uuid: uuidSchema,
		patch: formCaseSelectionSchema.omit({ uuid: true, tag: true }).partial(),
	}),
	...formEntrySharedOperations,
]);
const inputSchema = formAddressSchema.extend({ edit: editSchema });
type Input = z.infer<typeof inputSchema>;
type Result = (MutationSuccess & { supplyUuid?: string }) | { error: string };

export const editFormEntryTool = {
	description:
		"Change the records or calculated values a form uses when it opens. Give each record a name and its expected record type. Choose from a list, use the worker’s own record, or get the record ID from an earlier value, a worker property, a table column, or a named connection on an earlier record. Use opening-record('Record name') and opening-value('Value name') in an expression to read an earlier supply. Use add-assignment to fill a question from a record property after the form’s starting values have run. Its source can be the form’s record, the worker’s record, or a named opening record. Use get_form to read the current order. An omitted UUID on add asks Nova to make one. A move names the preceding supply, or null for first. For a shared form, restore-shared-choice brings back one of its parent’s records. Extra choices belong to the entry. Edit a shared choice’s name on the parent.",
	inputSchema,
	async execute(
		input: Input,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<Result>> {
		try {
			const doc = ctx.snapshot.doc;
			const address = resolveFormAddress(doc, input);
			if (!address.ok)
				return {
					kind: "mutate",
					mutations: [],
					result: { error: address.error },
				};
			const form = address.form;
			const edit = input.edit;
			const shared = form.shadowOf;
			if (
				shared &&
				(edit.operation === "use-menu-choices" ||
					edit.operation === "use-form-choices")
			)
				return {
					kind: "mutate",
					mutations: [],
					result: {
						error:
							"This entry has its own ordered choices. You can restore a shared choice, add a choice, or remove one.",
					},
				};
			if (
				shared &&
				edit.operation === "edit-choice" &&
				edit.patch.name !== undefined &&
				shared.selections.some(
					(row) => row.kind === "replace" && row.selection === edit.uuid,
				)
			)
				return {
					kind: "mutate",
					mutations: [],
					result: {
						error:
							"This choice gets its name from the shared form. You can rename it on that form or add a new choice here.",
					},
				};
			if (
				!shared &&
				(edit.operation === "restore-shared-choice" ||
					edit.operation === "change-shared-form")
			)
				return {
					kind: "mutate",
					mutations: [],
					result: {
						error:
							"This form owns its questions. You can create another entry that opens this form.",
					},
				};
			let change: FormEntryChange;
			if (edit.operation === "add-choice") {
				const tag = newFormSelectionTag(doc, form.uuid, edit.value.name);
				change = {
					...edit,
					value: {
						...edit.value,
						uuid: edit.value.uuid ?? uuidSchema.parse(crypto.randomUUID()),
						tag,
					},
				};
			} else if (edit.operation === "add-value")
				change = {
					...edit,
					value: {
						...edit.value,
						uuid: edit.value.uuid ?? uuidSchema.parse(crypto.randomUUID()),
					},
				};
			else if (edit.operation === "add-assignment")
				change = {
					...edit,
					value: {
						...edit.value,
						uuid: edit.value.uuid ?? uuidSchema.parse(crypto.randomUUID()),
					},
				};
			else change = formEntryChangeSchema.parse(edit);
			const commit = await guardedMutate(
				ctx,
				[
					{
						kind: "updateForm",
						uuid: form.uuid,
						patch: {},
						entryChange: change,
					},
				],
				`form:${form.uuid}`,
			);
			if (!commit.ok)
				return {
					kind: "mutate",
					mutations: [],
					result: { error: commit.error },
				};
			return {
				kind: "mutate",
				mutations: commit.mutations,
				result: {
					ok: true,
					summary: { location: form.name, subject: "Form entry" },
					...("value" in change &&
						"uuid" in change.value && { supplyUuid: change.value.uuid }),
				},
			};
		} catch (error) {
			return toToolErrorResult(error);
		}
	},
};
