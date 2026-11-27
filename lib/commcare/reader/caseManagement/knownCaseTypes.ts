/**
 * What Nova holds of an app's case types that no export of it carries: the
 * type its catalog declares for each property, and the case type each index
 * of a type reaches. A declared type is no byte of an export, yet every print
 * of a read of the property lowers by it (a sort's comparator, a
 * `datetime-coerce`, a `format-date`, a comparison of dates and times), so a
 * reading that did not declare it would print the app's logic another way.
 * And a document's catalog can name a type's parent while nothing in the app
 * does (no form opens a case of the type under one, no menu chooses its case
 * after its parent's), and CommCare HQ's app then holds an update key `parent/<property>` with the ancestor's
 * type nowhere. Any other index is typed in the step that walks it, a save
 * through `host` or a read through a custom index naming the type it reaches
 * (`throughCaseType`), and HQ's key `host/<property>` carries that type
 * nowhere either. A reading of an app Nova holds is told what its document
 * says, as it is told the project space's tables and levels.
 */
import type { BlueprintDoc, CasePropertyDataType } from "@/lib/domain";
import { caseRelationsForReadBack } from "@/lib/domain/appCaseRelations";
import { openingAssignmentSource } from "@/lib/domain/formOpeningAssignments";
import type { KnownIndexTarget, ReaderKnownCaseTypes } from "../types";

export function knownCaseTypesOf(doc: BlueprintDoc): ReaderKnownCaseTypes {
	const graph = caseRelationsForReadBack(doc);
	for (const form of Object.values(doc.forms)) {
		for (const assignment of form.openingAssignments ?? []) {
			let origin = openingAssignmentSource(
				doc,
				form.uuid,
				assignment.source,
			).type;
			for (const step of assignment.via ?? []) {
				if (origin === undefined) break;
				const targetType: string | undefined =
					step.throughCaseType ??
					(step.identifier === "parent"
						? doc.caseTypes?.find((type) => type.name === origin)?.parent_type
						: undefined);
				if (targetType === undefined) break;
				graph.note(origin, { identifier: step.identifier, targetType });
				origin = targetType;
			}
		}
	}
	const declared = new Map<string, CasePropertyDataType>();
	const types = new Set(doc.caseTypes?.map((type) => type.name));
	for (const type of doc.caseTypes ?? [])
		for (const property of type.properties)
			if (property.data_type !== undefined)
				declared.set(
					JSON.stringify([type.name, property.name]),
					property.data_type,
				);
	return {
		hasType: (caseType) => types.has(caseType),
		declaredTypeOf: (caseType, property) =>
			declared.get(JSON.stringify([caseType, property])),
		relationsOf: (caseType) => graph.edges(caseType),
		targetOf(caseType, identifier): KnownIndexTarget | undefined {
			const edges = graph.edges(caseType, identifier);
			const first = edges[0];
			if (
				first === undefined ||
				edges.some((edge) => edge.targetType !== first.targetType)
			)
				return undefined;
			return {
				caseType: first.targetType,
				...(first.relationship !== undefined &&
					edges.every((edge) => edge.relationship === first.relationship) && {
						relationship: first.relationship,
					}),
			};
		},
	};
}
