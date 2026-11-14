/**
 * The pure verdicts a surface asks before offering a move, a target, or a
 * "carry it automatically" choice, and their parity with the commit gate:
 * every `ok` verdict commits, every refusal names a real finding.
 */

import { type Draft, produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import {
	formLinkAddChoices,
	formLinkCarryVerdict,
	formLinkManualCarryVerdict,
	formLinkMoveVerdicts,
	formLinkRequiredDatums,
	formLinkTargetVerdict,
} from "@/lib/doc/formLinkReview";
import { formLinkTargetChoices } from "@/lib/doc/formLinkTargetChoices";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc, FormLinkTarget } from "@/lib/domain";
import { literal, term } from "@/lib/domain/expression/builders";
import { proseText } from "@/lib/domain/prose";
import { assertAdmittedDoc } from "./admittedDoc";

const INTAKE = testUuid("mod-intake");
const CARE = testUuid("mod-care");
const REGISTER = testUuid("frm-register");
const SURVEY = testUuid("frm-survey");
const VISIT = testUuid("frm-visit");
const VISIT_AGAIN = testUuid("frm-visit-again");
const NOTE = testUuid("frm-note");
const SUB = testUuid("mod-sub");
const SUB_NOTE = testUuid("frm-sub-note");
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
const toSub: FormLinkTarget = { type: "module", moduleUuid: SUB };

/**
 * Intake (patient) → [Register (registration, with three destinations, the
 * last every time), Survey]; Care (patient) → [Visit (followup), Visit again
 * (followup), Note (survey)]; Sub, a submenu of Care → [Sub note (survey)].
 * HQ's form settings page offers Sub as a link target from no form of a
 * root menu.
 */
function fixture(): BlueprintDoc {
	const doc = buildDoc({
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
			{
				uuid: "mod-sub",
				name: "Sub",
				forms: [
					{
						uuid: "frm-sub-note",
						name: "Sub note",
						type: "survey",
						fields: [f({ kind: "text", id: "s", label: proseText("S") })],
					},
				],
			},
		],
	});
	const nested = produce(doc, (draft) => {
		draft.modules[SUB].parentModuleUuid = CARE;
	});
	assertAdmittedDoc(nested);
	return nested;
}

/**
 * A form that loads several cases reads none of them as one starting value,
 * so the follow-ups' mood questions no longer open with the case's mood once
 * their menu chooses several cases.
 */
function dropOneCasePreloads(draft: Draft<BlueprintDoc>): void {
	for (const formUuid of [VISIT, VISIT_AGAIN]) {
		for (const fieldUuid of draft.fieldOrder[formUuid] ?? []) {
			const field = draft.fields[fieldUuid];
			if (field !== undefined && "default_value" in field)
				delete field.default_value;
		}
	}
}

describe("formLinkMoveVerdicts", () => {
	it("answers ok at every destination index, an every-time destination's included", () => {
		for (const uuid of [L1, L2, ELSE]) {
			expect([
				...formLinkMoveVerdicts(fixture(), REGISTER, uuid).entries(),
			]).toEqual([
				[0, { ok: true }],
				[1, { ok: true }],
				[2, { ok: true }],
			]);
		}
	});

	it("is empty for a link that is not on the form", () => {
		expect(
			formLinkMoveVerdicts(fixture(), REGISTER, testUuid("ghost")).size,
		).toBe(0);
	});

	it("every position it answers commits at the actual gate", () => {
		const doc = fixture();
		for (const uuid of [L1, L2, ELSE]) {
			const others = [L1, L2, ELSE].filter((candidate) => candidate !== uuid);
			for (const [index] of formLinkMoveVerdicts(doc, REGISTER, uuid)) {
				const after = index === 0 ? null : others[index - 1];
				const gate = mutationCommitVerdict(
					doc,
					[{ kind: "moveFormLink", formUuid: REGISTER, uuid, after }],
					LOOKUP_CONTEXT_UNAVAILABLE,
				);
				expect(gate.ok).toBe(true);
				if (gate.ok)
					expect(
						gate.nextDoc.forms[REGISTER].formLinks?.map((link) => link.uuid),
					).toEqual([...others.slice(0, index), uuid, ...others.slice(index)]);
			}
		}
	});
});

