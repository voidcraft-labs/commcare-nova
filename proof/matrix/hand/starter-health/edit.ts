/**
 * The edit the base `starter-health` states, D to D′: the follow-up form
 * "Mid-Pregnancy Home Visit" (the first form of the app's second menu) gains
 * a whole-number question `antenatal_visits` after its last question, saved
 * to a new property of the form's case, `antenatal_visits`. Proof 5's
 * footprint is that form and its menu's case type.
 *
 * It finds its targets by what CommCare HQ's app keys them by, a form by its
 * place in the app, never by a Nova UUID, so the same edit applies to any
 * reading of the base at any pin. The UUID of the question it adds is written
 * out. Where the answer is saved is planned by Nova's one "Saves to" planner
 * (`lib/doc/fieldCaseWriteMutations.ts::planFieldCaseWrite`) over the
 * document holding the new question, as the builder's "Saves to" row plans
 * it, so the case catalog's new property and the form's own case write are
 * the ones a person's edit makes.
 */

import { produce } from "immer";
import { planFieldCaseWrite } from "@/lib/doc/fieldCaseWriteMutations";
import { applyMutations } from "@/lib/doc/mutations";
import type { Mutation } from "@/lib/doc/types";
import { type BlueprintDoc, proseText, type Uuid } from "@/lib/domain";

/** The question the edit adds. */
export const ANTENATAL_VISITS = "3b8e6c1d-2f4a-4b5c-9d6e-7f8a9b0c1d51" as Uuid;
/** The question's id and the case property it saves to. */
export const PROPERTY = "antenatal_visits";

/** The menu and the form the edit changes, by their places in the app. */
const MENU = 1;
const FORM = 0;

export function edit(doc: BlueprintDoc): readonly Mutation[] {
	const menu = doc.moduleOrder[MENU];
	const form = menu === undefined ? undefined : doc.formOrder[menu]?.[FORM];
	const caseType = menu === undefined ? undefined : doc.modules[menu]?.caseType;
	if (menu === undefined || form === undefined || caseType === undefined)
		throw new Error(
			`The edit of starter-health changes form ${FORM} of the app's menu ${MENU}, a follow-up form of a menu with a case type, and the document holds none there. proof/matrix/bases/starter_health.py makes the app from CommCare HQ's health template, whose second menu's first form is "Mid-Pregnancy Home Visit".`,
		);
	const add = {
		kind: "addField",
		parentUuid: form,
		after: (doc.fieldOrder[form] ?? []).at(-1) ?? null,
		field: {
			uuid: ANTENATAL_VISITS,
			kind: "int",
			id: PROPERTY,
			label: proseText("Antenatal visits so far"),
			plainLabel: true,
		},
	} as Mutation;
	const withQuestion = produce(doc, (draft) => {
		applyMutations(draft, [add]);
	});
	const saves = planFieldCaseWrite(withQuestion, ANTENATAL_VISITS, {
		caseType,
		property: PROPERTY,
	});
	if (!saves.ok)
		throw new Error(
			`The edit of starter-health saves the new question to ${caseType}'s ${PROPERTY}, and Nova's "Saves to" planner refused it: ${saves.message}`,
		);
	return [add, ...saves.mutations];
}
