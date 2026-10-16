/**
 * Step `connect-task-forms`: moves the task out of each form whose deliver
 * config holds both a deliver unit and a task. CommCare Connect checks a
 * delivery before it completes a task, so it turns away the visit of a form
 * that completes a task the worker was assigned, and the validator now
 * refuses that shape (`CONNECT_DELIVER_FORM_HOLDS_TASK`; part 08 of step 2's
 * plan, Finding 61).
 *
 * A survey form is added to the same menu immediately after the source
 * form, named for the task, holding `connect: { task }` moved from the
 * source and one Label `note` whose text is the task's description, or its
 * name where the description is blank. The source keeps its deliver unit,
 * and the task keeps its id, so Connect keys it as the same task type and a
 * task already assigned is completed by the new form. The new form takes no
 * display condition: the source's may read its case, which a survey form has
 * none of. Its uuid is UUIDv5 of the source form's uuid and the name
 * `connect-task-form`, and the Label's UUIDv5 of the new form's and
 * `connect-task-note`, so the rehearsal and the execute run write the same
 * target. It runs after `connect-ids`, so the id it moves is one the grammar
 * admits.
 *
 * One `connect-task-moved-to-own-form` line per source form, naming it, with
 * the task's id and the new form.
 */

import { v5 as uuidv5 } from "uuid";
import { asUuid } from "@/lib/domain";
import { uniqueSlug } from "@/lib/domain/idSlug";
import type { JsonRecord } from "../oldShape";
import type { CutoverStep, DocumentChange } from "../transform";
import { isRecord, rawText } from "./relativePaths";

export const CONNECT_TASK_FORM_NAME = "connect-task-form";
export const CONNECT_TASK_NOTE_NAME = "connect-task-note";

export const connectTaskFormsStep: CutoverStep = {
	id: "connect-task-forms",
	apply(document) {
		const changes: DocumentChange[] = [];
		const formIds = new Set(
			Object.values(document.formOrder)
				.flat()
				.map((uuid) => rawText(document.forms[uuid]?.id)),
		);
		const forms = document.forms as Record<string, JsonRecord>;
		const fields = document.fields as Record<string, JsonRecord>;
		const formOrder = document.formOrder as Record<string, string[]>;
		const fieldOrder = document.fieldOrder as Record<string, string[]>;
		for (const moduleUuid of document.moduleOrder) {
			const order = formOrder[moduleUuid];
			if (order === undefined) continue;
			for (const sourceUuid of [...order]) {
				const source = forms[sourceUuid];
				const connect = source?.connect;
				if (
					source === undefined ||
					!isRecord(connect) ||
					connect.deliver_unit === undefined ||
					!isRecord(connect.task)
				) {
					continue;
				}
				const task = connect.task;
				const taskName = rawText(task.name);
				const description = rawText(task.description);
				const formUuid = uuidv5(CONNECT_TASK_FORM_NAME, sourceUuid);
				const noteUuid = uuidv5(CONNECT_TASK_NOTE_NAME, formUuid);
				const formId = uniqueSlug(taskName, "form", formIds);
				formIds.add(formId);
				const { task: _moved, ...kept } = connect;
				forms[sourceUuid] = { ...source, connect: kept };
				forms[formUuid] = {
					uuid: formUuid,
					id: formId,
					name: taskName,
					type: "survey",
					connect: { task },
				};
				fields[noteUuid] = {
					uuid: noteUuid,
					id: "note",
					kind: "label",
					label: {
						parts: [
							{
								kind: "text",
								text: description.trim() === "" ? taskName : description,
							},
						],
					},
				};
				fieldOrder[formUuid] = [noteUuid];
				order.splice(order.indexOf(sourceUuid) + 1, 0, formUuid);
				changes.push({
					reason: "connect-task-moved-to-own-form",
					entity: {
						type: "form",
						uuid: asUuid(sourceUuid),
						nameAtMigration: rawText(source.name),
					},
					detail: {
						task: rawText(task.id),
						newFormUuid: formUuid,
						newForm: taskName,
					},
				});
			}
		}
		return changes;
	},
};