describe("formLinkTargetVerdict", () => {
	it("admits a module, a sibling form, and a form in another module", () => {
		const doc = fixture();
		expect(formLinkTargetVerdict(doc, REGISTER, toCare)).toEqual({
			ok: true,
		});
		expect(formLinkTargetVerdict(doc, REGISTER, toVisit)).toEqual({
			ok: true,
		});
		expect(
			formLinkTargetVerdict(doc, REGISTER, {
				type: "form",
				moduleUuid: INTAKE,
				formUuid: SURVEY,
			}),
		).toEqual({ ok: true });
	});

	it("refuses a form target naming itself, and a missing target", () => {
		const doc = fixture();
		expect(
			formLinkTargetVerdict(doc, REGISTER, {
				type: "form",
				moduleUuid: INTAKE,
				formUuid: REGISTER,
			}),
		).toEqual({ ok: false, reason: "self-target" });
		expect(
			formLinkTargetVerdict(doc, REGISTER, {
				type: "module",
				moduleUuid: testUuid("ghost"),
			}),
		).toEqual({ ok: false, reason: "target-not-found" });
		expect(
			formLinkTargetVerdict(doc, REGISTER, {
				type: "form",
				moduleUuid: CARE,
				formUuid: testUuid("ghost"),
			}),
		).toEqual({ ok: false, reason: "target-not-found" });
	});

	it("admits a chain of links that leads back to this form, and the gate commits it", () => {
		// Note → Survey → Register; pointing Register at Note closes the loop,
		// which a worker leaves by Back or Home.
		const looped = produce(fixture(), (draft) => {
			delete draft.forms[REGISTER].formLinks;
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
		assertAdmittedDoc(looped);
		expect(formLinkTargetVerdict(looped, REGISTER, toNote)).toEqual({
			ok: true,
		});
		const gate = mutationCommitVerdict(
			looped,
			[
				{
					kind: "addFormLink",
					formUuid: REGISTER,
					link: { uuid: testUuid("r→n"), target: toNote },
				},
			],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(gate.ok).toBe(true);
	});

	it("admits starting this form again", () => {
		expect(
			formLinkTargetVerdict(fixture(), REGISTER, { type: "this-form" }),
		).toEqual({ ok: true });
	});

	it("refuses a submenu HQ does not offer from here, naming the menu that holds it", () => {
		const doc = fixture();
		expect(formLinkTargetVerdict(doc, REGISTER, toSub)).toEqual({
			ok: false,
			reason: "not-offered",
			menuUuid: SUB,
			parentUuid: CARE,
		});
		const gate = mutationCommitVerdict(
			doc,
			[
				{
					kind: "addFormLink",
					formUuid: REGISTER,
					link: { uuid: testUuid("r→sub"), target: toSub },
				},
			],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(gate.ok).toBe(false);
		if (!gate.ok)
			expect(gate.findings.map((finding) => finding.code)).toContain(
				"FORM_LINK_TARGET_NOT_OFFERED",
			);
		// A form inside the submenu is always offered.
		expect(
			formLinkTargetVerdict(doc, REGISTER, {
				type: "form",
				moduleUuid: SUB,
				formUuid: SUB_NOTE,
			}),
		).toEqual({ ok: true });
	});

	it("refuses a direct destination that cannot receive the complete selection", () => {
		const doc = produce(fixture(), (draft) => {
			const source = draft.modules[CARE]?.caseListConfig;
			const target = draft.modules[INTAKE]?.caseListConfig;
			if (source === undefined || target === undefined)
				throw new Error("fixture");
			source.selection = { kind: "multiple", maximum: 10 };
			// Choosing several cases runs in Web Apps alone.
			draft.appSettings.runsOnlyOn = "web-apps";
			target.selection = { kind: "multiple", maximum: 5 };
			draft.forms[REGISTER].type = "followup";
			dropOneCasePreloads(draft);
		});
		assertAdmittedDoc(doc);
		const target: FormLinkTarget = {
			type: "form",
			moduleUuid: INTAKE,
			formUuid: REGISTER,
		};

		expect(formLinkTargetVerdict(doc, VISIT, target)).toEqual({
			ok: false,
			reason: "selection-cardinality",
			sourceCardinality: "multiple",
			targetCardinality: "multiple",
			sourceMaximum: 10,
			targetMaximum: 5,
		});
		expect(formLinkRequiredDatums(doc, VISIT, target)).toEqual([]);
		expect(formLinkCarryVerdict(doc, VISIT, target)).toEqual({
			kind: "nothing-needed",
		});
		expect(formLinkManualCarryVerdict(doc, VISIT, target)).toMatchObject({
			ok: false,
			reason: "selection-cardinality",
		});
	});

	it("checks the datum mode the proposed link will actually store", () => {
		const doc = produce(fixture(), (draft) => {
			const source = draft.modules[CARE]?.caseListConfig;
			const target = draft.modules[INTAKE]?.caseListConfig;
			if (source === undefined || target === undefined)
				throw new Error("fixture");
			source.selection = { kind: "multiple", maximum: 10 };
			// Choosing several cases runs in Web Apps alone.
			draft.appSettings.runsOnlyOn = "web-apps";
			target.selection = { kind: "multiple", maximum: 10 };
			draft.forms[REGISTER].type = "followup";
			dropOneCasePreloads(draft);
		});
		assertAdmittedDoc(doc);
		const target: FormLinkTarget = {
			type: "form",
			moduleUuid: INTAKE,
			formUuid: REGISTER,
		};

		expect(formLinkTargetVerdict(doc, VISIT_AGAIN, target)).toEqual({
			ok: true,
		});
		expect(
			formLinkTargetVerdict(doc, VISIT_AGAIN, target, [
				{
					name: { kind: "selected-case", module: INTAKE },
					xpath: term(literal("patient-id")),
				},
			]),
		).toMatchObject({
			ok: false,
			reason: "selection-cardinality",
			sourceCardinality: "multiple",
			targetCardinality: "multiple",
		});
		expect(formLinkManualCarryVerdict(doc, VISIT_AGAIN, target)).toMatchObject({
			ok: false,
			reason: "selection-cardinality",
		});
	});

	it("refuses an automatic collection carry when a runtime target may be one selected case", () => {
		const doc = produce(fixture(), (draft) => {
			draft.caseTypes ??= [];
			draft.caseTypes.push({
				name: "visit",
				properties: [{ name: "mood", label: proseText("Mood") }],
			});
			const source = draft.modules[CARE]?.caseListConfig;
			const target = draft.modules[INTAKE]?.caseListConfig;
			if (source === undefined || target === undefined) {
				throw new Error("fixture");
			}
			source.selection = { kind: "multiple", maximum: 10 };
			// Choosing several cases runs in Web Apps alone.
			draft.appSettings.runsOnlyOn = "web-apps";
			target.selection = { kind: "multiple", maximum: 10 };
			draft.forms[REGISTER].type = "followup";
			dropOneCasePreloads(draft);
			const visit = draft.forms[VISIT];
			const own = visit.caseOperations?.find(
				(operation) => operation.action === "own",
			);
			if (own === undefined) throw new Error("fixture");
			// Visit saves nothing to its own case; it only retypes the case a
			// runtime expression names.
			delete own.writes;
			visit.caseOperations = [
				own,
				{
					uuid: testUuid("retype-selected"),
					id: "retype_selected",
					action: "update",
					caseType: "patient",
					target: {
						kind: "expression",
						expr: term(literal("runtime-patient-id")),
					},
					retype: "visit",
				},
			];
		});

		assertAdmittedDoc(doc);
		expect(
			formLinkTargetVerdict(doc, VISIT, {
				type: "form",
				moduleUuid: INTAKE,
				formUuid: REGISTER,
			}),
		).toEqual({
			ok: false,
			reason: "selection-case-type",
			expectedCaseType: "patient",
			possibleFinalCaseTypes: ["visit", "patient"],
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
			{
				name: { kind: "selected-case", module: CARE },
				id: "case_id",
				caseType: "patient",
			},
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
	it("offers the otherwise only while a destination may not run and none is stored", () => {
		const doc = fixture();
		expect(formLinkAddChoices(doc, REGISTER)).toEqual({
			conditional: { ok: true },
			everyTime: { ok: true },
			otherwise: { ok: true },
		});
		expect(formLinkAddChoices(doc, SURVEY)).toEqual({
			conditional: { ok: true },
			everyTime: { ok: true },
			otherwise: { ok: false, reason: "otherwise-unreachable" },
		});
		const withOtherwise = produce(doc, (draft) => {
			draft.forms[REGISTER].otherwise = {
				kind: "destination",
				destination: "module",
			};
		});
		assertAdmittedDoc(withOtherwise);
		expect(formLinkAddChoices(withOtherwise, REGISTER).otherwise).toEqual({
			ok: false,
			reason: "otherwise-exists",
		});
	});
});

describe("formLinkTargetChoices", () => {
	it("begins with this form, then lists every menu, an unoffered submenu marked with its parent", () => {
		const choices = formLinkTargetChoices(fixture(), REGISTER);
		expect(choices.thisForm).toEqual({
			name: "Register",
			target: { type: "this-form" },
			verdict: { ok: true },
		});
		expect(
			choices.menus.map((menu) => ({
				uuid: menu.uuid,
				offered: menu.offered,
				...(!menu.offered && menu.reason === "parent"
					? { parentUuid: menu.parentUuid }
					: {}),
			})),
		).toEqual([
			{ uuid: INTAKE, offered: true },
			{ uuid: CARE, offered: true },
			{ uuid: SUB, offered: false, parentUuid: CARE },
		]);
		const intake = choices.menus[0];
		// The form names itself by name only as a self target; this-form is
		// the choice that starts it again.
		expect(
			intake?.forms.find((form) => form.uuid === REGISTER)?.verdict,
		).toEqual({ ok: false, reason: "self-target" });
	});

	it("every choice it marks ok commits as a new destination", () => {
		const doc = fixture();
		const choices = formLinkTargetChoices(doc, SURVEY);
		const targets = [
			choices.thisForm,
			...choices.menus.flatMap((menu) => [menu, ...menu.forms]),
		].filter((choice) => choice.verdict.ok);
		expect(targets.length).toBeGreaterThan(0);
		for (const [index, choice] of targets.entries()) {
			if (
				formLinkCarryVerdict(doc, SURVEY, choice.target).kind ===
				"manual-required"
			)
				continue;
			const gate = mutationCommitVerdict(
				doc,
				[
					{
						kind: "addFormLink",
						formUuid: SURVEY,
						link: {
							uuid: testUuid(`choice-${index}`),
							condition: { kind: "match-all" },
							target: choice.target,
						},
					},
				],
				LOOKUP_CONTEXT_UNAVAILABLE,
			);
			expect(gate.ok, JSON.stringify(choice.target)).toBe(true);
		}
	});
});
