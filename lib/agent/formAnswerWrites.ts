import { orderedFieldUuids } from "@/lib/doc/fieldWalk";
import {
	type BlueprintDoc,
	fieldPreload,
	formCaseWriteViews,
	isContainer,
	type Uuid,
} from "@/lib/domain";
import {
	type FieldCaseWriteRead,
	fieldCaseWrites,
} from "./authoring/fieldBehavior";

/**
 * The answers a form saves as they are, question by question: each
 * question's "Saves to" (`fieldCaseWriteViews`), read off the form's case
 * changes, with the question's path, and whether it opens with the case's
 * current value (its `default_value` is the `form-case` read, `fieldPreload`).
 * The changes themselves are the form's case operations; this names the
 * questions whose answers they save, so a read can answer "where does this
 * answer go" without walking every change.
 */
export function formAnswerWrites(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
	formUuid: Uuid,
): {
	readonly fieldUuid: Uuid;
	readonly path: string;
	readonly writes: readonly FieldCaseWriteRead[];
	readonly opensWithCaseValue?: true;
}[] {
	const module = doc.modules[moduleUuid];
	const form = doc.forms[formUuid];
	if (!module || !form) return [];
	const saved = formCaseWriteViews(doc, formUuid);
	const answers: {
		fieldUuid: Uuid;
		path: string;
		writes: FieldCaseWriteRead[];
		opensWithCaseValue?: true;
	}[] = [];
	const walk = (parent: Uuid, prefix: readonly string[]): void => {
		for (const uuid of orderedFieldUuids(doc, parent)) {
			const field = doc.fields[uuid];
			if (field === undefined) continue;
			const path = [...prefix, field.id];
			if ((saved.get(uuid)?.length ?? 0) > 0)
				answers.push({
					fieldUuid: uuid,
					path: path.join("/"),
					writes: fieldCaseWrites(doc, field).filter(
						(write) =>
							form.caseOperations?.some(
								(operation) => operation.uuid === write.operationUuid,
							) === true,
					),
					...(fieldPreload(field) !== undefined && {
						opensWithCaseValue: true as const,
					}),
				});
			if (isContainer(field)) walk(uuid, path);
		}
	};
	walk(formUuid, []);
	return answers;
}
