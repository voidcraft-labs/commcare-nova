import { current, type Draft, isDraft } from "immer";
import { z } from "zod";
import type { BlueprintDoc } from "@/lib/domain";
import { formCaseSelections } from "@/lib/domain/advancedEntryDatums";
import {
	type ComputedEntryValue,
	computedEntryValueSchema,
	type FormCaseSelection,
	formCaseSelectionSchema,
	sharedEntryValues,
} from "@/lib/domain/formEntryCases";
import { formOpeningAssignmentSchema } from "@/lib/domain/forms";
import { type Uuid, uuidSchema } from "@/lib/domain/uuid";
import { spliceEntryAfter } from "./mutations/sequence";

const after = uuidSchema.nullable();
export const formEntrySharedOperations = [
	z.strictObject({
		operation: z.literal("edit-assignment"),
		uuid: uuidSchema,
		value: formOpeningAssignmentSchema.omit({ uuid: true }),
	}),
	z.strictObject({
		operation: z.literal("remove-assignment"),
		uuid: uuidSchema,
	}),
	z.strictObject({
		operation: z.literal("move-assignment"),
		uuid: uuidSchema,
		after,
	}),

	z.strictObject({ operation: z.literal("use-form-choices") }),
	z.strictObject({
		operation: z.literal("change-shared-form"),
		parentFormUuid: uuidSchema,
	}),
	z.strictObject({
		operation: z.literal("restore-shared-choice"),
		uuid: uuidSchema,
		after: after.optional(),
	}),
	z.strictObject({ operation: z.literal("use-menu-choices") }),
	z.strictObject({ operation: z.literal("remove-choice"), uuid: uuidSchema }),
	z.strictObject({
		operation: z.literal("move-choice"),
		uuid: uuidSchema,
		after,
	}),
	z.strictObject({
		operation: z.literal("edit-value"),
		uuid: uuidSchema,
		patch: computedEntryValueSchema.omit({ uuid: true }).partial(),
	}),
	z.strictObject({ operation: z.literal("remove-value"), uuid: uuidSchema }),
	z.strictObject({
		operation: z.literal("move-value"),
		uuid: uuidSchema,
		after,
	}),
] as const;
export const formEntryChangeSchema = z.discriminatedUnion("operation", [
	...formEntrySharedOperations,
	z.strictObject({
		operation: z.literal("add-assignment"),
		value: formOpeningAssignmentSchema,
		after: after.optional(),
	}),
	z.strictObject({
		operation: z.literal("add-choice"),
		value: formCaseSelectionSchema,
		after: after.optional(),
	}),
	z.strictObject({
		operation: z.literal("edit-choice"),
		uuid: uuidSchema,
		patch: formCaseSelectionSchema.omit({ uuid: true }).partial(),
	}),
	z.strictObject({
		operation: z.literal("add-value"),
		value: computedEntryValueSchema,
		after: after.optional(),
	}),
]);
export type FormEntryChange = z.infer<typeof formEntryChangeSchema>;

/** Each command touches one position or the named properties of one supply.
 * Replaying an update to a retired target leaves the remaining collection alone. */
