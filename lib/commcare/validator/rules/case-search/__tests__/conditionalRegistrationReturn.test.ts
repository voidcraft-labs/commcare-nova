import { produce } from "immer";
import { describe, expect, it } from "vitest";
import {
	CREATE_RECORD_FIELD,
	CREATE_RECORD_YES,
	HOST_MODULE,
	noMatchesWireFixture,
	REGISTER_FORM,
} from "@/lib/commcare/__tests__/noMatchesWireFixture";
import { readMenusOf } from "@/lib/commcare/reader/menus/__tests__/menuReading";
import { runValidation } from "@/lib/commcare/validator/runner";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc } from "@/lib/domain";
import { eq, formField } from "@/lib/domain/expression";

const CODE = "CASE_LIST_REGISTRATION_REQUIRES_CREATED_RESULT";
const condition = eq(formField(CREATE_RECORD_FIELD), {
	kind: "choice",
	field: CREATE_RECORD_FIELD,
	options: [CREATE_RECORD_YES],
});

function validation(doc: BlueprintDoc) {
	return runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
}

describe("conditional creation on a list action", () => {
	it.each(["basic", "new-case"] as const)(
		"refuses the %s inline return when it fetches a case the form may skip",
		(scenario) => {
			const base = noMatchesWireFixture(scenario);
			expect(validation(base)).toEqual([]);
			const optional = produce(base, (draft) => {
				draft.forms[REGISTER_FORM].openCondition = condition;
			});
			expect(validation(optional)).toEqual([
				expect.objectContaining({
					code: CODE,
					location: { moduleUuid: HOST_MODULE, moduleName: "Patients" },
					details: { formUuid: REGISTER_FORM, formName: "Register patient" },
				}),
			]);
			const toFirstMenu = produce(optional, (draft) => {
				draft.forms[REGISTER_FORM].postSubmit = "firstMenu";
			});
			expect(validation(toFirstMenu)).toEqual([]);
		},
	);

	it("keeps the conditional form on an ordinary list without a return query", () => {
		const optional = produce(noMatchesWireFixture("second-list"), (draft) => {
			delete draft.modules[HOST_MODULE].caseListRegistrationForm;
			delete draft.modules[HOST_MODULE].caseSearchConfig;
			draft.forms[REGISTER_FORM].openCondition = condition;
		});
		expect(validation(optional)).toEqual([]);
	});

	it("accounts for the same condition when bringing in HQ's stored registration", async () => {
		const reading = await readMenusOf(
			noMatchesWireFixture("new-case"),
			(app) => {
				const registration = app.modules
					.flatMap((menu) => menu.forms)
					.find(
						(form) => (form.name as { en?: string }).en === "Register patient",
					);
				if (!registration)
					throw new Error("The app lacks the registration form.");
				const actions = registration.actions as {
					open_case: { condition: unknown };
				};
				actions.open_case.condition = {
					type: "if",
					question: "/data/create_record",
					answer: "yes",
				};
			},
		);
		expect(reading.outcome.kind).toBe("account");
		expect(reading.findings.map((finding) => finding.code)).toContain(
			"menus-and-case-lists/case-list-form-return-search-needs-the-created-case",
		);
	});
});
