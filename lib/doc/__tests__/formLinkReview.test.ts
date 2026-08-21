/**
 * The pure verdicts a surface asks before offering a move, a target, or a
 * "carry it automatically" choice — and their parity with the commit gate:
 * every `ok` verdict commits, every refusal names a real finding.
 */

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { planFormLinkMove } from "@/lib/doc/formLinkMutations";
import {
	formLinkAddChoices,
	formLinkCarryVerdict,
	formLinkMoveVerdicts,
	formLinkRequiredDatums,
	formLinkTargetVerdict,
} from "@/lib/doc/formLinkReview";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc, FormLinkTarget } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";

const INTAKE = testUuid("mod-intake");
const CARE = testUuid("mod-care");
const REGISTER = testUuid("frm-register");
const SURVEY = testUuid("frm-survey");
const VISIT = testUuid("frm-visit");
const VISIT_AGAIN = testUuid("frm-visit-again");
const NOTE = testUuid("frm-note");
const L1 = testUuid("lnk-1");
const L2 = testUuid("lnk-2");
const ELSE = testUuid("lnk-else");

const toVisit: FormLinkTarget = {
	type: "form",
	moduleUuid: CARE,
	formUuid: VISIT,
};
const toNote: FormLinkTarget = {
	type: "form",
	moduleUuid: CARE,
	formUuid: NOTE,
};
const toCare: FormLinkTarget = { type: "module", moduleUuid: CARE };

/**
 * Intake (patient) → [Register (registration, with links), Survey];
 * Care (patient) → [Visit (followup), Visit again (followup), Note (survey)].
 */
function fixture(): BlueprintDoc {
	return buildDoc({
		appName: "Review",
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "mood", label: proseText("Mood") }],
			},
		],
		modules: [
			{
				uuid: "mod-intake",
				name: "Intake",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "frm-register",
						name: "Register",
						type: "registration",
						postSubmit: "app_home",
						formLinks: [
							{ uuid: "lnk-1", condition: "1 = 1", target: toNote },
							{ uuid: "lnk-2", condition: "2 = 2", target: toVisit },
							{ uuid: "lnk-else", target: toCare },
						],
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: proseText("Name"),
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
						],
					},
					{
						uuid: "frm-survey",
						name: "Survey",
						type: "survey",
						fields: [f({ kind: "text", id: "s", label: proseText("S") })],
					},
				],
			},
			{
				uuid: "mod-care",
				name: "Care",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "frm-visit",
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "text",
								id: "mood",
								label: proseText("Mood"),
								caseWrite: { caseType: "patient", property: "mood" },
							}),
						],
					},
					{
						uuid: "frm-visit-again",
						name: "Visit again",
						type: "followup",
						fields: [
							f({
								kind: "text",
								id: "mood",
								label: proseText("Mood"),
								caseWrite: { caseType: "patient", property: "mood" },
							}),
						],
					},
					{
						uuid: "frm-note",
						name: "Note",
						type: "survey",
						fields: [f({ kind: "text", id: "n", label: proseText("N") })],
					},
				],
			},
		],
	});
}

describe("formLinkMoveVerdicts", () => {
	it("answers every destination index for a conditional link", () => {
		const verdicts = formLinkMoveVerdicts(fixture(), REGISTER, L1);
		expect([...verdicts.entries()]).toEqual([
			[0, { ok: true }],
			[1, { ok: true }],
			[2, { ok: false, reason: "after-else", elseUuid: ELSE }],
		]);
	});

	it("keeps the otherwise link last", () => {
		const verdicts = formLinkMoveVerdicts(fixture(), REGISTER, ELSE);
		expect([...verdicts.entries()]).toEqual([
			[0, { ok: false, reason: "else-not-last", blockingUuids: [L1, L2] }],
			[1, { ok: false, reason: "else-not-last", blockingUuids: [L2] }],
			[2, { ok: true }],
		]);
	});

	it("is empty for a link that is not on the form", () => {
		expect(
			formLinkMoveVerdicts(fixture(), REGISTER, testUuid("ghost")).size,
		).toBe(0);
	});

	it("agrees with the commit gate at every position (parity)", () => {
		const doc = fixture();
		for (const uuid of [L1, L2, ELSE]) {
			for (const [index, verdict] of formLinkMoveVerdicts(
				doc,
				REGISTER,
				uuid,
			)) {
				const plan = planFormLinkMove(doc, REGISTER, uuid, index);
				expect(plan.ok, `${uuid} → ${index}`).toBe(verdict.ok);
				if (!plan.ok) continue;
				const gate = mutationCommitVerdict(
					doc,
					[...plan.mutations],
					LOOKUP_CONTEXT_UNAVAILABLE,
				);
				expect(gate.ok, `${uuid} → ${index} commits`).toBe(true);
			}
		}
	});
});