export function applyFormEntryChange(
	draft: Draft<BlueprintDoc>,
	formUuid: Uuid,
	change: FormEntryChange,
): void {
	const form = draft.forms[formUuid];
	if (!form) return;
	const choices = (): FormCaseSelection[] =>
		form.caseSelections ?? [
			...formCaseSelections(isDraft(draft) ? current(draft) : draft, formUuid),
		];
	const parentRows = () =>
		form.shadowOf
			? formCaseSelections(
					isDraft(draft) ? current(draft) : draft,
					form.shadowOf.form,
				)
			: [];
	const saveChoices = (rows: FormCaseSelection[]) => {
		if (!form.shadowOf) {
			form.caseSelections = rows;
			return;
		}
		const parents = new Set(parentRows().map((row) => row.uuid));
		form.shadowOf.selections = rows.map((row) =>
			parents.has(row.uuid)
				? {
						kind: "replace",
						selection: row.uuid,
						caseType: row.caseType,
						source: row.source,
					}
				: { kind: "add", ...row },
		);
	};
	const values = (): ComputedEntryValue[] => form.computedDatums ?? [];
	switch (change.operation) {
		case "add-assignment": {
			const rows = form.openingAssignments ?? [];
			if (!rows.some((row) => row.uuid === change.value.uuid))
				form.openingAssignments = spliceEntryAfter(
					rows,
					structuredClone(change.value),
					change.after,
				);
			return;
		}
		case "edit-assignment": {
			if (form.openingAssignments)
				form.openingAssignments = form.openingAssignments.map((row) =>
					row.uuid === change.uuid
						? { ...structuredClone(change.value), uuid: row.uuid }
						: row,
				);
			return;
		}
		case "remove-assignment": {
			const remaining = form.openingAssignments?.filter(
				(row) => row.uuid !== change.uuid,
			);
			if (remaining?.length) form.openingAssignments = remaining;
			else {
				delete form.openingAssignments;
				delete form.heldBasicOpening;
			}
			return;
		}
		case "move-assignment": {
			const rows = form.openingAssignments ?? [];
			const row = rows.find((row) => row.uuid === change.uuid);
			if (row)
				form.openingAssignments = spliceEntryAfter(rows, row, change.after);
			return;
		}
		case "use-form-choices":
			if (!form.shadowOf) form.caseSelections ??= choices();
			return;
		case "change-shared-form": {
			if (!form.shadowOf || change.parentFormUuid === form.shadowOf.form)
				return;
			const parent = draft.forms[change.parentFormUuid];
			const extras = form.shadowOf.selections.filter(
				(row) => row.kind === "add",
			);
			if (parent && !parent.shadowOf) {
				form.type = parent.type;
				const computed = sharedEntryValues(
					parent,
					formUuid,
					form.computedDatums,
				);
				if (computed.length) form.computedDatums = computed;
			}
			form.shadowOf = { form: change.parentFormUuid, selections: [] };
			form.shadowOf.selections = [
				...parentRows().map((row) => ({
					kind: "replace" as const,
					selection: row.uuid,
					caseType: row.caseType,
					source: row.source,
				})),
				...extras,
			];
			return;
		}
		case "restore-shared-choice": {
			const row = parentRows().find((row) => row.uuid === change.uuid);
			if (row && !choices().some((held) => held.uuid === row.uuid))
				saveChoices(spliceEntryAfter(choices(), row, change.after));
			return;
		}
		case "use-menu-choices":
			if (form.shadowOf) return;
			delete form.caseSelections;
			return;
		case "add-choice":
			if (choices().some((row) => row.uuid === change.value.uuid)) return;
			saveChoices(
				spliceEntryAfter(
					choices(),
					structuredClone(change.value),
					change.after,
				),
			);
			return;
		case "edit-choice":
			saveChoices(
				choices().map((row) =>
					row.uuid === change.uuid
						? { ...row, ...structuredClone(change.patch) }
						: row,
				),
			);
			return;
		case "remove-choice":
			saveChoices(choices().filter((row) => row.uuid !== change.uuid));
			return;
		case "move-choice": {
			const list = choices();
			const row = list.find((item) => item.uuid === change.uuid);
			if (row) saveChoices(spliceEntryAfter(list, row, change.after));
			return;
		}
		case "add-value":
			if (values().some((row) => row.uuid === change.value.uuid)) return;
			form.computedDatums = spliceEntryAfter(
				values(),
				structuredClone(change.value),
				change.after,
			);
			return;
		case "edit-value": {
			const row = form.computedDatums?.find(
				(item) => item.uuid === change.uuid,
			);
			if (row) Object.assign(row, structuredClone(change.patch));
			return;
		}
		case "remove-value": {
			const remaining = values().filter((row) => row.uuid !== change.uuid);
			if (remaining.length) form.computedDatums = remaining;
			else delete form.computedDatums;
			return;
		}
		case "move-value": {
			const list = values();
			const row = list.find((item) => item.uuid === change.uuid);
			if (row) form.computedDatums = spliceEntryAfter(list, row, change.after);
			return;
		}
	}
}
