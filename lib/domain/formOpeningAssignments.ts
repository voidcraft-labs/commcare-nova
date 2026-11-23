import {
	formCaseSelections,
	ownFormSelectionIndex,
} from "./advancedEntryDatums";
import type { BlueprintDoc } from "./blueprint";
import { resolveRelationDestination } from "./expression/relationDestination";
import type { FormOpeningAssignment } from "./forms";
import { moduleUuidOfForm } from "./postSubmit";
import type { Uuid } from "./uuid";

export function openingAssignmentSource(
	doc: BlueprintDoc,
	form: Uuid,
	source: FormOpeningAssignment["source"],
) {
	const choices = formCaseSelections(doc, form);
	const own = ownFormSelectionIndex(doc, form);
	const worker = choices.findIndex(
		(row) => row.source.kind === "worker-record",
	);
	const index =
		source.kind === "own"
			? own
			: source.kind === "worker-record"
				? worker < 0
					? undefined
					: worker
				: choices.findIndex((row) => row.uuid === source.selection);
	const key =
		source.kind === "selection" && index !== undefined && index >= 0
			? index === own
				? "own"
				: index === worker
					? "worker-record"
					: source.selection
			: source.kind === "selection"
				? source.selection
				: source.kind;
	const module = moduleUuidOfForm(doc, form);
	const type =
		index !== undefined
			? choices[index]?.caseType
			: source.kind === "worker-record"
				? "commcare-user"
				: module
					? doc.modules[module]?.caseType
					: undefined;
	const rank =
		index ?? (source.kind === "worker-record" ? choices.length + 1 : 0);
	return { key, rank, type };
}

export function openingAssignmentPropertyType(
	doc: BlueprintDoc,
	form: Uuid,
	assignment: Pick<FormOpeningAssignment, "source" | "via">,
): string | undefined {
	const type = openingAssignmentSource(doc, form, assignment.source).type;
	if (!assignment.via || !type) return type;
	const result = resolveRelationDestination(
		{ kind: "ancestor", via: assignment.via },
		type,
		doc.caseTypes ?? [],
	);
	return result.ok ? result.caseType : undefined;
}

export function openingAssignmentName(
	doc: BlueprintDoc,
	form: Uuid,
	assignment: FormOpeningAssignment,
): string {
	const source = assignment.source;
	const record =
		source.kind === "own"
			? "form’s record"
			: source.kind === "worker-record"
				? "worker’s record"
				: (formCaseSelections(doc, form).find(
						(row) => row.uuid === source.selection,
					)?.name ?? "opening record");
	return `${doc.fields[assignment.field]?.id ?? "Question"} from ${record}`;
}