describe("formLinkTargetVerdict", () => {
	it("admits a module, a sibling form, and a form in another module", () => {
		const doc = fixture();
		expect(formLinkTargetVerdict(doc, REGISTER, undefined, toCare)).toEqual({
			ok: true,
		});
		expect(formLinkTargetVerdict(doc, REGISTER, undefined, toVisit)).toEqual({
			ok: true,
		});
		expect(
			formLinkTargetVerdict(doc, REGISTER, undefined, {
				type: "form",
				moduleUuid: INTAKE,
				formUuid: SURVEY,
			}),
		).toEqual({ ok: true });
	});

	it("refuses itself, a missing target, and a chain that loops back", () => {
		const doc = fixture();
		expect(
			formLinkTargetVerdict(doc, REGISTER, undefined, {
				type: "form",
				moduleUuid: INTAKE,
				formUuid: REGISTER,
			}),
		).toEqual({ ok: false, reason: "self-target" });
		expect(
			formLinkTargetVerdict(doc, REGISTER, undefined, {
				type: "module",
				moduleUuid: testUuid("ghost"),
			}),
		).toEqual({ ok: false, reason: "target-not-found" });
		expect(
			formLinkTargetVerdict(doc, REGISTER, undefined, {
				type: "form",
				moduleUuid: CARE,
				formUuid: testUuid("ghost"),
			}),
		).toEqual({ ok: false, reason: "target-not-found" });
		// Note → Survey → Register; pointing Register at Note loops.
		const looped = produce(doc, (draft) => {
			const note = draft.forms[NOTE];
			const survey = draft.forms[SURVEY];
			if (note === undefined || survey === undefined)
				throw new Error("fixture");
			note.formLinks = [
				{
					uuid: testUuid("n→s"),
					target: { type: "form", moduleUuid: INTAKE, formUuid: SURVEY },
				},
			];
			survey.formLinks = [
				{
					uuid: testUuid("s→r"),
					target: { type: "form", moduleUuid: INTAKE, formUuid: REGISTER },
				},
			];
		});
		expect(formLinkTargetVerdict(looped, REGISTER, L1, toNote)).toEqual({
			ok: false,
			reason: "cycle",
			chain: [NOTE, SURVEY, REGISTER],
		});
	});

	it("ignores the edited link's own current edge", () => {
		// Register already points at Note through lnk-1; retargeting lnk-1
		// at Visit must not count that edge, and Visit reaches nothing.
		expect(formLinkTargetVerdict(fixture(), REGISTER, L1, toVisit)).toEqual({
			ok: true,
		});
	});
});

describe("formLinkRequiredDatums / formLinkCarryVerdict", () => {
	it("a module target and a survey form need nothing", () => {
		const doc = fixture();
		expect(formLinkRequiredDatums(doc, REGISTER, toCare)).toEqual([]);
		expect(formLinkRequiredDatums(doc, REGISTER, toNote)).toEqual([]);
		expect(formLinkCarryVerdict(doc, REGISTER, toCare)).toEqual({
			kind: "nothing-needed",
		});
	});

	it("a followup target needs case_id, carried from the case this registration creates", () => {
		const doc = fixture();
		expect(formLinkRequiredDatums(doc, REGISTER, toVisit)).toEqual([
			{ id: "case_id", caseType: "patient" },
		]);
		expect(formLinkCarryVerdict(doc, REGISTER, toVisit)).toEqual({
			kind: "automatic",
			carried: [{ datumId: "case_id", sourceDatumId: "case_id_new_patient_0" }],
		});
	});

	it("a survey source cannot carry a case, so the author works it out by hand", () => {
		expect(formLinkCarryVerdict(fixture(), SURVEY, toVisit)).toEqual({
			kind: "manual-required",
			datumIds: ["case_id"],
		});
	});

	it("a followup source carries the case it opened under the same id", () => {
		expect(
			formLinkCarryVerdict(fixture(), VISIT, {
				type: "form",
				moduleUuid: CARE,
				formUuid: VISIT_AGAIN,
			}),
		).toEqual({
			kind: "automatic",
			carried: [{ datumId: "case_id", sourceDatumId: "case_id" }],
		});
	});

	it("answers nothing-needed for a target that does not exist (the verdict owns that)", () => {
		expect(
			formLinkRequiredDatums(fixture(), REGISTER, {
				type: "form",
				moduleUuid: CARE,
				formUuid: testUuid("ghost"),
			}),
		).toEqual([]);
	});
});

describe("formLinkAddChoices", () => {
	it("offers the otherwise only while none exists", () => {
		const doc = fixture();
		expect(formLinkAddChoices(doc, REGISTER)).toEqual({
			conditional: { ok: true },
			otherwise: { ok: false, reason: "else-exists", elseUuid: ELSE },
		});
		expect(formLinkAddChoices(doc, SURVEY)).toEqual({
			conditional: { ok: true },
			otherwise: { ok: true },
		});
	});
});
