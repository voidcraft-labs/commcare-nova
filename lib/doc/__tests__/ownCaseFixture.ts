// A fixture's own cases: the first operation of every registration,
// follow-up and close form of a module with a case type
// (`CASE_OWN_OPERATION`). A test that builds such a form by hand gives it
// one here, and reads or edits the one it holds through the helpers below.

import { testUuid } from "@/__tests__/helpers/uuid";
import type { BlueprintDoc, Mutation, Uuid } from "@/lib/doc/types";
import type {
	CaseOperationWrite,
	CaseWriteKey,
	OwnCaseOperation,
} from "@/lib/domain";

/** Give each case form that holds no own case one, first, writing nothing,
 *  its uuid derived from the form's so a test can address it. */
export function addOwnCases(doc: BlueprintDoc): void {
	for (const [moduleUuid, formUuids] of Object.entries(doc.formOrder)) {
		const caseType = doc.modules[moduleUuid]?.caseType;
		if (caseType === undefined) continue;
		for (const formUuid of formUuids) {
			const form = doc.forms[formUuid];
			if (form === undefined || form.type === "survey") continue;
			const operations = form.caseOperations ?? [];
			if (operations.some((operation) => operation.action === "own")) continue;
			form.caseOperations = [
				{
					uuid: ownCaseUuidFor(formUuid),
					id: caseType.replace(/[^A-Za-z0-9_]/g, "_"),
					action: "own",
				},
				...operations,
			];
		}
	}
}

/** The uuid `addOwnCases` gives a form's own case. */
export function ownCaseUuidFor(formUuid: string): Uuid {
	return testUuid(`own-case-of-${formUuid}`);
}

/** The own case `formUuid` holds; a fixture without one is a broken test. */
export function ownCaseOf(doc: BlueprintDoc, formUuid: Uuid): OwnCaseOperation {
	const own = doc.forms[formUuid]?.caseOperations?.find(
		(operation): operation is OwnCaseOperation => operation.action === "own",
	);
	if (own === undefined)
		throw new Error(`The fixture's form ${formUuid} holds no own case.`);
	return own;
}

/** The mutation that adds `write` to the form's own case. */
export function addOwnWrite(
	doc: BlueprintDoc,
	formUuid: Uuid,
	write: CaseOperationWrite,
): Mutation {
	return {
		kind: "updateForm",
		uuid: formUuid,
		patch: {},
		caseOperationPatch: {
			operation: "add-write",
			uuid: ownCaseOf(doc, formUuid).uuid,
			value: write,
		},
	};
}

/** The mutation that removes the own case's write of `key`. */
export function removeOwnWrite(
	doc: BlueprintDoc,
	formUuid: Uuid,
	key: CaseWriteKey,
): Mutation {
	return {
		kind: "updateForm",
		uuid: formUuid,
		patch: {},
		caseOperationPatch: {
			operation: "remove-write",
			uuid: ownCaseOf(doc, formUuid).uuid,
			key,
		},
	};
}
