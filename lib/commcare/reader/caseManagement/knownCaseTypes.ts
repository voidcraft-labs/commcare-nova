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
import type {
	BlueprintDoc,
	CasePropertyDataType,
	CaseType,
	Uuid,
} from "@/lib/domain";
import { type RelationStep, walkExpression } from "@/lib/domain/expression";
import { openingAssignmentSource } from "@/lib/domain/formOpeningAssignments";
import { operationCaseType } from "@/lib/domain/forms";
import { expressionSlotValues } from "@/lib/domain/referenceSlots";
import type { KnownIndexTarget, ReaderKnownCaseTypes } from "../types";

/** Notes each typed step of `steps` walked from `origin`: a `parent` step
 *  reaches the catalog's parent, any other the type it names. Stops at a
 *  step whose type is unknown. */
function noteSteps(
	origin: string,
	steps: readonly RelationStep[],
	parentOf: (caseType: string) => string | undefined,
	note: (caseType: string, identifier: string, reached: string) => void,
): void {
	let at = origin;
	for (const step of steps) {
		const reached =
			step.identifier === "parent"
				? (step.throughCaseType ?? parentOf(at))
				: step.throughCaseType;
		if (reached === undefined) return;
		if (step.identifier !== "parent") note(at, step.identifier, reached);
		at = reached;
	}
}

/** The index targets `doc` holds, for `ReaderInput.knownCaseTypes`. */
export function knownCaseTypesOf(doc: BlueprintDoc): ReaderKnownCaseTypes {
	const parents = new Map<
		string,
		Pick<CaseType, "parent_type" | "relationship">
	>();
	for (const type of doc.caseTypes ?? [])
		if (type.parent_type !== undefined && !parents.has(type.name))
			parents.set(type.name, type);
	const parentOf = (caseType: string) => parents.get(caseType)?.parent_type;
	const declared = new Map<string, CasePropertyDataType>();
	for (const type of doc.caseTypes ?? [])
		for (const property of type.properties)
			if (property.data_type !== undefined)
				declared.set(
					JSON.stringify([type.name, property.name]),
					property.data_type,
				);
	const typed = new Map<string, Set<string>>();
	const key = (caseType: string, identifier: string) =>
		JSON.stringify([caseType, identifier]);
	const note = (caseType: string, identifier: string, reached: string) => {
		const types = typed.get(key(caseType, identifier)) ?? new Set<string>();
		types.add(reached);
		typed.set(key(caseType, identifier), types);
	};
	for (const form of Object.values(doc.forms)) {
		for (const assignment of form.openingAssignments ?? []) {
			const origin = openingAssignmentSource(
				doc,
				form.uuid,
				assignment.source,
			).type;
			if (origin && assignment.via)
				noteSteps(origin, assignment.via, parentOf, note);
		}
	}
	// A save through the indices above its operation's case.
	for (const [formUuid, form] of Object.entries(doc.forms))
		for (const operation of form.caseOperations ?? []) {
			const origin = operationCaseType(doc, formUuid as Uuid, operation);
			if (origin === undefined) continue;
			for (const write of operation.writes ?? [])
				if (write.via !== undefined)
					noteSteps(origin, write.via, parentOf, note);
		}
	// A case list column showing a property through the indices above its menu's case.
	for (const mod of Object.values(doc.modules))
		for (const column of mod.caseListConfig?.columns ?? [])
			if (
				column.kind !== "calculated" &&
				column.via !== undefined &&
				mod.caseType !== undefined
			)
				noteSteps(mod.caseType, column.via, parentOf, note);
	// A read of a property through the indices above the case it names.
	const owners = [
		...Object.keys(doc.fields).map((uuid) => ({
			entity: "field" as const,
			uuid,
		})),
		...Object.keys(doc.forms).map((uuid) => ({
			entity: "form" as const,
			uuid,
		})),
		...Object.keys(doc.modules).map((uuid) => ({
			entity: "module" as const,
			uuid,
		})),
	];
	for (const owner of owners)
		for (const { expression } of expressionSlotValues(doc, {
			entity: owner.entity,
			uuid: owner.uuid as Uuid,
		}))
			walkExpression(expression, {
				visitTerm: (term) => {
					if (
						term.kind === "prop" &&
						term.caseType !== undefined &&
						term.via?.kind === "ancestor"
					)
						noteSteps(term.caseType, term.via.via, parentOf, note);
				},
			});
	return {
		declaredTypeOf: (caseType, property) =>
			declared.get(JSON.stringify([caseType, property])),
		targetOf: (caseType, identifier): KnownIndexTarget | undefined => {
			if (identifier === "parent") {
				const parent = parents.get(caseType);
				return parent?.parent_type === undefined
					? undefined
					: {
							caseType: parent.parent_type,
							...(parent.relationship !== undefined && {
								relationship: parent.relationship,
							}),
						};
			}
			const types = typed.get(key(caseType, identifier));
			const [only] = types ?? [];
			return types?.size === 1 && only !== undefined
				? { caseType: only }
				: undefined;
		},
	};
}
