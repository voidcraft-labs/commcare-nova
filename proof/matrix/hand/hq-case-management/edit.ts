/**
 * The edit the base `hq-case-management` states, D to D′: the registration
 * form (the first form of the app's first menu), which opens a household and
 * one `member` child case, gains a text question `relation` after its last
 * question, saved to the child's new property `relation`. Proof 5's
 * footprint is that form.
 *
 * It finds its targets by what CommCare HQ's app keys them by, a form by its
 * place in the app, never by a Nova UUID, so the same edit applies to any
 * reading of the base at any pin. The UUID of the question it adds is written
 * out. Where the answer is saved is planned by Nova's one "Saves to" planner
 * (`lib/doc/fieldCaseWriteMutations.ts::planFieldCaseWrite`) over the
 * document holding the new question, as the builder's "Saves to" row plans
 * it, so the child case's new write and the catalog's new property are the
 * ones a person's edit makes.
 */

import { produce } from "immer";
import { planFieldCaseWrite } from "@/lib/doc/fieldCaseWriteMutations";
import { applyMutations } from "@/lib/doc/mutations";
import type { Mutation } from "@/lib/doc/types";
import { type BlueprintDoc, proseText, type Uuid } from "@/lib/domain";

/** The question the edit adds. */
export const RELATION = "9d2f4b6a-1c3e-4a5b-8c7d-6e5f4a3b2c11" as Uuid;
/** The question's id and the child case's property it saves to. */
export const PROPERTY = "relation";
/** The child case type the registration form opens. */
const CHILD_TYPE = "member";

/** The menu and the form the edit changes, by their places in the app. */
const MENU = 0;
const FORM = 0;

export function edit(doc: BlueprintDoc): readonly Mutation[] {
	const menu = doc.moduleOrder[MENU];
	const form = menu === undefined ? undefined : doc.formOrder[menu]?.[FORM];
	const opensChild =
		form !== undefined &&
		(doc.forms[form]?.caseOperations ?? []).some(
			(operation) =>
				operation.action === "create" &&
				"caseType" in operation &&
				operation.caseType === CHILD_TYPE,
		);
	if (form === undefined || !opensChild)
		throw new Error(
			`The edit of hq-case-management changes form ${FORM} of the app's menu ${MENU}, a registration form that opens a ${CHILD_TYPE} child case, and the document holds none there. proof/matrix/bases/hq_case_management.py authors the Households menu's Registration Form with one child case outside any repeat.`,
		);
	const add = {
		kind: "addField",
		parentUuid: form,
		after: (doc.fieldOrder[form] ?? []).at(-1) ?? null,
		field: {
			uuid: RELATION,
			kind: "text",
			id: PROPERTY,
			label: proseText("Relation to the head of household"),
			plainLabel: true,
		},
	} as Mutation;
	const withQuestion = produce(doc, (draft) => {
		applyMutations(draft, [add]);
	});
	const saves = planFieldCaseWrite(withQuestion, RELATION, {
		caseType: CHILD_TYPE,
		property: PROPERTY,
	});
	if (!saves.ok)
		throw new Error(
			`The edit of hq-case-management saves the new question to the ${CHILD_TYPE} child case's ${PROPERTY}, and Nova's "Saves to" planner refused it: ${saves.message}`,
		);
	return [add, ...saves.mutations];
}
