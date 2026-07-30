import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import { applyMutations } from "@/lib/doc/mutations";
import type { BlueprintDoc } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import {
	refineFormConnectMutations,
	updateFormMutations,
} from "../blueprintHelpers";

const MODULE_UUID = testUuid("update-form-module");
const FORM_UUID = testUuid("update-form-form");
const FIELD_UUID = testUuid("update-form-field");

function docWithEveryHelperClearableSlot(): BlueprintDoc {
	return {
		appId: "update-form-wire",
		appName: "Update form wire",
		connectType: "learn",
		caseTypes: null,
		modules: {
			[MODULE_UUID]: {
				uuid: MODULE_UUID,
				id: "module",
				name: "Module",
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
}

describe("updateFormMutations clear wire", () => {
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
		const form = next.forms[FORM_UUID];
		expect(form).toBeDefined();
		for (const key of ["purpose", "closeCondition", "postSubmit"] as const) {
			expect(Object.hasOwn(form ?? {}, key)).toBe(false);
		}
		expect(form?.connect).toEqual(doc.forms[FORM_UUID].connect);
	});

	it("refines an existing participant but cannot add or remove participation", () => {
		const doc = docWithEveryHelperClearableSlot();
		const refined = {
			learn_module: {
				id: "module",
				name: "Module",
				description: "Refined",
				time_estimate: 15,
			},
		};
		expect(refineFormConnectMutations(doc, FORM_UUID, refined)).toEqual([
			{
				kind: "updateForm",
				uuid: FORM_UUID,
				patch: { connect: refined },
			},
		]);

		const nonparticipant: BlueprintDoc = {
			...doc,
			forms: {
				...doc.forms,
				[FORM_UUID]: { ...doc.forms[FORM_UUID], connect: undefined },
			},
		};
		expect(
			refineFormConnectMutations(nonparticipant, FORM_UUID, refined),
		).toEqual([]);
		expect(refineFormConnectMutations(doc, FORM_UUID, null as never)).toEqual(
			[],
		);
	});
});
