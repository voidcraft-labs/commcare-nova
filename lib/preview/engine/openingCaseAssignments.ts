import type { BlueprintDoc, Uuid } from "@/lib/domain";
import {
	formCaseSelections,
	ownFormSelectionIndex,
} from "@/lib/domain/advancedEntryDatums";
import { implicitFormSelectionId } from "@/lib/domain/formEntryCases";
import { moduleUuidOfForm } from "@/lib/domain/postSubmit";
import { xpathToString } from "../xpath/coerce";
import type { XPathNode } from "../xpath/runtimeValues";
import {
	type CaseDatabaseSnapshot,
	caseDatabaseXPathInstance,
} from "./xpathInstances";

export interface OpeningCaseAssignment {
	readonly assignment: Uuid;
	readonly field: Uuid;
	readonly value: string;
	readonly caseType: string;
	readonly property: string;
	readonly caseId: string;
}

function nodeText(node: XPathNode | undefined): string {
	return node === undefined ? "" : xpathToString(node.value());
}

/** Resolve assignment sources against exactly the entry's authorized device
 * projection. A missing link or property is an empty read. The caller applies
 * even those empty writes through the normal answer cast at each destination. */
export function openingCaseAssignments(
	doc: BlueprintDoc,
	formUuid: Uuid,
	selectedCaseIds: ReadonlyMap<Uuid, string>,
	snapshot: CaseDatabaseSnapshot,
): readonly OpeningCaseAssignment[] {
	const rows = doc.forms[formUuid]?.openingAssignments;
	const menu = moduleUuidOfForm(doc, formUuid);
	if (!rows?.length || menu === undefined) return [];
	const casedb = caseDatabaseXPathInstance(snapshot, doc.caseTypes ?? []);
	const cases = casedb.root().children("casedb")[0].children("case");
	const byId = new Map(
		cases.map((row) => [nodeText(row.attributes("case_id")[0]), row]),
	);
	const choices = formCaseSelections(doc, formUuid);
	const ownIndex = ownFormSelectionIndex(doc, formUuid);
	const own = ownIndex === undefined ? undefined : choices[ownIndex];
	const worker = choices.find(
		(choice) => choice.source.kind === "worker-record",
	);
	return rows.map((assignment) => {
		const source = assignment.source;
		const selection =
			source.kind === "selection"
				? source.selection
				: source.kind === "worker-record"
					? (worker?.uuid ?? implicitFormSelectionId(formUuid, "worker-record"))
					: (own?.uuid ?? implicitFormSelectionId(formUuid, menu));
		let caseId = selectedCaseIds.get(selection) ?? "";
		let row = byId.get(caseId);
		for (const step of assignment.via ?? []) {
			caseId = nodeText(
				row?.children("index")[0]?.children(step.identifier)[0],
			);
			row = byId.get(caseId);
		}
		const property = assignment.property;
		const leaf =
			property === "owner_id"
				? row?.attributes(property)[0]
				: row?.children(property)[0];
		return {
			assignment: assignment.uuid,
			field: assignment.field,
			value: nodeText(leaf),
			caseType: nodeText(row?.attributes("case_type")[0]),
			property,
			caseId,
		};
	});
}
