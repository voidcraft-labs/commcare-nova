/**
 * The type a case-operation write's value must be assignable to.
 *
 * The effective catalog is the wrong answer on its own here, and the way it is
 * wrong is invisible: `effectiveCaseTypes` fills an undeclared property's
 * `data_type` FROM ITS WRITERS, so a property whose only writer is the very
 * write being edited reports the type that write currently happens to infer.
 * Constraining the editor by that pins the write to itself — a property added
 * through "Or save something new" commits an empty text value, is immediately
 * read back as `text`, and can then never hold a date, because the only thing
 * saying it is text is the value the author is trying to replace.
 *
 * So the question is not "what type is this property?" but "what type is this
 * property REGARDLESS of this write?", and there are exactly three answers:
 *
 * - the catalog DECLARES a type — that binds, and the commit gate enforces
 *   every writer against it;
 * - it does not, but something else writes it — the writers must agree, so the
 *   effective type binds;
 * - it does not, and nothing else writes it — this write establishes the type,
 *   and anything storable is admissible.
 */

import {
	type BlueprintDoc,
	type CasePropertyDataType,
	effectiveCaseTypes,
} from "@/lib/domain";
import { declarersOf } from "./referenceIndex";
import type { Uuid } from "./types";

function declaredType(
	caseTypes: readonly {
		name: string;
		properties: readonly CasePropertyLike[];
	}[],
	caseType: string,
	property: string,
): CasePropertyDataType | undefined {
	return caseTypes
		.find((candidate) => candidate.name === caseType)
		?.properties.find((candidate) => candidate.name === property)?.data_type;
}

interface CasePropertyLike {
	readonly name: string;
	readonly data_type?: CasePropertyDataType;
}

/**
 * True when the only thing writing `(caseType, property)` is this operation.
 *
 * The reference index keys a FORM's operation declarations under the form, not
 * under each operation (`registerFormDeclarations`), so `declarersOf` answers
 * "does anything outside this form write it?" and the siblings inside the form
 * have to be read off the form itself. Field writers carry their own uuid, so
 * a field in this same form is already a foreign carrier.
 */
function operationIsSoleWriter(
	doc: BlueprintDoc,
	formUuid: Uuid,
	operationUuid: Uuid,
	caseType: string,
	property: string,
): boolean {
	const foreign = declarersOf(doc, caseType, property).some(
		(carrier) => carrier !== formUuid,
	);
	if (foreign) return false;
	const form = doc.forms[formUuid];
	if (form === undefined) return true;
	return !(form.caseOperations ?? []).some(
		(operation) =>
			operation.uuid !== operationUuid &&
			(operation.retype ?? operation.caseType) === caseType &&
			(operation.writes ?? []).some((write) => write.property === property),
	);
}

export function caseOperationWriteValueType(
	doc: BlueprintDoc,
	formUuid: Uuid,
	operationUuid: Uuid,
	caseType: string,
	property: string,
): CasePropertyDataType | undefined {
	const authored = declaredType(doc.caseTypes ?? [], caseType, property);
	if (authored !== undefined) return authored;
	if (operationIsSoleWriter(doc, formUuid, operationUuid, caseType, property)) {
		return undefined;
	}
	return declaredType(effectiveCaseTypes(doc), caseType, property);
}
