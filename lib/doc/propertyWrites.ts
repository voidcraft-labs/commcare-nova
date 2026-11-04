/**
 * Every write of one case property, read from the forms the reference index
 * names as its declarers (`declarersOf`), never a document walk.
 *
 * A write lands on its operation's case type after any retype (the module's
 * case type for the form's own case), or on the type its `via` reaches
 * through the catalog. A write whose value is one question's answer, as it
 * is, names that question (`caseWriteValueField`): it is in the question's
 * "Saves to" view. Any other value is an expression the operation computes.
 */

import {
	type CaseOperation,
	type CaseOperationWrite,
	caseWriteValueField,
	operationCaseType,
	type Uuid,
} from "@/lib/domain";
import { resolveRelationDestination } from "@/lib/domain/expression/relationDestination";
import { declarersOf } from "./referenceIndex";
import type { BlueprintDoc } from "./types";

export interface PropertyWrite {
	readonly formUuid: Uuid;
	readonly operation: CaseOperation;
	readonly write: CaseOperationWrite;
	/** The question whose answer the write saves as it is, when it does. */
	readonly field?: Uuid;
}

/** The case type one write of `operation` on `formUuid` saves to. */
export function writeCaseType(
	doc: BlueprintDoc,
	formUuid: Uuid,
	operation: CaseOperation,
	write: CaseOperationWrite,
): string | undefined {
	const operationType =
		operation.action === "own"
			? operationCaseType(doc, formUuid, operation)
			: (operation.retype ?? operation.caseType);
	if (operationType === undefined || operationType.length === 0)
		return undefined;
	if (write.via === undefined) return operationType;
	const reached = resolveRelationDestination(
		{ kind: "ancestor", via: write.via },
		operationType,
		doc.caseTypes ?? [],
	);
	return reached.ok ? reached.caseType : undefined;
}

/** Every write of `(caseType, property)`, in form, operation, write order. */
export function propertyWrites(
	doc: BlueprintDoc,
	caseType: string,
	property: string,
): readonly PropertyWrite[] {
	const writes: PropertyWrite[] = [];
	for (const carrier of declarersOf(doc, caseType, property)) {
		const formUuid = carrier as Uuid;
		const form = Object.hasOwn(doc.forms, formUuid)
			? doc.forms[formUuid]
			: undefined;
		for (const operation of form?.caseOperations ?? []) {
			for (const write of operation.writes ?? []) {
				if (write.property !== property) continue;
				if (writeCaseType(doc, formUuid, operation, write) !== caseType)
					continue;
				const read = caseWriteValueField(write.value);
				writes.push({
					formUuid,
					operation,
					write,
					...(read !== undefined && { field: read.field }),
				});
			}
		}
	}
	return writes;
}
