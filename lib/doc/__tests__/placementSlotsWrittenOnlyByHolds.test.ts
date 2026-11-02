/**
 * A held placement enters a document only through `holdPlacements`. Every
 * other payload that carries a module, a form, an operation or a field
 * refuses the held slot, so a forged edit cannot choose where a published app
 * keeps a change or which kind of menu HQ holds, and a duplicate or a menu
 * the document diff adds starts unheld, so a publish never mistakes a new
 * question or menu for the one HQ already received. Each refusal is paired with the same
 * payload without the slot, which parses, so the slot alone is what is
 * refused.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { prepareMutationCandidate } from "@/lib/doc/commitVerdicts";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import { duplicateFieldMutations } from "@/lib/doc/duplicateFieldMutations";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import { readPlacementHolds } from "@/lib/doc/placementHolds";
import { type Mutation, mutationSchema } from "@/lib/doc/types";
import type { Field } from "@/lib/domain";
import {
	holdFixture,
	ownCloseAt,
	read,
	saveToCase,
	UPDATE,
	update,
	VISITS,
} from "./placementHoldFixture";

/** `held` is refused with a sentence about a published app's placement, and
 *  `unheld`, the same payload without the slot, parses. */
function expectHeldSlotRefused(unheld: unknown, held: unknown): void {
	const accepted = mutationSchema.safeParse(unheld);
	expect(accepted.error?.issues).toBeUndefined();
	const refused = mutationSchema.safeParse(held);
	expect(refused.success).toBe(false);
	expect(
		refused.error?.issues.some((issue) => /published/.test(issue.message)),
	).toBe(true);
}

describe("held placement slots", () => {
	it("refuses a held slot written by any other mutation", () => {
		const { doc, formUuid } = holdFixture();
		const moduleUuid = doc.moduleOrder[0];
		const newForm = { ...doc.forms[formUuid], uuid: testUuid("form-copy") };
		const placement = saveToCase("nova_operations", "upd");

		// addForm: the own close, and an operation's placement.
		expectHeldSlotRefused(
			{ kind: "addForm", moduleUuid, form: newForm },
			{
				kind: "addForm",
				moduleUuid,
				form: { ...newForm, ownClosePlacement: ownCloseAt("nova_close") },
			},
		);
		expectHeldSlotRefused(
			{ kind: "addForm", moduleUuid, form: newForm },
			{
				kind: "addForm",
				moduleUuid,
				form: {
					...newForm,
					caseOperations: newForm.caseOperations?.map((op) => ({
						...op,
						placement,
					})),
				},
			},
		);

		// updateForm.patch: the own close.
		expectHeldSlotRefused(
			{ kind: "updateForm", uuid: formUuid, patch: { displayCondition: null } },
			{
				kind: "updateForm",
				uuid: formUuid,
				patch: { ownClosePlacement: ownCloseAt("nova_close") },
			},
		);

		// caseOperationChange add: a new operation's placement.
		const added = { ...update(), uuid: testUuid("op-new"), id: "new_upd" };
		expectHeldSlotRefused(
			{
				kind: "updateForm",
				uuid: formUuid,
				patch: {},
				caseOperationChange: { operation: "add", value: added },
			},
			{
				kind: "updateForm",
				uuid: formUuid,
				patch: {},
				caseOperationChange: {
					operation: "add",
					value: { ...added, placement },
				},
			},
		);

		// caseOperationPatch update: an existing operation's placement.
		const patchOf = (patch: object) => ({
			kind: "updateForm",
			uuid: formUuid,
			patch: {},
			caseOperationPatch: {
				operation: "update",
				uuid: UPDATE,
				targetAction: "update",
				patch,
			},
		});
		expectHeldSlotRefused(
			patchOf({ condition: read("flag") }),
			patchOf({ placement }),
		);

		// addField: a query repeat's placement.
		const repeat = { ...doc.fields[VISITS], uuid: testUuid("visits-copy") };
		expectHeldSlotRefused(
			{ kind: "addField", parentUuid: formUuid, field: repeat },
			{
				kind: "addField",
				parentUuid: formUuid,
				field: { ...repeat, placement: "count" },
			},
		);

		// updateField.patch: a query repeat's placement.
		const fieldPatchOf = (patch: object) => ({
			kind: "updateField",
			uuid: VISITS,
			targetKind: "repeat",
			patch,
		});
		expectHeldSlotRefused(
			fieldPatchOf({ id: "visits_renamed" }),
			fieldPatchOf({ placement: "count" }),
		);

		// addModule: a menu's held kind.
		const newModule = {
			...doc.modules[moduleUuid],
			uuid: testUuid("module-copy"),
			id: "module_copy",
		};
		expectHeldSlotRefused(
			{ kind: "addModule", module: newModule },
			{ kind: "addModule", module: { ...newModule, heldKind: "advanced" } },
		);

		// updateModule.patch: a menu's held kind.
		const modulePatchOf = (patch: object) => ({
			kind: "updateModule",
			uuid: moduleUuid,
			patch,
		});
		expectHeldSlotRefused(
			modulePatchOf({ hiddenFromMenu: true }),
			modulePatchOf({ heldKind: "advanced" }),
		);
		expectHeldSlotRefused(
			modulePatchOf({ hiddenFromMenu: true }),
			modulePatchOf({ heldKind: null }),
		);
	});

	it("the document diff adds a held menu unheld, then holds it", () => {
		const { doc } = holdFixture();
		const moduleUuid = doc.moduleOrder[0];
		const copyUuid = testUuid("module-copy");
		const target = structuredClone(doc);
		target.modules[copyUuid] = {
			...doc.modules[moduleUuid],
			uuid: copyUuid,
			id: "module_copy",
			heldKind: "advanced",
		};
		target.moduleOrder = [...doc.moduleOrder, copyUuid];
		target.formOrder[copyUuid] = [];
		const mutations = diffDocsToMutations(doc, target);
		const added = mutations.find(
			(m) => m.kind === "addModule" && m.module.uuid === copyUuid,
		);
		if (added?.kind !== "addModule") throw new Error("The diff adds the menu.");
		expect(Object.hasOwn(added.module, "heldKind")).toBe(false);
		expect(mutations.at(-1)).toEqual({
			kind: "holdPlacements",
			holds: [
				{ target: "module-kind", moduleUuid: copyUuid, placement: "advanced" },
			],
		});
		for (const mutation of mutations)
			expect(mutationSchema.safeParse(mutation).error?.issues).toBeUndefined();
	});

	it("a duplicated field starts unheld", () => {
		const { doc } = holdFixture((d) => {
			d.fields[VISITS] = { ...d.fields[VISITS], placement: "count" } as Field;
		});
		const plan = duplicateFieldMutations(doc, VISITS);
		if (plan === undefined) throw new Error("The query repeat duplicates.");
		const next = prepareMutationCandidate(
			doc,
			admitMutationBatch(plan.mutations as Mutation[]),
		).nextDoc;
		expect(next.fields[plan.cloneUuid]).toMatchObject({
			kind: "repeat",
			repeat_mode: "query_bound",
		});
		expect(Object.hasOwn(next.fields[plan.cloneUuid], "placement")).toBe(false);
		// The source keeps its hold, and it is the only one.
		expect([...readPlacementHolds(next).keys()]).toEqual([
			`query-repeat:${VISITS}`,
		]);
	});
});
