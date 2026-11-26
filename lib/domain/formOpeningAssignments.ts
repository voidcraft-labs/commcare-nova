import {
	formCaseSelections,
	ownFormSelectionIndex,
} from "./advancedEntryDatums";
import type { BlueprintDoc } from "./blueprint";
import { resolveRelationDestination } from "./expression/relationDestination";
import { formContentUuid } from "./formEntryCases";
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

/**
 * Where CommCare HQ's form builder lists each question of a form: every
 * question with a control first, in the form's order, then every Hidden
 * Value, in the form's order (`xform.py::XForm.get_questions` reads the
 * body's controls, then the data leaves no control holds), which its Case
 * Management page scores (`case_config_ui.js` `questionScores`).
 */
function hqQuestionScores(
	doc: BlueprintDoc,
	formUuid: Uuid,
): Map<Uuid, number> {
	const controls: Uuid[] = [];
	const hidden: Uuid[] = [];
	const walk = (parent: Uuid) => {
		const children = Object.hasOwn(doc.fieldOrder, parent)
			? doc.fieldOrder[parent]
			: undefined;
		for (const uuid of children ?? []) {
			const field = Object.hasOwn(doc.fields, uuid)
				? doc.fields[uuid]
				: undefined;
			if (field === undefined) continue;
			(field.kind === "hidden" ? hidden : controls).push(uuid);
			walk(uuid);
		}
	};
	walk(formUuid);
	return new Map([...controls, ...hidden].map((uuid, index) => [uuid, index]));
}

/**
 * `assignments`, starting record values of the form `formUuid`, in the order
 * CommCare runs them: by the record that supplies each, as the gate holds
 * them, and within one record by where CommCare HQ's form builder lists the
 * question each fills, the order its Case Management save writes a record's
 * map in (`case_config_utils.js`, sorted by `questionScores`). A record's
 * values fill distinct questions, so their order tells only where one fills
 * a question another's calculation reads; the export, Preview and the
 * reading all take this one order, so a save in CommCare HQ keeps it.
 */
export function openingAssignmentsInRunOrder(
	doc: BlueprintDoc,
	formUuid: Uuid,
	assignments: readonly FormOpeningAssignment[],
): FormOpeningAssignment[] {
	const scores = hqQuestionScores(doc, formContentUuid(doc, formUuid));
	const keyed = assignments.map((assignment, index) => ({
		assignment,
		index,
		rank: openingAssignmentSource(doc, formUuid, assignment.source).rank,
		score: scores.get(assignment.field) ?? Number.MAX_SAFE_INTEGER,
	}));
	keyed.sort(
		(a, b) => a.rank - b.rank || a.score - b.score || a.index - b.index,
	);
	return keyed.map(({ assignment }) => assignment);
}
