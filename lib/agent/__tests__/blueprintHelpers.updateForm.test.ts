import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { caseListConfig } from "@/lib/__tests__/docHelpers";
import { runValidation } from "@/lib/commcare/validator/runner";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import { applyMutations } from "@/lib/doc/mutations";
import type { BlueprintDoc } from "@/lib/domain";
import { blueprintDocSchema } from "@/lib/domain/blueprint";
import { proseText } from "@/lib/domain/prose";
import {
	addFormMutations,
	refineFormConnectMutations,
	updateFormMutations,
} from "../blueprintHelpers";

const MODULE_UUID = testUuid("update-form-module");
const FORM_UUID = testUuid("update-form-form");
const FIELD_UUID = testUuid("update-form-field");

function docWithEveryHelperClearableSlot(): BlueprintDoc {
	const doc: BlueprintDoc = {
		appId: "update-form-wire",
		appName: "Update form wire",
		connectType: "learn",
		caseTypes: [{ name: "patient", properties: [] }],
		modules: {
			[MODULE_UUID]: {
				uuid: MODULE_UUID,
				id: "module",
				name: "Module",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
			},
		},
		forms: {
			[FORM_UUID]: {
				uuid: FORM_UUID,
				id: "form",
				name: "Form",
				type: "close",
				purpose: "Collect the final status",
				closeCondition: { field: FIELD_UUID, answer: "yes" },
				connect: {
					learn_module: {
						id: "module",
						name: "Module",
						description: "Learn",
						time_estimate: 10,
					},
				},
				postSubmit: "app_home",
			},
		},
		fields: {
			[FIELD_UUID]: {
				uuid: FIELD_UUID,
				id: "ready",
				kind: "text",
				label: proseText("Ready"),
			},
		},
		moduleOrder: [MODULE_UUID],
		formOrder: { [MODULE_UUID]: [FORM_UUID] },
		fieldOrder: { [FORM_UUID]: [FIELD_UUID] },
		fieldParent: { [FIELD_UUID]: FORM_UUID },
	};
	blueprintDocSchema.parse(toPersistableDoc(doc));
	expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
	return doc;
}

describe("form metadata and Connect helper ownership", () => {
	it("carries every helper clear as null through admission and JSON", () => {
		const doc = docWithEveryHelperClearableSlot();
		const planned = updateFormMutations(doc, FORM_UUID, {
			purpose: null,
			closeCondition: null,
			postSubmit: null,
		});

		expect(planned).toEqual([
			{
				kind: "updateForm",
				uuid: FORM_UUID,
				patch: {
					purpose: null,
					closeCondition: null,
					postSubmit: null,
				},
			},
		]);

		const admitted = admitMutationBatch(planned);
		const roundTripped = admitMutationBatch(
			JSON.parse(JSON.stringify(admitted)) as unknown,
		);
		expect(roundTripped).toEqual(admitted);

		const next = produce(doc, (draft) => {
			applyMutations(draft, roundTripped);
		});
		expect(runValidation(next, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		const form = next.forms[FORM_UUID];
		expect(form).toBeDefined();
		for (const key of ["purpose", "closeCondition", "postSubmit"] as const) {
			expect(Object.hasOwn(form ?? {}, key)).toBe(false);
		}
		expect(form?.connect).toEqual(doc.forms[FORM_UUID].connect);
	});

	it("refines an existing participant but cannot remove participation", () => {
		const doc = docWithEveryHelperClearableSlot();
		const refined = {
			learn_module: {
				id: "module",
				name: "Module",
				description: "Refined",
				time_estimate: 15,
			},
		};
		const mutations = refineFormConnectMutations(doc, FORM_UUID, refined);
		expect(mutations).toEqual([
			{
				kind: "updateForm",
				uuid: FORM_UUID,
				patch: { connect: refined },
			},
		]);

		const next = produce(doc, (draft) => {
			applyMutations(draft, admitMutationBatch(mutations));
		});
		expect(next.forms[FORM_UUID].connect).toEqual(refined);
		expect(runValidation(next, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		expect(doc.forms[FORM_UUID].connect).not.toEqual(refined);

		for (const value of [null, undefined]) {
			expect(
				Reflect.apply(refineFormConnectMutations, undefined, [
					doc,
					FORM_UUID,
					value,
				]),
			).toEqual([]);
		}
	});
	it("does not acquire participation through extra properties on generic form inputs", () => {
		const doc = docWithEveryHelperClearableSlot();
		const original = structuredClone(doc);
		const uuid = testUuid("nonparticipant-generic-form");
		const proposedConnect = {
			learn_module: {
				id: "unexpected",
				name: "Unexpected",
				description: "Should not be installed",
				time_estimate: 1,
			},
		};
		// Extra properties can arrive through structurally assignable variables.
		const input = {
			uuid,
			name: "Auxiliary",
			type: "survey" as const,
			connect: proposedConnect,
		};
		const added = produce(doc, (draft) => {
			applyMutations(
				draft,
				admitMutationBatch([
					...addFormMutations(doc, MODULE_UUID, input),
					{
						kind: "addField",
						parentUuid: uuid,
						field: {
							uuid: testUuid("auxiliary-question"),
							id: "notes",
							kind: "text",
							label: proseText("Notes"),
						},
					},
				]),
			);
		});
		expect(added.forms[uuid]).toMatchObject({
			uuid,
			name: "Auxiliary",
			type: "survey",
		});
		expect(Object.hasOwn(added.forms[uuid], "connect")).toBe(false);
		expect(refineFormConnectMutations(added, uuid, proposedConnect)).toEqual(
			[],
		);
		expect(runValidation(added, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		const patch = { purpose: "Revised purpose", connect: proposedConnect };
		const updated = produce(added, (draft) => {
			applyMutations(
				draft,
				admitMutationBatch(updateFormMutations(added, uuid, patch)),
			);
		});
		expect(updated.forms[uuid].purpose).toBe("Revised purpose");
		expect(runValidation(updated, LOOKUP_CONTEXT_UNAVAILABLE)).toEqual([]);
		expect(Object.hasOwn(updated.forms[uuid], "connect")).toBe(false);
		expect(updated.forms[FORM_UUID].connect).toEqual(
			original.forms[FORM_UUID].connect,
		);
		expect(doc).toEqual(original);
	});
});
